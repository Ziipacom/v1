"""Provider OAuth and delivery tests: every outbound request is a mock."""
import asyncio
import base64
from datetime import datetime, timedelta, timezone
import json
import time
from urllib.parse import parse_qs, urlsplit
import uuid

import httpx
import pytest
from fastapi import HTTPException

from test_api import client, register_creator
from app import app, db, cache
import social_publishing as publishing

if not any(getattr(route, 'path', '') == '/api/publishing/config' for route in app.routes):
    app.include_router(publishing.router)

CHANNEL_ID = 'UC' + 'a' * 22
VIDEO_ID = 'aB123456789'
API_ORIGIN = 'https://api.ziipa.test'


@pytest.fixture(autouse=True)
def isolated_publishing(monkeypatch, client):
    client.base_url = httpx.URL(API_ORIGIN)
    monkeypatch.setattr(publishing.config, 'encryption_key', base64.urlsafe_b64encode(b't' * 32).decode())
    monkeypatch.setattr(publishing.config, 'api_origin', API_ORIGIN)
    monkeypatch.setattr(publishing.config, 'approved_origins', API_ORIGIN)
    monkeypatch.setattr(publishing.config, 'youtube_client_id', 'test-client-id')
    monkeypatch.setattr(publishing.config, 'youtube_client_secret', 'test-client-secret')
    monkeypatch.setattr(publishing.config, 'youtube_public_approved', False)
    monkeypatch.setattr(publishing.config, 'bluesky_enabled', False)
    monkeypatch.setattr(publishing.config, 'twitch_client_id', '')
    monkeypatch.setattr(publishing.config, 'twitch_client_secret', '')
    def forbidden(request):
        raise AssertionError('A provider response must be explicitly mocked by this test')
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(forbidden), follow_redirects=False))
    for key in cache.scan_iter('publishing_*'):
        cache.delete(key)
    yield
    for key in cache.scan_iter('publishing_*'):
        cache.delete(key)


def db_session():
    return next(app.dependency_overrides[db]())


def provider_mock(monkeypatch, upload_result=None):
    requests = []
    def handler(request):
        requests.append(request)
        url = str(request.url).split('?')[0]
        assert url in publishing.HTTP_URLS
        if url == publishing.TOKEN_URL:
            return httpx.Response(200, json={'access_token': 'private-test-access', 'refresh_token': 'private-test-refresh',
                'expires_in': 3600, 'scope': ' '.join(sorted(publishing.YOUTUBE_SCOPES))})
        if url == publishing.CHANNELS_URL:
            return httpx.Response(200, json={'items': [{'id': CHANNEL_ID, 'snippet': {'title': 'My authorized channel'}}]})
        if url == publishing.UPLOAD_URL:
            return upload_result(request) if upload_result else httpx.Response(200, json={'id': VIDEO_ID})
        if url == publishing.VIDEOS_URL:
            return httpx.Response(200, json={'items': [{'id': VIDEO_ID, 'snippet': {'channelId': CHANNEL_ID},
                'status': {'uploadStatus': 'processed', 'privacyStatus': 'private'}, 'processingDetails': {'processingStatus': 'succeeded'}}]})
        if url == publishing.REVOKE_URL:
            return httpx.Response(200, json={})
        raise AssertionError('Unexpected provider call')
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False))
    return requests


def authorized_channel(client, monkeypatch, *, choose=True, upload_result=None):
    requests = provider_mock(monkeypatch, upload_result)
    start = client.post('/api/publishing/oauth/youtube/start')
    assert start.status_code == 200
    begin = client.get(start.json()['auth_url'], follow_redirects=False)
    assert begin.status_code == 302
    query = parse_qs(urlsplit(begin.headers['location']).query)
    assert query['code_challenge_method'] == ['S256']
    assert query['redirect_uri'] == [API_ORIGIN + '/api/publishing/oauth/youtube/callback']
    callback = client.get(API_ORIGIN + '/api/publishing/oauth/youtube/callback', params={'state': query['state'][0], 'code': 'test-auth-code'})
    assert callback.status_code == 200
    assert 'Nothing has been posted' in callback.text
    if choose:
        selected = client.post('/api/publishing/connections/youtube/target', json={'target_id': CHANNEL_ID})
        assert selected.status_code == 200
    return requests, query


