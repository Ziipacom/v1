"""Isolated signed-webhook/import lifecycle; no real provider or broadcasting."""
from datetime import datetime, timedelta, timezone
import asyncio
import hashlib
import hmac
import json
from types import SimpleNamespace
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import SecretStr
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app as main
import live_api as live
import live_recordings as recordings
import live_recordings_worker as worker
import live_webhooks as hooks
import render_api
import render_services
import notification_services
from test_rendering import runtime  # existing real FFmpeg fixture, generated inputs only
from creator import CreatorItem, CreatorMedia
from render_services import RenderJob
from storage_services import LocalStorage

NOW = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)
SECRET = 'fixture-only-webhook-secret-' + 'x' * 32
WEBHOOK_ID = str(uuid.uuid4())
CONTENT = b'\x00\x00\x00\x18ftypmp42' + b'fixture' * 40
REAL_PROBE = render_services._probe


@pytest.fixture
def harness(monkeypatch, tmp_path):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    main.Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    monkeypatch.setattr(recordings, 'now', lambda: NOW)
    monkeypatch.setattr(recordings.config, 'live_recordings_enabled', True)
    monkeypatch.setattr(recordings.config, 'live_webhook_id', WEBHOOK_ID)
    monkeypatch.setattr(recordings.config, 'live_webhook_secret', SecretStr(SECRET))
    monkeypatch.setattr(recordings, 'notify', lambda: None)
    monkeypatch.setattr(main.settings, 'uploads_dir', str(tmp_path / 'media'))
    monkeypatch.setattr(render_services.config, 'work_dir', str(tmp_path / 'work'))
    backend = LocalStorage()
    monkeypatch.setattr(worker, 'storage', lambda: backend)
    monkeypatch.setattr('storage_services.storage', lambda: backend)
    monkeypatch.setattr(render_api, 'readiness', lambda: {'can_render': True})
    monkeypatch.setattr(render_api, 'notify_worker', lambda: None)
    monkeypatch.setattr(render_services, '_probe', lambda *args: (70.0, [{'codec_type': 'video', 'width': 1280, 'height': 720}]))
    notices = []
    monkeypatch.setattr(notification_services, 'enqueue_notification', lambda session, owner_id, **kw: notices.append((owner_id, kw)))
    with factory() as session:
        owner = main.User(name='Live owner', email='live-recorder@example.test', password_hash='unused')
        stranger = main.User(name='Other', email='live-recording-other@example.test', password_hash='unused')
        session.add_all([owner, stranger]); session.commit()
        stream = live.LiveStream(id=str(uuid.uuid4()), owner_id=owner.id, request_id=str(uuid.uuid4()),
            title='Recorded session', provider_id=str(uuid.uuid4()), record=True, status='ended')
        session.add(stream); session.commit()
        asset_id, session_id = str(uuid.uuid4()), str(uuid.uuid4())
        asset = {'id': asset_id, 'type': 'video', 'status': {'phase': 'ready'},
            'source': {'type': 'recording', 'sessionId': session_id}, 'size': len(CONTENT),
            'downloadUrl': 'https://livepeercdn.com/asset/recording-fixture/video/download.mp4',
            'hash': [{'algorithm': 'sha256', 'hash': hashlib.sha256(CONTENT).hexdigest()}]}
        provider_session = {'id': session_id, 'parentId': stream.provider_id, 'record': True}
        calls = []
        async def provider(method, path, *args, **kwargs):
            calls.append((method, path))
            assert method == 'GET', 'Calendar/recording automation attempted provider mutation'
            if path == '/asset/' + asset_id:
                return dict(asset)
            if path == '/session/' + session_id:
                return dict(provider_session)
            pytest.fail('Unexpected provider path ' + path)
        monkeypatch.setattr(live, 'provider_request', provider)
        chosen = {'user': owner}
        application = FastAPI()
        application.include_router(recordings.router); application.include_router(hooks.router)
        application.dependency_overrides[main.current_user] = lambda: chosen['user']
        application.dependency_overrides[main.guard] = lambda: None
        def database():
            with factory() as request_session:
                yield request_session
        application.dependency_overrides[main.db] = database
        with TestClient(application) as client:
            yield SimpleNamespace(factory=factory, session=session, owner=owner, stranger=stranger, stream=stream,
                asset=asset, provider_session=provider_session, calls=calls, chosen=chosen, client=client,
                backend=backend, notices=notices)
    engine.dispose()


