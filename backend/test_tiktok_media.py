"""Private TikTok handoffs use isolated SQLite/media and mocked provider traffic."""
import base64
import hashlib
import json
import logging
import time
import uuid

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import User, current_user, db, guard
import creator
from creator import CreatorItem, CreatorMedia
import social_publishing as publishing
import tiktok_publishing_adapter as adapter
import render_services as render
from test_rendering import database, runtime, creation


ORIGIN = 'https://ziipa.example.test'


class Cache:
    def __init__(self):
        self.values = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    def get(self, key):
        return self.values.get(key)

    def eval(self, _script, _number, key, value):
        if self.values.get(key) == value:
            self.values.pop(key, None)


@pytest.fixture
def setup(database, monkeypatch):
    _, session, user, stranger, backend = database
    item, source, _ = creation(session, user)
    item.visibility = 'published'
    raw = b'\x00\x00\x00\x20ftypisom' + bytes(100)
    source.size = len(raw)
    backend.path(source.id).write_bytes(raw)
    monkeypatch.setattr(creator, 'MEDIA_ROOT', backend.root)
    monkeypatch.setattr(publishing, 'storage', lambda: backend)
    monkeypatch.setattr(publishing, 'cache', Cache())
    monkeypatch.setattr(publishing.config, 'encryption_key', base64.urlsafe_b64encode(b't' * 32).decode())
    monkeypatch.setattr(publishing.config, 'api_origin', ORIGIN)
    monkeypatch.setattr(publishing.config, 'approved_origins', ORIGIN)
    monkeypatch.setattr(publishing.config, 'tiktok_verified_media_origins', ORIGIN)
    monkeypatch.setattr(publishing.config, 'tiktok_client_key', 'test-client')
    monkeypatch.setattr(publishing.config, 'tiktok_client_secret', 'test-secret')
    monkeypatch.setattr(publishing.config, 'tiktok_public_approved', False)
    monkeypatch.setattr(adapter, 'probe_video', lambda _body, _type: 10)
    grant = publishing.PublishingGrant(owner_id=user.id, provider='tiktok', selected_target_id='target',
        targets=[{'id': 'target', 'name': 'My actual TikTok', 'kind': 'tiktok_account'}],
        token_cipher=publishing.encrypt_tokens(user.id, 'tiktok', {'provider': 'tiktok', 'open_id': 'target',
            'access_token': 'private-provider-token', 'expires_at': time.time() + 3600}))
    session.add(grant); session.commit()
    calls, pulls = [], []

    def handler(request):
        calls.append(request)
        if str(request.url) == adapter.CREATOR_URL:
            return httpx.Response(200, json={'error': {'code': 'ok'}, 'data': {
                'creator_nickname': 'My actual TikTok', 'privacy_level_options': ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'],
                'max_video_post_duration_sec': 180}})
        if str(request.url) == adapter.INIT_URL:
            job = session.query(publishing.PublishingJob).one()
            assert job.provider_data == {'provider': 'tiktok', 'stage': 'init_started'}
            data = json.loads(request.content)
            assert data['source_info']['source'] == 'PULL_FROM_URL'
            pulls.append(data['source_info']['video_url'])
            assert 'cookie' not in request.headers and 'x-ziipa-user' not in request.headers
            return httpx.Response(200, json={'error': {'code': 'ok'}, 'data': {'publish_id': 'v_pub_url~test'}})
        raise AssertionError('Unexpected outbound request; media must not be fetched by URL or FILE_UPLOAD.')

    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False))
    application = FastAPI(); application.include_router(publishing.router)
    active = [user]
    application.dependency_overrides[current_user] = lambda: active[0]
    application.dependency_overrides[db] = lambda: session
    application.dependency_overrides[guard] = lambda: None
    with TestClient(application, base_url=ORIGIN) as client:
        yield client, session, user, stranger, item, source, grant, raw, calls, pulls, active, backend


def review_body(item, grant, **updates):
    return {'item_id': item.id, 'expected_media_id': item.data['media_id'], 'expected_target_id': grant.selected_target_id, **updates}


