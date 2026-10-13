"""Private Media OS tests use an isolated rollback database and no external services."""
from datetime import datetime, timedelta, timezone
import uuid

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, guard
from creator import CreatorComment, CreatorDistribution, CreatorItem, CreatorMedia, CreatorPreferences
import personal_media as os_api


@pytest.fixture
def workspace():
    # Memory deletion also redacts its completed Assistant proposal history.
    import assistant_api
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(bind=connection, join_transaction_mode='create_savepoint')
        owner = User(name='Library owner', email='owner@example.test', password_hash='unused')
        stranger = User(name='Other owner', email='other@example.test', password_hash='unused')
        session.add_all([owner, stranger]); session.flush()
        media = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=123)
        other_media = CreatorMedia(id=str(uuid.uuid4()), owner_id=stranger.id, content_type='image/png', size=456)
        item = CreatorItem(owner_id=owner.id, data={'title': 'Concert camera', 'description': 'Original live footage',
                                                   'category': 'video', 'media_id': media.id, 'tags': ['music']})
        other_item = CreatorItem(owner_id=stranger.id, data={'title': 'Private other', 'category': 'video', 'media_id': other_media.id})
        session.add_all([media, other_media, item, other_item]); session.commit()
        acting = {'user': owner, 'guard_calls': 0}
        application = FastAPI()
        application.include_router(os_api.router)
        def test_db():
            yield session
        def test_user():
            if acting['user'] is None:
                raise HTTPException(401, 'Please sign in')
            return acting['user']
        def test_guard(request: Request):
            acting['guard_calls'] += 1
            if request.headers.get('origin') == 'https://untrusted.test':
                raise HTTPException(403, 'Untrusted origin')
        application.dependency_overrides.update({db: test_db, current_user: test_user, guard: test_guard})
        with TestClient(application) as client:
            yield client, session, owner, stranger, acting, item, other_item
        session.close()
        transaction.rollback()
    engine.dispose()


def project(client, item_id=None):
    result = client.post('/api/os/projects', json={'name': 'Release campaign', 'asset_ids': [item_id] if item_id else []})
    assert result.status_code == 201, result.text
    return result.json()


def memory(client, body='Use purple captions'):
    result = client.post('/api/os/memories', json={'kind': 'style', 'body': body})
    assert result.status_code == 201, result.text
    return result.json()


