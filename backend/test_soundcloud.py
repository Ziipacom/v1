"""SoundCloud tests: isolated local database/Redis and mocked provider traffic only."""
import asyncio
import base64
import hashlib
import json
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import HTTPException

from app import app, cache, db
from test_api import client, register_creator
import soundcloud as sc
import social_publishing as publishing

ORIGIN = 'https://api.ziipa.test'
PASSWORD = 'creator-test-pass-123'


@pytest.fixture(autouse=True)
def isolated(monkeypatch, client):
    client.base_url = httpx.URL(ORIGIN)
    monkeypatch.setattr(sc.config, 'enabled', True)
    monkeypatch.setattr(sc.config, 'client_id', 'synthetic-client')
    monkeypatch.setattr(sc.config, 'client_secret', 'synthetic-secret')
    monkeypatch.setattr(sc.config, 'public_search_enabled', False)
    monkeypatch.setattr(sc.config, 'owner_widget_enabled', False)
    monkeypatch.setattr(publishing.config, 'encryption_key', base64.urlsafe_b64encode(b's' * 32).decode())
    monkeypatch.setattr(publishing.config, 'api_origin', ORIGIN)
    monkeypatch.setattr(publishing.config, 'approved_origins', ORIGIN)
    monkeypatch.setattr(publishing.config, 'portal_url', ORIGIN + '/portal')
    def forbidden(request):
        raise AssertionError('Every SoundCloud provider call must be explicitly mocked')
    monkeypatch.setattr(sc, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(forbidden), follow_redirects=False))


def session():
    return next(app.dependency_overrides[db]())


def track(number=1, owner=7, **updates):
    return {'urn': f'soundcloud:tracks:{number}', 'title': f'Track {number}',
            'permalink_url': f'https://soundcloud.com/creator-{owner}/track-{number}',
            'user': {'urn': f'soundcloud:users:{owner}', 'username': f'Creator {owner}',
                     'permalink_url': f'https://soundcloud.com/creator-{owner}'},
            'sharing': 'public', 'access': 'playable', 'duration': 12000,
            'streamable': True, 'embeddable_by': 'all', 'license': 'all-rights-reserved',
            'secret_token': 'never-return-track-secret', 'stream_url': 'https://evil.test/audio',
            'artwork_url': 'https://evil.test/tracker', **updates}


def mock_provider(monkeypatch, *, catalog=None, replacement=None):
    requests = []
    def handler(request):
        requests.append(request)
        if replacement:
            result = replacement(request)
            if result is not None:
                return result
        url = str(request.url).split('?')[0]
        if url == sc.TOKEN_URL:
            return httpx.Response(200, json={'access_token': 'synthetic-access', 'refresh_token': 'synthetic-refresh', 'expires_in': 3600})
        assert request.headers.get('authorization') == 'OAuth synthetic-access' or url == sc.REVOKE_URL
        if url == sc.ME_URL:
            return httpx.Response(200, json={'urn': 'soundcloud:users:7', 'username': 'Fixture Creator',
                'permalink_url': 'https://soundcloud.com/creator-7', 'email': 'never-store-provider-email@test.invalid'})
        if url in {sc.MINE_URL, sc.SEARCH_URL}:
            return httpx.Response(200, json={'collection': catalog if catalog is not None else [track()],
                                          'next_href': 'https://evil.test/never-follow'})
        if request.url.path.startswith('/tracks/soundcloud:tracks:'):
            return httpx.Response(200, json=track(int(request.url.path.rsplit(':', 1)[1])))
        if url == sc.REVOKE_URL:
            return httpx.Response(204)
        raise AssertionError('Unexpected provider URL')
    monkeypatch.setattr(sc, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False))
    return requests