def payload(h, **changes):
    return {'id': str(uuid.uuid4()), 'webhookId': WEBHOOK_ID, 'event': 'asset.ready',
        'createdAt': int(NOW.timestamp() * 1000), 'timestamp': int(NOW.timestamp() * 1000),
        'payload': {'asset': {'id': h.asset['id'], 'streamKey': 'must-never-be-stored'}}, **changes}


def sign(value):
    body = json.dumps(value, separators=(',', ':')).encode()
    digest = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    return body, f"t={value['timestamp']},v1={digest}"


def send(h, value=None):
    body, signature = sign(value or payload(h))
    return h.client.post('/api/live/webhooks/livepeer', content=body,
        headers={'Livepeer-Signature': signature, 'Content-Type': 'application/json'})


def consent(h, **changes):
    data = {'revision': 0, 'enabled': True, 'consent': True, 'clip_count': 3, 'clip_seconds': 30, 'rendition': 'portrait', **changes}
    response = h.client.put('/api/live/streams/' + h.stream.id + '/recording-automation', json=data)
    assert response.status_code == 200, response.text
    return response.json()


def imported(h):
    return h.client.get('/api/live/recordings').json()[0]


def fetch(url, path):
    assert url.startswith('https://livepeercdn.com/asset/')
    path.write_bytes(CONTENT)
    return len(CONTENT), hashlib.sha256(CONTENT).hexdigest()


@pytest.mark.parametrize('change', ['unsigned', 'wrong-secret', 'stale', 'future', 'timestamp-mismatch', 'other-webhook', 'duplicate-time', 'invalid-json'])
def test_webhook_rejects_forgery_replay_and_malformed_headers(harness, change):
    h = harness
    value = payload(h)
    if change == 'stale': value['timestamp'] -= 300_001
    if change == 'future': value['timestamp'] += 300_001
    if change == 'other-webhook': value['webhookId'] = str(uuid.uuid4())
    body, signature = sign(value)
    if change == 'unsigned': signature = ''
    if change == 'wrong-secret': signature = signature[:-1] + ('a' if signature[-1] != 'a' else 'b')
    if change == 'timestamp-mismatch': signature = signature.replace(str(value['timestamp']), str(value['timestamp'] + 1))
    if change == 'duplicate-time': signature += ',t=' + str(value['timestamp'])
    if change == 'invalid-json': body = b'{}{}'; signature = f"t={value['timestamp']},v1=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    response = h.client.post('/api/live/webhooks/livepeer', content=body, headers={'Livepeer-Signature': signature})
    assert response.status_code == 401
    assert h.calls == []
    assert h.session.scalar(select(func.count()).select_from(recordings.LiveWebhookReceipt)) == 0


def test_webhook_bounds_body_and_disable_is_fail_closed(harness, monkeypatch):
    h = harness
    response = h.client.post('/api/live/webhooks/livepeer', content=b'a' * (hooks.MAX_BODY + 1), headers={'Livepeer-Signature': 'invalid'})
    assert response.status_code == 413
    monkeypatch.setattr(recordings.config, 'live_webhook_secret', SecretStr(''))
    assert send(h).status_code == 503 and not h.calls


def test_opt_in_required_no_retrospective_import_and_no_url_storage(harness):
    h = harness
    assert send(h).status_code == 200
    assert h.client.get('/api/live/recordings').json() == []
    consent(h)
    event = payload(h, createdAt=int((NOW - timedelta(seconds=1)).timestamp() * 1000))
    assert send(h, event).status_code == 200
    assert h.client.get('/api/live/recordings').json() == []
    assert send(h).status_code == 200
    row = h.session.scalar(select(recordings.LiveRecording))
    assert row.status == 'queued' and row.owner_id == h.owner.id
    assert 'http' not in json.dumps(row.policy) and 'must-never' not in json.dumps(recordings.export_live_recordings(h.session, h.owner.id))


def test_duplicate_retry_deduplicates_event_and_distinct_events_deduplicate_asset(harness):
    h = harness
    consent(h)
    event = payload(h)
    assert send(h, event).status_code == 200
    assert send(h, event).json()['duplicate'] is True
    event['timestamp'] += 1000
    assert send(h, event).json()['duplicate'] is True
    assert send(h).status_code == 200
    assert h.session.scalar(select(func.count()).select_from(recordings.LiveRecording)) == 1
    event['createdAt'] -= 1000
    assert send(h, event).status_code == 409


