"""Real local account/Redis semantics; provider traffic is entirely mocked."""
import asyncio
import base64
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
import uuid

import httpx
import pytest
from sqlalchemy import select

import app as core
from creator import CreatorConnection
import social_api as social
import social_read_adapters as adapters
import social_read_imports as imports
from test_api import client, register_creator


@pytest.fixture
def configured(client, monkeypatch):
    client.base_url = httpx.URL('https://api.ziipa.com')
    monkeypatch.setattr(core, 'TRUSTED_ORIGINS', frozenset((*core.TRUSTED_ORIGINS, 'https://ziipa.com', 'https://api.ziipa.com')))
    monkeypatch.setattr(core.settings, 'public_app_url', 'https://ziipa.com')
    for provider in ('facebook', 'instagram', 'tiktok'):
        for field in ('enabled', 'approved'):
            monkeypatch.setattr(core.settings, f'social_{provider}_imports_{field}', True)
    monkeypatch.setattr(imports.vault.config, 'encryption_key', base64.urlsafe_b64encode(bytes(range(32))).decode())
    monkeypatch.setattr(imports.vault.config, 'api_origin', 'https://api.ziipa.com')
    monkeypatch.setattr(imports.vault.config, 'approved_origins', 'https://api.ziipa.com,https://ziipa.com')
    for field in ('meta_client_id', 'meta_client_secret', 'tiktok_client_key', 'tiktok_client_secret'):
        monkeypatch.setattr(imports.vault.config, field, 'synthetic-not-a-provider-secret')
    monkeypatch.setattr(imports.vault.config, 'meta_graph_version', 'v25.0')
    register_creator(client)
    return client


def session():
    return next(core.app.dependency_overrides[core.db]())


def connection(provider):
    return session().scalar(select(CreatorConnection).where(CreatorConnection.provider == provider))


def install(monkeypatch, *, provider='tiktok', videos=None, hook=None):
    calls = []
    def respond(request):
        calls.append(request)
        assert request.url.host in ('open.tiktokapis.com', 'graph.facebook.com')
        assert 'cookie' not in request.headers
        if hook:
            changed = hook(request)
            if changed is not None:
                return changed
        path = request.url.path
        if path == '/v2/oauth/token/':
            return httpx.Response(200, json={'access_token': 'PRIVATE_ACCESS', 'refresh_token': 'PRIVATE_REFRESH',
                'open_id': 'account-subject', 'scope': 'user.info.basic,video.list', 'expires_in': 86400, 'refresh_expires_in': 31536000})
        if path == '/v2/user/info/':
            return httpx.Response(200, json={'data': {'user': {'open_id': 'account-subject', 'display_name': 'Provider profile label'}}})
        if path == '/v2/video/list/':
            rows = videos if videos is not None else [{'id': '123456789', 'title': 'PUBLIC_VIDEO', 'video_description': 'Public script',
                'share_url': 'https://www.tiktok.com/@verified/video/123456789?utm_source=provider',
                'cover_image_url': 'https://p16-sign.tiktokcdn.com/cover.jpg?x-expires=123&x-signature=public-image-signature', 'create_time': 1700000000}]
            return httpx.Response(200, json={'data': {'videos': rows}, 'error': {'code': 'ok'}})
        if path.endswith('/oauth/access_token'):
            return httpx.Response(200, json={'access_token': 'PRIVATE_META', 'expires_in': 86400})
        if path.endswith('/me/permissions'):
            return httpx.Response(200, json={'data': [{'permission': value, 'status': 'granted'} for value in adapters.scopes(provider)]})
        if path.endswith('/me'):
            return httpx.Response(200, json={'id': '111'})
        if path.endswith('/me/accounts'):
            return httpx.Response(200, json={'data': [{'id': '222', 'name': 'Provider Page label', 'access_token': 'PRIVATE_PAGE',
                'is_published': True, 'tasks': ['ANALYZE'], 'instagram_business_account': {'id': '333', 'username': 'professional'}}]})
        if path.endswith('/222/posts'):
            return httpx.Response(200, json={'data': videos if videos is not None else [{'id': '222_444', 'message': 'PUBLIC_VIDEO',
                'from': {'id': '222'}, 'is_published': True, 'is_hidden': False, 'is_expired': False, 'privacy': {'value': 'EVERYONE'}}]})
        if path.endswith('/333/media'):
            return httpx.Response(200, json={'data': videos if videos is not None else [{'id': '444', 'caption': 'PUBLIC_VIDEO',
                'media_type': 'VIDEO', 'permalink': 'https://www.instagram.com/reel/Abc_123/'}]})
        raise AssertionError('Unexpected fixed provider endpoint')
    monkeypatch.setattr(imports.vault, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond),
        headers={'Authorization': 'Bearer WRONG_ACCOUNT'}, cookies={'other-account': 'must-not-leave'}))
    return calls