def begin(client):
    result = client.post('/api/music/soundcloud/oauth/start', json={'consent': True})
    assert result.status_code == 200, result.text
    assert result.headers['cache-control'] == 'private, no-store'
    redirect = client.get(result.json()['auth_url'], follow_redirects=False)
    assert redirect.status_code == 302, redirect.text
    parsed = urlsplit(redirect.headers['location'])
    assert parsed.scheme == 'https' and parsed.netloc == 'secure.soundcloud.com' and parsed.path == '/authorize'
    query = parse_qs(parsed.query)
    assert query['redirect_uri'] == [ORIGIN + sc.OAUTH_PATH + '/callback']
    assert query['code_challenge_method'] == ['S256']
    return query


def connect(client, monkeypatch, **kwargs):
    requests = mock_provider(monkeypatch, **kwargs)
    query = begin(client)
    result = client.get(sc.OAUTH_PATH + '/callback', params={'state': query['state'][0], 'code': 'synthetic-code'})
    assert result.status_code == 200, result.text
    return requests, query


def test_readiness_is_authenticated_default_off_and_never_claims_import(client, monkeypatch):
    assert client.get('/api/music/soundcloud/config').status_code == 401
    register_creator(client)
    monkeypatch.setattr(sc.config, 'enabled', False)
    result = client.get('/api/music/soundcloud/config').json()
    assert not result['configured'] and not result['can_connect'] and not result['can_import']
    assert client.post(sc.OAUTH_PATH + '/start', json={'consent': True}).status_code == 409
    monkeypatch.setattr(sc.config, 'enabled', True)
    monkeypatch.setattr(publishing.config, 'encryption_key', '')
    assert not client.get('/api/music/soundcloud/config').json()['configured']


@pytest.mark.parametrize('consent', [False, 1, 'true', None])
def test_connect_requires_literal_user_consent(client, consent):
    register_creator(client)
    assert client.post(sc.OAUTH_PATH + '/start', json={'consent': consent}).status_code == 422
    assert session().query(sc.SoundCloudConnection).count() == 0


def test_native_authorization_is_portal_handoff_not_native_oauth(client):
    register_creator(client)
    login = client.post('/api/mobile/auth/login', json={'email': 'creator@example.com', 'password': PASSWORD}).json()
    result = client.post(sc.OAUTH_PATH + '/start', json={'consent': True}, headers={'Authorization': 'Bearer ' + login['access_token']})
    assert result.status_code == 200
    assert result.json()['status'] == 'browser_sign_in_required' and result.json()['auth_url'] is None
    assert result.json()['connect_via_portal'] == ORIGIN + '/portal'
    assert session().query(sc.SoundCloudConnection).count() == 0
    assert not list(cache.scan_iter('soundcloud_oauth:*'))


def test_oauth_pkce_single_use_encrypted_owner_bound_and_no_private_profile_export(client, monkeypatch):
    register_creator(client)
    requests, query = connect(client, monkeypatch)
    token_request = next(value for value in requests if str(value.url) == sc.TOKEN_URL)
    fields = parse_qs(token_request.content.decode())
    challenge = base64.urlsafe_b64encode(hashlib.sha256(fields['code_verifier'][0].encode()).digest()).rstrip(b'=').decode()
    assert query['code_challenge'] == [challenge]
    row = session().query(sc.SoundCloudConnection).one()
    assert row.status == 'authorized' and row.account_urn == 'soundcloud:users:7'
    assert 'synthetic' not in row.token_cipher
    assert sc.decrypted(row)['refresh_token'] == 'synthetic-refresh'
    with pytest.raises(HTTPException):
        sc.decrypted(SimpleNamespace(owner_id=row.owner_id + 1, token_cipher=row.token_cipher))
    text = client.get('/api/account/export').text
    assert 'soundcloud' in text and 'stored_audio' in text
    assert all(value not in text for value in ('synthetic-access', 'synthetic-secret', 'token_cipher', 'never-store-provider-email'))
    assert client.get(sc.OAUTH_PATH + '/callback', params={'state': query['state'][0], 'code': 'again'}).status_code == 400
    assert len(requests) == 2