def test_provider_binding_rejects_nonrecordings_and_foreign_sessions(harness):
    h = harness
    consent(h)
    h.asset['source'] = {'type': 'url', 'url': 'http://127.0.0.1/private'}
    assert send(h).status_code == 409
    h.asset['source'] = {'type': 'recording', 'sessionId': h.provider_session['id']}
    h.provider_session['parentId'] = str(uuid.uuid4())
    assert send(h).json()['ignored'] is True
    assert h.client.get('/api/live/recordings').json() == []


def test_owner_scope_strict_consent_and_optimistic_revision(harness):
    h = harness
    url = '/api/live/streams/' + h.stream.id + '/recording-automation'
    assert h.client.get(url).json()['revision'] == 0
    assert h.client.put(url, json={'revision': 0, 'enabled': True, 'consent': False}).status_code == 422
    policy = consent(h)
    assert policy['automatic_publication'] is False
    assert h.client.put(url, json={'revision': 0, 'enabled': False}).status_code == 409
    send(h); row = imported(h)
    h.chosen['user'] = h.stranger
    assert h.client.get('/api/live/recordings').json() == []
    assert h.client.get(url).status_code == 404
    assert h.client.get('/api/live/recordings/' + row['id']).status_code == 404
    assert h.client.post('/api/live/recordings/' + row['id'] + '/cancel', json={'revision': row['revision']}).status_code == 404


def test_private_import_clips_queue_recovery_and_one_completion_notice(harness):
    h = harness
    consent(h); send(h)
    assert worker.tick(h.factory, fetch=fetch) is True
    first = imported(h)
    assert first['item_id'] and first['media_id'] and first['status'] == 'processing'
    assert [(clip['start'], clip['end']) for clip in first['clips']] == [(0, 30), (30, 60), (60, 70)]
    assert len([clip for clip in first['clips'] if clip['render_id']]) == 2  # existing queue cap respected
    source = h.session.get(CreatorItem, first['item_id'])
    assert source.visibility == 'draft' and h.backend.path(first['media_id']).read_bytes() == CONTENT
    assert h.session.scalar(select(func.count()).select_from(CreatorMedia)) == 1
    for job in h.session.scalars(select(RenderJob)):
        job.status = 'ready'
    row = h.session.get(recordings.LiveRecording, first['id']); row.next_run = NOW
    h.session.commit()
    assert worker.tick(h.factory, fetch=lambda *args: pytest.fail('Completed source was downloaded twice')) is True
    for job in h.session.scalars(select(RenderJob)):
        job.status = 'ready'
    h.session.commit()
    h.session.expire_all()
    row = h.session.get(recordings.LiveRecording, first['id']); row.next_run = NOW; h.session.commit()
    assert worker.tick(h.factory, fetch=fetch) is True
    assert imported(h)['status'] == 'ready' and len(h.notices) == 1
    assert worker.tick(h.factory, fetch=fetch) is False
    assert {item.visibility for item in h.session.scalars(select(CreatorItem))} == {'draft'}
    assert all(method == 'GET' for method, _ in h.calls)


def test_cancel_during_download_prevents_storage_and_drafts(harness):
    h = harness
    consent(h); send(h)
    def cancel_fetch(url, path):
        current = imported(h)
        response = h.client.post('/api/live/recordings/' + current['id'] + '/cancel', json={'revision': current['revision']})
        assert response.status_code == 200
        return fetch(url, path)
    worker.tick(h.factory, fetch=cancel_fetch)
    assert imported(h)['status'] == 'cancelled'
    assert h.session.scalar(select(func.count()).select_from(CreatorMedia)) == 0
    assert h.session.scalar(select(func.count()).select_from(CreatorItem)) == 0


def test_disable_automation_revokes_queued_import_and_worker_noop(harness, monkeypatch):
    h = harness
    policy = consent(h); send(h)
    consent(h, revision=policy['revision'], enabled=False, consent=False)
    assert imported(h)['status'] == 'cancelled'
    assert worker.tick(h.factory, fetch=lambda *args: pytest.fail('Revoked import downloaded')) is False
    monkeypatch.setattr(recordings.config, 'live_recordings_enabled', False)
    assert worker.tick(lambda: pytest.fail('Disabled worker queried DB')) is False
    assert worker.next_wakeup_at(None) is None


