"""Integration tests use a dedicated Redis DB and rollback-only PostgreSQL transaction."""
import os
os.environ['REDIS_URL'] = 'redis://127.0.0.1:56389/15'
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from app import app, db, engine, Base, cache, passwords, User


@pytest.fixture
def client():
    Base.metadata.create_all(engine)
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(bind=connection, join_transaction_mode='create_savepoint')
        def test_db():
            yield session
        app.dependency_overrides[db] = test_db
        for key in cache.scan_iter('rate:*'):
            cache.delete(key)
        with TestClient(app) as client:
            yield client
        session.close()
        transaction.rollback()
        app.dependency_overrides.clear()
        for prefix in ('session:*', 'mobile_session:*'):
            for key in cache.scan_iter(prefix):
                cache.delete(key)


def test_registration_session_logout(client):
    assert client.get('/api/me').status_code == 401
    data = {'name': 'Test Explorer', 'email': 'explorer@example.com', 'password': 'local-test-password-123'}
    result = client.post('/api/auth/register', json=data)
    assert result.status_code == 201
    assert 'HttpOnly' in result.headers['set-cookie']
    assert client.get('/api/me').json()['name'] == data['name']
    assert client.post('/api/auth/logout').status_code == 200
    assert client.get('/api/me').status_code == 401
    assert client.post('/api/auth/login', json={**data, 'password':'wrong'}).status_code == 401
    assert client.post('/api/auth/login', json=data).status_code == 200
    assert client.post('/api/auth/register', json=data).status_code == 409


def test_validation_waitlist_and_origin(client):
    assert client.post('/api/waitlist', json={'name':'Test','email':'bad'}).status_code == 422
    data = {'name':'Test', 'email':'waitlist@example.com'}
    assert client.post('/api/waitlist', json=data, headers={'Origin':'https://untrusted.example'}).status_code == 403
    assert client.post('/api/waitlist', json=data).status_code == 200
    assert client.post('/api/waitlist', json=data).status_code == 200
    assert client.post('/api/auth/register', json={**data, 'password':'short'}).status_code == 422


def test_rate_limit(client):
    for _ in range(15):
        assert client.post('/api/waitlist', json={'name':'Test','email':'rate@example.com'}).status_code == 200
    assert client.post('/api/waitlist', json={'name':'Test','email':'rate@example.com'}).status_code == 429


def test_health(client):
    result = client.get('/api/health')
    assert result.status_code == 200
    assert result.json() == {'database':'connected','redis':'connected'}


def register_creator(client, email='creator@example.com'):
    result = client.post('/api/auth/register', json={'name':'Creator Test','email':email,'password':'creator-test-pass-123'})
    assert result.status_code == 201


def test_creator_drafts_feeds_and_filters(client):
    assert client.get('/api/creator/bootstrap').status_code == 401
    register_creator(client)
    result = client.post('/api/creator/items', json={'title':'My first film','category':'video','tags':['film']})
    assert result.status_code == 201
    item_id = result.json()['id']
    assert client.get('/api/creator/bootstrap').json()['drafts'][0]['id'] == item_id
    feed = client.post('/api/creator/feeds', json={'name':'Music people','category':'music','tag':'studio','shared':True})
    assert feed.status_code == 201
    state = client.get('/api/creator/bootstrap').json()
    assert len(state['feeds']) == 1
    assert len(state['community_feeds']) == 1
    settings = state['preferences']
    settings['muted_words'] = ['after hours']
    assert client.post('/api/creator/preferences', json=settings).status_code == 200
    assert not any('After hours' in i['title'] for i in client.get('/api/creator/bootstrap').json()['items'])
    assert client.post('/api/creator/items', json={'title':'Invalid trim','trim_start':10,'trim_end':5}).status_code == 422
    assert client.post('/api/creator/items', json={'title':'No video','visibility':'published'}).status_code == 422
    assert client.post('/api/creator/items', json={'title':'No mint','category':'nft','visibility':'published'}).status_code == 409