def test_browser_binding_and_signin_epoch_prevent_reuse(client, monkeypatch):
    register_creator(client)
    requests = mock_provider(monkeypatch)
    query = begin(client)
    client.cookies.delete(sc.COOKIE)
    assert client.get(sc.OAUTH_PATH + '/callback', params={'state': query['state'][0], 'code': 'code'}).status_code == 400
    assert requests == []
    query = begin(client)
    client.post('/api/auth/logout')
    assert client.get(sc.OAUTH_PATH + '/callback', params={'state': query['state'][0], 'code': 'code'}).status_code == 401
    assert requests == []


def test_disconnect_cancels_pending_callback_and_other_owner_cannot_disconnect(client, monkeypatch):
    register_creator(client)
    requests = mock_provider(monkeypatch)
    query = begin(client)
    revision = session().query(sc.SoundCloudConnection).one().revision
    assert client.delete('/api/music/soundcloud/connection', params={'revision': revision}).status_code == 200
    assert client.get(sc.OAUTH_PATH + '/callback', params={'state': query['state'][0], 'code': 'code'}).status_code == 409
    assert requests == []
    connect(client, monkeypatch)
    client.post('/api/auth/logout')
    register_creator(client, 'second@example.com')
    assert client.delete('/api/music/soundcloud/connection', params={'revision': 2}).status_code == 409
    assert session().query(sc.SoundCloudConnection).count() == 1


def test_callback_rechecks_disconnect_after_provider_reply(client, monkeypatch):
    register_creator(client)
    def race(request):
        if str(request.url) == sc.TOKEN_URL:
            session().delete(session().query(sc.SoundCloudConnection).one())
            session().commit()
        return None
    requests = mock_provider(monkeypatch, replacement=race)
    query = begin(client)
    result = client.get(sc.OAUTH_PATH + '/callback', params={'state': query['state'][0], 'code': 'code'})
    assert result.status_code == 409
    assert len(requests) == 2 and session().query(sc.SoundCloudConnection).count() == 0


def test_owned_catalog_is_bounded_sanitized_and_never_follows_pagination(client, monkeypatch):
    register_creator(client)
    requests, _ = connect(client, monkeypatch, catalog=[track(), track(2, 8), track(3, 8, sharing='private'), track(4, sharing='private')])
    result = client.get('/api/music/soundcloud/tracks')
    assert result.status_code == 200, result.text
    assert [row['id'] for row in result.json()['tracks']] == ['soundcloud:tracks:1', 'soundcloud:tracks:4']
    assert result.json()['has_more'] is True
    assert all(value not in result.text for value in ('stream_url', 'artwork_url', 'secret_token', 'evil.test', 'synthetic-access'))
    assert all(not row['can_import'] and not row['can_embed'] for row in result.json()['tracks'])
    assert len(requests) == 3
    query = parse_qs(requests[-1].url.query.decode())
    assert query['limit'] == ['20']
    assert len(client.get('/api/music/soundcloud/tracks', params={'q': 'Track 4'}).json()['tracks']) == 1


def test_public_discovery_is_separately_gated_metadata_only(client, monkeypatch):
    register_creator(client)
    requests, _ = connect(client, monkeypatch, catalog=[track(), track(2, 8), track(3, sharing='private')])
    assert client.get('/api/music/soundcloud/tracks', params={'scope': 'public', 'q': 'music'}).status_code == 409
    monkeypatch.setattr(sc.config, 'public_search_enabled', True)
    assert client.get('/api/music/soundcloud/tracks', params={'scope': 'public'}).status_code == 422
    result = client.get('/api/music/soundcloud/tracks', params={'scope': 'public', 'q': ' music '})
    assert result.status_code == 200
    assert [row['id'] for row in result.json()['tracks']] == ['soundcloud:tracks:1', 'soundcloud:tracks:2']
    assert parse_qs(requests[-1].url.query.decode())['q'] == ['music']