def published_video(client, tmp_path, monkeypatch):
    import creator
    monkeypatch.setattr(creator, 'MEDIA_ROOT', tmp_path)
    content = b'\x00\x00\x00\x20ftypisom' + bytes(100)
    upload = client.post('/api/creator/media', content=content, headers={'Content-Type': 'video/mp4'})
    assert upload.status_code == 200
    created = client.post('/api/creator/items', json={'title': 'User approved original', 'media_id': upload.json()['id'], 'visibility': 'published'})
    assert created.status_code == 201
    return created.json()


def publication(item, **updates):
    grant = db_session().query(publishing.PublishingGrant).filter_by(provider=updates.get('provider', 'youtube')).first()
    return {'item_id': item['id'], 'expected_media_id': item['media_id'],
            'expected_target_id': grant.selected_target_id if grant and grant.selected_target_id else CHANNEL_ID,
            'provider': 'youtube', 'idempotency_key': str(uuid.uuid4()),
            'privacy': 'private', 'made_for_kids': False, 'consent': True, 'original_media_acknowledged': True, **updates}


def test_token_encryption_is_authenticated_owner_bound_and_not_response_data(client, monkeypatch):
    register_creator(client)
    authorized_channel(client, monkeypatch)
    row = db_session().query(publishing.PublishingGrant).one()
    assert 'private-test' not in row.token_cipher
    assert publishing.decrypt_tokens(row)['refresh_token'] == 'private-test-refresh'
    original_owner = row.owner_id
    row.owner_id += 1
    with pytest.raises(HTTPException):
        publishing.decrypt_tokens(row)
    row.owner_id = original_owner
    state = client.get('/api/publishing/connections').text
    assert 'private-test' not in state and 'token_cipher' not in state and 'test-client-secret' not in state


def test_readiness_requires_credentials_encryption_and_fixed_callback(client, monkeypatch):
    assert client.get('/api/publishing/config').status_code == 401
    register_creator(client)
    providers = client.get('/api/publishing/config').json()['providers']
    assert next(p for p in providers if p['provider'] == 'youtube')['can_start'] is True
    assert all(p['oauth_implemented'] and not p['can_start'] for p in providers if p['provider'] in ('bluesky', 'twitch'))
    assert client.post('/api/publishing/oauth/twitch/start').status_code == 409
    monkeypatch.setattr(publishing.config, 'encryption_key', '')
    assert client.post('/api/publishing/oauth/youtube/start').status_code == 409
    monkeypatch.setattr(publishing.config, 'encryption_key', base64.urlsafe_b64encode(b'x' * 32).decode())
    monkeypatch.setattr(publishing.config, 'api_origin', 'https://api.ziipa.test@evil.test')
    assert client.post('/api/publishing/oauth/youtube/start').status_code == 409


def test_instagram_oauth_readiness_is_separate_from_required_media_delivery_setup(client, monkeypatch):
    monkeypatch.setattr(publishing.config, 'meta_client_id', 'test-meta-id')
    monkeypatch.setattr(publishing.config, 'meta_client_secret', 'test-meta-secret')
    monkeypatch.setattr(publishing.config, 'meta_graph_version', 'v25.0')
    monkeypatch.setattr(publishing.config, 'meta_public_approved', True)
    monkeypatch.setattr(publishing.settings, 'media_storage_backend', 'local')
    monkeypatch.setattr(publishing.config, 'meta_media_origins', '')
    state = publishing.readiness('instagram')
    assert state['can_start'] and state['oauth_implemented']
    assert not state['publish_ready'] and len(state['delivery_requirements']) == 2
    monkeypatch.setattr(publishing.settings, 'media_storage_backend', 'r2')
    monkeypatch.setattr(publishing.settings, 'r2_endpoint_url', 'https://media.ziipa.test')
    monkeypatch.setattr(publishing.settings, 'r2_access_key_id', 'test-r2-id')
    monkeypatch.setattr(publishing.settings, 'r2_secret_access_key', 'test-r2-secret')
    monkeypatch.setattr(publishing.settings, 'r2_bucket_name', 'test-r2-bucket')
    monkeypatch.setattr(publishing.config, 'meta_media_origins', 'https://elsewhere.test')
    assert not publishing.readiness('instagram')['publish_ready']
    monkeypatch.setattr(publishing.config, 'meta_media_origins', 'https://media.ziipa.test')
    ready = publishing.readiness('instagram')
    assert ready['publish_ready'] and ready['delivery_requirements'] == []
    assert 'test-r2-secret' not in json.dumps(ready)


