"""Visitor isolation, artwork authorization, public-import opt-in and media-tag consent."""
from types import SimpleNamespace
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import app as core
import creator
import profile_api as profiles
import profile_follows as following
from account_services import AccountState
from admin_services import AdminUserState


@pytest.fixture
def ctx(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    core.Base.metadata.create_all(engine)
    session = Session(engine, expire_on_commit=False)
    owner = core.User(name='Public creator', email='creator@example.test', password_hash='unused')
    viewer = core.User(name='Profile visitor', email='viewer@example.test', password_hash='unused')
    session.add_all((owner, viewer)); session.commit()
    actor = {'user': viewer}
    def user():
        if actor['user'] is None:
            raise HTTPException(401, 'Sign in')
        return actor['user']
    api = FastAPI(); api.include_router(profiles.router); api.include_router(following.router)
    api.dependency_overrides.update({core.db: lambda: session, core.current_user: user, core.guard: lambda: None})
    import social_api
    monkeypatch.setattr(social_api, 'build_hub', lambda user, db: {'providers': [], 'media': []})
    monkeypatch.setattr(creator, '_profile_image_bytes', lambda media: b'owned-image')
    with TestClient(api) as client:
        yield SimpleNamespace(client=client, session=session, owner=owner, viewer=viewer, actor=actor)
    session.close(); engine.dispose()


def post(ctx, owner=None, visibility='published'):
    item = creator.CreatorItem(owner_id=(owner or ctx.owner).id, visibility=visibility,
        data=creator.ItemInput(title='Original creation', visibility='draft' if visibility == 'draft' else 'published').model_dump(mode='json'))
    ctx.session.add(item); ctx.session.commit()
    return item


def test_visitor_only_receives_published_posts_and_no_private_collections(ctx):
    public = post(ctx)
    post(ctx, visibility='draft'); post(ctx, visibility='hidden'); post(ctx, owner=ctx.viewer)
    ctx.session.add(creator.CreatorPreferences(owner_id=ctx.owner.id, data={'saved': ['private-bookmark'],
        'profile': {}, 'liked': ['private-like']})); ctx.session.commit()
    response = ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}')
    assert response.status_code == 200
    value = response.json()
    assert [item['id'] for item in value['items']] == [public.id]
    assert value['creator'] == {'id': ctx.owner.id, 'name': ctx.owner.name}
    assert value['sharing'] is None and value['saved_private'] is True
    assert 'email' not in value['creator']
    assert 'private-bookmark' not in response.text and 'private-like' not in response.text
    assert 'no-store' in response.headers['cache-control']


@pytest.mark.parametrize('privacy', ['private'])
def test_private_profile_and_its_post_are_hidden(ctx, privacy):
    item = post(ctx)
    ctx.session.add(AccountState(owner_id=ctx.owner.id, privacy={'profile_visibility': privacy})); ctx.session.commit()
    restricted = ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').json()
    assert restricted['access'] == 'followers_only' and restricted['items'] == [] and restricted['audience'] is None
    assert ctx.client.get(f'/api/creator/items/{item.id}').status_code == 404
    ctx.actor['user'] = ctx.owner
    assert len(ctx.client.get('/api/creator/profile/collections').json()['items']) == 1


@pytest.mark.parametrize('direction', ['viewer', 'owner'])
def test_blocks_hide_profile_both_directions(ctx, direction):
    blocker = ctx.viewer if direction == 'viewer' else ctx.owner
    blocked = ctx.owner if direction == 'viewer' else ctx.viewer
    ctx.session.add(creator.CreatorPreferences(owner_id=blocker.id, data={'blocked_user_ids': [blocked.id]})); ctx.session.commit()
    assert ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').status_code == 404