def authorize(client, provider):
    start = client.post(f'/api/social/{provider}/connect')
    assert start.status_code == 200 and start.json()['status'] == 'authorization_required'
    url = start.json()['auth_url']
    assert url.startswith(f'https://api.ziipa.com/api/social/oauth/{provider}/authorize?ticket=')
    redirect = client.get(url, follow_redirects=False)
    assert redirect.status_code == 302
    query = parse_qs(urlsplit(redirect.headers['location']).query)
    assert set(query['scope'][0].split(',')) == adapters.scopes(provider)
    assert 'video.publish' not in query['scope'][0] and 'pages_manage_posts' not in query['scope'][0]
    callback = client.get(f'/api/social/oauth/{provider}/callback', params={'state': query['state'][0], 'code': 'one-use-code'})
    assert callback.status_code == 200
    return query['state'][0]


@pytest.mark.parametrize('provider,target_id', [('tiktok', 'account-subject'), ('facebook', '222'), ('instagram', '333')])
def test_read_only_authorization_explicit_selection_import_and_no_database_metadata(configured, monkeypatch, provider, target_id):
    client = configured
    calls = install(monkeypatch, provider=provider)
    state = authorize(client, provider)
    assert client.get(f'/api/social/oauth/{provider}/callback', params={'state': state, 'code': 'replay'}).status_code == 400
    account = next(row for row in client.get('/api/social/hub').json()['providers'] if row['provider'] == provider)
    original_expiry = imports.read_metadata(connection(provider))['expires_at']
    assert account['auth_type'] == 'oauth' and account['status'] == 'connected' and not account['can_sync'] and not account['can_publish']
    assert client.post(f'/api/social/{provider}/sync').status_code == 409
    assert client.post(f'/api/social/{provider}/import-target', json={'target_id': 'foreign-target', 'revision': account['revision']}).status_code == 422
    selected = client.post(f'/api/social/{provider}/import-target', json={'target_id': target_id, 'revision': account['revision']})
    assert selected.status_code == 200 and selected.json()['revision'] != account['revision']
    assert imports.read_metadata(connection(provider))['expires_at'] <= original_expiry
    assert client.post(f'/api/social/{provider}/import-target', json={'target_id': target_id, 'revision': account['revision']}).status_code == 409
    result = client.post(f'/api/social/{provider}/sync')
    assert result.status_code == 200 and result.json()['media'][0]['title'] == 'PUBLIC_VIDEO'
    row = connection(provider)
    assert 'PUBLIC_VIDEO' not in json.dumps(row.data) and 'Provider profile label' not in json.dumps(row.data)
    assert 'Provider Page label' not in json.dumps(row.data) and 'snapshot' not in row.data and 'import_targets' not in row.data
    raw_metadata = imports.read_metadata(row)
    assert raw_metadata['snapshot']['media'][0]['title'] == 'PUBLIC_VIDEO'
    assert 0 < core.cache.ttl(imports.metadata_key(row)) <= (21600 if provider == 'tiktok' else 86400)
    exported = client.get('/api/account/export')
    assert exported.status_code == 200 and 'read_cipher' not in exported.text
    assert all(value not in exported.text for value in ('PRIVATE_ACCESS', 'PRIVATE_REFRESH', 'PRIVATE_META', 'PRIVATE_PAGE'))
    assert calls and all(request.headers.get('authorization') != 'Bearer WRONG_ACCOUNT' for request in calls)
    core.cache.delete(imports.metadata_key(row))
    assert client.get('/api/social/hub').json()['media'] == []


