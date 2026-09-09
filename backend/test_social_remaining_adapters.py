"""New providers: all account, write, stream-key and SDK calls are mocked."""
import asyncio
import base64
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
import uuid

import httpx
import pytest
from Crypto.PublicKey import ECC

from test_api import register_creator
from test_social_publishing import client, isolated_publishing, db_session, published_video, publication, API_ORIGIN
import social_publishing as publishing
import bluesky_publishing_adapter as bluesky
import twitch_publishing_adapter as twitch
import render_services as render

DID = 'did:plc:' + 'a' * 24
CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'


def ephemeral_jwk():
    key = ECC.generate(curve='P-256')
    encode = lambda value: base64.urlsafe_b64encode(int(value).to_bytes(32, 'big')).rstrip(b'=').decode()
    return {'kty': 'EC', 'crv': 'P-256', 'kid': 'test-only', 'x': encode(key.pointQ.x), 'y': encode(key.pointQ.y), 'd': encode(key.d)}


def connect_twitch(client, monkeypatch, handler_extra=None):
    monkeypatch.setattr(publishing.config, 'twitch_client_id', 'twitch-test-app')
    monkeypatch.setattr(publishing.config, 'twitch_client_secret', 'twitch-private-secret')
    calls, settings = [], {'title': 'My live channel', 'game_id': '1234', 'broadcaster_language': 'en'}
    def handler(request):
        calls.append(request)
        url = str(request.url).split('?')[0]
        assert url in twitch.URLS
        if handler_extra:
            result = handler_extra(request)
            if result:
                return result
        if url == twitch.TOKEN_URL:
            return httpx.Response(200, json={'access_token': 'TWITCH_TEST_ACCESS', 'refresh_token': 'TWITCH_TEST_REFRESH', 'expires_in': 3600})
        if url == twitch.VALIDATE_URL:
            return httpx.Response(200, json={'client_id': 'twitch-test-app', 'user_id': '123', 'scopes': sorted(twitch.SCOPES), 'expires_in': 3600})
        if url == twitch.USERS_URL:
            return httpx.Response(200, json={'data': [{'id': '123', 'login': 'ziipa_test', 'display_name': 'Ziipa Test'}]})
        if url == twitch.CHANNELS_URL:
            assert request.url.params['broadcaster_id'] == '123'
            if request.method == 'PATCH':
                settings.update(json.loads(request.content))
                return httpx.Response(204)
            return httpx.Response(200, json={'data': [{'broadcaster_id': '123', 'game_name': 'Creative', **settings}]})
        if url == twitch.STREAMS_URL:
            return httpx.Response(200, json={'data': []})
        if url == twitch.KEY_URL:
            assert request.url.params['broadcaster_id'] == '123'
            return httpx.Response(200, json={'data': [{'stream_key': 'live_123_TEST_SECRET_KEY'}]})
        if url == twitch.FOLLOWS_URL:
            assert request.url.params['user_id'] == '123' and request.url.params['first'] == '50'
            return httpx.Response(200, json={'data': [{'broadcaster_id': '456', 'broadcaster_login': 'followed_channel', 'broadcaster_name': 'Followed channel'}]})
        if url == twitch.REVOKE_URL:
            return httpx.Response(200, json={})
        raise AssertionError('Unexpected Twitch operation')
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False))
    start = client.post('/api/publishing/oauth/twitch/start').json()['auth_url']
    redirect = client.get(start, follow_redirects=False)
    query = parse_qs(urlsplit(redirect.headers['location']).query)
    assert set(query['scope'][0].split()) == twitch.SCOPES
    callback = client.get(API_ORIGIN + '/api/publishing/oauth/twitch/callback', params={'state': query['state'][0], 'code': 'test-code'})
    assert callback.status_code == 200
    return calls