def test_oauth_single_use_pkce_browser_binding_and_explicit_target(client, monkeypatch):
    register_creator(client)
    requests, query = authorized_channel(client, monkeypatch, choose=False)
    assert any(b'code_verifier=' in request.content for request in requests if str(request.url) == publishing.TOKEN_URL)
    state = client.get('/api/publishing/connections').json()['connections'][0]
    assert state['selected_target_id'] is None and state['can_publish'] is False
    assert client.post('/api/publishing/connections/youtube/target', json={'target_id': 'UC' + 'b' * 22}).status_code == 422
    assert client.get(API_ORIGIN + '/api/publishing/oauth/youtube/callback', params={'state': query['state'][0], 'code': 'again'}).status_code == 400
    start = client.post('/api/publishing/oauth/youtube/start').json()['auth_url']
    begin = client.get(start, follow_redirects=False)
    assert client.get(start, follow_redirects=False).status_code == 400
    query = parse_qs(urlsplit(begin.headers['location']).query)
    client.cookies.clear()
    assert client.get(API_ORIGIN + '/api/publishing/oauth/youtube/callback', params={'state': query['state'][0], 'code': 'stolen'}).status_code == 401


def test_oauth_rejects_same_browser_account_switch(client, monkeypatch):
    provider_mock(monkeypatch)
    register_creator(client)
    start = client.post('/api/publishing/oauth/youtube/start').json()['auth_url']
    # Do not clear the OAuth binding cookie: only change the actual Ziipa login.
    client.post('/api/auth/logout')
    register_creator(client, 'switched-account@example.com')
    assert client.get(start, follow_redirects=False).status_code == 401
    assert client.get('/api/publishing/connections').json()['connections'] == []
    start = client.post('/api/publishing/oauth/youtube/start').json()['auth_url']
    begin = client.get(start, follow_redirects=False)
    state = parse_qs(urlsplit(begin.headers['location']).query)['state'][0]
    client.post('/api/auth/logout')
    client.post('/api/auth/login', json={'email': 'creator@example.com', 'password': 'creator-test-pass-123'})
    assert client.get(API_ORIGIN + '/api/publishing/oauth/youtube/callback', params={'state': state, 'code': 'wrong-owner'}).status_code == 401
    assert client.get('/api/publishing/connections').json()['connections'] == []


def test_oauth_origin_mismatch_fails_closed_instead_of_broadening_cookies(client, monkeypatch):
    client.base_url = httpx.URL('https://portal.ziipa.test')
    register_creator(client)
    start = client.post('/api/publishing/oauth/youtube/start').json()['auth_url']
    # Start cookie belongs to portal; callback configuration wrongly names api.
    assert client.get(start, follow_redirects=False).status_code == 401


def test_native_oauth_uses_configured_portal_not_unbound_tickets(client, monkeypatch):
    from test_api import native_headers
    monkeypatch.setattr(publishing.config, 'approved_origins', API_ORIGIN + ',https://ziipa.com')
    headers = native_headers(client)
    result = client.post('/api/publishing/oauth/youtube/start', headers=headers)
    assert result.status_code == 200
    assert result.json()['status'] == 'browser_sign_in_required'
    assert result.json()['auth_url'] is None
    assert result.json()['connect_via_portal'] == 'https://ziipa.com/portal'


def test_publish_is_consented_idempotent_then_receipt_verified(client, tmp_path, monkeypatch):
    register_creator(client)
    requests, _ = authorized_channel(client, monkeypatch)
    item = published_video(client, tmp_path, monkeypatch)
    body = publication(item)
    assert client.post('/api/publishing/publish', json={**body, 'consent': False}).status_code == 422
    assert client.post('/api/publishing/publish', json={**body, 'privacy': 'public'}).status_code == 422
    result = client.post('/api/publishing/publish', json=body)
    assert result.status_code == 200
    assert result.json()['status'] == 'processing'
    assert result.json()['external_id'] == VIDEO_ID
    repeat = client.post('/api/publishing/publish', json=body)
    assert repeat.json()['id'] == result.json()['id']
    assert client.post('/api/publishing/publish', json=publication(item)).json()['id'] == result.json()['id']
    assert client.post('/api/publishing/publish', json={**body, 'title': 'Different upload'}).status_code == 409
    uploads = [request for request in requests if request.url.path == '/upload/youtube/v3/videos']
    assert len(uploads) == 1
    assert uploads[0].url.params['notifySubscribers'] == 'false'
    assert b'"privacyStatus": "private"' in uploads[0].content
    verified = client.post(f"/api/publishing/jobs/{result.json()['id']}/refresh")
    assert verified.status_code == 200
    assert verified.json()['status'] == 'delivered' and verified.json()['privacy'] == 'private'