def test_disabled_or_unapproved_read_flow_has_no_authorization_url(configured, monkeypatch):
    monkeypatch.setattr(core.settings, 'social_tiktok_imports_approved', False)
    result = configured.post('/api/social/tiktok/connect').json()
    assert result['status'] == 'setup_required' and result['auth_url'] is None


def test_native_handoff_and_browser_origin_are_explicit(configured):
    token = configured.post('/api/mobile/auth/login', json={'email': 'creator@example.com', 'password': 'creator-test-pass-123'}).json()['access_token']
    native = configured.post('/api/social/tiktok/connect', headers={'Authorization': 'Bearer ' + token}).json()
    assert native['status'] == 'browser_sign_in_required' and native['auth_url'] is None
    assert native['connect_via_portal'] == 'https://ziipa.com/portal'
    mismatch = configured.post('/api/social/tiktok/connect', headers={'Origin': 'https://ziipa.com'})
    assert mismatch.status_code == 409


def test_cipher_is_bound_to_read_purpose_owner_and_provider(configured):
    cipher = imports.encrypt(1, 'tiktok', {'access_token': 'synthetic'})
    row = SimpleNamespace(owner_id=1, provider='tiktok', data={'read_cipher': cipher})
    assert imports.decrypt(row) == {'access_token': 'synthetic'}
    for owner, provider in ((2, 'tiktok'), (1, 'facebook')):
        with pytest.raises(core.HTTPException):
            imports.decrypt(SimpleNamespace(owner_id=owner, provider=provider, data={'read_cipher': cipher}))
    with pytest.raises(core.HTTPException):
        imports.vault.decrypt_tokens(SimpleNamespace(owner_id=1, provider='tiktok', token_cipher=cipher))


def test_link_change_during_callback_does_not_restore_authorization(configured, monkeypatch):
    def interrupt(request):
        if request.url.path == '/v2/user/info/':
            row = connection('tiktok')
            row.data = {**row.data, 'revision': str(uuid.uuid4())}
            session().commit()
    install(monkeypatch, hook=interrupt)
    configured.post('/api/social/tiktok/link', json={'handle': 'original'})
    start = configured.post('/api/social/tiktok/connect').json()
    redirect = configured.get(start['auth_url'], follow_redirects=False)
    state = parse_qs(urlsplit(redirect.headers['location']).query)['state'][0]
    result = configured.get('/api/social/oauth/tiktok/callback', params={'state': state, 'code': 'code'})
    assert result.status_code == 409 and connection('tiktok').data['auth_type'] == 'public_profile'


def test_first_authorization_disconnect_during_exchange_prevents_late_callback(configured, monkeypatch):
    owner_id = configured.get('/api/me').json()['id']
    def interrupt(request):
        if request.url.path == '/v2/user/info/':
            assert connection('tiktok') is None
            owner = session().get(core.User, owner_id)
            social.disconnect_for('tiktok', owner, session())
    install(monkeypatch, hook=interrupt)
    start = configured.post('/api/social/tiktok/connect').json()
    redirect = configured.get(start['auth_url'], follow_redirects=False)
    state = parse_qs(urlsplit(redirect.headers['location']).query)['state'][0]
    result = configured.get('/api/social/oauth/tiktok/callback', params={'state': state, 'code': 'code'})
    assert result.status_code == 409
    row = connection('tiktok')
    assert row.data['auth_type'] == 'none' and 'read_cipher' not in row.data
    assert imports.read_metadata(row) == {}