def test_twitch_real_channel_controls_require_verified_target_consent_and_secret_handoff(client, monkeypatch, tmp_path):
    register_creator(client)
    calls = connect_twitch(client, monkeypatch)
    assert client.get('/api/publishing/connections/twitch/channel').status_code == 409
    assert client.post('/api/publishing/connections/twitch/target', json={'target_id': '999'}).status_code == 422
    assert client.post('/api/publishing/connections/twitch/target', json={'target_id': '123'}).status_code == 200
    status = client.get('/api/publishing/connections/twitch/channel').json()
    assert status['is_live'] is False and status['channel_url'] == 'https://www.twitch.tv/ziipa_test'
    assert client.post('/api/publishing/connections/twitch/channel-settings', json={'title': 'New title', 'consent': False}).status_code == 422
    assert client.post('/api/publishing/connections/twitch/channel-settings', json={'expected_target_id': '999', 'title': 'Wrong destination', 'consent': True}).status_code == 409
    updated = client.post('/api/publishing/connections/twitch/channel-settings', json={'expected_target_id': '123', 'title': 'Approved title', 'game_id': '987', 'language': 'en', 'consent': True})
    assert updated.status_code == 200 and updated.json()['settings_confirmed']
    assert client.post('/api/publishing/connections/twitch/ingest', json={'consent': False}).status_code == 422
    ingest = client.post('/api/publishing/connections/twitch/ingest', json={'consent': True})
    assert ingest.status_code == 200 and 'no-store' in ingest.headers['cache-control']
    assert ingest.json()['server_url'] == 'rtmps://ingest.global-contribute.live-video.net/app/'
    assert ingest.json()['stream_key'] == 'live_123_TEST_SECRET_KEY'
    people = client.post('/api/publishing/connections/twitch/follows').json()['people']
    assert people[0]['id'] == '456'
    overview = client.get('/api/publishing/connections').text
    assert 'TEST_SECRET_KEY' not in overview and 'TWITCH_TEST_ACCESS' not in overview
    item = published_video(client, tmp_path, monkeypatch)
    assert client.post('/api/publishing/publish', json=publication(item, provider='twitch')).status_code == 409
    assert len([r for r in calls if r.method == 'PATCH']) == 1
    client.post('/api/auth/logout')
    register_creator(client, 'other-twitch@example.com')
    assert client.post('/api/publishing/connections/twitch/ingest', json={'consent': True}).status_code == 409


def test_twitch_disconnect_and_reauthorization_detach_relay_first(client, monkeypatch):
    import live_api
    events = []
    async def detach(owner, session):
        assert db_session().query(publishing.PublishingGrant).filter_by(provider='twitch').one().token_cipher
        events.append('detach')
    monkeypatch.setattr(live_api, 'detach_twitch_destinations', detach)
    register_creator(client)
    connect_twitch(client, monkeypatch)
    connect_twitch(client, monkeypatch)
    assert events == ['detach']
    response = client.post('/api/publishing/connections/twitch/disconnect')
    assert response.status_code == 200 and response.json()['provider_revoked'] is True
    assert events == ['detach', 'detach']
    assert client.get('/api/publishing/connections').json()['connections'] == []


def test_twitch_mismatched_client_broadcaster_scopes_never_returns_ingest():
    async def scenario(proof):
        called = []
        def handler(request):
            called.append(str(request.url))
            return httpx.Response(200, json=proof)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(twitch.TwitchError):
                await twitch.ingest({'access_token': 'TEST'}, '123', client, SimpleNamespace(twitch_client_id='app'))
        assert called == [twitch.VALIDATE_URL]
    for proof in ({'client_id': 'evil', 'user_id': '123', 'scopes': sorted(twitch.SCOPES), 'expires_in': 3600},
                  {'client_id': 'app', 'user_id': '999', 'scopes': sorted(twitch.SCOPES), 'expires_in': 3600},
                  {'client_id': 'app', 'user_id': '123', 'scopes': [], 'expires_in': 3600}):
        asyncio.run(scenario(proof))


def configure_bluesky(monkeypatch):
    monkeypatch.setattr(publishing.config, 'bluesky_enabled', True)
    monkeypatch.setattr(publishing.config, 'bluesky_private_jwk', json.dumps(ephemeral_jwk()))
    monkeypatch.setattr(bluesky, 'validate_settings', lambda cfg: None)


def fake_sdk_session(token='TEST_BSKY_ACCESS'):
    return {'tokenSet': {'access_token': token, 'refresh_token': 'TEST_BSKY_REFRESH', 'sub': DID, 'scope': bluesky.SCOPE,
                        'token_type': 'DPoP', 'iss': 'https://bsky.social', 'aud': 'https://pds.host.bsky.network'},
            'dpopJwk': {'d': 'TEST_PRIVATE_DPOP'}, 'authMethod': {'method': 'private_key_jwt'}}


