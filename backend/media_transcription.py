"""Opt-in, local speech recognition of owned originals; no provider API or downloads.

The synchronous entry point never commits or edits a creation. Call it from a
worker/thread, only after the user explicitly requests transcription. Returned
captions are proposals for review, not an assertion of recognition accuracy.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid
import wave

from fastapi import HTTPException
from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import select

from creator import CreatorItem, CreatorMedia
from personal_media import OSAssetMetadata, rights_json
from render_services import MAX_INPUT_BYTES, _materialize

# Speech inputs are deliberately independent of renderer capabilities. A still
# image may render a video canvas, but must never be read for transcription.
SPEECH_FORMATS = {'video/mp4': 'mov', 'video/quicktime': 'mov', 'video/webm': 'matroska',
                  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'mov', 'audio/aac': 'aac',
                  'audio/flac': 'flac', 'audio/ogg': 'ogg'}


class TranscriptionSettings(BaseSettings):
    enabled: bool = False
    executable: str = ''
    model: str = ''
    ffmpeg: str = 'ffmpeg'
    ffprobe: str = 'ffprobe'
    work_dir: str = '.local/transcription-work'
    timeout_seconds: int = Field(default=75, ge=10, le=90)
    model_config = SettingsConfigDict(env_prefix='TRANSCRIPTION_', env_file='.env', extra='ignore')


config = TranscriptionSettings()
MAX_SECONDS = 90
MAX_JSON_BYTES = 256 * 1024
MAX_SEGMENTS = 100  # Matches CreatorItem's existing caption-list limit.
MAX_TEXT = 16000
MAX_AUDIO_BYTES = 90 * 16000 * 2 + 4096
ENGINE = 'whisper.cpp'


def _result(status, detail, segments=None):
    segments = segments or []
    return {'status': status, 'text': ' '.join(segment['text'] for segment in segments),
            'segments': segments, 'engine': ENGINE, 'detail': detail}


def _owned_source(session, owner_id, item_id):
    try:
        identifier = str(uuid.UUID(item_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(404, 'Creation not found.') from None
    # Refresh persisted ownership/permissions, including after a long inference.
    with session.no_autoflush:
        item = session.scalar(select(CreatorItem).where(CreatorItem.id == identifier,
            CreatorItem.owner_id == owner_id).execution_options(populate_existing=True))
        if item is None:
            raise HTTPException(404, 'Creation not found.')
        metadata = session.scalar(select(OSAssetMetadata).where(OSAssetMetadata.item_id == identifier,
            OSAssetMetadata.owner_id == owner_id).execution_options(populate_existing=True))
        try:
            permitted = metadata is not None and rights_json(metadata.rights)['effective_allow_ai']
        except (ValidationError, TypeError, ValueError):
            permitted = False
        if not permitted:
            raise HTTPException(403, 'Confirm unexpired media rights and allow AI use before transcription.')
        try:
            media_id = str(uuid.UUID((item.data or {}).get('media_id', '')))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(404, 'Owned source media not found.') from None
        media = session.scalar(select(CreatorMedia).where(CreatorMedia.id == media_id,
            CreatorMedia.owner_id == owner_id).execution_options(populate_existing=True))
        if media is None:
            raise HTTPException(404, 'Owned source media not found.')
        return {'id': media.id, 'size': media.size, 'content_type': media.content_type}


def _runtime():
    # Only operator-selected local files. A model name is never sent to a hub.
    executable = Path(config.executable).expanduser()
    model = Path(config.model).expanduser()
    ffmpeg, ffprobe = shutil.which(config.ffmpeg), shutil.which(config.ffprobe)
    if (not executable.is_absolute() or not executable.is_file() or executable.is_symlink()
            or not model.is_absolute() or not model.is_file() or model.is_symlink()
            or not 0 < model.stat().st_size <= 200 * 1024 * 1024 or not ffmpeg or not ffprobe):
        raise RuntimeError('Local speech runtime is not configured.')
    return str(executable.resolve()), str(model.resolve()), ffmpeg, ffprobe


def audio_runtime():
    """A hosted recognizer still decodes owned media locally, never by URL."""
    ffmpeg, ffprobe = shutil.which(config.ffmpeg), shutil.which(config.ffprobe)
    if not ffmpeg or not ffprobe:
        raise RuntimeError('Local audio extraction is not configured.')
    return ffmpeg, ffprobe


@contextmanager
def _slot(root):
    """One speech process per work directory, shared by API/worker processes.

    OS locks release on process exit. Never unlink the lock file: doing so would
    allow another process to lock a new inode while this one is still occupied.
    """
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / 'speech.lock').open('a+b') as handle:
        if os.fstat(handle.fileno()).st_size == 0:
            try:
                handle.write(b'0')
                handle.flush()
            except OSError:
                raise RuntimeError('Local speech worker is busy.') from None
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise RuntimeError('Local speech worker is busy.') from None
        else:
            import fcntl
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise RuntimeError('Local speech worker is busy.') from None
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _run(command, work, deadline, watched=None):
    """No shell or inherited secrets; bounded wall time, output and CPU threads."""
    if time.monotonic() >= deadline:
        raise RuntimeError('Speech operation exceeded its deadline.')
    env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR') if key in os.environ}
    env.update(PATH=str(Path(command[0]).parent) + os.pathsep + os.defpath,
               TEMP=str(work), TMP=str(work), OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2',
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    with (work / 'stdout.log').open('wb') as stdout, (work / 'stderr.log').open('wb') as stderr:
        process = subprocess.Popen(command, cwd=work, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
            shell=False, env=env, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            while process.poll() is None:
                oversized = watched and watched[0].exists() and watched[0].stat().st_size > watched[1]
                if time.monotonic() >= deadline or stdout.tell() > MAX_JSON_BYTES or stderr.tell() > MAX_JSON_BYTES or oversized:
                    raise RuntimeError('Speech operation exceeded its resource limit.')
                time.sleep(0.05)
            if process.returncode or time.monotonic() >= deadline:
                raise RuntimeError('Local speech processing failed.')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        if (stdout.tell() > MAX_JSON_BYTES or stderr.tell() > MAX_JSON_BYTES
                or (watched and watched[0].exists() and watched[0].stat().st_size > watched[1])):
            raise RuntimeError('Speech operation exceeded its output limit.')
    return (work / 'stdout.log').read_bytes()


def _extract(ffmpeg, ffprobe, content_type, work, deadline):
    format_name = SPEECH_FORMATS[content_type]
    input_flags = ['-protocol_whitelist', 'file', '-f', format_name]
    raw = _run([ffprobe, '-v', 'error', '-max_alloc', '67108864', '-threads', '2',
        *input_flags, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', 'source.bin'],
        work, min(deadline, time.monotonic() + 10))
    probe = json.loads(raw)
    duration = float(probe.get('format', {}).get('duration', 0))
    streams = probe.get('streams')
    if (not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS
            or not isinstance(streams, list) or not 0 < len(streams) <= 16):
        raise ValueError('Invalid speech media duration or layout.')
    if not any(isinstance(stream, dict) and stream.get('codec_type') == 'audio' for stream in streams):
        return None
    audio = work / 'speech.wav'
    _run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-cpucount', '2',
        '-max_alloc', '67108864', '-threads', '2', *input_flags, '-i', 'source.bin', '-map', '0:a:0',
        '-vn', '-sn', '-dn', '-t', str(MAX_SECONDS), '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le', '-threads', '2', '-fs', str(MAX_AUDIO_BYTES), 'speech.wav'],
        work, min(deadline, time.monotonic() + 20), (audio, MAX_AUDIO_BYTES))
    with wave.open(str(audio), 'rb') as wav:
        actual_duration = wav.getnframes() / wav.getframerate()
        if (wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000
                or not 0 < actual_duration <= MAX_SECONDS):
            raise ValueError('Invalid decoded audio.')
        # Exact digital silence must not become a hallucinated subtitle.
        audible = False
        while chunk := wav.readframes(8192):
            audible = audible or any(chunk)
    return actual_duration if audible else None


def normalize_segments(payload, duration):
    """Whisper CLI JSON offsets are milliseconds; keep a small subtitle schema."""
    if not isinstance(payload, dict) or not isinstance(payload.get('transcription'), list):
        raise ValueError('Missing speech segments.')
    rows = payload['transcription']
    if len(rows) > MAX_SEGMENTS:
        raise ValueError('Too many speech segments.')
    result, previous_end, characters = [], 0.0, 0
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('offsets'), dict) or not isinstance(row.get('text'), str):
            raise ValueError('Malformed speech segment.')
        start, end = row['offsets'].get('from'), row['offsets'].get('to')
        # The pinned CLI emits integer milliseconds, never floats. Bound before
        # division to reject overflow-sized integers and sub-millisecond cues.
        if type(start) is not int or type(end) is not int or not 0 <= start < end <= MAX_SECONDS * 1000:
            raise ValueError('Invalid speech timestamps.')
        start, end = start / 1000, end / 1000
        if (not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end
                or start < previous_end or end > min(duration, MAX_SECONDS) + 0.05):
            raise ValueError('Invalid speech interval.')
        # Allow final timestamp quantization without rounding beyond the audio.
        end = math.floor(min(end, duration) * 1000) / 1000
        text = ' '.join(''.join(c for c in row['text'] if c.isprintable() or c.isspace()).split())
        if not text:
            continue
        if len(text) > 250 or start >= end:
            raise ValueError('Speech segment is outside subtitle limits.')
        characters += len(text) + 1
        if characters > MAX_TEXT:
            raise ValueError('Speech transcript is too long.')
        result.append({'start': round(start, 3), 'end': round(end, 3), 'text': text})
        previous_end = end
    return result


def transcribe_media(session, owner_id: int, item_id: str, *, recognize=None, before_recognize=None) -> dict:
    descriptor = _owned_source(session, owner_id, item_id)
    if not config.enabled and recognize is None:
        return _result('unavailable', 'Local transcription is disabled. Add a manual transcript or timed captions.')
    if (descriptor['content_type'] not in SPEECH_FORMATS or not 0 < descriptor['size'] <= MAX_INPUT_BYTES):
        return _result('unavailable', 'Choose owned audio or video up to 100 MiB and 90 seconds, or add a manual transcript.')
    deadline = time.monotonic() + config.timeout_seconds
    try:
        if recognize is None:
            executable, model, ffmpeg, ffprobe = _runtime()
        else:
            ffmpeg, ffprobe = audio_runtime()
        root = Path(config.work_dir).expanduser().resolve()
        with _slot(root), tempfile.TemporaryDirectory(prefix='speech-', dir=root) as directory:
            work = Path(directory)
            try:
                _materialize(owner_id, descriptor, work / 'source.bin')
            except HTTPException:
                raise RuntimeError('Private storage is unavailable.') from None
            duration = _extract(ffmpeg, ffprobe, descriptor['content_type'], work, deadline)
            if duration is None:
                result = _result('no_speech', 'No audio track or only digital silence was found. Add a manual transcript if needed.')
            else:
                if before_recognize is not None:
                    before_recognize()
                if recognize is None:
                    output = work / 'transcript.json'
                    _run([executable, '-m', model, '-f', 'speech.wav', '-of', 'transcript', '-oj',
                        '-t', '2', '-p', '1', '-ng', '-l', 'auto', '-ml', '120', '-sow', '-sns', '-np'],
                        work, deadline, (output, MAX_JSON_BYTES))
                    if output.is_symlink() or not output.is_file() or output.stat().st_size > MAX_JSON_BYTES:
                        raise ValueError('Missing or oversized transcript.')
                    segments = normalize_segments(json.loads(output.read_text(encoding='utf-8')), duration)
                else:
                    # Only a trusted backend callback; clients never supply a
                    # destination or model. No runtime fallback is attempted.
                    segments = recognize(work / 'speech.wav', duration, deadline)
                result = _result('ready' if segments else 'no_speech',
                    'Machine transcript. Review the words and timing before applying captions.' if segments
                    else 'The recognition engine returned no speech. Add a manual transcript if needed.', segments)
        if _owned_source(session, owner_id, item_id) != descriptor:
            return _result('unavailable', 'The saved source changed during transcription. Retry with the current creation.')
        return result
    except HTTPException:
        # Final authorization failures must not leak a completed transcript.
        raise
    except (OSError, RuntimeError, ValueError, TypeError, KeyError, wave.Error, subprocess.SubprocessError):
        # Never return decoder diagnostics, local paths, source bytes or partial text.
        return _result('unavailable', 'Local transcription is unavailable, busy, unsupported or exceeded its limits. Add a manual transcript or timed captions.')