def test_failed_provider_read_tombstones_old_snapshot_and_rotates_revision(configured, monkeypatch):
    install(monkeypatch)
    authorize(configured, 'tiktok')
    account = next(row for row in configured.get('/api/social/hub').json()['providers'] if row['provider'] == 'tiktok')
    configured.post('/api/social/tiktok/import-target', json={'target_id': 'account-subject', 'revision': account['revision']})
    assert configured.post('/api/social/tiktok/sync').json()['media']
    row = connection('tiktok')
    old_revision = row.data['revision']
    old_key = imports.metadata_key(row)
    for key in core.cache.scan_iter('social_sync:*'):
        core.cache.delete(key)
    install(monkeypatch, hook=lambda request: httpx.Response(403, json={'access_token': 'NEVER_SHOW_PROVIDER_BODY'}))
    failed = configured.post('/api/social/tiktok/sync')
    assert failed.status_code == 200 and failed.json()['media'] == []
    assert 'NEVER_SHOW_PROVIDER_BODY' not in failed.text
    assert connection('tiktok').data['revision'] != old_revision and core.cache.get(old_key) is None


def test_cache_miss_error_and_expiry_never_fall_back_to_postgres(configured, monkeypatch):
    install(monkeypatch)
    authorize(configured, 'tiktok')
    row = connection('tiktok')
    row.data = {**row.data, 'selected_import_target_id': 'account-subject', 'snapshot': {'media': [{'title': 'PRIVATE_LEGACY'}]}}
    session().commit()
    core.cache.delete(imports.metadata_key(row))
    assert 'PRIVATE_LEGACY' not in configured.get('/api/social/hub').text
    core.cache.set(imports.metadata_key(row), json.dumps({'expires_at': 1, 'snapshot': {'media': [{'title': 'EXPIRED'}]}}), ex=30)
    assert 'EXPIRED' not in configured.get('/api/social/hub').text


def test_facebook_import_excludes_unknown_private_unpublished_hidden_foreign_posts(configured, monkeypatch):
    public = {'id': '222_444', 'message': 'PUBLIC', 'from': {'id': '222'}, 'is_published': True,
              'is_hidden': False, 'is_expired': False, 'privacy': {'value': 'EVERYONE'}}
    rows = [public, {**public, 'id': '222_445', 'privacy': {'value': 'SELF'}, 'message': 'PRIVATE'},
            {**public, 'id': '222_446', 'is_published': False, 'message': 'DRAFT'},
            {**public, 'id': '222_447', 'is_hidden': True, 'message': 'HIDDEN'},
            {**public, 'id': '222_448', 'from': {'id': '999'}, 'message': 'FOREIGN'},
            {key: value for key, value in {**public, 'id': '222_449', 'message': 'UNKNOWN'}.items() if key != 'privacy'}]
    install(monkeypatch, provider='facebook', videos=rows)
    authorize(configured, 'facebook')
    account = next(row for row in configured.get('/api/social/hub').json()['providers'] if row['provider'] == 'facebook')
    configured.post('/api/social/facebook/import-target', json={'target_id': '222', 'revision': account['revision']})
    hub = configured.post('/api/social/facebook/sync').json()
    assert [(row['title'], row['url']) for row in hub['media']] == [('PUBLIC', 'https://www.facebook.com/222/posts/444')]


@pytest.mark.parametrize('provider,rows', [('tiktok', [{'id': '123', 'title': 'MISMATCH', 'share_url': 'https://www.tiktok.com/@wrong/video/456'},
    {'id': '123', 'title': 'HOSTILE', 'share_url': 'https://www.tiktok.com.attacker.test/@wrong/video/123'}]),
    ('instagram', [{'id': '444', 'caption': 'HOSTILE', 'media_type': 'VIDEO', 'permalink': 'https://instagram.com.attacker.test/reel/abc/'},
     {'id': '445', 'caption': 'UNKNOWN', 'media_type': 'STORY', 'permalink': 'https://www.instagram.com/reel/abc/'}])])