def test_bluesky_encrypted_sdk_state_public_consent_durable_post_and_status(client, monkeypatch, tmp_path):
    configure_bluesky(monkeypatch)
    operations = []
    async def bridge(settings, origin, operation, **data):
        operations.append(operation)
        sessions = {DID: fake_sdk_session('TEST_BSKY_ROTATED' if operation in ('upload', 'create', 'status') else 'TEST_BSKY_ACCESS')}
        if operation == 'authorize':
            assert data['handle'] == 'creator.bsky.social'
            return {'ok': True, 'result': {'auth_url': 'https://bsky.social/oauth/authorize?request_uri=test', 'state': 's' * 40},
                    'states': {'s' * 40: {'dpopJwk': {'d': 'TEST_PRIVATE_DPOP'}, 'appState': data['app_state']}}, 'sessions': {}}
        if operation == 'callback':
            assert data['states']['s' * 40]['appState'] == data['app_state']
            return {'ok': True, 'result': {'did': DID, 'targets': [{'id': DID, 'name': 'My Bluesky', 'kind': 'bluesky_account', 'url': 'https://bsky.app/profile/' + DID}]}, 'sessions': sessions}
        if operation == 'upload':
            assert db_session().query(publishing.PublishingJob).one().provider_data['stage'] == 'upload_started'
            return {'ok': True, 'result': {'did': DID, 'blob': {'$type': 'blob', 'ref': {'$link': CID}, 'mimeType': 'video/mp4', 'size': len(base64.b64decode(data['media_base64']))}}, 'sessions': sessions}
        if operation == 'create':
            job = db_session().query(publishing.PublishingJob).one()
            assert job.provider_data['stage'] == 'create_started'
            assert publishing.decrypt_tokens(db_session().query(publishing.PublishingGrant).one())['access_token'] == 'TEST_BSKY_ROTATED'
            assert data['rkey'] == job.id.replace('-', '')
            return {'ok': True, 'result': {'uri': f"at://{DID}/app.bsky.feed.post/{data['rkey']}", 'cid': CID}, 'sessions': sessions}
        if operation == 'status':
            return {'ok': True, 'result': {'uri': f"at://{DID}/app.bsky.feed.post/{data['rkey']}", 'cid': CID, 'video_ready': True}, 'sessions': sessions}
        raise AssertionError('Unexpected SDK bridge call')
    monkeypatch.setattr(bluesky, 'run_bridge', bridge)
    register_creator(client)
    assert client.post('/api/publishing/oauth/bluesky/start', json={'handle': 'https://localhost'}).status_code == 422
    start = client.post('/api/publishing/oauth/bluesky/start', json={'handle': '@creator.bsky.social'}).json()['auth_url']
    assert client.get(start, follow_redirects=False).status_code == 302
    from app import cache
    saved = json.loads(cache.get(publishing.state_key('callback', 's' * 40)))
    assert 'TEST_PRIVATE_DPOP' not in json.dumps(saved)
    callback = client.get(API_ORIGIN + '/api/publishing/oauth/bluesky/callback', params={'state': 's' * 40, 'code': 'TEST_CODE', 'iss': 'https://bsky.social'})
    assert callback.status_code == 200
    assert client.post('/api/publishing/connections/bluesky/target', json={'target_id': DID}).status_code == 200
    item = published_video(client, tmp_path, monkeypatch)
    assert client.post('/api/publishing/publish', json=publication(item, provider='bluesky')).status_code == 422
    body = publication(item, provider='bluesky', privacy='public')
    posted = client.post('/api/publishing/publish', json=body)
    assert posted.status_code == 200 and posted.json()['status'] == 'processing'
    checked = client.post(f"/api/publishing/jobs/{posted.json()['id']}/refresh")
    assert checked.status_code == 200 and checked.json()['status'] == 'delivered'
    assert client.post('/api/publishing/publish', json=body).json()['id'] == posted.json()['id']
    assert operations.count('create') == 1
    assert 'TEST_PRIVATE_DPOP' not in client.get('/api/publishing/connections').text
    assert 'TEST_BSKY' not in client.get('/api/publishing/connections').text
    assert 'TEST_PRIVATE_DPOP' not in json.dumps(db_session().query(publishing.PublishingJob).one().provider_data)