def test_uncertain_upload_is_never_automatically_reposted(client, tmp_path, monkeypatch):
    register_creator(client)
    def lost_response(request):
        raise httpx.ReadTimeout('Provider response lost')
    requests, _ = authorized_channel(client, monkeypatch, upload_result=lost_response)
    item = published_video(client, tmp_path, monkeypatch)
    body = publication(item)
    result = client.post('/api/publishing/publish', json=body).json()
    assert result['status'] == 'uncertain'
    assert client.post('/api/publishing/publish', json=body).json()['id'] == result['id']
    assert client.post(f"/api/publishing/jobs/{result['id']}/refresh").json()['status'] == 'uncertain'
    assert len([r for r in requests if r.url.path == '/upload/youtube/v3/videos']) == 1


def test_verified_pre_delivery_failure_can_be_explicitly_retried(client, tmp_path, monkeypatch):
    register_creator(client)
    requests, _ = authorized_channel(client, monkeypatch)
    item = published_video(client, tmp_path, monkeypatch)
    body = publication(item)
    original_reader = publishing.original_bytes
    def missing(*args):
        raise HTTPException(404, 'Source unavailable before sending')
    monkeypatch.setattr(publishing, 'original_bytes', missing)
    result = client.post('/api/publishing/publish', json=body).json()
    assert result['status'] == 'failed'
    assert not any(r.url.path == '/upload/youtube/v3/videos' for r in requests)
    monkeypatch.setattr(publishing, 'original_bytes', original_reader)
    assert client.post('/api/publishing/publish', json=body).json()['status'] == 'failed'
    retried = client.post('/api/publishing/publish', json={**body, 'retry_failed': True}).json()
    assert retried['id'] == result['id'] and retried['status'] == 'processing'
    assert len([r for r in requests if r.url.path == '/upload/youtube/v3/videos']) == 1


def test_ownership_and_disconnect_revocation(client, tmp_path, monkeypatch):
    register_creator(client)
    requests, _ = authorized_channel(client, monkeypatch)
    item = published_video(client, tmp_path, monkeypatch)
    outcome = client.post('/api/publishing/publish', json=publication(item)).json()
    client.cookies.clear()
    register_creator(client, 'another-publisher@example.com')
    assert client.get('/api/publishing/connections').json() == {'connections': [], 'jobs': []}
    assert client.post('/api/publishing/publish', json=publication(item)).status_code == 404
    assert client.post(f"/api/publishing/jobs/{outcome['id']}/refresh").status_code == 404
    client.cookies.clear()
    client.post('/api/auth/login', json={'email': 'creator@example.com', 'password': 'creator-test-pass-123'})
    disconnected = client.post('/api/publishing/connections/youtube/disconnect')
    assert disconnected.status_code == 200 and disconnected.json()['provider_revoked'] is True
    assert any(str(r.url) == publishing.REVOKE_URL for r in requests)
    assert client.get('/api/publishing/connections').json()['connections'] == []


def test_expired_tokens_refresh_only_on_server(client, tmp_path, monkeypatch):
    register_creator(client)
    requests, _ = authorized_channel(client, monkeypatch)
    row = db_session().query(publishing.PublishingGrant).one()
    tokens = publishing.decrypt_tokens(row)
    tokens['expires_at'] = time.time() - 60
    row.token_cipher = publishing.encrypt_tokens(row.owner_id, row.provider, tokens)
    db_session().commit()
    item = published_video(client, tmp_path, monkeypatch)
    result = client.post('/api/publishing/publish', json=publication(item))
    assert result.status_code == 200 and result.json()['status'] == 'processing'
    assert any(b'grant_type=refresh_token' in request.content for request in requests if str(request.url) == publishing.TOKEN_URL)
    assert 'private-test' not in result.text


