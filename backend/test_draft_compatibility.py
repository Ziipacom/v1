"""Shared-draft edits retain fields that older Ziipa clients do not send."""
import base64

import pytest

from test_api import client, register_creator
from app import app, db
from creator import CreatorItem


def session_for_test():
    return next(app.dependency_overrides[db]())


@pytest.fixture
def creation(client, tmp_path, monkeypatch):
    import creator
    monkeypatch.setattr(creator, 'MEDIA_ROOT', tmp_path)
    register_creator(client)
    image = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')
    media = client.post('/api/creator/media', content=image, headers={'Content-Type': 'image/png'}).json()
    audio = client.post('/api/creator/media', content=b'ID3' + bytes(128), headers={'Content-Type': 'audio/mpeg'}).json()
    data = {
        'title': 'Shared studio draft', 'description': 'Created with mobile tools',
        'category': 'store', 'media_id': media['id'], 'tags': ['studio'], 'city': 'Miami',
        'trim_start': 2, 'trim_end': 12, 'price_cents': 350,
        'captions': [{'start': 2, 'end': 4, 'text': 'First caption'},
                     {'start': 5, 'end': 9, 'text': 'Second caption'}],
        'overlays': [{'id': 'headline', 'text': 'Made with Ziipa', 'position': 'top', 'theme': 'lime'}],
        'soundtrack': {'media_id': audio['id'], 'name': 'Original music', 'volume': 0.4, 'start': 1},
        'distribution_targets': ['bluesky', 'instagram'],
    }
    response = client.post('/api/creator/items', json=data)
    assert response.status_code == 201
    return response.json()


def saved(client, item_id):
    return next(item for item in client.get('/api/creator/bootstrap').json()['drafts'] if item['id'] == item_id)


def test_old_client_edit_preserves_mobile_only_fields(client, creation):
    # The legacy portal still submits common fields but has no knowledge of
    # overlays, soundtrack, captions or distribution destinations in this edit.
    result = client.post(f"/api/creator/items/{creation['id']}", json={
        'title': 'Updated on the web', 'description': 'A portal edit',
        'category': 'store', 'city': 'Tampa', 'tags': ['new'],
        'media_id': creation['media_id'], 'visibility': 'draft',
        'trim_start': 2, 'trim_end': 12, 'price_cents': 450,
    })
    assert result.status_code == 200
    actual = saved(client, creation['id'])
    assert actual['title'] == 'Updated on the web'
    assert actual['city'] == 'Tampa'
    for name in ('overlays', 'soundtrack', 'captions', 'distribution_targets'):
        assert actual[name] == creation[name]
    assert len(actual['captions']) == 2


def test_new_client_can_replace_complete_editor_fields(client, creation):
    changes = {
        'title': 'Updated with the current editor',
        'overlays': [{'id': 'new', 'text': 'New overlay', 'position': 'bottom', 'theme': 'purple'}],
        'captions': [{'start': 3, 'end': 6, 'text': 'One replacement caption'}],
        'soundtrack': {**creation['soundtrack'], 'volume': 0.8},
        'distribution_targets': ['youtube'],
    }
    result = client.post(f"/api/creator/items/{creation['id']}", json=changes)
    assert result.status_code == 200
    actual = saved(client, creation['id'])
    for name, value in changes.items():
        assert actual[name] == value
    assert actual['description'] == creation['description']
    assert actual['media_id'] == creation['media_id']


def test_explicit_empty_arrays_and_null_clear_supported_fields(client, creation):
    result = client.post(f"/api/creator/items/{creation['id']}", json={
        'title': 'Intentionally cleared', 'overlays': [], 'captions': [],
        'distribution_targets': [], 'tags': [], 'soundtrack': None, 'media_id': None,
        'trim_end': None, 'price_cents': None, 'remix_of': None,
    })
    assert result.status_code == 200
    actual = saved(client, creation['id'])
    for name in ('overlays', 'captions', 'distribution_targets', 'tags'):
        assert actual[name] == []
    for name in ('soundtrack', 'media_id', 'trim_end', 'price_cents', 'remix_of'):
        assert actual[name] is None
    assert actual['trim_start'] == creation['trim_start']