@pytest.mark.parametrize('updates', [dict(sharing='private'), dict(access='preview'), dict(access='blocked'), dict(streamable=False), dict(embeddable_by='me'), dict(user={'id': 8, 'username': 'Other', 'permalink_url': 'https://soundcloud.com/other'})])
def test_restricted_or_nonowned_tracks_never_get_widget(client, monkeypatch, updates):
    register_creator(client)
    connect(client, monkeypatch)
    monkeypatch.setattr(sc.config, 'owner_widget_enabled', True)
    mock_provider(monkeypatch, replacement=lambda request: httpx.Response(200, json=track(**updates)) if request.url.path.startswith('/tracks/') else None)
    result = client.post('/api/music/soundcloud/tracks/soundcloud%3Atracks%3A1/playback', json={'consent': True})
    assert result.status_code == 200
    assert result.json()['mode'] == 'external' and result.json()['widget_url'] is None


def test_widget_is_opted_in_fresh_owned_and_all_autoplay_flags_false(client, monkeypatch):
    register_creator(client)
    requests, _ = connect(client, monkeypatch)
    monkeypatch.setattr(sc.config, 'owner_widget_enabled', True)
    path = '/api/music/soundcloud/tracks/soundcloud%3Atracks%3A1/playback'
    assert client.post(path, json={'consent': False}).status_code == 422
    assert len(requests) == 2
    result = client.post(path, json={'consent': True})
    assert result.status_code == 200 and result.json()['mode'] == 'widget'
    url = urlsplit(result.json()['widget_url'])
    assert url.scheme == 'https' and url.netloc == 'w.soundcloud.com' and url.path == '/player/'
    assert parse_qs(url.query) == {'url': ['https://soundcloud.com/creator-7/track-1'], 'auto_play': ['false'], 'show_comments': ['false'], 'show_reposts': ['false'], 'visual': ['false']}
    assert len(requests) == 3


def test_untrusted_metadata_urls_and_invalid_ids_cannot_escape_provider_allowlist(client, monkeypatch):
    register_creator(client)
    requests, _ = connect(client, monkeypatch, catalog=[track(permalink_url='https://evil.test/a/b'), track(2, permalink_url='https://soundcloud.com/a/b?secret_token=secret')])
    assert client.get('/api/music/soundcloud/tracks').json()['tracks'] == []
    assert client.post('/api/music/soundcloud/tracks/https%3A%2F%2Fevil.test/playback', json={'consent': True}).status_code in {404, 422}
    assert len(requests) == 3


@pytest.mark.parametrize('response', [httpx.Response(302, headers={'Location': 'http://127.0.0.1/private'}), httpx.Response(200, content=b'x' * (sc.MAX_JSON + 1)), httpx.Response(429, json={'private_error': 'must-not-escape'})])
def test_provider_redirect_oversize_and_rate_errors_are_bounded(client, monkeypatch, response):
    register_creator(client)
    connect(client, monkeypatch)
    requests = mock_provider(monkeypatch, replacement=lambda request: response if str(request.url).split('?')[0] == sc.MINE_URL else None)
    result = client.get('/api/music/soundcloud/tracks')
    assert result.status_code in {409, 429, 502}
    assert 'must-not-escape' not in result.text and '127.0.0.1' not in result.text
    assert len(requests) == 1


def expire_connection():
    row = session().query(sc.SoundCloudConnection).one()
    tokens = sc.decrypted(row)
    tokens['expires_at'] = time.time() - 1
    row.token_cipher = publishing.encrypt_tokens(row.owner_id, 'soundcloud', tokens)
    session().commit()
    return row


def test_refresh_rotation_is_persisted_before_metadata_request(client, monkeypatch):
    register_creator(client)
    connect(client, monkeypatch)
    row = expire_connection()
    old_cipher = row.token_cipher
    def renewal(request):
        if str(request.url) == sc.TOKEN_URL:
            assert parse_qs(request.content.decode())['refresh_token'] == ['synthetic-refresh']
            return httpx.Response(200, json={'access_token': 'synthetic-access', 'refresh_token': 'rotated-refresh', 'expires_in': 3600})
        return None
    requests = mock_provider(monkeypatch, replacement=renewal)
    assert client.get('/api/music/soundcloud/tracks').status_code == 200
    assert len(requests) == 2
    row = session().query(sc.SoundCloudConnection).one()
    assert row.token_cipher != old_cipher and sc.decrypted(row)['refresh_token'] == 'rotated-refresh'