def test_real_stdio_sdk_metadata_process_has_no_network_and_no_private_key_output(monkeypatch):
    # This runs the installed official SDK, but metadata creation has no HTTP.
    settings = SimpleNamespace(bluesky_enabled=True, bluesky_private_jwk=json.dumps(ephemeral_jwk()),
                               bluesky_node_binary='node', bluesky_extra_origins='')
    monkeypatch.setenv('DATABASE_URL', 'TEST_UNRELATED_DATABASE_SECRET')
    monkeypatch.setenv('R2_SECRET_ACCESS_KEY', 'TEST_UNRELATED_R2_SECRET')
    monkeypatch.setenv('LIVEPEER_API_KEY', 'TEST_UNRELATED_LIVE_SECRET')
    monkeypatch.setenv('NODE_OPTIONS', '--require=unexpected-module')
    spawn = asyncio.create_subprocess_exec
    async def inspected_spawn(*args, **kwargs):
        assert args[1] == '--max-old-space-size=256'
        assert all(key.upper() in bluesky.BRIDGE_ENV_KEYS for key in kwargs['env'])
        assert not any('TEST_UNRELATED' in value for value in kwargs['env'].values())
        assert settings.bluesky_private_jwk not in str(args)
        return await spawn(*args, **kwargs)
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', inspected_spawn)
    result = asyncio.run(bluesky.run_bridge(settings, API_ORIGIN, 'metadata'))
    assert result['ok'] is True
    assert result['result']['metadata']['scope'] == bluesky.SCOPE
    assert 'd' not in result['result']['jwks']['keys'][0]
    assert json.loads(settings.bluesky_private_jwk)['d'] not in json.dumps(result)