def test_artwork_is_current_owned_image_and_rechecks_privacy(ctx):
    image = creator.CreatorMedia(id=str(uuid.uuid4()), owner_id=ctx.owner.id, content_type='image/png', size=11)
    unrelated = creator.CreatorMedia(id=str(uuid.uuid4()), owner_id=ctx.viewer.id, content_type='image/png', size=11)
    ctx.session.add_all((image, unrelated)); ctx.session.flush()
    ctx.session.add(creator.CreatorPreferences(owner_id=ctx.owner.id, data={'profile': {'avatar_media_id': image.id}})); ctx.session.commit()
    value = ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').json()
    url = value['profile']['avatar_url']
    assert ctx.client.get(url).content == b'owned-image'
    assert ctx.client.get(f'/api/creator/profile-images/{ctx.owner.id}/{unrelated.id}').status_code == 404
    ctx.session.add(AccountState(owner_id=ctx.owner.id, privacy={'profile_visibility': 'private'})); ctx.session.commit()
    assert ctx.client.get(url).status_code == 404


def test_tag_requires_original_author_and_target_review_then_can_be_removed(ctx):
    item = post(ctx)
    url = f'/api/creator/profiles/{ctx.viewer.id}/tags'
    assert ctx.client.post(url, json={'item_id': item.id}).status_code == 404
    ctx.actor['user'] = ctx.owner
    assert ctx.client.post(url, json={'item_id': item.id}).json()['status'] == 'pending'
    assert ctx.client.post(url, json={'item_id': item.id}).json()['revision'] == 1
    assert ctx.client.get(f'/api/creator/profiles/{ctx.viewer.id}').json()['tagged'] == []
    ctx.actor['user'] = ctx.viewer
    pending = ctx.client.get('/api/creator/profile/collections').json()['pending_tags']
    assert pending[0]['item']['id'] == item.id
    review = f'/api/creator/profile/tags/{item.id}'
    assert ctx.client.post(review, json={'accepted': True, 'revision': 1}).json()['status'] == 'accepted'
    assert ctx.client.post(review, json={'accepted': False, 'revision': 1}).status_code == 409
    assert ctx.client.get(f'/api/creator/profiles/{ctx.viewer.id}').json()['tagged'][0]['id'] == item.id
    assert ctx.client.post(review, json={'accepted': False, 'revision': 2}).json()['status'] == 'dismissed'
    assert ctx.client.get(f'/api/creator/profiles/{ctx.viewer.id}').json()['tagged'] == []


def test_tag_does_not_bypass_withdrawn_source_visibility(ctx):
    item = post(ctx)
    ctx.session.add(profiles.ProfileMediaTag(owner_id=ctx.viewer.id, item_id=item.id, status='accepted')); ctx.session.commit()
    assert len(ctx.client.get(f'/api/creator/profiles/{ctx.viewer.id}').json()['tagged']) == 1
    item.visibility = 'draft'; ctx.session.commit()
    assert ctx.client.get(f'/api/creator/profiles/{ctx.viewer.id}').json()['tagged'] == []


def test_import_sharing_is_opt_in_revisioned_and_revocable(ctx, monkeypatch):
    import social_api
    hub = {'providers': [{'provider': 'bluesky', 'name': 'Bluesky', 'can_sync': True,
        'capabilities': {'public_feed': True}, 'sync_error': 'private connection diagnostic'}],
        'media': [{'id': 'bsky:post', 'provider': 'bluesky', 'title': 'Public post'}]}
    monkeypatch.setattr(social_api, 'build_hub', lambda user, db: hub)
    monkeypatch.setattr(social_api, 'providers_for', lambda user, db: hub['providers'])
    assert ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').json()['network']['media'] == []
    ctx.actor['user'] = ctx.owner
    assert ctx.client.get('/api/creator/profile/collections').json()['network']['media']
    body = {'providers': ['bluesky'], 'revision': 0}
    assert ctx.client.post('/api/creator/profile/network-sharing', json=body).status_code == 200
    assert ctx.client.post('/api/creator/profile/network-sharing', json=body).status_code == 409
    ctx.actor['user'] = ctx.viewer
    result = ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}')
    assert result.json()['network']['media'] and 'private connection diagnostic' not in result.text
    ctx.actor['user'] = ctx.owner
    assert ctx.client.post('/api/creator/profile/network-sharing', json={'providers': [], 'revision': 1}).status_code == 200
    ctx.actor['user'] = ctx.viewer
    assert ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').json()['network']['media'] == []