def test_refresh_loss_requires_reauthorization_and_is_not_retried(client, monkeypatch):
    register_creator(client)
    connect(client, monkeypatch)
    expire_connection()
    requests = []
    def fail(request):
        requests.append(request)
        raise httpx.ReadTimeout('synthetic-sensitive-error', request=request)
    monkeypatch.setattr(sc, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(fail)))
    result = client.get('/api/music/soundcloud/tracks')
    assert result.status_code == 502 and 'sensitive' not in result.text
    assert session().query(sc.SoundCloudConnection).one().status == 'reauthorization_required'
    assert client.get('/api/music/soundcloud/tracks').status_code == 409
    assert len(requests) == 1


def test_refresh_lease_prevents_duplicate_single_use_redemption(client, monkeypatch):
    register_creator(client)
    requests, _ = connect(client, monkeypatch)
    row = expire_connection()
    cache.set(f'soundcloud_refresh:{row.owner_id}', 'another-request', ex=40)
    assert client.get('/api/music/soundcloud/tracks').status_code == 409
    assert len(requests) == 2


def test_cancelled_refresh_never_replays_a_potentially_consumed_token(client, monkeypatch):
    register_creator(client)
    connect(client, monkeypatch)
    row = expire_connection()
    async def cancelled(*args, **kwargs):
        raise asyncio.CancelledError()
    monkeypatch.setattr(sc, 'provider_json', cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(sc.access_token(session(), row, object()))
    assert session().query(sc.SoundCloudConnection).one().status == 'reauthorization_required'
    assert cache.get(f'soundcloud_refresh:{row.owner_id}') is None


def test_disconnect_is_revision_guarded_and_erases_even_if_provider_unavailable(client, monkeypatch):
    register_creator(client)
    connect(client, monkeypatch)
    row = session().query(sc.SoundCloudConnection).one()
    assert client.delete('/api/music/soundcloud/connection', params={'revision': row.revision + 1}).status_code == 409
    def unavailable(request):
        raise httpx.ConnectError('do not expose', request=request)
    monkeypatch.setattr(sc, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(unavailable)))
    result = client.delete('/api/music/soundcloud/connection', params={'revision': row.revision})
    assert result.status_code == 200 and result.json()['disconnected'] and not result.json()['provider_revoked']
    assert session().query(sc.SoundCloudConnection).count() == 0
    assert client.get('/api/music/soundcloud/config').json()['connection'] is None


def test_exact_self_revocation_remains_available_during_maintenance(client, monkeypatch):
    register_creator(client)
    connect(client, monkeypatch)
    import admin_services
    def maintenance(*args, **kwargs):
        raise HTTPException(503, 'Maintenance')
    monkeypatch.setattr(admin_services, 'require_mutations_open', maintenance)
    assert client.post(sc.OAUTH_PATH + '/start', json={'consent': True}).status_code == 503
    assert client.post('/api/music/soundcloud/tracks/1/playback', json={'consent': True}).status_code == 503
    assert client.delete('/api/music/soundcloud/connection', params={'revision': session().query(sc.SoundCloudConnection).one().revision}).status_code == 200


def test_account_deletion_removes_soundcloud_and_does_not_leak_provider_data(client, monkeypatch):
    register_creator(client)
    connect(client, monkeypatch)
    result = client.post('/api/account/delete', json={'password': PASSWORD, 'confirmation': 'DELETE'})
    assert result.status_code == 200, result.text
    assert session().query(sc.SoundCloudConnection).count() == 0
    assert client.get('/api/music/soundcloud/config').status_code == 401
