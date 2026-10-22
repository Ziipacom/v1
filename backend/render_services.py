"""Bounded rendering of owned originals. FFmpeg only runs in render_worker.py."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import textwrap
import time
import unicodedata
import uuid
from typing import Literal

from fastapi import HTTPException
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from redis.exceptions import RedisError
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, select, delete, or_
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Mapped, mapped_column

from app import Base, User, cache, settings
from creator import CreatorItem, CreatorMedia, ItemInput, Overlay, OVERLAY_LAYOUT
from storage_services import LocalStorage, object_key, storage
from media_quota import lock_admission, require_capacity, MediaAdmissionError, config as quota_config
from timeline_edit import EFFECT_FILTERS, checked_timeline


class RenderSettings(BaseSettings):
    enabled: bool = False
    ffmpeg: str = 'ffmpeg'
    ffprobe: str = 'ffprobe'
    font: str = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    work_dir: str = '.render-work'
    timeout_seconds: int = 180
    poll_seconds: int = Field(default=30, ge=15, le=60)
    reconcile_seconds: int = Field(default=1800, ge=600, le=3600)
    model_config = SettingsConfigDict(env_prefix='RENDER_', env_file='.env', extra='ignore')


config = RenderSettings()
MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_OUTPUT_BYTES = 25 * 1024 * 1024
MAX_DURATION = 90
LEASE_SECONDS = 600
Rendition = Literal['original', 'portrait', 'square', 'landscape']
RENDITIONS = {'original': None, 'portrait': (720, 1280), 'square': (720, 720), 'landscape': (1280, 720)}


def rendition_descriptor(name='original'):
    if name not in RENDITIONS:
        raise HTTPException(422, 'Choose an original, portrait, square or landscape rendition.')
    canvas = RENDITIONS[name]
    return {'name': name, 'fit': 'contain', 'width': canvas[0] if canvas else None, 'height': canvas[1] if canvas else None}


def snapshot_rendition(snapshot):
    value = snapshot.get('rendition')
    if value is None:
        return rendition_descriptor()
    if not isinstance(value, dict) or value != rendition_descriptor(value.get('name')) or value.get('name') == 'original':
        raise HTTPException(422, 'The saved rendition descriptor is invalid.')
    return value


def coordination_scope():
    database = make_url(settings.database_url)
    identity = {'database': [database.get_backend_name(), database.host, database.port,
                             database.database, database.username],
                'storage': settings.media_storage_backend,
                'media_limits': [quota_config.owner_max_bytes, quota_config.project_max_bytes],
                'media': [settings.r2_endpoint_url.rstrip('/'), settings.r2_bucket_name] if settings.media_storage_backend == 'r2'
                         else str(Path(settings.uploads_dir).expanduser().resolve())}
    # No credentials or personal data appear in Redis key names. A worker on
    # another DB/bucket must never enable this API's render button.
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]


EDIT_PROTOCOL = 3
HEARTBEAT_KEY = 'ziipa:render:worker:v3:' + coordination_scope()
WAKE_KEY = 'ziipa:render:queue-revision:v3:' + coordination_scope()
LEGACY_HEARTBEAT_KEYS = ('ziipa:render:worker:' + coordination_scope(),
                         'ziipa:render:worker:v2:' + coordination_scope())
FORMATS = {'video/mp4': 'mov', 'video/quicktime': 'mov', 'video/webm': 'matroska',
           'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'mov', 'audio/aac': 'aac',
           'audio/flac': 'flac', 'audio/ogg': 'ogg',
           'image/jpeg': 'image2', 'image/png': 'image2', 'image/webp': 'image2', 'image/gif': 'gif'}
IMAGE_FORMATS = {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}


class OverlayLayoutError(RuntimeError):
    """Only fixed, user-actionable overlay messages may reach job receipts."""


def notify_worker():
    # Only a wake hint. The committed database job and recovery scan remain
    # authoritative if Redis restarts or this best-effort signal is lost.
    try:
        cache.set(WAKE_KEY, secrets.token_urlsafe(16))
    except RedisError:
        pass


class RenderJob(Base):
    __tablename__ = 'render_jobs'
    __table_args__ = (UniqueConstraint('owner_id', 'item_id', 'input_fingerprint'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    input_fingerprint: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default='queued', index=True)
    detail: Mapped[str] = mapped_column(String(400), default='Waiting for the render worker.')
    output_media_id: Mapped[str] = mapped_column(String(36), default=lambda: str(uuid.uuid4()))
    output_sha256: Mapped[str] = mapped_column(String(64), default='')
    source_sha256: Mapped[str] = mapped_column(String(64), default='')
    duration: Mapped[float | None] = mapped_column(nullable=True)
    output_width: Mapped[int | None] = mapped_column(nullable=True)
    output_height: Mapped[int | None] = mapped_column(nullable=True)
    attempts: Mapped[int] = mapped_column(default=0)
    claim_token: Mapped[str] = mapped_column(String(64), default='')
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def runtime_paths():
    ffmpeg, ffprobe = shutil.which(config.ffmpeg), shutil.which(config.ffprobe)
    font = Path(config.font).expanduser().resolve()
    if not ffmpeg or not ffprobe or not font.is_file():
        raise HTTPException(503, 'Rendering needs FFmpeg, ffprobe and a configured Unicode font on the worker.')
    return ffmpeg, ffprobe, font


def readiness():
    requirements = []
    if not config.enabled:
        requirements.append('Enable the dedicated render worker')
    try:
        runtime_paths()
    except HTTPException:
        requirements.append('Install FFmpeg, ffprobe and a Unicode font')
    try:
        incompatible_worker_active = any(cache.get(key) for key in LEGACY_HEARTBEAT_KEYS)
        worker_ready = bool(cache.get(HEARTBEAT_KEY)) and not incompatible_worker_active
    except Exception:
        worker_ready, incompatible_worker_active = False, False
    if incompatible_worker_active:
        requirements.append('Stop and drain the older render worker before queuing protocol-three edits')
    return {'configured': not requirements, 'worker_ready': worker_ready,
            'incompatible_worker_active': bool(incompatible_worker_active),
            'edit_protocol': EDIT_PROTOCOL,
            'can_render': not requirements and worker_ready, 'requirements': requirements,
            'max_input_bytes': MAX_INPUT_BYTES, 'max_output_bytes': MAX_OUTPUT_BYTES,
            'max_duration_seconds': MAX_DURATION, 'max_output_long_edge': 1280,
            'output_type': 'video/mp4', 'features': ['trim', 'timed_captions', 'text_overlays', 'positioned_text_overlays', 'timed_text_overlays', 'owned_soundtrack_mix', 'contain_renditions', 'timeline_v1', 'visual_effects', 'audio_canvas', 'still_image_canvas'],
            'overlay_layout': dict(OVERLAY_LAYOUT),
            'still_image_seconds': 6, 'still_image_types': sorted(IMAGE_FORMATS),
            'timeline': {'version': 1, 'max_clips': 12, 'min_source_clip_seconds': 0.2, 'max_output_seconds': MAX_DURATION,
                         'speeds': [0.5, 1, 1.5, 2], 'caption_clock': 'output'},
            'visual_effects': list(EFFECT_FILTERS),
            'renditions': [rendition_descriptor(name) for name in RENDITIONS], 'rendition_fit': 'contain'}


def _owned_media(session, owner_id, media_id, audio=False):
    try:
        parsed = str(uuid.UUID(str(media_id)))
    except (ValueError, TypeError):
        raise HTTPException(422, 'Choose a saved owned source file.')
    media = session.get(CreatorMedia, parsed)
    if not media or media.owner_id != owner_id:
        raise HTTPException(404, 'Your source media was not found.')
    if media.content_type not in FORMATS or (audio and not media.content_type.startswith('audio/')):
        raise HTTPException(422, 'Choose a supported owned video, audio or still image and, optionally, an owned audio soundtrack.')
    if not 0 < media.size <= MAX_INPUT_BYTES:
        raise HTTPException(422, 'The source file exceeds the rendering limit.')
    return {'id': media.id, 'content_type': media.content_type, 'size': media.size}


def input_snapshot(session, item: CreatorItem, rendition: Rendition = 'original') -> dict:
    try:
        parsed = ItemInput.model_validate(item.data)
    except Exception as exc:
        raise HTTPException(422, 'Save valid editor settings before rendering.') from exc
    source = _owned_media(session, item.owner_id, parsed.media_id)
    if parsed.timeline is not None and source['content_type'] in IMAGE_FORMATS:
        raise HTTPException(422, 'Still images export as six-second videos; timeline regions require audio or video.')
    edit = parsed.model_dump(include={'trim_start', 'trim_end', 'captions', 'overlays', 'soundtrack'})
    if parsed.timeline is not None:
        edit['timeline'] = parsed.timeline.model_dump(mode='json')
    if parsed.visual_effect != 'none':
        edit['visual_effect'] = parsed.visual_effect
    if not all(math.isfinite(value) for value in (edit['trim_start'], edit['trim_end'] or 0)):
        raise HTTPException(422, 'Trim times must be finite.')
    soundtrack = edit.get('soundtrack')
    audio = None
    if soundtrack:
        if not soundtrack.get('media_id'):
            raise HTTPException(422, 'The soundtrack is a label only. Upload your owned or licensed audio before rendering.')
        audio = _owned_media(session, item.owner_id, soundtrack['media_id'], audio=True)
        if not all(math.isfinite(soundtrack[key]) for key in ('start', 'volume')):
            raise HTTPException(422, 'Audio times and volume must be finite.')
    for caption in edit['captions']:
        if not math.isfinite(caption['start']) or not math.isfinite(caption['end']):
            raise HTTPException(422, 'Caption times must be finite.')
    descriptor = rendition_descriptor(rendition)
    # Original is deliberately absent: every existing snapshot/hash stays valid.
    advanced_overlays = any(any(value.get(key) is not None for key in ('x', 'y', 'scale', 'start', 'end')) for value in edit['overlays'])
    return {'schema': 3 if advanced_overlays else 2 if parsed.timeline is not None or parsed.visual_effect != 'none' else 1, 'source': source, 'audio': audio, 'edit': edit,
            **({'rendition': descriptor} if rendition != 'original' else {})}


def snapshot_hash(snapshot) -> str:
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def input_fingerprint(session, item: CreatorItem, rendition: Rendition = 'original') -> str:
    return snapshot_hash(input_snapshot(session, item, rendition))


def current_job_fingerprint(session, item, job):
    return input_fingerprint(session, item, snapshot_rendition(job.snapshot)['name'])


def resolve_rendered_media(session, owner_id: int, item: CreatorItem, render_id: str) -> CreatorMedia:
    try:
        render_id = str(uuid.UUID(str(render_id)))
    except (ValueError, TypeError):
        raise HTTPException(404, 'Your render was not found.')
    job = session.get(RenderJob, render_id)
    if item.owner_id != owner_id or not job or job.owner_id != owner_id or job.item_id != item.id:
        raise HTTPException(404, 'Your render was not found.')
    if job.status != 'ready':
        raise HTTPException(409, 'The rendered video is not ready.')
    if job.input_fingerprint != current_job_fingerprint(session, item, job):
        raise HTTPException(409, 'This render is stale. Save your edits and render again before exporting or publishing.')
    media = session.get(CreatorMedia, job.output_media_id)
    if not media or media.owner_id != owner_id or media.content_type != 'video/mp4' or media.size > MAX_OUTPUT_BYTES:
        raise HTTPException(409, 'The rendered output is no longer available.')
    return media


def receipt(job, session=None):
    status, detail = job.status, job.detail
    if session is not None and status == 'ready':
        item = session.get(CreatorItem, job.item_id)
        try:
            if not item or item.owner_id != job.owner_id or current_job_fingerprint(session, item, job) != job.input_fingerprint:
                status, detail = 'stale', 'Saved editor settings changed. Render again before exporting.'
        except HTTPException:
            status, detail = 'stale', 'The source media or editor settings are no longer available.'
    return {'id': job.id, 'item_id': job.item_id, 'status': status, 'detail': detail,
            'input_fingerprint': job.input_fingerprint, 'output_media_id': job.output_media_id if status == 'ready' else None,
            'duration_seconds': job.duration, 'content_type': 'video/mp4',
            'rendition': snapshot_rendition(job.snapshot)['name'], 'fit': 'contain',
            'output_width': job.output_width, 'output_height': job.output_height,
            'created_at': job.created_at.isoformat(), 'updated_at': job.updated_at.isoformat()}


def _limits():
    if os.name != 'posix':
        return
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES + 1024 * 1024, MAX_OUTPUT_BYTES + 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def _run(command, cwd: Path, timeout: float):
    """No shell, no network protocols, bounded logs and explicit process timeout."""
    # Cgroup CPU quotas do not change the host CPU count seen by libavfilter
    # (including internal source graphs). Prevent host-sized implicit pools.
    command = [command[0], '-cpucount', '2', *command[1:]]
    with (cwd / 'stdout.log').open('wb') as stdout, (cwd / 'stderr.log').open('wb') as stderr:
        process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                   shell=False, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                                   preexec_fn=_limits if os.name == 'posix' else None,
                                   env={**{key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR') if key in os.environ},
                                        # Bound glibc per-thread arena reservations as well as
                                        # resident memory; the address-space cap stays 1 GiB.
                                        'MALLOC_ARENA_MAX': '2',
                                        'PATH': os.defpath, 'TEMP': str(cwd), 'TMP': str(cwd)})
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if time.monotonic() > deadline or stdout.tell() > 1024 * 1024 or stderr.tell() > 1024 * 1024:
                    process.kill()
                    process.wait(timeout=5)
                    raise RuntimeError('Rendering exceeded its time or log limit.')
                time.sleep(0.05)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        if stdout.tell() > 1024 * 1024 or stderr.tell() > 1024 * 1024:
            raise RuntimeError('Rendering exceeded its log limit.')
        if process.returncode:
            raise RuntimeError('FFmpeg could not process this media format or editor settings.')
    return (cwd / 'stdout.log').read_bytes()[:1024 * 1024]


def _probe(path: Path, content_type: str):
    _, ffprobe, _ = runtime_paths()
    raw = _run([ffprobe, '-v', 'error', '-max_alloc', '67108864', '-threads', '2', '-protocol_whitelist', 'file',
                '-f', FORMATS[content_type], '-show_entries', 'format=duration:stream=codec_type,width,height,duration,sample_aspect_ratio',
                '-of', 'json', path.name], path.parent, 15)
    try:
        result = json.loads(raw)
        duration = float(result.get('format', {}).get('duration', 0))
        streams = result['streams']
        if not math.isfinite(duration) or not 0 < duration <= 86400 or not isinstance(streams, list) or len(streams) > 16:
            raise ValueError()
        return duration, streams
    except (ValueError, TypeError, KeyError) as exc:
        raise RuntimeError('The media duration or stream layout could not be verified.') from exc


def _materialize(owner_id, descriptor, path):
    backend = storage()
    if isinstance(backend, LocalStorage):
        original = backend.path(str(uuid.UUID(descriptor['id'])))
        source = original.resolve()
        if source.parent != backend.root or not source.is_file() or original.is_symlink():
            raise RuntimeError('The owned original is unavailable.')
        with source.open('rb') as handle:
            data = handle.read(MAX_INPUT_BYTES + 1)
    else:
        body = _r2_client().get_object(Bucket=backend.bucket, Key=object_key(owner_id, str(uuid.UUID(descriptor['id']))))['Body']
        data = bytearray()
        deadline = time.monotonic() + 40
        try:
            while len(data) <= MAX_INPUT_BYTES:
                if time.monotonic() > deadline:
                    raise RuntimeError('Private source download exceeded its deadline.')
                part = body.read(min(1024 * 1024, MAX_INPUT_BYTES + 1 - len(data)))
                if not part:
                    break
                data.extend(part)
        finally:
            body.close()
    if len(data) != descriptor['size'] or len(data) > MAX_INPUT_BYTES:
        raise RuntimeError('The owned original changed or exceeds the byte limit.')
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def _safe_text(text):
    # Text is never interpolated into the filter graph or ASS markup. FFmpeg's
    # expansion=none treats %, quotes, braces and backslashes literally.
    return ''.join(c for c in text if c == '\n' or c.isprintable())


def _display_text(text, width):
    return '\n'.join(line for paragraph in _safe_text(text).split('\n')
                     for line in (textwrap.wrap(paragraph, width=width, replace_whitespace=False) or ['']))


def _custom_display_text(text, scale):
    """Shared mobile/web policy: whole words, then Unicode-codepoint chunks."""
    columns = max(1, math.floor(15 / scale))
    lines = []
    for paragraph in text.split('\n'):
        # ECMAScript horizontal whitespace, then Unicode category-C removal:
        # same order as the shared TypeScript preview (tabs become spaces).
        safe = re.sub(r'[\u0009\u000b\u000c\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', paragraph)
        safe = ''.join(c for c in safe if not unicodedata.category(c).startswith('C')).strip(' ')
        current = ''
        for word in safe.split(' '):
            if not word:
                continue
            if len(word) > columns:
                if current:
                    lines.append(current); current = ''
                while len(word) > columns:
                    lines.append(word[:columns]); word = word[columns:]
            if current and len(current) + 1 + len(word) > columns:
                lines.append(current); current = ''
            current = current + ' ' + word if current else word
        lines.append(current)
    return '\n'.join(lines)


def _measure_text(ffmpeg, work, filename, font_size):
    """Measure actual glyphs with the renderer's font in a tiny offline frame.

    AVExpr print emits only numeric dimensions. No source is decoded and no
    image is retained. Existing process, memory, log and timeout guards apply.
    """
    graph = (f"drawtext=fontfile=font.ttf:textfile={filename}:expansion=none:fontsize={font_size}:"
             "x='print(text_w)':y='print(text_h)'")
    _run([ffmpeg, '-hide_banner', '-loglevel', 'repeat+info', '-nostdin', '-nostats', '-max_alloc', '67108864',
          '-filter_threads', '1', '-threads', '1', '-f', 'lavfi', '-i', 'color=c=black:s=2x2:r=1:d=1',
          '-vf', graph, '-frames:v', '1', '-threads', '1', '-f', 'null', '-'], work, 10)
    messages = (work / 'stderr.log').read_text(encoding='utf-8', errors='replace')
    # AVExpr print() has no log context in distro FFmpeg (bare numbers), while
    # newer builds include an Eval context prefix. Match only complete numeric
    # lines in either format, not numbers from stream metadata or progress.
    # Keep invalid numeric values in order too: dropping a NaN height could
    # incorrectly pair the width with drawtext's second x evaluation instead.
    # Keep repeat+info above: equal dimensions must not become "Last message
    # repeated" and disappear from this fixed, one-frame measurement graph.
    scalar = r'[+-]?(?:[0-9]+(?:\.[0-9]*)?(?:e[+-]?[0-9]+)?|nan|inf(?:inity)?)'
    values = re.findall(r'^(?:\[Eval @ [^\]\r\n]+\][ \t]+)?(' + scalar + r')[ \t]*$',
                        messages, re.MULTILINE | re.IGNORECASE)
    if len(values) < 2:
        raise OverlayLayoutError('The render worker could not verify the positioned text size. Your editable original remains saved.')
    width, height = map(float, values[:2])
    if not math.isfinite(width) or not math.isfinite(height) or width < 0 or height < 0:
        raise OverlayLayoutError('The positioned text size could not be verified.')
    return width, height


def _still_source(snapshot, work):
    """Probe then freeze exactly the first image frame under the same limits."""
    ffmpeg, ffprobe, _ = runtime_paths()
    raw = _run([ffprobe, '-v', 'error', '-max_alloc', '67108864', '-threads', '1', '-protocol_whitelist', 'file',
                '-f', FORMATS[snapshot['source']['content_type']], '-show_entries', 'stream=codec_type,width,height',
                '-of', 'json', 'source.bin'], work, 15)
    try:
        streams = json.loads(raw)['streams']
        video = next(stream for stream in streams if stream.get('codec_type') == 'video')
        width, height = int(video['width']), int(video['height'])
        if not 2 <= width <= 4096 or not 2 <= height <= 4096 or width * height > 4096 * 4096:
            raise ValueError()
    except (ValueError, TypeError, KeyError, StopIteration) as exc:
        raise RuntimeError('The still image dimensions exceed the supported source limit.') from exc
    _run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '67108864',
          '-threads', '1', '-protocol_whitelist', 'file', '-f', FORMATS[snapshot['source']['content_type']], '-i', 'source.bin',
          '-frames:v', '1', '-threads', '1', '-update', '1', 'still.png'], work, 20)
    if not (work / 'still.png').is_file() or (work / 'still.png').stat().st_size > MAX_INPUT_BYTES:
        raise RuntimeError('The frozen still image exceeds the supported source limit.')
    return 6.0, [video]


def validate_snapshot_version(snapshot):
    version = snapshot.get('schema')
    if type(version) is not int or version not in (1, 2, EDIT_PROTOCOL):
        raise RuntimeError('The render snapshot version is unsupported; save and queue this edit again.')
    edit = snapshot.get('edit')
    if not isinstance(edit, dict) or (version == 1 and (edit.get('timeline') is not None or edit.get('visual_effect', 'none') != 'none')):
        raise RuntimeError('The saved edit does not match its render snapshot version.')
    try:
        overlays = [Overlay.model_validate(value).model_dump() for value in edit.get('overlays', [])]
        if len(overlays) > 8 or any(any(value.get(key) is not None for key in ('x', 'y', 'scale', 'start', 'end')) for value in overlays) and version < 3:
            raise ValueError('Extended overlays require protocol three')
    except (ValueError, TypeError) as exc:
        raise RuntimeError('The saved overlays do not match their render snapshot version.') from exc


def render_files(snapshot: dict, work: Path):
    """Render already materialized source.bin/music.bin in an isolated folder."""
    validate_snapshot_version(snapshot)
    ffmpeg, _, font = runtime_paths()
    still_source = snapshot['source']['content_type'] in IMAGE_FORMATS
    duration, streams = _still_source(snapshot, work) if still_source else _probe(work / 'source.bin', snapshot['source']['content_type'])
    video = next((stream for stream in streams if stream.get('codec_type') == 'video'), None)
    audio_source = snapshot['source']['content_type'].startswith('audio/')
    if not video and not audio_source:
        raise RuntimeError('The original has no supported video stream.')
    if video and (not 2 <= int(video.get('width', 0)) <= 4096 or not 2 <= int(video.get('height', 0)) <= 4096):
        raise RuntimeError('The video dimensions exceed the 4096-pixel source limit.')
    has_audio = any(stream.get('codec_type') == 'audio' for stream in streams)
    if audio_source and not has_audio:
        raise RuntimeError('The original has no supported audio stream.')
    edit = {**snapshot['edit'], 'overlays': [Overlay.model_validate(value).model_dump()
                                            for value in snapshot['edit'].get('overlays', [])]}
    timeline = None
    if edit.get('timeline') is not None:
        if still_source:
            raise RuntimeError('Timeline regions require an audio or video source.')
        try:
            timeline = checked_timeline(edit['timeline'], duration)
        except ValueError as exc:
            raise RuntimeError('Choose valid timeline regions inside the source, totaling at most 90 seconds.') from exc
        start, end, length = 0.0, timeline.duration, timeline.duration
    else:
        start, end = float(edit['trim_start']), float(edit['trim_end'] if edit['trim_end'] is not None else duration)
        if not 0 <= start < end <= duration + 0.05 or not 0.1 <= end - start <= MAX_DURATION:
            raise RuntimeError('Choose a trim inside the source lasting 0.1-90 seconds.')
        length = min(end, duration) - start
    effect = edit.get('visual_effect', 'none')
    if effect not in EFFECT_FILTERS:
        raise RuntimeError('Choose one of the supported visual effects.')
    width, height = (int(video['width']), int(video['height'])) if video else (1280, 720)
    source_aspect = width / height
    if video and video.get('sample_aspect_ratio'):
        try:
            numerator, denominator = map(float, video['sample_aspect_ratio'].split(':'))
            ratio = numerator / denominator
            if math.isfinite(ratio) and ratio > 0:
                source_aspect *= ratio
        except (ValueError, ZeroDivisionError):
            pass
    scale = min(1, 1280 / max(width, height), 720 / min(width, height))
    width, height = max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)
    rendition = snapshot_rendition(snapshot)
    shutil.copyfile(font, work / 'font.ttf')
    canvas = [f'scale={width}:{height}', 'setsar=1', 'fps=30', 'format=yuv420p']
    if rendition['name'] != 'original':
        width, height = rendition['width'], rendition['height']
        contain = (f"scale=w='max(2,trunc(min({width},{height}*dar)/2)*2)':"
                   f"h='max(2,trunc(min({height},{width}/dar)/2)*2)'")
        canvas = [contain, 'setsar=1', f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black', 'fps=30', 'format=yuv420p']
    # Custom centers belong to the contained media, not the padded rendition.
    content_width, content_height = width, height
    if rendition['name'] != 'original':
        content_width = max(2, math.trunc(min(width, height * source_aspect) / 2) * 2)
        content_height = max(2, math.trunc(min(height, width / source_aspect) / 2) * 2)
    content_left, content_top = (width - content_width) / 2, (height - content_height) / 2
    command = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '67108864', '-filter_threads', '1', '-threads', '2']
    graph_prefix = []
    if timeline:
        # Separate bounded file inputs seek each requested region. A reversed
        # timeline never buffers the intervening raw frames in a split graph.
        for index, clip in enumerate(timeline.clips):
            raw_length = min(clip.end, duration) - clip.start
            clip_length = raw_length / clip.speed
            command += ['-threads', '1', '-protocol_whitelist', 'file', '-ss', f'{clip.start:.6f}', '-t', f'{raw_length:.6f}',
                        '-f', FORMATS[snapshot['source']['content_type']], '-i', 'source.bin']
            if video:
                clip_filters = [f'trim=duration={raw_length:.6f}', f'setpts=(PTS-STARTPTS)/{clip.speed:.6f}', *canvas]
                graph_prefix.append(f'[{index}:v:0]' + ','.join(clip_filters) + f'[cv{index}]')
            else:
                graph_prefix.append(f'color=c=black:s={width}x{height}:r=30:d={clip_length:.6f}[cv{index}]')
            if has_audio:
                graph_prefix.append(f'[{index}:a:0]atrim=duration={raw_length:.6f},asetpts=PTS-STARTPTS,'
                                    f'atempo={clip.speed:.6f},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,'
                                    f'apad,atrim=duration={clip_length:.6f}[ca{index}]')
        concat_inputs = ''.join(f'[cv{i}]' + (f'[ca{i}]' if has_audio else '') for i in range(len(timeline.clips)))
        graph_prefix.append(concat_inputs + f'concat=n={len(timeline.clips)}:v=1:a={int(has_audio)}[vbase]' + ('[aoriginal]' if has_audio else ''))
        video_input = '[vbase]'
        filters = []
        music_index = len(timeline.clips)
    else:
        if still_source:
            command += ['-threads', '1', '-protocol_whitelist', 'file', '-loop', '1', '-framerate', '30', '-f', 'image2', '-i', 'still.png']
        else:
            command += ['-protocol_whitelist', 'file', '-f', FORMATS[snapshot['source']['content_type']], '-i', 'source.bin']
        if video:
            filters = [f'trim=start={start:.6f}:end={end:.6f}', 'setpts=PTS-STARTPTS', *canvas]
            video_input = '[0:v:0]'
        else:
            graph_prefix.append(f'color=c=black:s={width}x{height}:r=30:d={length:.6f}[vbase]')
            filters, video_input = [], '[vbase]'
        music_index = 1
    filters.extend(EFFECT_FILTERS[effect])
    index = 0
    themes = {'light': ('black', 'white@0.9'), 'dark': ('white', 'black@0.75'),
              'purple': ('white', '0x5424AF@0.9'), 'lime': ('black', '0xA4E900@0.95')}
    for overlay in edit['overlays']:
        overlay_start = overlay.get('start') or 0
        overlay_end = min(length, overlay['end']) if overlay.get('end') is not None else length
        if overlay_end <= overlay_start:
            continue
        filename = f'text{index}.txt'; index += 1
        custom = overlay.get('x') is not None
        if custom:
            font_size = max(1, round(content_width / 19 * (overlay.get('scale') or 1)))
            border = max(0, round(content_width / 90))
            text = _custom_display_text(overlay['text'], overlay.get('scale') or 1)
            # Do not turn LF into CRLF on Windows: drawtext can treat the CR as
            # another line, diverging from mobile and the Linux worker.
            (work / filename).write_text(text, encoding='utf-8', newline='\n')
            text_width, text_height = _measure_text(ffmpeg, work, filename, font_size)
            if text_width + 2 * border > content_width or text_height + 2 * border > content_height:
                raise OverlayLayoutError('The positioned text does not fit inside this media canvas. Reduce its size, shorten it or use fewer lines; your editable original remains saved.')
        else:
            font_size = max(1, round(max(16, round(width / 19)) * (overlay.get('scale') or 1)))
            border = 12
            (work / filename).write_text(_display_text(overlay['text'], max(12, round(width / (font_size * 0.65)))), encoding='utf-8')
        fg, bg = themes[overlay['theme']]
        y = {'top': 'h*0.12', 'center': '(h-text_h)/2', 'bottom': 'h*0.80-text_h'}[overlay['position']]
        x = '(w-text_w)/2'
        if custom:
            center_x, center_y = content_left + overlay['x'] * content_width, content_top + overlay['y'] * content_height
            x = f"'max({content_left + border:.6f},min({center_x:.6f}-text_w/2,{content_left + content_width - border:.6f}-text_w))'"
            y = f"'max({content_top + border:.6f},min({center_y:.6f}-text_h/2,{content_top + content_height - border:.6f}-text_h))'"
        enabled = f":enable='gte(t,{overlay_start:.6f})*lt(t,{overlay_end:.6f})'" if overlay.get('start') is not None or overlay.get('end') is not None else ''
        filters.append(f'drawtext=fontfile=font.ttf:textfile={filename}:expansion=none:fontsize={font_size}:fontcolor={fg}:box=1:boxcolor={bg}:boxborderw={border:g}:x={x}:y={y}{enabled}')
    for caption in edit['captions']:
        caption_start, caption_end = max(0, caption['start'] - start), min(length, caption['end'] - start)
        if caption_end <= caption_start:
            continue
        filename = f'text{index}.txt'; index += 1
        (work / filename).write_text(_display_text(caption['text'], max(12, round(width / (max(16,round(width/23))*0.65)))), encoding='utf-8')
        filters.append(f"drawtext=fontfile=font.ttf:textfile={filename}:expansion=none:fontsize={max(16,round(width/23))}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=8:x=(w-text_w)/2:y=h*0.91-text_h:enable='between(t,{caption_start:.6f},{caption_end:.6f})'")
    graph = ';'.join([*graph_prefix, video_input + (','.join(filters) if filters else 'null') + '[vout]'])
    if snapshot['audio']:
        music_duration, music_streams = _probe(work / 'music.bin', snapshot['audio']['content_type'])
        music_start = float(edit['soundtrack']['start'])
        if not any(stream.get('codec_type') == 'audio' for stream in music_streams) or not 0 <= music_start < music_duration:
            raise RuntimeError('The soundtrack start is outside the owned audio file.')
        command += ['-threads', '2', '-protocol_whitelist', 'file', '-f', FORMATS[snapshot['audio']['content_type']], '-i', 'music.bin']
        graph += f";[{music_index}:a:0]atrim=start={music_start:.6f}:end={music_start+length:.6f},asetpts=PTS-STARTPTS,aresample=48000,volume={edit['soundtrack']['volume']:.6f},apad[amusic]"
    if has_audio and not timeline:
        graph += f';[0:a:0]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS,aresample=48000[aoriginal]'
    audio_map = None
    if has_audio and snapshot['audio']:
        graph += ';[aoriginal][amusic]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]'
        audio_map = '[aout]'
    elif has_audio:
        audio_map = '[aoriginal]'
    elif snapshot['audio']:
        audio_map = '[amusic]'
    (work / 'filters.txt').write_text(graph, encoding='utf-8')
    command += ['-filter_complex_threads', '1', '-filter_complex', graph, '-map', '[vout]']
    if audio_map:
        command += ['-map', audio_map, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000']
    else:
        command += ['-an']
    command += ['-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '23', '-maxrate', '1800k', '-bufsize', '3600k',
                '-t', f'{length:.6f}', '-fs', str(MAX_OUTPUT_BYTES), '-map_metadata', '-1', '-map_chapters', '-1',
                '-movflags', '+faststart', '-f', 'mp4']
    if timeline:
        # Twelve independently sought regions keep decoder contexts alive.
        # Fixed low-buffer encoding stays within the existing 1GiB address-space
        # guard; no larger process/container limit or extra scratch is granted.
        # CRF/rate limits remain unchanged, at some compression-efficiency cost.
        command += ['-tune', 'zerolatency', '-x264-params',
                    'rc-lookahead=0:sync-lookahead=0:mbtree=0:ref=1:threads=1']
    command += ['output.mp4']
    _run(command, work, min(max(config.timeout_seconds, 10), 240))
    output = work / 'output.mp4'
    output_duration, output_streams = _probe(output, 'video/mp4')
    if not 0 < output.stat().st_size < MAX_OUTPUT_BYTES or abs(output_duration - length) > 0.25 or not any(s.get('codec_type') == 'video' for s in output_streams):
        raise RuntimeError('The render was truncated or exceeded its output limit.')
    output_video = next(s for s in output_streams if s.get('codec_type') == 'video')
    if (int(output_video.get('width', 0)), int(output_video.get('height', 0))) != (width, height):
        raise RuntimeError('The actual rendered dimensions do not match the reviewed rendition canvas.')
    return output, output_duration


def claim_job(session):
    now = datetime.now(timezone.utc)
    job = session.scalar(select(RenderJob).where(or_(RenderJob.status == 'queued',
        (RenderJob.status == 'processing') & (RenderJob.lease_until < now))).order_by(RenderJob.created_at).with_for_update(skip_locked=True).limit(1))
    if not job:
        return None
    if job.attempts >= 2:
        job.status, job.detail = 'failed', 'The worker was interrupted twice. Save and explicitly retry the render.'
        session.commit()
        return None
    job.status, job.detail = 'processing', 'Rendering your saved edits into a new private MP4.'
    job.attempts += 1
    job.claim_token = secrets.token_urlsafe(32)
    job.lease_until, job.updated_at = now + timedelta(seconds=LEASE_SECONDS), now
    session.commit()
    return job.id, job.claim_token


def _store_output(backend, owner_id, output_id, path):
    if isinstance(backend, LocalStorage):
        backend.root.mkdir(parents=True, exist_ok=True)
        target = backend.path(str(uuid.UUID(output_id)))
        if target.exists():
            raise RuntimeError('A render output already exists; refusing to overwrite it.')
        with path.open('rb') as source, target.open('xb') as output:
            shutil.copyfileobj(source, output, length=1024 * 1024)
    else:
        _r2_client().put_object(Bucket=backend.bucket, Key=object_key(owner_id, str(uuid.UUID(output_id))),
                               Body=path.read_bytes(), ContentType='video/mp4')


def _r2_client():
    import boto3
    from botocore.config import Config
    return boto3.client('s3', endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id, aws_secret_access_key=settings.r2_secret_access_key,
        region_name='auto', config=Config(signature_version='s3v4', connect_timeout=5, read_timeout=10,
                                          retries={'max_attempts': 1, 'mode': 'standard'}))


def process_job(session_factory, job_id: str, claim: str):
    root = Path(config.work_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    with session_factory() as session:
        job = session.get(RenderJob, job_id)
        if not job or job.status != 'processing' or job.claim_token != claim:
            return
        owner_id, snapshot = job.owner_id, dict(job.snapshot)
        session.commit()
    try:
        validate_snapshot_version(snapshot)
        with tempfile.TemporaryDirectory(prefix='render-', dir=root) as temporary:
            work = Path(temporary)
            source_hash = _materialize(owner_id, snapshot['source'], work / 'source.bin')
            if snapshot['audio']:
                _materialize(owner_id, snapshot['audio'], work / 'music.bin')
            output, duration = render_files(snapshot, work)
            digest = hashlib.sha256(output.read_bytes()).hexdigest()
            with session_factory() as session:
                user = lock_admission(session, owner_id, nowait=False, missing_ok=True)
                job = session.scalar(select(RenderJob).where(RenderJob.id == job_id).with_for_update())
                if not user or not job or job.status != 'processing' or job.claim_token != claim:
                    return
                item = session.get(CreatorItem, job.item_id)
                if not item or item.owner_id != owner_id or current_job_fingerprint(session, item, job) != job.input_fingerprint:
                    job.status, job.detail = 'stale', 'Editor settings changed while rendering. Save and render the current version.'
                    session.commit()
                    return
                backend = storage()
                if session.get(CreatorMedia, job.output_media_id):
                    raise RuntimeError('The reserved render output is already in the media catalog.')
                # Include all owned sources/audio/drafts/older exports plus active
                # direct-upload reservations while the shared admission lock is held.
                require_capacity(session, owner_id, output.stat().st_size)
                if isinstance(backend, LocalStorage) and backend.path(job.output_media_id).exists():
                    # This random reserved key can only be a previous crashed
                    # attempt. The user/job locks and lease prevent concurrent
                    # claims; never overwrite a catalogued original or output.
                    if job.output_media_id in {snapshot['source']['id'], (snapshot['audio'] or {}).get('id')}:
                        raise RuntimeError('The render reservation conflicts with an original.')
                    backend.delete(owner_id, job.output_media_id)
                _store_output(backend, owner_id, job.output_media_id, output)
                session.add(CreatorMedia(id=job.output_media_id, owner_id=owner_id, content_type='video/mp4', size=output.stat().st_size))
                job.status, job.detail = 'ready', 'The saved timeline, visual effect, captions, overlays and selected soundtrack are baked into this private MP4.'
                job.output_sha256, job.source_sha256, job.duration = digest, source_hash, duration
                _, output_streams = _probe(output, 'video/mp4')
                output_video = next(s for s in output_streams if s.get('codec_type') == 'video')
                job.output_width, job.output_height = int(output_video['width']), int(output_video['height'])
                job.updated_at, job.lease_until = datetime.now(timezone.utc), None
                session.commit()
                from media_workflows import notify_workflows
                notify_workflows(owner_id)
    except Exception as exc:
        with session_factory() as session:
            # Match the commit lock order so a failed old worker cannot delete a
            # replacement worker's reserved output during cleanup.
            if not lock_admission(session, owner_id, nowait=False, missing_ok=True):
                return
            job = session.scalar(select(RenderJob).where(RenderJob.id == job_id).with_for_update())
            if job and job.claim_token == claim and job.status == 'processing':
                job.status, job.detail = 'failed', (exc.detail if isinstance(exc, MediaAdmissionError) else str(exc) if isinstance(exc, OverlayLayoutError) else
                    'The media could not be rendered within the format, duration or resource limits. Check your trim/audio and retry.')
                job.updated_at, job.lease_until = datetime.now(timezone.utc), None
                # A failed final storage write may leave this reserved key.
                if not session.get(CreatorMedia, job.output_media_id):
                    try:
                        storage().delete(owner_id, job.output_media_id)
                    except Exception:
                        job.detail += ' Output cleanup will be retried on account deletion.'
                session.commit()


def delete_render_jobs(owner_id: int, session):
    """Call with the User lock held, before collecting regular media for deletion."""
    for job in session.scalars(select(RenderJob).where(RenderJob.owner_id == owner_id)):
        if not session.get(CreatorMedia, job.output_media_id):
            try:
                storage().delete(owner_id, job.output_media_id)
            except Exception as exc:
                raise HTTPException(503, 'Rendered media cleanup is temporarily unavailable. Retry account deletion.') from exc
    session.execute(delete(RenderJob).where(RenderJob.owner_id == owner_id))
