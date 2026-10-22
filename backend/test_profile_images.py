"""Private profile artwork: real owned uploads, isolated SQL and bounded reads."""
import base64
from datetime import datetime, timedelta, timezone
from io import BytesIO
import uuid
from urllib.parse import urlsplit

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app
from app import Base, User, current_user, db, guard
import creator
from creator import CreatorMedia, CreatorPreferences, CreatorItem
import mobile_api
from storage_services import LocalStorage, object_key
from media_quota import usage


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')
EMPTY = {'avatar_media_id': None, 'avatar_url': None, 'cover_media_id': None,
         'cover_url': None, 'cover_sample': None}


@pytest.fixture
def h(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'profile.sqlite'), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        owner = User(name='Artwork owner', email='artwork@example.test', password_hash='unused')
        other = User(name='Another owner', email='other-artwork@example.test', password_hash='unused')
        session.add_all([owner, other]); session.commit()
    backend = LocalStorage(); backend.root = tmp_path / 'media'; backend.root.mkdir()
    monkeypatch.setattr(creator, 'MEDIA_ROOT', backend.root)
    monkeypatch.setattr(creator, 'storage', lambda: backend)
    monkeypatch.setattr(mobile_api, 'storage', lambda: backend)
    monkeypatch.setattr(creator.settings, 'media_storage_backend', 'local')
    monkeypatch.setattr(creator.settings, 'enable_demo_catalog', False)
    monkeypatch.setattr(creator, 'connections_for', lambda *_: [])
    import media_rewards
    monkeypatch.setattr(media_rewards, 'sync_preferences_rewards', lambda *_: None)
    state = {'user_id': owner.id, 'session': None, 'block_write': False}
    api = FastAPI(); api.include_router(creator.router)
    def authenticated():
        if state['user_id'] is None:
            raise HTTPException(401, 'Sign in')
        with factory() as session:
            return session.get(User, state['user_id'])
    def connection():
        if state['session'] is not None:
            yield state['session']
        else:
            with factory() as session:
                yield session
    def guarded():
        if state['block_write']:
            raise HTTPException(403, 'Write rejected')
    api.dependency_overrides[current_user] = authenticated
    api.dependency_overrides[db] = connection
    api.dependency_overrides[guard] = guarded
    with TestClient(api) as client:
        yield client, factory, owner, other, backend, state
    engine.dispose()


def upload(h, data=PNG, content_type='image/png'):
    result = h[0].post('/api/creator/media', content=data, headers={'Content-Type': content_type})
    assert result.status_code == 200, result.text
    return result.json()['id']


def save(h, **patch):
    result = h[0].post('/api/creator/profile', json=patch)
    assert result.status_code == 200, result.text
    return result.json()


def test_capability_defaults_upload_read_and_bootstrap_are_private(h):
    client, _, _, _, _, _ = h
    assert client.get('/api/creator/profile').json() == EMPTY
    capability = client.get('/api/creator/config').json()['profile_images']
    assert capability == {'version': 1, 'max_bytes': 10 * 1024 * 1024,
                          'content_types': ['image/jpeg', 'image/png', 'image/webp'],
                          'cover_samples': list(creator.PROFILE_COVER_SAMPLES)}
    avatar, cover = upload(h), upload(h)
    actual = save(h, avatar_media_id=avatar, cover_media_id=cover)
    assert actual['avatar_media_id'] == avatar and actual['cover_media_id'] == cover
    assert actual['cover_sample'] is None
    assert client.get('/api/creator/profile').json() == actual
    assert client.get('/api/creator/bootstrap').json()['profile'] == actual
    assert 'profile' not in client.get('/api/creator/bootstrap').json()['preferences']
    for key in ('avatar_url', 'cover_url'):
        path = urlsplit(actual[key]).path
        assert path.startswith('/api/creator/profile-images/')
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 200 and response.content == PNG
        assert response.headers['content-type'] == 'image/png'
        assert response.headers['cache-control'] == 'private, no-store'
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert 'location' not in response.headers
    assert client.get('/api/creator/profile').headers['cache-control'] == 'private, no-store'


