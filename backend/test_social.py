"""Social integration tests never contact a provider or post anything externally."""
import asyncio
from functools import partial
import base64

import httpx
import pytest
from fastapi import HTTPException
from redis.exceptions import RedisError

from test_api import client, register_creator
from app import cache
import social_api as social

DID = 'did:plc:abcdefghijklmnopqrstuvwx'
PERSON_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'


@pytest.fixture(autouse=True)
def isolated_social_rate_keys():
    for key in cache.scan_iter('social_sync:*'):
        cache.delete(key)
    yield
    for key in cache.scan_iter('social_sync:*'):
        cache.delete(key)


def install_public_api(monkeypatch, responses=None):
    requests = []
    fixtures = responses or {
        'app.bsky.actor.getProfile': {'did': DID, 'handle': 'artist.bsky.social', 'displayName': 'Artist'},
        'app.bsky.feed.getAuthorFeed': {'feed': [{'post': {'uri': f'at://{DID}/app.bsky.feed.post/123abc',
            'author': {'did': DID, 'handle': 'artist.bsky.social', 'displayName': 'Artist'},
            'record': {'text': 'A real public post', 'createdAt': '2026-09-09T12:00:00Z'},
            'embed': {'$type': 'app.bsky.embed.images#view', 'images': [{'thumb': 'https://cdn.bsky.app/img/feed_thumbnail/image.jpg'}]},
        }}]},
        'app.bsky.graph.getFollows': {'subject': {'did': DID}, 'follows': [{'did': PERSON_DID,
            'handle': 'friend.bsky.social', 'displayName': 'Following', 'avatar': 'https://cdn.bsky.app/img/avatar/image.jpg'}]},
    }
    def respond(request):
        requests.append(request)
        assert request.url.host == 'public.api.bsky.app'
        assert request.url.scheme == 'https'
        assert 'authorization' not in request.headers
        method = request.url.path.split('/')[-1]
        value = fixtures[method]
        return value(request) if callable(value) else httpx.Response(200, json=value)
    original = httpx.AsyncClient
    monkeypatch.setattr(social.httpx, 'AsyncClient', partial(original, transport=httpx.MockTransport(respond)))
    return requests


@pytest.mark.parametrize('provider,raw,expected', [
    ('bluesky', '@artist.bsky.social', 'https://bsky.app/profile/artist.bsky.social'),
    ('bluesky', 'https://bsky.app/profile/artist.bsky.social', 'https://bsky.app/profile/artist.bsky.social'),
    ('facebook', 'https://www.facebook.com/profile.php?id=123', 'https://facebook.com/profile.php?id=123'),
    ('instagram', 'ZiipaCom', 'https://instagram.com/ziipacom'),
    ('tiktok', 'https://www.tiktok.com/@ziipacom', 'https://tiktok.com/@ziipacom'),
    ('twitch', 'https://www.twitch.tv/ziipacom', 'https://twitch.tv/ziipacom'),
    ('youtube', 'https://www.youtube.com/@ziipacom', 'https://youtube.com/@ziipacom'),
])
def test_profile_normalization(provider, raw, expected):
    assert social.normalized_profile(provider, social.LinkInput(handle=raw))[1] == expected


@pytest.mark.parametrize('provider,raw', [
    ('bluesky', 'https://127.0.0.1/profile/private'),
    ('bluesky', 'http://bsky.app/profile/artist.bsky.social'),
    ('bluesky', 'https://bsky.app.attacker.test/profile/artist.bsky.social'),
    ('bluesky', 'https://bsky.app@127.0.0.1/profile/artist.bsky.social'),
    ('bluesky', 'https://bsky.app:443/profile/artist.bsky.social'),
    ('bluesky', 'https://bsky.app/profile/artist.bsky.social/post/123'),
    ('bluesky', 'https://bsky.app/profile/artist.bsky.social?redirect=http://localhost'),
    ('bluesky', 'https://bsky.app/profile/%2e%2e'),
    ('bluesky', '127.0.0.1'),
    ('instagram', 'https://instagram.com/accounts'),
    ('instagram', 'https://instagram.com/ziipa?utm_source=test'),
    ('instagram', 'javascript:alert(1)'),
    ('tiktok', 'https://www.tiktok.com/@me/video/123'),
    ('facebook', 'https://facebook.com/profile.php?id=123&id=456'),
    ('youtube', 'https://youtube.com/watch?v=123'),
])
def test_profile_url_safety(provider, raw):
    with pytest.raises(HTTPException) as error:
        social.normalized_profile(provider, social.LinkInput(handle=raw))
    assert error.value.status_code == 422