def test_only_provider_attested_canonical_original_posts_are_imported(configured, monkeypatch, provider, rows):
    install(monkeypatch, provider=provider, videos=rows)
    authorize(configured, provider)
    account = next(row for row in configured.get('/api/social/hub').json()['providers'] if row['provider'] == provider)
    configured.post(f'/api/social/{provider}/import-target', json={'target_id': 'account-subject' if provider == 'tiktok' else '333', 'revision': account['revision']})
    assert configured.post(f'/api/social/{provider}/sync').json()['media'] == []


def test_disconnect_during_provider_read_does_not_recreate_grant_or_cache(configured, monkeypatch):
    install(monkeypatch)
    authorize(configured, 'tiktok')
    account = next(row for row in configured.get('/api/social/hub').json()['providers'] if row['provider'] == 'tiktok')
    configured.post('/api/social/tiktok/import-target', json={'target_id': 'account-subject', 'revision': account['revision']})
    def interrupt(request):
        if request.url.path == '/v2/video/list/':
            row = connection('tiktok')
            imports.clear_metadata(row)
            session().delete(row); session().commit()
    install(monkeypatch, hook=interrupt)
    result = configured.post('/api/social/tiktok/sync')
    assert result.status_code == 409 and connection('tiktok') is None
    assert configured.get('/api/social/hub').json()['media'] == []


def test_oauth_ticket_cannot_change_owner_or_be_replayed(configured):
    ticket = configured.post('/api/social/tiktok/connect').json()['auth_url']
    configured.cookies.clear()
    register_creator(configured, 'different-import-owner@example.com')
    assert configured.get(ticket, follow_redirects=False).status_code == 401
    assert configured.get(ticket, follow_redirects=False).status_code == 400


def test_maintenance_permits_only_narrow_import_disconnection(configured, monkeypatch):
    from admin_services import AdminSettings
    install(monkeypatch)
    authorize(configured, 'tiktok')
    row = connection('tiktok')
    key = imports.metadata_key(row)
    assert core.cache.get(key)
    session().add(AdminSettings(id=1, maintenance_mode=True)); session().commit()
    assert configured.post('/api/social/tiktok/connect').status_code == 503
    assert configured.post('/api/social/tiktok/sync').status_code == 503
    assert configured.post('/api/social/tiktok/disconnect').status_code == 200
    assert connection('tiktok').data['auth_type'] == 'none' and core.cache.get(key) is None


def test_cache_outage_during_sync_cannot_resurrect_old_metadata_after_recovery(configured, monkeypatch):
    from redis.exceptions import RedisError
    install(monkeypatch)
    authorize(configured, 'tiktok')
    account = next(row for row in configured.get('/api/social/hub').json()['providers'] if row['provider'] == 'tiktok')
    configured.post('/api/social/tiktok/import-target', json={'target_id': 'account-subject', 'revision': account['revision']})
    assert configured.post('/api/social/tiktok/sync').json()['media']
    old_key = imports.metadata_key(connection('tiktok'))
    for key in core.cache.scan_iter('social_sync:*'):
        core.cache.delete(key)
    original_set, original_delete = core.cache.set, core.cache.delete
    def failing_set(key, *args, **kwargs):
        if str(key).startswith('social_import_metadata:'):
            raise RedisError('private transport detail')
        return original_set(key, *args, **kwargs)
    def failing_delete(key, *args, **kwargs):
        if str(key).startswith('social_import_metadata:'):
            raise RedisError('private transport detail')
        return original_delete(key, *args, **kwargs)
    with monkeypatch.context() as scoped:
        scoped.setattr(core.cache, 'set', failing_set)
        scoped.setattr(core.cache, 'delete', failing_delete)
        result = configured.post('/api/social/tiktok/sync')
        assert result.status_code == 503 and 'private transport detail' not in result.text
    assert imports.metadata_key(connection('tiktok')) != old_key
    assert core.cache.get(old_key) is not None  # Hard TTL still bounds inaccessible bytes.
    assert configured.get('/api/social/hub').json()['media'] == []