def test_media_and_draft_authorization(client, tmp_path, monkeypatch):
    import creator
    import base64
    monkeypatch.setattr(creator, 'MEDIA_ROOT', tmp_path)
    register_creator(client)
    assert client.post('/api/creator/media', content=b'<html>bad</html>', headers={'content-type':'image/png'}).status_code == 415
    assert not list(tmp_path.iterdir())
    png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')
    upload=client.post('/api/creator/media', content=png, headers={'content-type':'image/png'})
    assert upload.status_code == 200
    media_id=upload.json()['id']
    data={'title':'Private artwork','category':'store','media_id':media_id,'price_cents':1250}
    draft=client.post('/api/creator/items',json=data).json()
    assert client.get(f'/api/creator/media/{media_id}', headers={'Range':'bytes=0-7'}).status_code == 206
    assert client.post(f"/api/creator/items/{draft['id']}/comments", json={'body':'Private note'}).status_code == 200
    client.cookies.clear()
    register_creator(client,'other-creator@example.com')
    assert client.get(f'/api/creator/media/{media_id}').status_code == 404
    assert client.get(f"/api/creator/items/{draft['id']}/comments").status_code == 404
    assert client.post(f"/api/creator/items/{draft['id']}",json=data).status_code == 404
    assert client.post('/api/creator/items',json={**data,'visibility':'published'}).status_code == 404
    assert not client.get('/api/creator/bootstrap').json()['drafts']
    client.cookies.clear()
    assert client.post('/api/auth/login',json={'email':'creator@example.com','password':'creator-test-pass-123'}).status_code == 200
    assert client.post(f"/api/creator/items/{draft['id']}",json={**data,'visibility':'published'}).status_code == 200
    client.cookies.clear()
    assert client.post('/api/auth/login',json={'email':'other-creator@example.com','password':'creator-test-pass-123'}).status_code == 200
    assert client.get(f'/api/creator/media/{media_id}').status_code == 200
    assert client.get(f"/api/creator/items/{draft['id']}/comments").status_code == 200


def test_creator_overlays_connections_and_distribution_status(client, tmp_path, monkeypatch):
    import creator
    import base64
    monkeypatch.setattr(creator, 'MEDIA_ROOT', tmp_path)
    register_creator(client, 'distribution@example.com')
    connections = client.get('/api/creator/connections').json()
    assert {c['provider'] for c in connections} == {'bluesky', 'facebook', 'instagram', 'tiktok', 'twitch', 'youtube'}
    assert all(c['status'] == 'disconnected' for c in connections)
    assert client.post('/api/creator/connections/tiktok', json={'action': 'connect'}).status_code == 409
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')
    media = client.post('/api/creator/media', content=png, headers={'content-type': 'image/png'}).json()
    item = client.post('/api/creator/items', json={
        'title': 'Cross-network creation', 'category': 'video', 'media_id': media['id'],
        'visibility': 'published', 'distribution_targets': ['instagram', 'tiktok'],
        'overlays': [{'id': 'headline', 'text': 'Made in Ziipa', 'position': 'center', 'theme': 'purple'}],
    }).json()
    assert item['overlays'][0]['text'] == 'Made in Ziipa'
    result = client.post(f"/api/creator/items/{item['id']}/distribute", json={'providers': ['instagram', 'tiktok']})
    assert result.status_code == 200
    assert {job['status'] for job in result.json()} == {'connection_required'}
    state = client.get('/api/creator/bootstrap').json()
    assert len(state['connections']) == 6
    assert {job['provider'] for job in state['distributions']} == {'instagram', 'tiktok'}
    assert client.post(f"/api/creator/items/{item['id']}/distribute", json={'providers': ['instagram', 'instagram']}).status_code == 422


def native_headers(client, email='native@example.com', name='Native Creator'):
    result = client.post('/api/mobile/auth/register', json={'name': name, 'email': email, 'password': 'native-password-123', 'accepted_policies': True, 'adult_confirmed': True, 'policy_version': '2026-08-31'})
    assert result.status_code == 201
    assert 'set-cookie' not in result.headers
    return {'Authorization': 'Bearer ' + result.json()['access_token']}


def test_native_sessions_are_scoped_revocable_and_expire(client):
    import hashlib
    assert client.post('/api/mobile/auth/register', json={'name': 'Native', 'email': 'native@example.com', 'password': 'native-password-123'}).status_code == 422
    headers = native_headers(client)
    token = headers['Authorization'].split()[1]
    assert client.get('/api/me').status_code == 401
    assert client.get('/api/me', headers=headers).json()['email'] == 'native@example.com'
    key = 'mobile_session:' + hashlib.sha256(token.encode()).hexdigest()
    assert 0 < cache.ttl(key) <= 604800
    # A bearer cannot be used as a web session cookie.
    client.cookies.set('ziipa_session', token)
    assert client.get('/api/me').status_code == 401
    assert client.post('/api/mobile/auth/logout', headers=headers).status_code == 200
    assert client.get('/api/me', headers=headers).status_code == 401
    login = client.post('/api/mobile/auth/login', json={'email': 'native@example.com', 'password': 'native-password-123'}).json()
    second = login['access_token']
    cache.delete('mobile_session:' + hashlib.sha256(second.encode()).hexdigest())
    assert client.get('/api/me', headers={'Authorization': f'Bearer {second}'}).status_code == 401
    # Malformed authorization must not fall back to a valid cookie.
    client.cookies.clear()
    client.post('/api/auth/login', json={'email': 'native@example.com', 'password': 'native-password-123'})
    assert client.get('/api/me', headers={'Authorization': 'Basic invalid'}).status_code == 401