def test_links_do_not_grant_oauth_or_publishing_and_are_isolated(client):
    assert client.get('/api/social/hub').status_code == 401
    assert client.post('/api/social/instagram/link', json={'handle': 'ziipacom'}).status_code == 401
    register_creator(client)
    result = client.post('/api/social/instagram/link', json={'handle': 'ziipacom'})
    assert result.status_code == 200
    assert result.json()['status'] == 'linked'
    assert result.json()['auth_type'] == 'public_profile'
    assert result.json()['can_publish'] is False
    assert result.json()['configured'] is False
    assert result.json()['can_sync'] is False
    assert client.post('/api/social/instagram/sync').status_code == 409
    ready = client.post('/api/social/instagram/connect').json()
    assert ready['status'] == 'setup_required' and ready['auth_url'] is None
    assert 'does not grant publishing permission' in ready['detail']
    assert 'Publishing accounts' in ready['detail']
    hub = client.get('/api/social/hub').json()
    assert hub['invite_url'] == 'https://ziipa.com'
    assert len(hub['providers']) == 6
    assert all(not p['can_publish'] for p in hub['providers'])
    assert client.post('/api/social/instagram/link', json={'handle': 'second'}, headers={'Origin': 'https://evil.test'}).status_code == 403
    client.cookies.clear()
    register_creator(client, 'social-other@example.com')
    assert all(p['status'] == 'disconnected' for p in client.get('/api/social/hub').json()['providers'])
    assert client.post('/api/social/instagram/disconnect').status_code == 200
    client.cookies.clear()
    client.post('/api/auth/login', json={'email': 'creator@example.com', 'password': 'creator-test-pass-123'})
    assert next(p for p in client.get('/api/social/hub').json()['providers'] if p['provider'] == 'instagram')['status'] == 'linked'


def test_public_sync_persists_bounded_imports_and_disconnect_clears_them(client, monkeypatch):
    requests = install_public_api(monkeypatch)
    register_creator(client)
    assert client.post('/api/social/bluesky/sync').status_code == 409
    client.post('/api/social/bluesky/link', json={'handle': 'artist.bsky.social'})
    sync = client.post('/api/social/bluesky/sync')
    assert sync.status_code == 200
    state = sync.json()
    assert len(requests) == 3
    assert requests[1].url.params['actor'] == DID
    assert state['media'][0]['text'] == 'A real public post'
    assert state['people'][0]['relationship'] == 'following'
    provider = next(p for p in state['providers'] if p['provider'] == 'bluesky')
    assert provider['sync_status'] == 'synced' and provider['last_synced_at']
    assert provider['status'] == 'linked' and provider['can_publish'] is False
    assert state == client.get('/api/social/hub').json()
    exported = client.get('/api/account/export').json()['social_networks']
    assert exported['media'] == state['media']
    assert client.post('/api/social/bluesky/sync').status_code == 429
    assert len(requests) == 3
    client.post('/api/social/bluesky/disconnect')
    state = client.get('/api/social/hub').json()
    assert state['media'] == [] and state['people'] == []


def test_sync_failure_is_sanitized_and_last_good_snapshot_is_retained(client, monkeypatch):
    install_public_api(monkeypatch)
    register_creator(client)
    client.post('/api/social/bluesky/link', json={'handle': 'artist.bsky.social'})
    previous = client.post('/api/social/bluesky/sync').json()
    for key in cache.scan_iter('social_sync:*'):
        cache.delete(key)
    async def failing(*args, **kwargs):
        raise social.SyncFailure('Bluesky could not be reached. Please retry later.')
    monkeypatch.setattr(social, 'bsky_get', failing)
    result = client.post('/api/social/bluesky/sync').json()
    assert result['media'] == previous['media']
    provider = next(p for p in result['providers'] if p['provider'] == 'bluesky')
    assert provider['sync_status'] == 'error'
    assert provider['last_synced_at']
    assert 'could not be reached' in provider['sync_error']
    client.post('/api/social/bluesky/link', json={'handle': 'another.bsky.social'})
    assert client.get('/api/social/hub').json()['media'] == []


def test_disconnect_during_sync_does_not_restore_connection(client, monkeypatch):
    from app import app, db
    from sqlalchemy import delete
    from creator import CreatorConnection
    install_public_api(monkeypatch)
    register_creator(client)
    owner_id = client.get('/api/me').json()['id']
    client.post('/api/social/bluesky/link', json={'handle': 'artist.bsky.social'})
    original = social.bsky_get
    async def disconnect_after_profile(*args, **kwargs):
        result = await original(*args, **kwargs)
        if args[1] == 'app.bsky.actor.getProfile':
            session = next(app.dependency_overrides[db]())
            session.execute(delete(CreatorConnection).where(CreatorConnection.owner_id == owner_id))
            session.commit()
        return result
    monkeypatch.setattr(social, 'bsky_get', disconnect_after_profile)
    assert client.post('/api/social/bluesky/sync').status_code == 409
    state = client.get('/api/social/hub').json()
    assert state['media'] == []
    assert all(p['status'] == 'disconnected' for p in state['providers'])


def test_imports_are_not_shared_between_users(client, monkeypatch):
    install_public_api(monkeypatch)
    register_creator(client)
    client.post('/api/social/bluesky/link', json={'handle': 'artist.bsky.social'})
    assert client.post('/api/social/bluesky/sync').json()['people']
    client.cookies.clear()
    register_creator(client, 'other-imports@example.com')
    hub = client.get('/api/social/hub').json()
    assert hub['media'] == [] and hub['people'] == []
    assert client.get('/api/account/export').json()['social_networks']['media'] == []


