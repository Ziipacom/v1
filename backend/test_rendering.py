"""Isolated rendering tests; real FFmpeg integration uses generated media only."""
import array
from datetime import datetime, timedelta, timezone
import math
import os
from pathlib import Path
import shutil
import time
import uuid

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import Base, User
from creator import CreatorItem, CreatorMedia
import render_services as render
from storage_services import LocalStorage
import render_api
from app import current_user, db, guard


@pytest.fixture
def runtime(monkeypatch):
    root = Path(__file__).resolve().parents[1]
    bundled = root / '.local' / 'ffmpeg-runtime' / 'ffmpeg-9.0.1-essentials_build' / 'bin'
    ffmpeg = shutil.which('ffmpeg') or str(bundled / 'ffmpeg.exe')
    ffprobe = shutil.which('ffprobe') or str(bundled / 'ffprobe.exe')
    font = Path('C:/Windows/Fonts/arial.ttf') if Path('C:/Windows/Fonts/arial.ttf').exists() else Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    if not Path(ffmpeg).exists() or not Path(ffprobe).exists() or not font.exists():
        pytest.skip('FFmpeg/ffprobe and a Unicode font are required for the real rendering integration test')
    monkeypatch.setattr(render.config, 'ffmpeg', ffmpeg)
    monkeypatch.setattr(render.config, 'ffprobe', ffprobe)
    monkeypatch.setattr(render.config, 'font', str(font))
    monkeypatch.setattr(render.config, 'enabled', True)
    return ffmpeg, ffprobe


@pytest.fixture
def database(tmp_path, monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    backend = LocalStorage()
    backend.root = tmp_path / 'media'
    backend.root.mkdir()
    monkeypatch.setattr(render, 'storage', lambda: backend)
    monkeypatch.setattr(render_api, 'notify_worker', lambda: None)
    monkeypatch.setattr(render.config, 'work_dir', str(tmp_path / 'work'))
    with factory() as session:
        user = User(name='Render owner', email='render-owner@example.test', password_hash='unused')
        stranger = User(name='Another owner', email='another@example.test', password_hash='unused')
        session.add_all([user, stranger]); session.commit()
        yield factory, session, user, stranger, backend
    engine.dispose()


def creation(session, user, audio=False):
    source = CreatorMedia(id=str(uuid.uuid4()), owner_id=user.id, content_type='video/mp4', size=100)
    session.add(source)
    music = CreatorMedia(id=str(uuid.uuid4()), owner_id=user.id, content_type='audio/wav', size=100) if audio else None
    if music:
        session.add(music)
    data = {'title': 'Saved creation', 'media_id': source.id, 'trim_start': 1, 'trim_end': 3,
            'captions': [{'start': 1.2, 'end': 1.6, 'text': 'Timed caption café'}],
            'overlays': [{'id': 'title', 'text': "50% café %{metadata:x} [a];movie=/etc/passwd", 'position': 'center', 'theme': 'purple'}],
            'soundtrack': {'media_id': music.id, 'name': 'Owned music', 'volume': 0.5, 'start': 1} if music else None}
    item = CreatorItem(owner_id=user.id, data=data, visibility='draft')
    session.add(item); session.commit()
    return item, source, music


def test_fingerprint_is_immutable_for_effects_and_rejects_wrong_owner(database):
    _, session, user, stranger, _ = database
    item, source, _ = creation(session, user)
    original = render.input_fingerprint(session, item)
    item.data = {**item.data, 'title': 'Rename only'}
    assert render.input_fingerprint(session, item) == original
    item.data = {**item.data, 'trim_start': 1.1}
    assert render.input_fingerprint(session, item) != original
    source.owner_id = stranger.id
    with pytest.raises(HTTPException) as error:
        render.input_fingerprint(session, item)
    assert error.value.status_code == 404


def test_ready_render_requires_current_edit_and_output_owner(database):
    _, session, user, stranger, _ = database
    item, _, _ = creation(session, user)
    output = CreatorMedia(id=str(uuid.uuid4()), owner_id=user.id, content_type='video/mp4', size=123)
    job = render.RenderJob(owner_id=user.id, item_id=item.id, input_fingerprint=render.input_fingerprint(session, item),
                           snapshot=render.input_snapshot(session, item), status='ready', output_media_id=output.id)
    session.add_all([job, output]); session.commit()
    assert render.resolve_rendered_media(session, user.id, item, job.id).id == output.id
    with pytest.raises(HTTPException) as error:
        render.resolve_rendered_media(session, stranger.id, item, job.id)
    assert error.value.status_code == 404
    item.data = {**item.data, 'overlays': []}
    with pytest.raises(HTTPException) as error:
        render.resolve_rendered_media(session, user.id, item, job.id)
    assert error.value.status_code == 409
    assert render.receipt(job, session)['status'] == 'stale'


def test_claim_is_single_use_and_crashed_worker_has_bounded_recovery(database):
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    job = render.RenderJob(owner_id=user.id, item_id=item.id, input_fingerprint=render.input_fingerprint(session, item), snapshot=render.input_snapshot(session, item))
    session.add(job); session.commit()
    first = render.claim_job(session)
    assert first[0] == job.id
    assert render.claim_job(session) is None
    job.lease_until = datetime.now(timezone.utc) - timedelta(seconds=1); session.commit()
    second = render.claim_job(session)
    assert second[0] == job.id and second[1] != first[1]
    job.lease_until = datetime.now(timezone.utc) - timedelta(seconds=1); session.commit()
    assert render.claim_job(session) is None
    assert job.status == 'failed'


def test_label_only_soundtrack_cannot_be_claimed_as_rendered(database):
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    item.data = {**item.data, 'soundtrack': {'name': 'Not an audio upload', 'media_id': None}}
    with pytest.raises(HTTPException) as error:
        render.input_snapshot(session, item)
    assert error.value.status_code == 422


def _generate(ffmpeg, work):
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-filter_complex_threads', '1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=24:d=4',
                 '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:v', 'libx264', '-threads', '2',
                 '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '4', 'generated.mp4'], work, 20)
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=6',
                 '-c:a', 'pcm_s16le', 'generated.wav'], work, 20)