def test_replacement_partial_changes_samples_and_clear_retain_owned_media(h):
    client, factory, owner, _, backend, _ = h
    first, cover, replacement = upload(h), upload(h), upload(h)
    save(h, avatar_media_id=first, cover_media_id=cover)
    changed = save(h, avatar_media_id=replacement)
    assert changed['cover_media_id'] == cover
    assert client.get('/api/creator/profile-images/' + first).status_code == 404
    assert client.get('/api/creator/media/' + first).status_code == 200
    sample = save(h, cover_sample='/media/ocean.jpg')
    assert sample['avatar_media_id'] == replacement and sample['cover_media_id'] is None
    assert sample['cover_url'] == sample['cover_sample'] == '/media/ocean.jpg'
    restored = save(h, cover_media_id=cover)
    assert restored['cover_sample'] is None and restored['avatar_media_id'] == replacement
    assert save(h, avatar_media_id=None)['cover_media_id'] == cover
    assert save(h, cover_media_id=None, cover_sample=None) == EMPTY
    with factory() as session:
        assert usage(session, owner.id) == len(PNG) * 3
        assert all(session.get(CreatorMedia, identifier) is not None for identifier in (first, cover, replacement))
    assert all(backend.path(identifier).read_bytes() == PNG for identifier in (first, cover, replacement))


@pytest.mark.parametrize('patch', [
    {'avatar_url': 'https://external.example/image.png'}, {'cover_url': '/media/studio.jpg'},
    {'owner_id': 2}, {'avatar_media_id': 'https://external.example/image.png'},
    {'avatar_media_id': '../outside'}, {'cover_sample': '../../outside'},
    {'cover_sample': 'https://external.example/cover.png'}, {'cover_sample': '/media/unknown.jpg'},
    {'cover_sample': 1}, {'cover_media_id': str(uuid.uuid4()), 'cover_sample': '/media/studio.jpg'},
])
def test_profile_rejects_urls_unknown_fields_invalid_ids_and_samples_without_mutation(h, patch):
    assert h[0].post('/api/creator/profile', json=patch).status_code == 422
    assert h[0].get('/api/creator/profile').json() == EMPTY


@pytest.mark.parametrize('kind,size,status', [('video/mp4', 100, 415), ('audio/wav', 100, 415),
    ('image/gif', 100, 415), ('image/heic', 100, 415), ('image/svg+xml', 100, 415),
    ('image/png', 0, 413), ('image/png', creator.PROFILE_IMAGE_MAX_BYTES + 1, 413)])
def test_profile_rejects_nonstatic_mime_and_oversize_media_ledger_rows(h, kind, size, status):
    client, factory, owner, _, _, _ = h
    identifier = str(uuid.uuid4())
    with factory() as session:
        session.add(CreatorMedia(id=identifier, owner_id=owner.id, content_type=kind, size=size)); session.commit()
    assert client.post('/api/creator/profile', json={'avatar_media_id': identifier}).status_code == status
    assert client.get('/api/creator/profile').json() == EMPTY


def test_profile_only_accepts_finalized_owned_media_and_does_not_expand_public_acl(h):
    client, factory, owner, other, _, state = h
    identifier = upload(h)
    save(h, avatar_media_id=identifier)
    state['user_id'] = other.id
    assert client.get('/api/creator/profile').json() == EMPTY
    assert client.get('/api/creator/bootstrap').json()['profile'] == EMPTY
    assert client.post('/api/creator/profile', json={'cover_media_id': identifier}).status_code == 404
    assert client.get('/api/creator/profile-images/' + identifier).status_code == 404
    assert client.get('/api/creator/media/' + identifier).status_code == 404
    # Generic published-media visibility remains unchanged, but the new owner
    # image endpoint still never serves another account's active artwork.
    with factory() as session:
        session.add(CreatorItem(owner_id=owner.id, data={'title': 'Explicitly published', 'media_id': identifier}, visibility='published'))
        session.commit()
    assert client.get('/api/creator/media/' + identifier).status_code == 200
    assert client.get('/api/creator/profile-images/' + identifier).status_code == 404
    assert client.post('/api/creator/profile', json={'avatar_media_id': str(uuid.uuid4())}).status_code == 404
    pending = str(uuid.uuid4())
    with factory() as session:
        session.add(creator.PendingUpload(id=pending, owner_id=other.id, content_type='image/png', size=len(PNG),
            filename='unfinished.png', expires_at=datetime.now(timezone.utc) + timedelta(minutes=10)))
        session.commit()
    assert client.post('/api/creator/profile', json={'avatar_media_id': pending}).status_code == 404