def test_native_block_report_and_moderator_removal(client, tmp_path, monkeypatch):
    import creator
    from app import settings
    import base64
    monkeypatch.setattr(creator, 'MEDIA_ROOT', tmp_path)
    owner = native_headers(client)
    owner_id = client.get('/api/me', headers=owner).json()['id']
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')
    upload = client.post('/api/creator/media', headers={**owner, 'content-type': 'image/png'}, content=png).json()
    payload = {'title': 'A shared artwork', 'category': 'video', 'media_id': upload['id'], 'visibility': 'published'}
    item = client.post('/api/creator/items', headers=owner, json=payload).json()
    viewer = native_headers(client, 'viewer@example.com', 'Viewer')
    viewer_id = client.get('/api/me', headers=viewer).json()['id']
    report = client.post('/api/safety/reports', headers=viewer, json={'item_id': item['id'], 'reason': 'spam', 'details': 'Review this post.'})
    assert report.status_code == 201
    assert client.get('/api/moderation/reports', headers=viewer).status_code == 403
    assert client.post('/api/safety/block', headers=viewer, json={'user_id': owner_id}).status_code == 200
    assert not any(i['id'] == item['id'] for i in client.get('/api/creator/bootstrap', headers=viewer).json()['items'])
    assert client.get(upload['url'], headers=viewer).status_code == 404
    assert client.post('/api/safety/block', headers=viewer, json={'user_id': owner_id, 'blocked': False}).status_code == 200
    assert client.get(upload['url'], headers=viewer).status_code == 200
    # Blocks also stop new comments from the blocked person on the blocker’s posts.
    assert client.post('/api/safety/block', headers=owner, json={'user_id': viewer_id}).status_code == 200
    assert client.post(f"/api/creator/items/{item['id']}/comments", headers=viewer, json={'body': 'Cannot contact'}).status_code == 403
    mod = native_headers(client, 'moderator@example.com', 'Moderator')
    monkeypatch.setattr(settings, 'moderator_emails', 'moderator@example.com')
    queue = client.get('/api/moderation/reports', headers=mod).json()
    assert queue[0]['item']['title'] == payload['title']
    assert client.post(f"/api/moderation/reports/{report.json()['id']}", headers=mod, json={'action': 'remove'}).status_code == 200
    assert client.get(upload['url'], headers=viewer).status_code == 404
    assert client.post(f"/api/creator/items/{item['id']}", headers=owner, json=payload).status_code == 403


def test_account_deletion_removes_media_and_invalidates_all_devices(client, tmp_path, monkeypatch):
    import creator
    import base64
    monkeypatch.setattr(creator, 'MEDIA_ROOT', tmp_path)
    headers = native_headers(client)
    token2 = client.post('/api/mobile/auth/login', json={'email': 'native@example.com', 'password': 'native-password-123'}).json()['access_token']
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')
    media = client.post('/api/creator/media', content=png, headers={**headers, 'content-type': 'image/png'}).json()
    post = client.post('/api/creator/items', headers=headers, json={'title': 'Private file', 'media_id': media['id']}).json()
    client.post(f"/api/creator/items/{post['id']}/comments", headers=headers, json={'body': 'My comment'})
    client.post('/api/creator/feeds', headers=headers, json={'name': 'My feed'})
    assert client.post('/api/account/delete', headers=headers, json={'password': 'wrong', 'confirmation': 'DELETE'}).status_code == 401
    assert (tmp_path / media['id']).exists()
    result = client.post('/api/account/delete', headers=headers, json={'password': 'native-password-123', 'confirmation': 'DELETE'})
    assert result.status_code == 200
    assert result.json()['pending_media_cleanup'] is False
    assert not list(tmp_path.iterdir())
    assert client.get('/api/me', headers=headers).status_code == 401
    assert client.get('/api/me', headers={'Authorization': f'Bearer {token2}'}).status_code == 401
    assert client.post('/api/mobile/auth/login', json={'email': 'native@example.com', 'password': 'native-password-123'}).status_code == 401