def test_fixed_http_targets_and_size_limits():
    async def run(url, response):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: response), follow_redirects=False) as transport:
            return await publishing.provider_json(transport, 'GET', url)
    with pytest.raises(ValueError):
        asyncio.run(run('http://localhost/private', httpx.Response(200, json={})))
    with pytest.raises(publishing.ProviderFailure):
        asyncio.run(run(publishing.CHANNELS_URL, httpx.Response(200, content=b'x' * (publishing.MAX_JSON_BYTES + 1))))
    status, _ = asyncio.run(run(publishing.CHANNELS_URL, httpx.Response(302, headers={'Location': 'http://localhost/private'}, json={})))
    assert status == 302


def test_interrupted_receipt_and_account_deletion_hook(client, monkeypatch):
    register_creator(client)
    authorized_channel(client, monkeypatch)
    session = db_session()
    owner = client.get('/api/me').json()['id']
    job = publishing.PublishingJob(owner_id=owner, provider='youtube', item_id=str(uuid.uuid4()),
        idempotency_key=str(uuid.uuid4()), source_hash='a' * 64, target_id=CHANNEL_ID, privacy='private',
        status='sending', created_at=datetime.now(timezone.utc) - timedelta(minutes=3))
    session.add(job)
    session.commit()
    assert publishing.receipt(job)['status'] == 'uncertain'
    assert asyncio.run(publishing.delete_publishing_account(owner, session))['provider_revocation_confirmed'] is True
    session.commit()
    assert client.get('/api/publishing/connections').json() == {'connections': [], 'jobs': []}


def test_tiktok_oauth_explicit_choices_upload_checkpoint_and_completion(client, tmp_path, monkeypatch):
    adapter = publishing.tiktok_adapter
    monkeypatch.setattr(publishing.config, 'tiktok_client_key', 'test-tiktok-key')
    monkeypatch.setattr(publishing.config, 'tiktok_client_secret', 'test-tiktok-secret')
    monkeypatch.setattr(publishing.config, 'tiktok_public_approved', False)
    monkeypatch.setattr(publishing.config, 'tiktok_verified_media_origins', API_ORIGIN)
    monkeypatch.setattr(adapter, 'probe_video', lambda _body, _type: 10)
    calls = []
    ok = {'code': 'ok'}
    def handler(request):
        calls.append(request)
        url = str(request.url).split('?')[0]
        if url == adapter.TOKEN_URL:
            return httpx.Response(200, json={'access_token': 'test-tiktok-private-token', 'refresh_token': 'test-tiktok-refresh',
                'expires_in': 3600, 'open_id': 'test-owner-open-id', 'scope': 'user.info.basic,video.publish'})
        if url == adapter.USER_URL:
            return httpx.Response(200, json={'data': {'user': {'open_id': 'test-owner-open-id', 'display_name': 'Authorized TikTok'}}, 'error': ok})
        if url == adapter.CREATOR_URL:
            return httpx.Response(200, json={'data': {'creator_username': 'ziipatest', 'creator_nickname': 'Ziipa Test',
                'privacy_level_options': ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], 'comment_disabled': False,
                'duet_disabled': False, 'stitch_disabled': False, 'max_video_post_duration_sec': 180}, 'error': ok})
        if url == adapter.INIT_URL:
            checkpoint = db_session().query(publishing.PublishingJob).one().provider_data
            assert checkpoint['stage'] == 'init_started'
            payload = json.loads(request.content)
            assert payload['post_info']['privacy_level'] == 'SELF_ONLY'
            assert payload['source_info']['source'] == 'PULL_FROM_URL'
            assert payload['source_info']['video_url'].startswith(API_ORIGIN + '/api/publishing/tiktok/media/')
            return httpx.Response(200, json={'data': {'publish_id': 'v_publish_test1'}, 'error': ok})
        if url == adapter.STATUS_URL:
            assert json.loads(request.content) == {'publish_id': 'v_publish_test1'}
            return httpx.Response(200, json={'data': {'status': 'PUBLISH_COMPLETE'}, 'error': ok})
        raise AssertionError('Unexpected TikTok request')
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False))
    register_creator(client)
    start = client.post('/api/publishing/oauth/tiktok/start').json()['auth_url']
    redirected = client.get(start, follow_redirects=False)
    query = parse_qs(urlsplit(redirected.headers['location']).query)
    assert query['code_challenge_method'] == ['S256']
    result = client.get(API_ORIGIN + '/api/publishing/oauth/tiktok/callback', params={'state': query['state'][0], 'code': 'test-code'})
    assert result.status_code == 200
    assert client.post('/api/publishing/connections/tiktok/target', json={'target_id': 'test-owner-open-id'}).status_code == 200
    creator_options = client.post('/api/publishing/connections/tiktok/creator-options').json()
    assert creator_options['privacy_level_options'] == ['SELF_ONLY']
    item = published_video(client, tmp_path, monkeypatch)
    review = client.post('/api/publishing/tiktok/review', json={'item_id': item['id'],
        'expected_media_id': item['media_id'], 'expected_target_id': 'test-owner-open-id'})
    assert review.status_code == 200, review.text
    options = {'privacy_level': 'SELF_ONLY', 'disable_comment': True, 'disable_duet': True, 'disable_stitch': True,
               'brand_content_toggle': False, 'brand_organic_toggle': False, 'is_aigc': False,
               'music_usage_confirmed': True, 'duration_seconds': 10, 'source_sha256': review.json()['source_sha256'],
               'content_disclosure_enabled': False, 'branded_content_policy_confirmed': False}
    body = publication(item, provider='tiktok', tiktok=options)
    sent = client.post('/api/publishing/publish', json=body)
    assert sent.status_code == 200 and sent.json()['status'] == 'processing'
    assert sent.json()['external_id'] == 'v_publish_test1'
    assert 'test-tiktok-private-token' not in client.get('/api/publishing/connections').text
    assert 'upload_id' not in json.dumps(db_session().query(publishing.PublishingJob).one().provider_data)
    checked = client.post(f"/api/publishing/jobs/{sent.json()['id']}/refresh")
    assert checked.status_code == 200 and checked.json()['status'] == 'delivered'
    assert client.post('/api/publishing/publish', json=body).json()['id'] == sent.json()['id']
    assert len([r for r in calls if str(r.url) == adapter.INIT_URL]) == 1