def test_private_library_default_rights_search_and_project_filter(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    value = client.get('/api/os/library').json()
    assert [entry['id'] for entry in value['items']] == [item.id]
    assert len(value['media']) == 1
    metadata = value['items'][0]['metadata']
    assert metadata['revision'] == 0
    assert metadata['rights']['basis'] == 'unknown'
    assert metadata['rights']['effective_allow_ai'] is False
    assert client.get('/api/os/library?q=CONCERT').json()['items'][0]['id'] == item.id
    assert client.get('/api/os/library?q=not-found').json()['items'] == []
    campaign = project(client, item.id)
    assert client.get('/api/os/library', params={'project_id': campaign['id']}).json()['items'][0]['id'] == item.id
    blank_campaign = project(client)
    assert client.get('/api/os/library', params={'project_id': blank_campaign['id']}).json()['items'] == []
    acting['user'] = stranger
    assert client.get('/api/os/library', params={'project_id': campaign['id']}).status_code == 404
    assert [entry['id'] for entry in client.get('/api/os/library').json()['items']] == [other_item.id]
    acting['user'] = None
    assert client.get('/api/os/library').status_code == 401


def test_metadata_revision_rights_expiry_and_owner_isolation(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    campaign = project(client)
    expires = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    payload = {'revision': 0, 'notes': '  Permission from venue  ', 'tags': ['concert', 'concert'],
               'project_id': campaign['id'], 'rights': {'basis': 'permission', 'license_note': 'One-day grant',
                 'source_url': 'https://example.test/license', 'expires_at': expires, 'allow_ai': True}}
    saved = client.put(f'/api/os/assets/{item.id}/metadata', json=payload)
    assert saved.status_code == 200
    value = saved.json()
    assert value['revision'] == 1 and value['notes'] == 'Permission from venue' and value['tags'] == ['concert']
    assert value['rights']['expired'] is True and value['rights']['effective_allow_ai'] is False
    assert client.put(f'/api/os/assets/{item.id}/metadata', json=payload).status_code == 409
    payload['revision'] = 1
    payload['rights']['expires_at'] = None
    saved = client.put(f'/api/os/assets/{item.id}/metadata', json=payload)
    assert saved.json()['rights']['effective_allow_ai'] is True
    assert saved.json()['revision'] == 2
    assert client.get('/api/os/library', params={'project_id': campaign['id']}).json()['items'][0]['id'] == item.id
    acting['user'] = stranger
    assert client.put(f'/api/os/assets/{item.id}/metadata', json=payload).status_code == 404
    payload['project_id'] = campaign['id']; payload['revision'] = 0
    assert client.put(f'/api/os/assets/{other_item.id}/metadata', json=payload).status_code == 404


@pytest.mark.parametrize('rights', [
    {'basis': 'unknown', 'allow_ai': True},
    {'source_url': 'http://example.test/license'},
    {'source_url': 'https://user:password@example.test/license'},
    {'source_url': 'javascript:alert(1)'},
    {'expires_at': '2026-10-01T00:00:00'},
])
def test_invalid_rights_never_saved(workspace, rights):
    client, session, owner, stranger, acting, item, other_item = workspace
    assert client.put(f'/api/os/assets/{item.id}/metadata', json={'revision': 0, 'rights': rights}).status_code == 422
    assert session.scalars(select(os_api.OSAssetMetadata)).all() == []


def test_memory_can_inspect_correct_and_forget_without_body_in_activity(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    original = memory(client, 'An explicit personal preference')
    assert client.get('/api/os/memories').json() == [original]
    assert client.patch(f"/api/os/memories/{original['id']}", json={'revision': 1, 'body': 'Corrected preference'}).json()['revision'] == 2
    assert client.patch(f"/api/os/memories/{original['id']}", json={'revision': 1, 'body': 'Stale edit'}).status_code == 409
    assert client.delete(f"/api/os/memories/{original['id']}?revision=1").status_code == 409
    acting['user'] = stranger
    assert client.get('/api/os/memories').json() == []
    assert client.patch(f"/api/os/memories/{original['id']}", json={'revision': 2, 'body': 'Intrusion'}).status_code == 404
    assert client.delete(f"/api/os/memories/{original['id']}").status_code == 404
    acting['user'] = owner
    assert client.delete(f"/api/os/memories/{original['id']}?revision=2").json() == {'deleted': True}
    assert client.get('/api/os/memories').json() == []
    exported = client.get('/api/os/export').json()
    assert exported['memories'] == []
    assert 'Corrected preference' not in str(exported['activity'])
    assert 'An explicit personal preference' not in str(exported['activity'])


@pytest.mark.parametrize('payload', [
    {'kind': 'style', 'body': '   '},
    {'kind': 'style', 'body': 'valid', 'source': 'inferred'},
    {'kind': 'sensitive_fact', 'body': 'valid'},
    {'kind': 'context', 'body': 'x' * 2001},
])
def test_only_explicit_bounded_memory_is_accepted(workspace, payload):
    client, *_ = workspace
    assert client.post('/api/os/memories', json=payload).status_code == 422
    assert client.get('/api/os/memories').json() == []


def test_projects_revisions_and_removing_group_preserves_assets_and_goals(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    assert client.post('/api/os/projects', json={'name': 'Intrusion', 'asset_ids': [other_item.id]}).status_code == 404
    campaign = project(client, item.id)
    patch = {'revision': 1, 'description': 'Organize footage', 'status': 'paused'}
    assert client.patch(f"/api/os/projects/{campaign['id']}", json=patch).json()['revision'] == 2
    assert client.patch(f"/api/os/projects/{campaign['id']}", json=patch).status_code == 409
    goal = client.post('/api/os/goals', json={'title': 'Make clips', 'project_id': campaign['id']}).json()
    metadata = client.put(f'/api/os/assets/{item.id}/metadata', json={'revision': 0, 'project_id': campaign['id']}).json()
    acting['user'] = stranger
    assert client.patch(f"/api/os/projects/{campaign['id']}", json={'revision': 2, 'name': 'Intrusion'}).status_code == 404
    assert client.delete(f"/api/os/projects/{campaign['id']}").status_code == 404
    acting['user'] = owner
    assert client.delete(f"/api/os/projects/{campaign['id']}?revision=2").status_code == 200
    assert client.get('/api/os/goals').json()[0]['project_id'] is None
    value = client.get('/api/os/library').json()['items'][0]['metadata']
    assert value['project_id'] is None and value['revision'] == metadata['revision'] + 1
    assert session.get(CreatorItem, item.id) is not None


def test_goal_progress_is_checked_steps_not_claimed_completion(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    goal = client.post('/api/os/goals', json={'title': 'Release', 'status': 'completed',
                           'steps': [{'id': 'record', 'title': 'Record', 'completed': True},
                                     {'id': 'edit', 'title': 'Edit'}]}).json()
    assert goal['progress'] == {'completed': 1, 'total': 2, 'percent': 50}
    value = client.patch(f"/api/os/goals/{goal['id']}", json={'revision': 1,
                           'steps': [{'id': 'record', 'title': 'Record', 'completed': True},
                                     {'id': 'edit', 'title': 'Edit', 'completed': True}]}).json()
    assert value['progress']['percent'] == 100
    assert client.patch(f"/api/os/goals/{goal['id']}", json={'revision': 1, 'status': 'active'}).status_code == 409
    assert client.post('/api/os/goals', json={'title': 'Invalid', 'steps': [{'id': 'a', 'title': 'one'}, {'id': 'a', 'title': 'two'}]}).status_code == 422
    assert client.post('/api/os/goals', json={'title': 'Invalid date', 'due_at': '2026-10-12T12:00:00'}).status_code == 422
    campaign = project(client)
    assert client.patch(f"/api/os/projects/{campaign['id']}", json={'revision': 1, 'goal_ids': [goal['id']]}).status_code == 200
    acting['user'] = stranger
    assert client.patch(f"/api/os/goals/{goal['id']}", json={'revision': 2, 'title': 'Intrusion'}).status_code == 404
    acting['user'] = owner
    assert client.delete(f"/api/os/goals/{goal['id']}?revision=2").status_code == 200
    assert client.get('/api/os/projects').json()[0]['goal_ids'] == []


def test_revenue_separates_currencies_expected_and_actual_with_truthful_provenance(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    stamp = datetime.now(timezone.utc).isoformat()
    entries = [('USD', 'income', 'received', 1000), ('USD', 'expense', 'received', 250),
               ('USD', 'income', 'expected', 500), ('USD', 'expense', 'expected', 100),
               ('EUR', 'income', 'received', 300)]
    ids = []
    for currency, direction, state, amount in entries:
        result = client.post('/api/os/revenue', json={'currency': currency, 'type': direction, 'status': state,
                              'amount_minor': amount, 'occurred_at': stamp, 'item_id': item.id})
        assert result.status_code == 201
        assert result.json()['provenance'] == 'user_reported'
        ids.append(result.json()['id'])
    result = client.get('/api/os/insights').json()
    currencies = {row['currency']: row for row in result['economics']}
    assert currencies['USD']['realized_income_minor'] == 1000
    assert currencies['USD']['realized_cost_minor'] == 250
    assert currencies['USD']['realized_net_minor'] == 750
    assert currencies['USD']['expected_net_minor'] == 400
    assert currencies['EUR']['realized_net_minor'] == 300
    assert all(row['verified_payments'] is False for row in currencies.values())
    assert result['engagement']['views'] is None
    assert result['engagement']['external_analytics_available'] is False
    assert client.post('/api/os/revenue', json={'currency': 'USD', 'type': 'income', 'amount_minor': -1, 'occurred_at': stamp}).status_code == 422
    assert client.post('/api/os/revenue', json={'currency': 'usd', 'type': 'income', 'amount_minor': 1, 'occurred_at': stamp}).status_code == 422
    acting['user'] = stranger
    assert client.get('/api/os/revenue').json() == []
    assert client.get('/api/os/insights').json()['economics'] == []
    assert client.delete(f'/api/os/revenue/{ids[0]}').status_code == 404
    assert client.post('/api/os/revenue', json={'currency': 'USD', 'type': 'income', 'amount_minor': 1,
                              'occurred_at': stamp, 'item_id': item.id}).status_code == 404
    acting['user'] = owner
    assert client.delete(f'/api/os/revenue/{ids[0]}').status_code == 200


def test_insights_use_owned_items_and_actual_local_engagement_delivery_records(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    session.add(CreatorPreferences(owner_id=owner.id, data={'liked': [item.id, other_item.id], 'saved': [item.id]}))
    session.add(CreatorPreferences(owner_id=stranger.id, data={'liked': [item.id, item.id], 'saved': [other_item.id]}))
    session.add(CreatorComment(owner_id=stranger.id, item_id=item.id, body='A local comment'))
    session.add(CreatorComment(owner_id=owner.id, item_id=other_item.id, body='Another local comment'))
    session.add(CreatorDistribution(owner_id=owner.id, item_id=item.id, provider='tiktok', status='connection_required'))
    session.add(CreatorDistribution(owner_id=stranger.id, item_id=other_item.id, provider='youtube', status='published'))
    session.commit()
    value = client.get('/api/os/insights').json()
    assert value['library']['items'] == 1
    assert value['engagement']['comments'] == 1
    assert value['engagement']['likes'] == 2
    assert value['engagement']['saves'] == 1
    assert value['publishing']['total'] == 1
    assert value['publishing']['by_status'] == {'connection_required': 1}
    assert value['rendering']['total'] == 0


def test_activity_redaction_export_and_account_cleanup_are_owner_scoped(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    project(client, item.id)
    memory(client, 'Private creative style')
    os_api.record_activity(session, owner.id, 'assistant.result', 'Prepared a draft', details={
        'item_id': item.id, 'count': 2, 'access_token': 'must-not-leak', 'password': 'must-not-leak',
        'body': 'Private creative style', 'snapshot': {'secret': 'must-not-leak'}})
    session.commit()
    activity = client.get('/api/os/activity').json()
    assert 'must-not-leak' not in str(activity) and 'Private creative style' not in str(activity)
    assert any(row['details'].get('item_id') == item.id for row in activity)
    exported = os_api.export_os_data(session, owner.id)
    assert len(exported['projects']) == 1 and len(exported['memories']) == 1
    acting['user'] = stranger
    other_memory = memory(client, 'Other private style')
    assert len(client.get('/api/os/activity').json()) == 1
    os_api.delete_os_data(session, owner.id)
    assert os_api.export_os_data(session, owner.id) == {key: [] for key in exported}
    assert session.get(os_api.OSMemory, other_memory['id']) is not None
    # Helper participates in its caller's transaction instead of committing itself.
    session.rollback()
    assert session.get(os_api.OSMemory, exported['memories'][0]['id']) is not None


def test_forgetting_memory_redacts_linked_assistant_proposal_but_not_other_owner(workspace):
    from assistant_api import AssistantAction, AssistantMessage
    client, session, owner, stranger, acting, item, other_item = workspace
    value = memory(client, 'Preference that should be forgotten')
    action = AssistantAction(owner_id=owner.id, tool='memory.create', title='Remember a preference',
                             summary='Preference that should be forgotten', arguments={'body': value['body']},
                             status='completed', result={'memory_id': value['id']})
    other_action = AssistantAction(owner_id=stranger.id, tool='memory.create', title='Remember a preference',
                                   summary='Other preference', arguments={'body': 'Other preference'},
                                   status='completed', result={'memory_id': value['id']})
    session.add_all([action, other_action]); session.flush()
    session.add(AssistantMessage(owner_id=owner.id, role='user', body=value['body'], action_id=action.id))
    session.add(AssistantMessage(owner_id=stranger.id, role='user', body='Other preference', action_id=other_action.id))
    session.commit()
    assert client.delete(f"/api/os/memories/{value['id']}").status_code == 200
    session.refresh(action); session.refresh(other_action)
    assert action.arguments == {} and action.result == {}
    assert value['body'] not in action.summary
    assert session.scalars(select(AssistantMessage).where(AssistantMessage.owner_id == owner.id)).all() == []
    assert other_action.arguments == {'body': 'Other preference'}
    assert len(session.scalars(select(AssistantMessage).where(AssistantMessage.owner_id == stranger.id)).all()) == 1


def test_writes_use_guard_and_overview_is_private(workspace):
    client, session, owner, stranger, acting, item, other_item = workspace
    assert client.post('/api/os/projects', json={'name': 'Blocked'}, headers={'Origin': 'https://untrusted.test'}).status_code == 403
    assert client.get('/api/os/projects').json() == []
    project(client, item.id)
    memory(client)
    value = client.get('/api/os/overview').json()
    assert value['library_count'] == 1 and value['media_count'] == 1
    assert value['project_count'] == 1 and value['memory_count'] == 1
    assert acting['guard_calls'] == 3
    acting['user'] = None
    assert client.get('/api/os/overview').status_code == 401