@pytest.mark.parametrize('failure', ['overflow', 'cancellation'])
def test_stdio_failure_kills_and_reaps_child_without_collecting_unbounded_data(monkeypatch, failure):
    class Input:
        def write(self, _data): pass
        async def drain(self): pass
        def close(self): pass
    class Output:
        reads = 0
        async def read(self, size):
            self.reads += 1
            if failure == 'cancellation':
                await asyncio.Event().wait()
            return b'x' * size
    class Process:
        stdin, stdout = Input(), Output()
        returncode = None
        killed, waited = False, False
        def kill(self):
            self.killed = True
            self.returncode = -9
        async def wait(self):
            self.waited = True
            return self.returncode
    child = Process()
    async def spawn(*_args, **_kwargs): return child
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr(bluesky, 'validate_settings', lambda _settings: None)
    settings = SimpleNamespace(bluesky_private_jwk='{}', bluesky_node_binary='node', bluesky_extra_origins='')
    async def scenario():
        async with asyncio.timeout(0.05):
            await bluesky.run_bridge(settings, API_ORIGIN, 'create')
    with pytest.raises(bluesky.BlueskyError if failure == 'overflow' else TimeoutError):
        asyncio.run(scenario())
    assert child.killed and child.waited
    assert child.stdout.reads == (bluesky.BRIDGE_STDOUT_LIMIT // (64 * 1024) + 1 if failure == 'overflow' else 1)


def test_bluesky_readiness_rejects_invalid_or_mismatched_client_keys():
    key = ephemeral_jwk()
    settings = SimpleNamespace(bluesky_enabled=True, bluesky_private_jwk=json.dumps(key),
                               bluesky_node_binary='node', bluesky_extra_origins='')
    bluesky.validate_settings(settings)
    for replacement in ({**key, 'd': 'not-base64'}, {**key, 'x': ephemeral_jwk()['x']}, {**key, 'kid': '<script>'}):
        settings.bluesky_private_jwk = json.dumps(replacement)
        with pytest.raises(bluesky.BlueskyError):
            bluesky.validate_settings(settings)


@pytest.mark.parametrize('change', ['target', 'media', 'media_during_read', 'private_during_read', 'missing_expected'])
def test_publication_consent_is_bound_to_displayed_target_and_source(client, monkeypatch, tmp_path, change):
    from test_social_publishing import authorized_channel
    register_creator(client)
    calls, _ = authorized_channel(client, monkeypatch)
    item = published_video(client, tmp_path, monkeypatch)
    body = publication(item)
    session = db_session()
    if change == 'target':
        grant = session.query(publishing.PublishingGrant).one()
        grant.selected_target_id = 'UC' + 'b' * 22
        session.commit()
    elif change == 'media':
        source = session.get(publishing.CreatorItem, item['id'])
        source.data = {**source.data, 'media_id': str(uuid.uuid4())}
        session.commit()
    elif change == 'missing_expected':
        del body['expected_target_id']
    else:
        reader = publishing.original_bytes
        def change_after_read(media, owner):
            result = reader(media, owner)
            source = session.get(publishing.CreatorItem, item['id'])
            if change == 'private_during_read':
                source.visibility = 'private'
            else:
                source.data = {**source.data, 'media_id': str(uuid.uuid4())}
            session.commit()
            return result
        monkeypatch.setattr(publishing, 'original_bytes', change_after_read)
    response = client.post('/api/publishing/publish', json=body)
    if change.endswith('_during_read'):
        assert response.status_code == 200 and response.json()['status'] == 'failed'
    else:
        assert response.status_code == (422 if change == 'missing_expected' else 409)
        assert session.query(publishing.PublishingJob).count() == 0
    assert not any(str(call.url).startswith(publishing.UPLOAD_URL) for call in calls)


def test_confirmed_instagram_checkpoint_survives_optional_lookup_deadline(client, monkeypatch, tmp_path):
    from test_social_publishing import authorized_channel
    register_creator(client)
    authorized_channel(client, monkeypatch)
    session = db_session()
    grant = session.query(publishing.PublishingGrant).one()
    grant.provider = 'instagram'
    tokens = {'provider': 'instagram', 'access_token': 'TEST_META', 'expires_at': 9999999999}
    grant.token_cipher = publishing.encrypt_tokens(grant.owner_id, 'instagram', tokens)
    grant.selected_target_id = '123'
    job = publishing.PublishingJob(owner_id=grant.owner_id, provider='instagram', item_id=str(uuid.uuid4()),
        idempotency_key=str(uuid.uuid4()), source_hash='b' * 64, target_id='123', privacy='public', status='processing',
        provider_data={'provider': 'instagram', 'target_id': '123', 'phase': 'container_created', 'container_id': '456'})
    session.add(job); session.commit()
    monkeypatch.setattr(publishing.config, 'meta_public_approved', True)
    async def poll(tokens, target, data, client, settings, checkpoint):
        await checkpoint({'provider': 'instagram', 'target_id': target, 'phase': 'delivered', 'container_id': '456', 'media_id': '789'})
        raise TimeoutError('Optional permalink lookup deadline')
    monkeypatch.setattr(publishing.meta_adapter(), 'poll', poll)
    response = client.post(f'/api/publishing/jobs/{job.id}/refresh')
    assert response.status_code == 200 and response.json()['status'] == 'delivered' and response.json()['external_id'] == '789'


@pytest.mark.parametrize('change', ['none', 'stale_before', 'stale_during', 'wrong_item'])
def test_rendered_publication_sends_selected_output_and_rejects_stale_or_wrong_item(client, monkeypatch, tmp_path, change):
    from test_social_publishing import authorized_channel
    register_creator(client)
    requests, _ = authorized_channel(client, monkeypatch)
    item = published_video(client, tmp_path, monkeypatch)
    content = b'\x00\x00\x00\x20ftypisom' + b'RENDERED_PIXELS_AND_AUDIO' + bytes(150)
    output = client.post('/api/creator/media', content=content, headers={'Content-Type': 'video/mp4'}).json()
    session = db_session()
    row = session.get(publishing.CreatorItem, item['id'])
    job = render.RenderJob(owner_id=row.owner_id, item_id=row.id, input_fingerprint=render.input_fingerprint(session, row),
                           snapshot=render.input_snapshot(session, row), status='ready', output_media_id=output['id'])
    session.add(job); session.commit()
    if change == 'stale_before':
        row.data = {**row.data, 'trim_start': 1}
        session.commit()
    elif change == 'wrong_item':
        job.item_id = str(uuid.uuid4())
        session.commit()
    elif change == 'stale_during':
        reader = publishing.original_bytes
        def update_after_read(*args):
            data = reader(*args)
            row.data = {**row.data, 'trim_start': 1}
            session.commit()
            return data
        monkeypatch.setattr(publishing, 'original_bytes', update_after_read)
    response = client.post('/api/publishing/publish', json=publication(item, render_id=job.id, original_media_acknowledged=False))
    uploads = [r for r in requests if str(r.url).startswith(publishing.UPLOAD_URL)]
    if change == 'none':
        assert response.status_code == 200 and response.json()['status'] == 'processing'
        assert len(uploads) == 1 and b'RENDERED_PIXELS_AND_AUDIO' in uploads[0].content
    else:
        assert response.status_code in (404, 409) or response.status_code == 200 and response.json()['status'] == 'failed'
        assert uploads == []