def test_real_ffmpeg_bakes_trim_unicode_timed_text_and_owned_audio_mix(runtime, database, tmp_path):
    ffmpeg, _ = runtime
    factory, session, user, _, backend = database
    generated = tmp_path / 'generated'; generated.mkdir()
    _generate(ffmpeg, generated)
    item, source, music = creation(session, user, audio=True)
    original = (generated / 'generated.mp4').read_bytes()
    backend.path(source.id).write_bytes(original)
    backend.path(music.id).write_bytes((generated / 'generated.wav').read_bytes())
    source.size = backend.path(source.id).stat().st_size
    music.size = backend.path(music.id).stat().st_size
    session.commit()
    job = render.RenderJob(owner_id=user.id, item_id=item.id, input_fingerprint=render.input_fingerprint(session, item), snapshot=render.input_snapshot(session, item))
    session.add(job); session.commit()
    claimed = render.claim_job(session)
    render.process_job(factory, *claimed)
    session.expire_all(); job = session.get(render.RenderJob, job.id)
    assert job.status == 'ready', job.detail
    output = render.resolve_rendered_media(session, user.id, item, job.id)
    assert output.id != source.id and backend.path(source.id).read_bytes() == original
    assert output.size <= render.MAX_OUTPUT_BYTES and job.output_sha256 and job.source_sha256
    shutil.copyfile(backend.path(output.id), generated / 'rendered.mp4')
    duration, streams = render._probe(generated / 'rendered.mp4', 'video/mp4')
    assert abs(duration - 2) < 0.15
    assert any(s['codec_type'] == 'audio' for s in streams)
    for when, name in [('0.05', 'before.rgb'), ('0.35', 'caption.rgb')]:
        render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-threads', '2', '-ss', when, '-i', 'rendered.mp4', '-frames:v', '1', '-threads', '2',
                     '-f', 'rawvideo', '-pix_fmt', 'rgb24', name], generated, 10)
    before, caption = (generated / 'before.rgb').read_bytes(), (generated / 'caption.rgb').read_bytes()
    assert len(before) == len(caption) == 320 * 240 * 3
    # Overlay changes the blue middle; timed caption changes only its active interval.
    middle = before[320 * 90 * 3:320 * 160 * 3]
    assert sum(middle[::3]) / len(middle[::3]) > 10
    assert sum(abs(a-b) for a, b in zip(before[320*175*3:], caption[320*175*3:])) > 10000
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-threads', '2', '-i', 'rendered.mp4', '-vn', '-ac', '1', '-ar', '48000',
                 '-f', 's16le', 'audio.pcm'], generated, 10)
    samples = array.array('h', (generated / 'audio.pcm').read_bytes())
    def amplitude(frequency):
        return abs(sum(value * math.sin(2*math.pi*frequency*index/48000) for index, value in enumerate(samples[:48000]))) / min(48000,len(samples))
    assert amplitude(440) > 100 and amplitude(880) > 100