def test_entire_sync_deadline_cancels_slow_requests_and_keeps_snapshot(client, monkeypatch):
    install_public_api(monkeypatch)
    register_creator(client)
    client.post('/api/social/bluesky/link', json={'handle': 'artist.bsky.social'})
    previous = client.post('/api/social/bluesky/sync').json()
    for key in cache.scan_iter('social_sync:*'):
        cache.delete(key)
    monkeypatch.setattr(social, 'TOTAL_SYNC_TIMEOUT_SECONDS', 0.06)
    original = social.bsky_get
    cancelled = []
    async def slow_request(*args, **kwargs):
        try:
            # Each individual operation fits the total timeout, but profile +
            # feed/graph stages together exceed it. No real external request.
            await asyncio.sleep(0.04)
            return await original(*args, **kwargs)
        except asyncio.CancelledError:
            cancelled.append(args[1])
            raise
    monkeypatch.setattr(social, 'bsky_get', slow_request)
    result = client.post('/api/social/bluesky/sync')
    assert result.status_code == 200
    hub = result.json()
    provider = next(p for p in hub['providers'] if p['provider'] == 'bluesky')
    assert provider['sync_status'] == 'error'
    assert provider['sync_error'] == 'Bluesky sync exceeded its time limit. Please retry later.'
    assert provider['last_synced_at'] == next(p for p in previous['providers'] if p['provider'] == 'bluesky')['last_synced_at']
    assert hub['media'] == previous['media'] and hub['people'] == previous['people']
    # Client setup counts against the same deadline, so under load cancellation
    # can occur during the profile stage instead of the parallel feed stage.
    assert cancelled and set(cancelled) <= social.BLUESKY_METHODS


def test_response_redirect_and_size_limits_never_follow_untrusted_locations():
    calls = []
    def redirect(request):
        calls.append(request)
        return httpx.Response(302, headers={'Location': 'http://127.0.0.1/secrets'})
    async def run(handler):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False) as api:
            await social.bsky_get(api, 'app.bsky.actor.getProfile', {'actor': 'artist.bsky.social'})
    with pytest.raises(social.SyncFailure):
        asyncio.run(run(redirect))
    assert len(calls) == 1
    with pytest.raises(social.SyncFailure):
        asyncio.run(run(lambda _: httpx.Response(200, content=b'x' * (social.MAX_RESPONSE_BYTES + 1))))
    with pytest.raises(social.SyncFailure):
        asyncio.run(run(lambda _: httpx.Response(200, json=['bad-shape'])))
    assert social.image_url('http://localhost/private') is None
    assert social.image_url('https://cdn.bsky.app@evil.test/private') is None


def test_sync_fails_closed_if_rate_limit_store_fails(client, monkeypatch):
    register_creator(client)
    client.post('/api/social/bluesky/link', json={'handle': 'artist.bsky.social'})
    def unavailable(*args, **kwargs):
        raise RedisError('unavailable')
    monkeypatch.setattr(cache, 'set', unavailable)
    assert client.post('/api/social/bluesky/sync').status_code == 503


def test_export_ownership_and_linked_distribution_stays_action_required(client, tmp_path, monkeypatch):
    import creator
    monkeypatch.setattr(creator, 'MEDIA_ROOT', tmp_path)
    register_creator(client)
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')
    upload = client.post('/api/creator/media', content=png, headers={'content-type': 'image/png'}).json()
    media_id = upload['id']
    item = client.post('/api/creator/items', json={'title': 'Original artwork', 'media_id': media_id, 'visibility': 'published'}).json()
    client.post('/api/social/instagram/link', json={'handle': 'ziipacom'})
    result = client.post(f"/api/creator/items/{item['id']}/distribute", json={'providers': ['instagram']}).json()
    assert result[0]['status'] == 'connection_required'
    assert 'does not grant posting access' in result[0]['detail']
    own_export = client.post(f'/api/social/media/{media_id}/export').json()
    assert own_export == {'url': f'/api/creator/media/{media_id}', 'content_type': 'image/png', 'size': len(png)}
    assert client.post('/api/social/instagram/disconnect').status_code == 200
    result = client.get('/api/creator/bootstrap').json()['distributions']
    assert result[0]['status'] == 'connection_required' and 'disconnected' in result[0]['detail']
    client.cookies.clear()
    register_creator(client, 'unrelated-export@example.com')
    assert client.post(f'/api/social/media/{media_id}/export').status_code == 404


def test_deletion_removes_network_profiles_and_snapshots(client, monkeypatch):
    install_public_api(monkeypatch)
    register_creator(client)
    client.post('/api/social/bluesky/link', json={'handle': 'artist.bsky.social'})
    client.post('/api/social/bluesky/sync')
    assert client.post('/api/account/delete', json={'password': 'creator-test-pass-123', 'confirmation': 'DELETE'}).status_code == 200
    assert client.get('/api/social/hub').status_code == 401