@pytest.mark.parametrize('failure', ['size', 'digest', 'duration', 'quota'])
def test_invalid_or_over_quota_recordings_fail_without_catalogued_media(harness, monkeypatch, failure):
    h = harness
    consent(h); send(h)
    if failure == 'size': h.asset['size'] = recordings.MAX_BYTES + 1
    if failure == 'digest': h.asset['hash'][0]['hash'] = '0' * 64
    if failure == 'duration': monkeypatch.setattr(render_services, '_probe', lambda *args: (1801, [{'codec_type': 'video', 'width': 720, 'height': 1280}]))
    if failure == 'quota': monkeypatch.setattr(worker, 'require_capacity', lambda *args: (_ for _ in ()).throw(HTTPException(413, 'full')))
    worker.tick(h.factory, fetch=fetch)
    assert imported(h)['status'] == 'blocked'
    assert h.session.scalar(select(func.count()).select_from(CreatorMedia)) == 0
    assert h.session.scalar(select(func.count()).select_from(CreatorItem)) == 0


def test_expired_processing_lease_recovers_same_reserved_media(harness):
    h = harness
    consent(h); send(h)
    with h.factory() as session:
        identity, token = worker.claim(session)
    h.session.expire_all()
    row = h.session.get(recordings.LiveRecording, identity)
    reserved = row.reserved_media_id
    h.backend.root.mkdir(parents=True, exist_ok=True)
    h.backend.path(reserved).write_bytes(b'incomplete-orphan')
    row.lease_until = NOW - timedelta(seconds=1); row.next_run = NOW; h.session.commit()
    worker.tick(h.factory, fetch=fetch)
    assert imported(h)['media_id'] == reserved
    assert h.backend.path(reserved).read_bytes() == CONTENT
    assert h.session.scalar(select(func.count()).select_from(CreatorMedia)) == 1


def test_reordered_stream_callbacks_use_provider_state_never_start(harness, monkeypatch):
    h = harness
    h.stream.status = 'awaiting_media'; h.stream.publish_enabled = True; h.session.commit()
    seen = []
    async def fresh(row):
        seen.append(row.id); row.status = 'awaiting_media'; row.checked_at = NOW
    monkeypatch.setattr(live, 'refresh_stream', fresh)
    for kind in ('stream.idle', 'stream.started'):
        response = send(h, payload(h, event=kind, stream={'id': h.stream.provider_id, 'isActive': True, 'streamKey': 'never-persist'}))
        assert response.status_code == 200
    h.session.refresh(h.stream)
    assert h.stream.status == 'awaiting_media' and len(seen) == 2
    h.stream.publish_enabled = False; h.session.commit()
    assert send(h, payload(h, event='stream.started', stream={'id': h.stream.provider_id})).status_code == 200
    assert len(seen) == 2


def test_account_export_and_delete_are_owned_and_do_not_commit(harness):
    h = harness
    consent(h); send(h)
    exported = recordings.export_live_recordings(h.session, h.owner.id)
    assert len(exported['recordings']) == 1 and len(exported['automation']) == 1
    assert recordings.export_live_recordings(h.session, h.stranger.id) == {'recordings': [], 'automation': []}
    recordings.delete_live_recordings(h.session, h.owner.id); h.session.rollback()
    assert h.session.scalar(select(func.count()).select_from(recordings.LiveRecording)) == 1
    recordings.delete_live_recordings(h.session, h.owner.id); h.session.commit()
    assert h.session.scalar(select(func.count()).select_from(recordings.LiveRecording)) == 0
    assert h.session.get(main.User, h.owner.id) is not None


def test_actual_generated_recording_to_three_private_rendered_clips(harness, runtime, tmp_path, monkeypatch):
    """Full SQL/webhook/adapter/import/render flow; only provider bytes are mocked."""
    h = harness
    ffmpeg, _ = runtime
    monkeypatch.setattr(render_services, '_probe', REAL_PROBE)
    monkeypatch.setattr(render_services, 'storage', lambda: h.backend)
    monkeypatch.setattr('media_workflows.notify_workflows', lambda *args: None)
    source = tmp_path / 'generated-recording.mp4'
    render_services._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
        '-filter_threads', '1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=6:d=46',
        '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', source.name], tmp_path, 30)
    actual = source.read_bytes()
    h.asset['size'] = len(actual)
    h.asset['hash'] = [{'algorithm': 'sha256', 'hash': hashlib.sha256(actual).hexdigest()}]
    consent(h, clip_count=3, clip_seconds=15, rendition='square')
    assert send(h).status_code == 200
    def generated_download(url, destination):
        destination.write_bytes(actual)
        return len(actual), hashlib.sha256(actual).hexdigest()
    for _ in range(5):
        worker.tick(h.factory, fetch=generated_download)
        while True:
            with h.factory() as session:
                claimed = render_services.claim_job(session)
            if not claimed:
                break
            render_services.process_job(h.factory, *claimed)
        result = imported(h)
        if result['status'] == 'ready':
            break
        with h.factory() as session:
            row = session.get(recordings.LiveRecording, result['id']); row.next_run = NOW; session.commit()
    result = imported(h)
    assert result['status'] == 'ready', result
    assert len(result['clips']) == 3
    for clip in result['clips']:
        assert clip['status'] == 'ready', clip
        with h.factory() as session:
            item = session.get(CreatorItem, clip['item_id'])
            job = session.get(RenderJob, clip['render_id'])
            assert item.visibility == 'draft' and (job.output_width, job.output_height) == (720, 720)
            assert job.duration == pytest.approx(15, abs=0.25)
            output = h.backend.path(job.output_media_id)
            assert hashlib.sha256(output.read_bytes()).hexdigest() == job.output_sha256
    assert {item.visibility for item in h.session.scalars(select(CreatorItem))} == {'draft'}
    assert len(h.notices) == 1