def test_unconfigured_imports_cannot_be_shared_or_spoofed(ctx):
    ctx.actor['user'] = ctx.owner
    for providers in (['twitch'], ['instagram'], ['unknown'], ['bluesky', 'bluesky']):
        assert ctx.client.post('/api/creator/profile/network-sharing', json={'providers': providers, 'revision': 0}).status_code in (409, 422)


def test_suspended_or_signed_out_visitors_cannot_read_profile(ctx):
    ctx.session.add(AdminUserState(user_id=ctx.owner.id, status='suspended'))
    ctx.session.commit()
    assert ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').status_code == 404
    ctx.actor['user'] = None
    assert ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').status_code == 401


def test_followers_only_requires_owner_approval_and_removal_revokes_media_access(ctx):
    item = post(ctx)
    ctx.session.add(AccountState(owner_id=ctx.owner.id, privacy={'profile_visibility': 'private'})); ctx.session.commit()
    endpoint = f'/api/creator/profiles/{ctx.owner.id}/follow'
    assert ctx.client.post(endpoint, json={'revision': 0}).json()['status'] == 'pending'
    assert ctx.client.get(f'/api/creator/items/{item.id}').status_code == 404
    ctx.actor['user'] = ctx.owner
    requests = ctx.client.get('/api/creator/profile/followers').json()['followers']
    assert requests[0]['id'] == ctx.viewer.id and requests[0]['status'] == 'pending'
    review = f'/api/creator/profile/followers/{ctx.viewer.id}'
    assert ctx.client.post(review, json={'revision': 1, 'accepted': True}).json()['status'] == 'accepted'
    ctx.actor['user'] = ctx.viewer
    assert ctx.client.get(f'/api/creator/items/{item.id}').status_code == 200
    receipt = ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').json()
    assert receipt['access'] == 'allowed' and receipt['audience']['followers'] == 1
    ctx.actor['user'] = ctx.owner
    assert ctx.client.post(review, json={'revision': 1, 'accepted': False}).status_code == 409
    assert ctx.client.post(review, json={'revision': 2, 'accepted': False}).json()['status'] == 'declined'
    ctx.actor['user'] = ctx.viewer
    assert ctx.client.get(f'/api/creator/items/{item.id}').status_code == 404
    assert ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').json()['items'] == []


def test_public_follow_counts_are_exact_and_unfollow_does_not_restore_private_access(ctx):
    route = f'/api/creator/profiles/{ctx.owner.id}'
    assert ctx.client.post(route + '/follow', json={'revision': 0}).json()['status'] == 'accepted'
    assert ctx.client.post(route + '/follow', json={'revision': 1}).json()['status'] == 'accepted'
    assert ctx.client.get(route).json()['audience']['followers'] == 1
    ctx.session.add(AccountState(owner_id=ctx.owner.id, privacy={'profile_visibility': 'private'})); ctx.session.commit()
    assert ctx.client.get(route).json()['access'] == 'allowed'
    assert ctx.client.post(route + '/unfollow', json={'revision': 1}).json()['status'] == 'cancelled'
    assert ctx.client.get(route).json()['access'] == 'followers_only'
    assert ctx.client.post(route + '/follow', json={'revision': 2}).json()['status'] == 'pending'


def test_profile_lock_persists_privacy_and_rejects_stale_changes(ctx):
    ctx.actor['user'] = ctx.owner
    response = ctx.client.post('/api/creator/profile/privacy', json={'private': True, 'expected_visibility': 'public', 'revision': 0})
    assert response.status_code == 200 and response.json() == {'visibility': 'private', 'revision': 1}
    assert ctx.client.get('/api/creator/profile/collections').json()['privacy']['visibility'] == 'private'
    assert ctx.client.post('/api/creator/profile/privacy', json={'private': False, 'expected_visibility': 'public', 'revision': 0}).status_code == 409
    ctx.actor['user'] = ctx.viewer
    assert ctx.client.get(f'/api/creator/profiles/{ctx.owner.id}').json()['access'] == 'followers_only'