def test_auth_and_write_guard_are_required(h):
    client, _, _, _, _, state = h
    state['block_write'] = True
    assert client.post('/api/creator/profile', json={'cover_sample': '/media/studio.jpg'}).status_code == 403
    assert client.get('/api/creator/profile').status_code == 200
    state['user_id'] = None
    for path in ('/api/creator/profile', '/api/creator/config', '/api/creator/profile-images/' + str(uuid.uuid4())):
        assert client.get(path).status_code == 401
    assert client.post('/api/creator/profile', json={}).status_code == 401


def test_preferences_and_profile_writes_refresh_stale_json_before_merging(h):
    client, factory, owner, _, _, state = h
    first, cover, replacement = upload(h), upload(h), upload(h)
    save(h, avatar_media_id=first)
    with factory() as stale:
        cached = stale.get(CreatorPreferences, owner.id)
        assert cached.data['profile']['cover_media_id'] is None
        save(h, cover_media_id=cover)
        state['session'] = stale
        try:
            # An old client's stale profile field is ignored by PreferencesInput;
            # the endpoint merges current raw profile data under the same lock.
            response = client.post('/api/creator/preferences', json={'saved': ['a'], 'profile': {'avatar_media_id': None}})
            assert response.status_code == 200 and 'profile' not in response.json()
        finally:
            state['session'] = None
    assert client.get('/api/creator/profile').json()['cover_media_id'] == cover
    with factory() as stale:
        cached = stale.get(CreatorPreferences, owner.id)
        assert cached.data['profile']['avatar_media_id'] == first
        save(h, cover_sample='/media/dj.jpg')
        state['session'] = stale
        try:
            updated = save(h, avatar_media_id=replacement)
            assert updated['cover_sample'] == '/media/dj.jpg' and updated['cover_media_id'] is None
        finally:
            state['session'] = None
    assert client.get('/api/creator/bootstrap').json()['preferences']['saved'] == ['a']


def test_missing_or_corrupt_private_image_never_becomes_a_url_for_another_owner(h):
    client, factory, owner, other, _, _ = h
    foreign = str(uuid.uuid4())
    with factory() as session:
        session.add(CreatorMedia(id=foreign, owner_id=other.id, content_type='image/png', size=len(PNG)))
        session.add(CreatorPreferences(owner_id=owner.id, data={'profile': {'avatar_media_id': foreign}})); session.commit()
    assert client.get('/api/creator/profile').json() == EMPTY
    assert client.get('/api/creator/profile-images/' + foreign).status_code == 404


def test_profile_authorization_refreshes_stale_media_ownership(h):
    client, factory, owner, other, _, state = h
    identifier = upload(h); save(h, avatar_media_id=identifier)
    with factory() as stale:
        cached = stale.get(CreatorMedia, identifier)
        assert cached.owner_id == owner.id
        with factory() as changed:
            changed.get(CreatorMedia, identifier).owner_id = other.id
            changed.commit()
        state['session'] = stale
        try:
            assert client.get('/api/creator/profile').json() == EMPTY
            assert client.get('/api/creator/profile-images/' + identifier).status_code == 404
        finally:
            state['session'] = None


def test_static_container_checks_reject_animation_and_truncation(h):
    animated_png = PNG[:33] + (8).to_bytes(4, 'big') + b'acTL' + bytes(8) + bytes(4) + PNG[33:]
    animated_webp_payload = b'WEBP' + b'VP8X' + (10).to_bytes(4, 'little') + b'\x02' + bytes(9)
    animated_webp = b'RIFF' + len(animated_webp_payload).to_bytes(4, 'little') + animated_webp_payload
    for content, kind in ((animated_png, 'image/png'), (animated_webp, 'image/webp'),
                          (PNG[:-5], 'image/png'), (b'\xff\xd8\xff\xe0truncated', 'image/jpeg')):
        identifier = upload(h, content, kind)
        assert h[0].post('/api/creator/profile', json={'avatar_media_id': identifier}).status_code == 415
    assert h[0].get('/api/creator/profile').json() == EMPTY