def test_explicit_account_delete_verifies_provider_binding_and_is_idempotent(harness, monkeypatch):
    h = harness
    consent(h); send(h)
    calls, removed = [], {'yes': False}
    async def provider(method, path, **kwargs):
        calls.append((method, path))
        if path == '/session/' + h.provider_session['id']:
            assert method == 'GET'; return dict(h.provider_session)
        assert path == '/asset/' + h.asset['id']
        if method == 'GET': return None if removed['yes'] else dict(h.asset)
        assert method == 'DELETE'; removed['yes'] = True; return {}
    monkeypatch.setattr(live, 'provider_request', provider)
    asyncio.run(recordings.delete_provider_recordings(h.session, h.owner.id))
    assert [method for method, _ in calls] == ['GET', 'GET', 'DELETE', 'GET']
    asyncio.run(recordings.delete_provider_recordings(h.session, h.owner.id))
    assert [method for method, _ in calls].count('DELETE') == 1
    assert h.session.scalar(select(func.count()).select_from(recordings.LiveRecording)) == 1  # caller owns DB cleanup
    h.session.rollback()


@pytest.mark.parametrize('removal_failed', [False, True])
def test_live_account_deletion_orders_shutdown_recording_removal_then_stream_removal(harness, monkeypatch, removal_failed):
    h = harness
    stages = []
    async def end(owner_id, session):
        assert owner_id == h.owner.id
        assert session.get(live.LiveStream, h.stream.id) is not None
        stages.append('ended')
    async def remove(session, owner_id):
        assert owner_id == h.owner.id and stages == ['ended']
        assert session.get(live.LiveStream, h.stream.id) is not None
        stages.append('recordings')
        if removal_failed:
            raise HTTPException(503, 'Provider removal is not confirmed.')
    monkeypatch.setattr(live, 'end_live_for_privacy', end)
    monkeypatch.setattr(recordings, 'delete_provider_recordings', remove)
    if removal_failed:
        with pytest.raises(HTTPException):
            asyncio.run(live.delete_live_account(h.owner.id, h.session))
        assert h.session.get(live.LiveStream, h.stream.id) is not None
    else:
        asyncio.run(live.delete_live_account(h.owner.id, h.session))
        assert h.session.get(live.LiveStream, h.stream.id) is None
    assert stages == ['ended', 'recordings']
    assert h.session.get(main.User, h.owner.id) is not None
    h.session.rollback()


@pytest.mark.parametrize('failure', ['wrong-parent', 'wrong-source', 'live', 'provider-error', 'still-present'])
def test_account_delete_never_deletes_unverified_recording_or_claims_failed_removal(harness, monkeypatch, failure):
    h = harness
    consent(h); send(h)
    if failure == 'wrong-parent': h.provider_session['parentId'] = str(uuid.uuid4())
    if failure == 'wrong-source': h.asset['source'] = {'type': 'url', 'url': 'https://example.test'}
    if failure == 'live': h.stream.publish_enabled = True; h.session.commit()
    calls = []
    async def provider(method, path, **kwargs):
        calls.append((method, path))
        if failure == 'provider-error': raise HTTPException(502, 'private upstream error')
        if path.startswith('/session/'): return dict(h.provider_session)
        return {} if method == 'DELETE' else dict(h.asset)
    monkeypatch.setattr(live, 'provider_request', provider)
    with pytest.raises(HTTPException) as error:
        asyncio.run(recordings.delete_provider_recordings(h.session, h.owner.id))
    assert error.value.status_code == 503 and 'private upstream error' not in error.value.detail
    if failure != 'still-present':
        assert all(method != 'DELETE' for method, _ in calls)
    h.session.rollback()
    assert h.session.get(main.User, h.owner.id) is not None