@pytest.mark.parametrize('provider,target', [('facebook', '123'), ('instagram', '456')])
def test_meta_oauth_selected_destination_durable_steps_and_receipts(client, tmp_path, monkeypatch, provider, target):
    from types import SimpleNamespace
    meta = publishing.meta_adapter()
    monkeypatch.setattr(publishing.config, 'meta_client_id', 'test-meta-id')
    monkeypatch.setattr(publishing.config, 'meta_client_secret', 'test-meta-private-secret')
    monkeypatch.setattr(publishing.config, 'meta_graph_version', 'v25.0')
    monkeypatch.setattr(publishing.config, 'meta_media_origins', 'https://media.ziipa.test')
    monkeypatch.setattr(publishing.config, 'meta_public_approved', True)
    calls = []
    def handler(request):
        calls.append(request)
        path = request.url.path
        if request.url.host == 'rupload.facebook.com':
            assert path == '/video-upload/v25.0/789'
            assert request.headers['authorization'] == 'OAuth test-meta-private-page'
            assert db_session().query(publishing.PublishingJob).one().provider_data['phase'] == 'upload_started'
            return httpx.Response(200, json={'success': True})
        assert request.url.host == 'graph.facebook.com'
        if path.endswith('/oauth/access_token'):
            return httpx.Response(200, json={'access_token': 'test-meta-private-user', 'expires_in': 5184000})
        if path.endswith('/me/permissions'):
            if request.method == 'DELETE':
                return httpx.Response(200, json={'success': True})
            return httpx.Response(200, json={'data': [{'permission': scope, 'status': 'granted'} for scope in meta.required_scopes(provider)]})
        if path.endswith('/me'):
            return httpx.Response(200, json={'id': '987'})
        if path.endswith('/me/accounts'):
            return httpx.Response(200, json={'data': [{'id': '123', 'name': 'Authorized Page', 'access_token': 'test-meta-private-page',
                'tasks': ['CREATE_CONTENT'], 'instagram_business_account': {'id': '456', 'username': 'authorized_instagram'}}]})
        if path == '/v25.0/123':
            return httpx.Response(200, json={'id': '123', 'instagram_business_account': {'id': '456'}})
        if path == '/v25.0/123/video_reels':
            fields = parse_qs(request.content.decode())
            checkpoint = db_session().query(publishing.PublishingJob).one().provider_data
            if fields['upload_phase'] == ['start']:
                assert checkpoint['phase'] == 'create_started'
                return httpx.Response(200, json={'video_id': '789', 'upload_url': 'https://rupload.facebook.com/video-upload/v25.0/789'})
            assert fields['upload_phase'] == ['finish'] and fields['video_state'] == ['PUBLISHED']
            assert checkpoint['phase'] == 'publish_started'
            return httpx.Response(200, json={'success': True})
        if path == '/v25.0/789':
            return httpx.Response(200, json={'id': '789', 'status': {'publishing_phase': {'status': 'complete'}}})
        if path == '/v25.0/456/media':
            assert db_session().query(publishing.PublishingJob).one().provider_data['phase'] == 'create_started'
            assert parse_qs(request.content.decode())['video_url'] == ['https://media.ziipa.test/owned.mp4?signature=test-private-signature']
            return httpx.Response(200, json={'id': '555'})
        if path == '/v25.0/555':
            return httpx.Response(200, json={'id': '555', 'status_code': 'FINISHED'})
        if path == '/v25.0/456/media_publish':
            assert db_session().query(publishing.PublishingJob).one().provider_data['phase'] == 'publish_started'
            assert parse_qs(request.content.decode()) == {'creation_id': ['555']}
            return httpx.Response(200, json={'id': '666'})
        if path == '/v25.0/666':
            return httpx.Response(200, json={'id': '666', 'permalink': 'https://www.instagram.com/reel/test123/'})
        raise AssertionError('Unexpected Meta API operation')
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False))
    register_creator(client)
    start = client.post(f'/api/publishing/oauth/{provider}/start').json()['auth_url']
    redirect = client.get(start, follow_redirects=False)
    query = parse_qs(urlsplit(redirect.headers['location']).query)
    assert set(query['scope'][0].split(',')) == meta.required_scopes(provider)
    assert client.get(API_ORIGIN + f'/api/publishing/oauth/{provider}/callback', params={'state': query['state'][0], 'code': 'test-code'}).status_code == 200
    assert client.get('/api/publishing/connections').json()['connections'][0]['selected_target_id'] is None
    assert client.post(f'/api/publishing/connections/{provider}/target', json={'target_id': '999'}).status_code == 422
    assert client.post(f'/api/publishing/connections/{provider}/target', json={'target_id': target}).status_code == 200
    item = published_video(client, tmp_path, monkeypatch)
    if provider == 'instagram':
        # The integration mock supplies the owned R2 source; no signed URL is fetched.
        media = db_session().get(publishing.CreatorMedia, item['media_id'])
        monkeypatch.setattr(publishing, 'original_bytes', lambda *args: bytes(media.size))
        monkeypatch.setattr(publishing, 'storage', lambda: SimpleNamespace(read_url=lambda *args: 'https://media.ziipa.test/owned.mp4?signature=test-private-signature'))
    body = publication(item, provider=provider, privacy='public')
    sent = client.post('/api/publishing/publish', json=body)
    assert sent.status_code == 200 and sent.json()['status'] == 'processing'
    if provider == 'instagram':
        assert not sent.json()['external_id']  # Pending container still has no public media ID.
    checked = client.post(f"/api/publishing/jobs/{sent.json()['id']}/refresh")
    assert checked.status_code == 200 and checked.json()['status'] == 'delivered'
    assert checked.json()['external_id'] == ('789' if provider == 'facebook' else '666')
    assert client.post('/api/publishing/publish', json=body).json()['id'] == sent.json()['id']
    assert client.post(f"/api/publishing/jobs/{sent.json()['id']}/refresh").json()['status'] == 'delivered'
    assert len([r for r in calls if r.url.path.endswith('/media_publish')]) == (1 if provider == 'instagram' else 0)
    assert 'test-meta-private' not in client.get('/api/publishing/connections').text
    assert 'signature' not in json.dumps(db_session().query(publishing.PublishingJob).one().provider_data)
    assert 'provider_data' not in checked.json()
    assert client.post(f'/api/publishing/connections/{provider}/disconnect').json()['provider_revoked'] is True