@pytest.mark.skipif(os.environ.get('ZIIPA_RENDER_RESOURCE_TEST') != '1', reason='Opt-in 90-second deployment resource check')
def test_real_max_duration_720p_motion_audio_export(runtime, database, tmp_path):
    ffmpeg, _ = runtime
    factory, session, user, _, backend = database
    generated = tmp_path / 'full-size'; generated.mkdir()
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=90',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=90',
        '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '90', 'generated.mp4'], generated, 180)
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=90', '-c:a', 'pcm_s16le', 'generated.wav'], generated, 30)
    item, source, music = creation(session, user, audio=True)
    shutil.copyfile(generated / 'generated.mp4', backend.path(source.id))
    shutil.copyfile(generated / 'generated.wav', backend.path(music.id))
    source.size, music.size = backend.path(source.id).stat().st_size, backend.path(music.id).stat().st_size
    item.data = {**item.data, 'trim_start': 0, 'trim_end': 90,
                'soundtrack': {**item.data['soundtrack'], 'start': 0},
                'captions': [{'start': n, 'end': n + 1.5, 'text': f'Caption café {n}'} for n in range(0, 90, 2)]}
    session.commit()
    job = render.RenderJob(owner_id=user.id, item_id=item.id, input_fingerprint=render.input_fingerprint(session, item), snapshot=render.input_snapshot(session, item))
    session.add(job); session.commit()
    started = time.monotonic()
    render.process_job(factory, *render.claim_job(session))
    elapsed = time.monotonic() - started
    session.expire_all(); job = session.get(render.RenderJob, job.id)
    assert job.status == 'ready', job.detail
    output = render.resolve_rendered_media(session, user.id, item, job.id)
    assert abs(job.duration - 90) < 0.15 and output.size < render.MAX_OUTPUT_BYTES
    print(f'720p/90s motion+audio render: {elapsed:.2f}s, {output.size} output bytes')
    peak = Path('/sys/fs/cgroup/memory.peak')
    if peak.exists():
        print(f'Whole-container memory peak: {peak.read_text().strip()} bytes')


def test_worker_cannot_publish_after_source_edit_or_account_deletion(database, monkeypatch, tmp_path):
    factory, session, user, _, backend = database
    item, source, _ = creation(session, user)
    backend.path(source.id).write_bytes(bytes(source.size))
    job = render.RenderJob(owner_id=user.id, item_id=item.id, input_fingerprint=render.input_fingerprint(session, item), snapshot=render.input_snapshot(session, item))
    session.add(job); session.commit()
    claimed = render.claim_job(session)
    def fake_render(snapshot, work):
        with factory() as other:
            changed = other.get(CreatorItem, item.id)
            changed.data = {**changed.data, 'overlays': []}; other.commit()
        path = work / 'output.mp4'; path.write_bytes(b'fake output')
        return path, 2
    monkeypatch.setattr(render, 'render_files', fake_render)
    render.process_job(factory, *claimed)
    session.expire_all(); job = session.get(render.RenderJob, job.id)
    assert job.status == 'stale' and not backend.path(job.output_media_id).exists()
    render.delete_render_jobs(user.id, session); session.commit()
    assert session.get(render.RenderJob, job.id) is None