def approve(client, item, grant):
    response = client.post('/api/publishing/tiktok/review', json=review_body(item, grant))
    assert response.status_code == 200, response.text
    review = response.json()
    return {'item_id': item.id, 'expected_media_id': item.data['media_id'], 'expected_target_id': grant.selected_target_id,
            'provider': 'tiktok', 'idempotency_key': str(uuid.uuid4()), 'privacy': 'private', 'made_for_kids': False,
            'consent': True, 'original_media_acknowledged': True,
            'tiktok': {'privacy_level': 'SELF_ONLY', 'disable_comment': True, 'disable_duet': True, 'disable_stitch': True,
                'brand_content_toggle': False, 'brand_organic_toggle': False, 'is_aigc': False,
                'music_usage_confirmed': True, 'content_disclosure_enabled': False, 'branded_content_policy_confirmed': False,
                'source_sha256': review['source_sha256']}}


def test_verified_domain_is_required_for_delivery_but_not_private_source_review(setup, monkeypatch):
    client, session, _, _, item, source, grant, raw, calls, _, _, _ = setup
    monkeypatch.setattr(publishing.config, 'tiktok_verified_media_origins', '')
    state = publishing.readiness('tiktok')
    assert state['can_start'] and not state['publish_ready']
    response = client.post('/api/publishing/tiktok/review', json=review_body(item, grant))
    assert response.status_code == 200
    data = response.json()
    assert data['duration_seconds'] == 10 and data['source_sha256'] == hashlib.sha256(raw).hexdigest()
    assert data['media_id'] == source.id and data['creator']['privacy_level_options'] == ['SELF_ONLY']
    body = approve(client, item, grant)
    assert client.post('/api/publishing/publish', json=body).status_code == 409
    assert session.query(publishing.PublishingJob).count() == 0
    assert all(str(request.url) == adapter.CREATOR_URL for request in calls)


def test_signed_pull_has_no_redirects_or_receipt_secrets_and_supports_ranges(setup):
    client, session, _, _, item, _, grant, raw, calls, pulls, _, _ = setup
    body = approve(client, item, grant)
    sent = client.post('/api/publishing/publish', json=body)
    assert sent.status_code == 200 and sent.json()['status'] == 'processing', sent.text
    url = pulls[0]
    token = url.rsplit('/', 1)[1]
    assert url not in sent.text and token not in client.get('/api/publishing/connections').text
    assert token not in json.dumps(session.query(publishing.PublishingJob).one().provider_data)
    assert client.get(url).content == raw
    partial = client.get(url, headers={'Range': 'bytes=2-9'})
    assert partial.status_code == 206 and partial.content == raw[2:10]
    assert partial.headers['content-range'] == f'bytes 2-9/{len(raw)}'
    assert 'no-store' in partial.headers['cache-control'] and 'location' not in partial.headers
    head = client.head(url)
    assert head.status_code == 200 and not head.content and int(head.headers['content-length']) == len(raw)
    assert client.get(url, headers={'Range': 'bytes=0-1,4-5'}).status_code == 416
    corrupt = url[:-1] + ('A' if url[-1] != 'A' else 'B')
    assert client.get(corrupt).status_code == 404
    assert client.post('/api/publishing/publish', json=body).json()['id'] == sent.json()['id']
    assert len([request for request in calls if str(request.url) == adapter.INIT_URL]) == 1


@pytest.mark.parametrize('change', ['private', 'target', 'disconnect', 'media_owner', 'changed_bytes', 'expired', 'redis_reset', 'account_deleted', 'unverified'])
def test_pull_capability_cannot_outlive_ownership_consent_or_exact_source(setup, change, monkeypatch):
    client, session, user, stranger, item, source, grant, raw, _, pulls, _, backend = setup
    sent = client.post('/api/publishing/publish', json=approve(client, item, grant))
    assert sent.json()['status'] == 'processing'
    url = pulls[0]
    if change == 'private': item.visibility = 'draft'
    elif change == 'target': grant.selected_target_id = 'different'
    elif change == 'disconnect': grant.status = 'revoked'
    elif change == 'media_owner': source.owner_id = stranger.id
    elif change == 'changed_bytes': backend.path(source.id).write_bytes(raw[:-1] + b'X')
    elif change == 'account_deleted': session.delete(user)
    elif change == 'unverified': monkeypatch.setattr(publishing.config, 'tiktok_verified_media_origins', '')
    else:
        key = publishing.tiktok_pull_key(url.rsplit('/', 1)[1].split('.')[0])
        if change == 'expired':
            record = json.loads(publishing.cache.get(key)); record['expires'] = time.time() - 1
            publishing.cache.values[key] = json.dumps(record)
        else: publishing.cache.values.pop(key)
    session.commit()
    assert client.get(url).status_code in (404, 409)