def test_r2_profile_delivery_is_bounded_inline_and_closes_the_private_body(h, monkeypatch):
    client, _, owner, _, _, state = h
    identifier = upload(h); actual = save(h, avatar_media_id=identifier)
    bodies, requests = [], []
    class Body(BytesIO):
        reads = []
        def read(self, size=-1):
            self.reads.append(size)
            return super().read(size)
    class Client:
        def get_object(self, **kwargs):
            requests.append(kwargs)
            body = Body(PNG); bodies.append(body)
            return {'Body': body, 'ContentType': 'image/png'}
    class PrivateStorage:
        bucket = 'isolated-profile-fixture'
        client = Client()
    monkeypatch.setattr(creator, 'storage', lambda: PrivateStorage())
    response = client.get(urlsplit(actual['avatar_url']).path, follow_redirects=False)
    assert response.status_code == 200 and response.content == PNG
    assert 'location' not in response.headers
    assert requests == [{'Bucket': PrivateStorage.bucket, 'Key': object_key(owner.id, identifier), 'Range': f'bytes=0-{len(PNG)}'}]
    assert all(body.closed for body in bodies)
    assert all(0 < size <= creator.PROFILE_IMAGE_MAX_BYTES + 1 for body in bodies for size in body.reads)
    state['user_id'] = None
    assert client.get(urlsplit(actual['avatar_url']).path).status_code == 401
    assert len(requests) == 1


@pytest.mark.parametrize('failure,status', [('oversize', 409), ('type_changed', 409), ('read_error', 503)])
def test_private_object_changes_fail_safely_and_never_read_unbounded(h, monkeypatch, failure, status):
    client, _, _, _, _, _ = h
    identifier = upload(h); save(h, avatar_media_id=identifier)
    bodies = []
    class Body(BytesIO):
        def read(self, size=-1):
            assert size == len(PNG) + 1 and size <= creator.PROFILE_IMAGE_MAX_BYTES + 1
            if failure == 'read_error':
                raise RuntimeError('private-provider-secret-that-must-not-appear')
            return super().read(size)
    class Client:
        def get_object(self, **_kwargs):
            body = Body(PNG + bytes(1000) if failure == 'oversize' else PNG); bodies.append(body)
            return {'Body': body, 'ContentType': 'video/mp4' if failure == 'type_changed' else 'image/png'}
    class PrivateStorage:
        bucket = 'isolated-profile-fixture'
        client = Client()
    monkeypatch.setattr(creator, 'storage', lambda: PrivateStorage())
    response = client.get('/api/creator/profile-images/' + identifier, follow_redirects=False)
    assert response.status_code == status
    assert all(body.closed for body in bodies)
    assert 'private-provider-secret' not in response.text and 'location' not in response.headers


def test_existing_account_export_includes_private_profile_references(h):
    _, factory, owner, _, _, _ = h
    identifier = upload(h)
    profile = save(h, avatar_media_id=identifier, cover_sample='/media/studio.jpg')
    from account_services import export_account
    with factory() as session:
        exported = export_account(user=session.get(User, owner.id), session=session)
    assert exported['preferences']['profile'] == {key: profile[key] for key in ('avatar_media_id', 'cover_media_id', 'cover_sample')}
    assert exported['account']['id'] == owner.id


def test_profile_references_protect_catalogued_media_from_stale_cleanup_entries(h):
    _, factory, owner, _, backend, _ = h
    identifier = upload(h); save(h, avatar_media_id=identifier)
    with factory() as session:
        session.add(mobile_api.MediaDeletion(id=identifier)); session.commit()
        mobile_api.drain_media_deletions(session)
        assert backend.path(identifier).read_bytes() == PNG
        assert session.get(mobile_api.MediaDeletion, identifier) is not None
        # Completed account deletion removes both preferences and media rows;
        # its durable outbox is then allowed to remove the owned file.
        session.delete(session.get(CreatorPreferences, owner.id))
        session.delete(session.get(CreatorMedia, identifier)); session.commit()
        mobile_api.drain_media_deletions(session)
        assert not backend.path(identifier).exists()
        assert session.get(mobile_api.MediaDeletion, identifier) is None