def test_api_queues_only_owned_saved_media_with_audio_rights_and_no_inline_render(database, monkeypatch):
    _, session, user, stranger, backend = database
    item, _, _ = creation(session, user, audio=True)
    active_user = [user]
    application = FastAPI(); application.include_router(render_api.router)
    application.dependency_overrides[current_user] = lambda: active_user[0]
    application.dependency_overrides[guard] = lambda: None
    application.dependency_overrides[db] = lambda: session
    monkeypatch.setattr(render_api, 'readiness', lambda: {'can_render': True})
    monkeypatch.setattr(render_api, 'storage', lambda: backend)
    monkeypatch.setattr(render, 'render_files', lambda *_: pytest.fail('The API must never render inline'))
    with TestClient(application) as client:
        denied = client.post('/api/render/jobs', json={'item_id': item.id})
        assert denied.status_code == 422
        result = client.post('/api/render/jobs', json={'item_id': item.id, 'soundtrack_rights_confirmed': True})
        assert result.status_code == 200 and result.json()['status'] == 'queued'
        job_id = result.json()['id']
        again = client.post('/api/render/jobs', json={'item_id': item.id, 'soundtrack_rights_confirmed': True})
        assert again.json()['id'] == job_id
        job = session.get(render.RenderJob, job_id)
        assert job.snapshot['rights_attestation']['soundtrack_confirmed'] is True
        assert client.post(f'/api/render/jobs/{job_id}/export').status_code == 409
        active_user[0] = stranger
        assert client.get(f'/api/render/jobs/{job_id}').status_code == 404
        assert client.post(f'/api/render/jobs/{job_id}/export').status_code == 404
        assert client.post('/api/render/jobs', json={'item_id': item.id, 'soundtrack_rights_confirmed': True}).status_code == 404
        active_user[0] = user
        result = client.post(f'/api/render/jobs/{job_id}/cancel')
        assert result.json()['status'] == 'cancelled'
        assert client.post('/api/render/jobs', json={'item_id': item.id, 'soundtrack_rights_confirmed': True}).json()['status'] == 'cancelled'
        assert client.post('/api/render/jobs', json={'item_id': item.id, 'soundtrack_rights_confirmed': True, 'retry_failed': True}).json()['status'] == 'queued'


def test_account_deletion_removes_reserved_render_files_and_jobs(database):
    _, session, user, _, backend = database
    item, _, _ = creation(session, user)
    job = render.RenderJob(owner_id=user.id, item_id=item.id, input_fingerprint=render.input_fingerprint(session, item), snapshot=render.input_snapshot(session, item), status='failed')
    session.add(job); session.commit()
    output_id, job_id = job.output_media_id, job.id
    backend.path(output_id).write_bytes(b'partial render output')
    render.delete_render_jobs(user.id, session); session.commit()
    assert not backend.path(output_id).exists() and session.get(render.RenderJob, job_id) is None


def test_enqueue_signal_follows_commit_and_redis_failure_preserves_job(database, monkeypatch):
    from redis.exceptions import ConnectionError as RedisConnectionError
    from unittest.mock import Mock

    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    committed, signals = [], []
    event.listen(session, 'after_commit', lambda _session: committed.append(True))
    monkeypatch.setattr(render_api, 'readiness', lambda: {'can_render': True})
    broken_cache = Mock()
    broken_cache.set.side_effect = RedisConnectionError('Deliberate test outage')
    monkeypatch.setattr(render, 'cache', broken_cache)

    def signal():
        assert committed, 'The wake must never precede the durable queue commit'
        signals.append(True)
        render.notify_worker()

    monkeypatch.setattr(render_api, 'notify_worker', signal)
    result = render_api.queue_render(render_api.RenderInput(item_id=item.id), user, session)
    assert result['status'] == 'queued' and signals == [True]
    job = session.get(render.RenderJob, result['id'])
    assert job and job.status == 'queued'
    duplicate = render_api.queue_render(render_api.RenderInput(item_id=item.id), user, session)
    assert duplicate['id'] == job.id and len(signals) == 2
    assert len(committed) == 1  # A repeated wake does not create another job.