def test_review_rejects_changed_media_wrong_owner_and_overlong_measured_source(setup, monkeypatch):
    client, _, _, stranger, item, _, grant, _, _, _, active, _ = setup
    assert client.post('/api/publishing/tiktok/review', json=review_body(item, grant, expected_media_id=str(uuid.uuid4()))).status_code == 409
    monkeypatch.setattr(adapter, 'probe_video', lambda *_: 200)
    assert client.post('/api/publishing/tiktok/review', json=review_body(item, grant)).status_code == 422
    active[0] = stranger
    assert client.post('/api/publishing/tiktok/review', json=review_body(item, grant)).status_code == 409


def test_publish_rechecks_actual_reviewed_bytes_before_any_provider_init(setup):
    client, _, _, _, item, source, grant, raw, calls, pulls, _, backend = setup
    body = approve(client, item, grant)
    backend.path(source.id).write_bytes(raw[:-1] + b'X')
    result = client.post('/api/publishing/publish', json=body)
    assert result.json()['status'] == 'failed' and not pulls
    assert all(str(request.url) == adapter.CREATOR_URL for request in calls)


def test_real_ffprobe_checks_owned_video_characteristics(runtime, tmp_path):
    ffmpeg, _ = runtime
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1',
        '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=2', '-c:v', 'libx264', '-threads', '2',
        '-pix_fmt', 'yuv420p', 'video.mp4'], tmp_path, 20)
    actual = adapter.probe_video((tmp_path / 'video.mp4').read_bytes(), 'video/mp4')
    assert abs(actual - 2) < 0.1
    with pytest.raises(adapter.TikTokError):
        adapter.probe_video(b'not-a-video', 'video/mp4')


def test_private_pull_tokens_are_redacted_from_access_logs_and_sentry_frames():
    token = 'n' * 43 + '.' + 's' * 43
    url = ORIGIN + adapter.PULL_PATH + token
    record = logging.LogRecord('uvicorn.access', logging.INFO, '', 0, '%s - "%s %s HTTP/%s" %d',
                               ('127.0.0.1', 'GET', url, '1.1', 200), None)
    assert publishing.RedactTikTokPullAccess().filter(record)
    assert token not in record.getMessage() and '[redacted]' in record.getMessage()
    event = {'request': {'url': url, 'headers': {'Cookie': 'private-cookie', 'Authorization': 'private-token'}, 'data': 'private-media'},
             'transaction': 'GET ' + url,
             'breadcrumbs': {'values': [{'data': {'url': url}}]},
             'contexts': {'trace': {'trace_id': 'keep-trace-id', 'data': {'http.url': url}}},
             'exception': {'values': [{'stacktrace': {'frames': [{'filename': 'social_publishing.py', 'vars': {
                 'token': token, 'body': 'private-bytes', 'signature': 's' * 43}}]}}]},
             'extra': {'raw_token': token}}
    cleaned = publishing.redact_tiktok_telemetry(event, {})
    encoded = json.dumps(cleaned)
    assert all(secret not in encoded for secret in (token, 'n' * 43, 's' * 43, 'private-cookie', 'private-token', 'private-media', 'private-bytes'))
    assert cleaned['contexts']['trace']['trace_id'] == 'keep-trace-id'
    assert cleaned['exception']['values'][0]['stacktrace']['frames'][0]['filename'] == 'social_publishing.py'
    assert publishing.redact_tiktok_telemetry({'request': {'url': ORIGIN + '/api/health'}, 'status': 200}, {})['status'] == 200