def test_scope_denial_saves_no_read_grant(configured, monkeypatch):
    install(monkeypatch, hook=lambda request: httpx.Response(200, json={'access_token': 'DENIED_TOKEN',
        'open_id': 'account-subject', 'expires_in': 86400, 'scope': 'user.info.basic'}) if request.url.path == '/v2/oauth/token/' else None)
    start = configured.post('/api/social/tiktok/connect').json()
    redirect = configured.get(start['auth_url'], follow_redirects=False)
    state = parse_qs(urlsplit(redirect.headers['location']).query)['state'][0]
    response = configured.get('/api/social/oauth/tiktok/callback', params={'state': state, 'code': 'code'})
    assert response.status_code == 502 and 'DENIED_TOKEN' not in response.text
    assert connection('tiktok') is None


def test_instagram_image_still_is_allowed_but_video_source_is_never_a_thumbnail(configured, monkeypatch):
    install(monkeypatch, provider='instagram', videos=[{'id': '444', 'caption': 'Image', 'media_type': 'IMAGE',
        'permalink': 'https://www.instagram.com/p/image/', 'media_url': 'https://scontent.cdninstagram.com/image.jpg'},
        {'id': '445', 'caption': 'Video', 'media_type': 'VIDEO', 'permalink': 'https://www.instagram.com/reel/video/',
         'media_url': 'https://scontent.cdninstagram.com/never-download.mp4'}])
    authorize(configured, 'instagram')
    account = next(row for row in configured.get('/api/social/hub').json()['providers'] if row['provider'] == 'instagram')
    configured.post('/api/social/instagram/import-target', json={'target_id': '333', 'revision': account['revision']})
    media = configured.post('/api/social/instagram/sync').json()['media']
    assert media[0]['thumbnail_url'].endswith('/image.jpg') and media[1]['thumbnail_url'] is None
    assert all('never-download' not in str(row) for row in media)


@pytest.mark.parametrize('response', [httpx.Response(302, headers={'Location': 'https://attacker.test/steal'}),
    httpx.Response(200, content=b'x' * (adapters.MAX_JSON_BYTES + 1)), httpx.Response(200, json=['not-an-object'])])
def test_read_transport_rejects_redirects_oversize_and_malformed_responses(response):
    calls = []
    async def exercise():
        def respond(request):
            calls.append(request)
            return response
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(adapters.ReadFailure):
                await adapters.request_json(client, 'GET', 'https://open.tiktokapis.com/v2/user/info/')
    asyncio.run(exercise())
    assert len(calls) == 1


def test_read_oauth_telemetry_excludes_codes_tokens_cookies_and_frame_locals():
    event = {'request': {'url': 'https://ziipa.com/api/social/oauth/tiktok/callback?code=PRIVATE_CODE',
        'query_string': 'PRIVATE_QUERY', 'cookies': 'PRIVATE_COOKIE', 'headers': {'Authorization': 'PRIVATE_AUTH'}, 'data': 'PRIVATE_BODY'},
        'extra': {'token': 'PRIVATE_EXTRA'}, 'exception': {'values': [{'value': 'PRIVATE_EXCEPTION',
            'stacktrace': {'frames': [{'vars': {'tokens': 'PRIVATE_LOCALS'}}]}}]},
        'breadcrumbs': {'values': [{'message': 'PRIVATE_MESSAGE', 'data': {'url': 'https://graph.facebook.com?access_token=PRIVATE_TOKEN', 'status_code': 400}}]}}
    result = imports.redact_read_telemetry(event, None)
    assert 'PRIVATE_' not in json.dumps(result)
    assert result['request']['url'].endswith('/callback')


@pytest.mark.parametrize('provider,path', [('tiktok', 'https://evil.test/v2/video/list/'),
    ('tiktok', 'https://open.tiktokapis.com/v2/post/publish/video/init/'),
    ('facebook', 'https://graph.facebook.com/v25.0/222/feed')])
def test_read_transport_never_sends_to_unapproved_or_publishing_paths(provider, path):
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: pytest.fail('No request permitted'))) as client:
            with pytest.raises(adapters.ReadFailure):
                await adapters.request_json(client, 'POST', path)
    asyncio.run(exercise())