@pytest.mark.parametrize('by_name', [False, True])
def test_block_revokes_follow_and_unblock_requires_new_approval(ctx, by_name):
    route = f'/api/creator/profiles/{ctx.owner.id}'
    assert ctx.client.post(route + '/follow', json={'revision': 0}).json()['status'] == 'accepted'
    ctx.session.add(AccountState(owner_id=ctx.owner.id, privacy={'profile_visibility': 'private'})); ctx.session.commit()
    block = {'blocked_creators': [ctx.viewer.name]} if by_name else {'blocked_user_ids': [ctx.viewer.id]}
    creator.preferences(creator.PreferencesInput(**block), ctx.owner, ctx.session)
    assert ctx.client.get(route).status_code == 404
    creator.preferences(creator.PreferencesInput(), ctx.owner, ctx.session)
    result = ctx.client.get(route).json()
    assert result['access'] == 'followers_only' and result['relationship']['status'] == 'none'
    assert ctx.client.post(route + '/follow', json={'revision': 0}).json()['status'] == 'pending'


def test_follower_approval_and_revocation_protect_selected_artwork(ctx):
    image = creator.CreatorMedia(id=str(uuid.uuid4()), owner_id=ctx.owner.id, content_type='image/png', size=11)
    ctx.session.add(image); ctx.session.flush()
    ctx.session.add(creator.CreatorPreferences(owner_id=ctx.owner.id, data={'profile': {'avatar_media_id': image.id}}))
    ctx.session.add(AccountState(owner_id=ctx.owner.id, privacy={'profile_visibility': 'private'})); ctx.session.commit()
    image_url = f'/api/creator/profile-images/{ctx.owner.id}/{image.id}'
    route = f'/api/creator/profiles/{ctx.owner.id}/follow'
    assert ctx.client.post(route, json={'revision': 0}).status_code == 200
    assert ctx.client.get(image_url).status_code == 404
    ctx.actor['user'] = ctx.owner
    review = f'/api/creator/profile/followers/{ctx.viewer.id}'
    assert ctx.client.post(review, json={'revision': 1, 'accepted': True}).status_code == 200
    ctx.actor['user'] = ctx.viewer
    assert ctx.client.get(image_url).content == b'owned-image'
    ctx.actor['user'] = ctx.owner
    assert ctx.client.post(review, json={'revision': 2, 'accepted': False}).status_code == 200
    ctx.actor['user'] = ctx.viewer
    assert ctx.client.get(image_url).status_code == 404


def test_external_audience_uses_reported_counts_not_bounded_following_list():
    import social_api
    profile = {'did': 'did:plc:abcdefghijklmnopqrstuvwx', 'followersCount': 1500, 'followsCount': 0}
    following = {'follows': [{'did': 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'handle': 'artist.bsky.social'}]}
    result = social_api.normalize_snapshot(profile, {'feed': []}, following)
    assert result['audience'] == {'followers': 1500, 'following': 0}
    profile.pop('followersCount'); profile.pop('followsCount')
    assert 'audience' not in social_api.normalize_snapshot(profile, {'feed': []}, following)


def test_creation_timestamps_preserve_utc_when_local_storage_omits_the_offset(ctx):
    from datetime import datetime
    item = post(ctx)
    item.created_at = datetime(2026, 10, 29, 12, 0)
    ctx.session.commit()
    result = ctx.client.get(f'/api/creator/items/{item.id}').json()
    assert result['created_at'] == '2026-10-29T12:00:00+00:00'


@pytest.mark.parametrize('invalid', [True, -1, '1500', 12.0, 9007199254740992, None])
def test_external_audience_does_not_turn_invalid_values_into_counts(invalid):
    import social_api
    profile = {'did': 'did:plc:abcdefghijklmnopqrstuvwx', 'followersCount': invalid, 'followsCount': invalid}
    assert 'audience' not in social_api.normalize_snapshot(profile, {'feed': []}, {'follows': []})