def test_omitted_visibility_preserves_published_column(client, creation):
    published = client.post(f"/api/creator/items/{creation['id']}", json={
        'title': creation['title'], 'visibility': 'published',
    })
    assert published.status_code == 200
    # Treat the persisted visibility column as authoritative even if legacy
    # JSON has stale visibility. An omitted default must not unpublish a post.
    session = session_for_test()
    row = session.get(CreatorItem, creation['id'])
    row.data = {**row.data, 'visibility': 'draft'}
    session.commit()
    updated = client.post(f"/api/creator/items/{creation['id']}", json={'title': 'Still published'})
    assert updated.status_code == 200
    assert updated.json()['visibility'] == 'published'
    assert saved(client, creation['id'])['visibility'] == 'published'


def test_invalid_merged_values_are_rejected_without_changes(client, creation):
    # End=1 is valid against incoming default start=0, but not stored start=2.
    result = client.post(f"/api/creator/items/{creation['id']}", json={'title': 'Must not save', 'trim_end': 1})
    assert result.status_code == 422
    actual = saved(client, creation['id'])
    assert actual['title'] == creation['title']
    assert actual['trim_end'] == 12
    # A legacy invalid stored value cannot bypass full-model validation merely
    # because the updating client omitted the invalid field.
    session = session_for_test()
    row = session.get(CreatorItem, creation['id'])
    row.data = {**row.data, 'overlays': [{'id': 'bad', 'text': '', 'position': 'top'}]}
    session.commit()
    assert client.post(f"/api/creator/items/{creation['id']}", json={'title': 'Also must not save'}).status_code == 422
    session.expire_all()
    assert session.get(CreatorItem, creation['id']).data['title'] == creation['title']


def test_clearing_media_does_not_bypass_publishing_requirements(client, creation):
    result = client.post(f"/api/creator/items/{creation['id']}", json={
        'title': creation['title'], 'visibility': 'published', 'media_id': None,
    })
    assert result.status_code == 422
    actual = saved(client, creation['id'])
    assert actual['visibility'] == 'draft'
    assert actual['media_id'] == creation['media_id']


def test_other_owner_cannot_edit_or_reuse_preserved_media(client, creation):
    client.cookies.clear()
    register_creator(client, 'other-draft-owner@example.com')
    assert client.post(f"/api/creator/items/{creation['id']}", json={'title': 'Unauthorized change'}).status_code == 404
    other = client.post('/api/creator/items', json={'title': 'Other draft'}).json()
    session = session_for_test()
    other_row = session.get(CreatorItem, other['id'])
    # Even if a legacy/imported draft refers to another user's media, merging
    # cannot skip the ordinary ownership check on an omitted media field.
    other_row.data = {**other_row.data, 'media_id': creation['media_id']}
    session.commit()
    assert client.post(f"/api/creator/items/{other['id']}", json={'title': 'Do not accept foreign media'}).status_code == 404
    other_row.data = {**other_row.data, 'media_id': None, 'soundtrack': creation['soundtrack']}
    session.commit()
    assert client.post(f"/api/creator/items/{other['id']}", json={'title': 'Do not accept foreign audio'}).status_code == 404


def test_hidden_content_cannot_be_restored_by_omitted_fields(client, creation):
    session = session_for_test()
    row = session.get(CreatorItem, creation['id'])
    row.visibility = 'hidden'
    session.commit()
    assert client.post(f"/api/creator/items/{creation['id']}", json={'title': 'Restore', 'visibility': 'published'}).status_code == 403
    session.expire_all()
    assert session.get(CreatorItem, creation['id']).visibility == 'hidden'


def test_new_drafts_still_use_creation_defaults(client):
    register_creator(client)
    assert client.post('/api/creator/items', json={}).status_code == 422
    created = client.post('/api/creator/items', json={'title': 'New minimal draft'})
    assert created.status_code == 201
    actual = created.json()
    assert actual['visibility'] == 'draft'
    assert actual['overlays'] == [] and actual['captions'] == []
    assert actual['distribution_targets'] == [] and actual['soundtrack'] is None
