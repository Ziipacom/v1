"""Approval, isolation and private-context acceptance tests; no model/network use."""
from datetime import timedelta
import json
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import Base, User, db, current_user, guard
from creator import CreatorItem
import assistant_api as api
import personal_media as media


def test_reward_read_requires_permission_and_does_not_prepare_spending(workspace):
    from media_rewards import RewardLedger
    client, session, owner, other, *_ = workspace
    assert ask(client, 'Show my media rewards')['proposal'] is None
    assert 'Enable' in ask(client, 'Show my media rewards')['message']['body']
    for user, points in ((owner, 7), (other, 4000)):
        session.add(RewardLedger(owner_id=user.id, program_key='ziipa', program_name='Ziipa',
                                reference_id=str(uuid.uuid4()), kind='earned', points=points))
    session.commit()
    enable(client, 'rewards.read')
    reply = ask(client, 'Show my media rewards')
    assert reply['proposal'] is None
    assert '7 noncash' in reply['message']['body']
    assert '4000' not in reply['message']['body']
    assert 'no cash value' in reply['message']['body']
    assert session.scalar(select(api.AssistantAction)) is None
    assert ask(client, 'Claim all my reward tokens automatically')['proposal'] is None


def test_reward_context_is_opt_in_and_has_no_wallet_addresses(workspace):
    from media_rewards import RewardLedger
    client, session, owner, other, *_ = workspace
    session.add(RewardLedger(owner_id=owner.id, program_key='ziipa', program_name='Ziipa',
                            reference_id=str(uuid.uuid4()), kind='earned', points=9))
    session.commit()
    assert 'media_rewards' not in json.loads(api.private_context(session, owner, None))
    enable(client, 'rewards.read')
    context = json.loads(api.private_context(session, owner, None))
    assert context['media_rewards']['noncash_points'] == 9
    assert context['media_rewards']['cash_value'] is None
    assert 'address' not in json.dumps(context)


@pytest.fixture
def workspace(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(connection, join_transaction_mode='create_savepoint')
        owner = User(name='Owner', email='assistant-owner@example.test', password_hash='unused')
        other = User(name='Other', email='assistant-other@example.test', password_hash='unused')
        session.add_all([owner, other]); session.flush()
        item = CreatorItem(owner_id=owner.id, data={'title': 'Private concert', 'category': 'video'})
        secret = CreatorItem(owner_id=other.id, data={'title': 'Other private media', 'category': 'video'})
        session.add_all([item, secret]); session.commit()
        actor = {'user': owner}
        app = FastAPI(); app.include_router(api.router); app.include_router(media.router)
        def user():
            if actor['user'] is None: raise HTTPException(401, 'Please sign in')
            return actor['user']
        app.dependency_overrides.update({db: lambda: session, current_user: user, guard: lambda: None})
        monkeypatch.setattr(api.config, 'local_ai_enabled', False)
        with TestClient(app) as client:
            yield client, session, owner, other, actor, item, secret
        session.close(); transaction.rollback()
    engine.dispose()


def enable(client, *tools):
    result = client.put('/api/os/assistant/permissions', json={'allowed_tools': list(tools)})
    assert result.status_code == 200, result.text


def ask(client, text):
    response = client.post('/api/os/assistant/messages', json={'message': text})
    assert response.status_code == 200, response.text
    return response.json()


def approve(client, row):
    return client.post('/api/os/assistant/actions/' + row['id'] + '/approve', json={'revision': row['revision']})


def test_change_requires_permission_and_review_then_idempotent(workspace):
    client, session, owner, *_ = workspace
    assert ask(client, 'Create project called Demo')['proposal'] is None
    assert session.scalar(select(media.OSProject)) is None
    enable(client, 'project.create')
    action = ask(client, 'Create project called Demo')['proposal']
    assert action['status'] == 'pending'
    assert session.scalar(select(media.OSProject)) is None
    response = approve(client, action)
    assert response.status_code == 200, response.text
    assert response.json()['action']['status'] == 'completed'
    assert approve(client, action).json()['result'] == response.json()['result']
    assert len(list(session.scalars(select(media.OSProject)))) == 1


def test_action_owner_revision_rejection_and_permission_revocation(workspace):
    client, session, owner, other, actor, *_ = workspace
    enable(client, 'goal.create')
    action = ask(client, 'Set a goal: three clips')['proposal']
    actor['user'] = other
    assert approve(client, action).status_code == 404
    assert client.get('/api/os/assistant/actions').json() == []
    assert client.get('/api/os/assistant/messages').json() == []
    actor['user'] = owner
    assert approve(client, action | {'revision': 999}).status_code == 409
    enable(client)
    assert approve(client, action).status_code == 409
    assert session.scalar(select(media.OSGoal)) is None
    enable(client, 'goal.create')
    fresh = ask(client, 'Set goal: three clips')['proposal']
    assert client.post(f'/api/os/assistant/actions/{fresh["id"]}/reject', json={'revision': 1}).status_code == 200
    assert approve(client, fresh).status_code == 409


def test_expired_proposal_does_not_execute(workspace):
    client, session, *_ = workspace
    enable(client, 'project.create')
    action = ask(client, 'Create project: Expiry')['proposal']
    row = session.get(api.AssistantAction, action['id']); row.expires_at = api.now() - timedelta(seconds=1); session.commit()
    assert approve(client, action).status_code == 409
    assert session.scalar(select(media.OSProject)) is None
    assert row.status == 'expired' and row.arguments == {}


def test_tools_allowlist_and_unknown_arguments(workspace):
    client, *_ = workspace
    assert client.put('/api/os/assistant/permissions', json={'allowed_tools': ['shell.exec']}).status_code == 422
    assert client.put('/api/os/assistant/permissions', json={'allowed_tools': ['project.create', 'project.create']}).status_code == 422
    assert client.post('/api/os/assistant/messages', json={'message': 'hello', 'tool': 'shell.exec'}).status_code == 422
    assert ask(client, 'run shell delete everything')['proposal'] is None
    assert client.get('/api/os/assistant/config').json()['mode'] == 'guided'


def test_search_scoped_and_signed_out(workspace):
    client, session, owner, other, actor, item, secret = workspace
    reply = ask(client, 'Find concert')['message']['body']
    assert 'Private concert' in reply and 'Other private' not in reply
    assert 'Found 0' in ask(client, 'Find Other private')['message']['body']
    actor['user'] = None
    assert client.get('/api/os/assistant/messages').status_code == 401
    assert client.get('/api/os/assistant/config').status_code == 401


def test_memory_context_opt_in_owner_rights_and_forget(workspace):
    client, session, owner, other, actor, item, secret = workspace
    enable(client, 'memory.create', 'library.search')
    action = ask(client, 'Remember: Use green captions')['proposal']
    result = approve(client, action).json()['result']
    memory = session.get(media.OSMemory, result['memory_id'])
    assert memory.body == 'Use green captions'
    assert 'Use green captions' not in api.private_context(session, owner, None)
    enable(client, 'memory.read', 'library.search')
    assert 'Use green captions' in api.private_context(session, owner, None)
    assert 'Private concert' not in api.private_context(session, owner, None)  # no AI rights granted
    session.add(media.OSAssetMetadata(owner_id=owner.id, item_id=item.id, rights={'basis': 'original', 'allow_ai': True}))
    session.add(media.OSMemory(owner_id=other.id, kind='style', body='Other secret'))
    session.commit()
    context = api.private_context(session, owner, None)
    assert 'Private concert' in context and 'Other secret' not in context
    assert client.delete(f'/api/os/memories/{memory.id}?revision=1').status_code == 200
    assert 'Use green captions' not in api.private_context(session, owner, None)
    assert all('Use green captions' not in row['body'] for row in client.get('/api/os/assistant/messages').json())
    assert session.get(api.AssistantAction, action['id']).result == {}


def test_context_expired_rights_and_edited_memory(workspace):
    client, session, owner, _, _, item, _ = workspace
    enable(client, 'memory.read', 'library.search')
    row = media.OSMemory(owner_id=owner.id, kind='style', body='Old style'); session.add(row)
    session.add(media.OSAssetMetadata(owner_id=owner.id, item_id=item.id,
        rights={'basis': 'licensed', 'allow_ai': True, 'expires_at': (api.now() - timedelta(hours=1)).isoformat()}))
    session.commit()
    client.patch(f'/api/os/memories/{row.id}', json={'revision': 1, 'body': 'New style'})
    context = api.private_context(session, owner, None)
    assert 'New style' in context and 'Old style' not in context and 'Private concert' not in context


def test_untrusted_model_proposal_checked_and_no_automatic_execution(workspace, monkeypatch):
    client, session, owner, other, actor, item, secret = workspace
    enable(client, 'project.create', 'workflow.create')
    monkeypatch.setattr(api, 'local_plan', lambda *args: api.Plan(reply='Done!', tool='project.create', arguments={'name': 'Planned', 'asset_ids': [secret.id]}))
    assert ask(client, 'Plan my campaign')['proposal'] is None
    monkeypatch.setattr(api, 'local_plan', lambda *args: api.Plan(reply='Done!', tool='project.create', arguments={'name': 'Planned'}))
    value = ask(client, 'Plan my campaign')
    assert 'Nothing has run' in value['message']['body']
    assert session.scalar(select(media.OSProject)) is None
    monkeypatch.setattr(api, 'local_plan', lambda *args: api.Plan(reply='Done!', tool='workflow.create', arguments={
        'name': 'Auto publish', 'action': 'reminder', 'enabled': True, 'run_at': (api.now() + timedelta(hours=1)).isoformat()}))
    assert ask(client, 'Schedule my campaign')['proposal'] is None


def test_approved_goal_and_reminder_atomic_records(workspace, monkeypatch):
    client, session, owner, *_ = workspace
    enable(client, 'goal.create', 'workflow.create')
    action = ask(client, 'Set goal: finish campaign')['proposal']
    assert approve(client, action).status_code == 200
    assert session.scalar(select(media.OSGoal)).status == 'active'
    monkeypatch.setattr(api, 'local_plan', lambda *args: api.Plan(reply='Ready', tool='workflow.create', arguments={
        'name': 'Friday review', 'action': 'reminder', 'run_at': (api.now() + timedelta(days=1)).isoformat(), 'enabled': False}))
    proposal = ask(client, 'Remind me to review tomorrow')['proposal']
    receipt = approve(client, proposal)
    assert receipt.status_code == 200, receipt.text
    from media_workflows import OsWorkflow
    workflow = session.get(OsWorkflow, receipt.json()['result']['workflow_id'])
    assert workflow.owner_id == owner.id and not workflow.enabled


def test_model_cannot_invent_goal_completion(workspace, monkeypatch):
    client, session, *_ = workspace
    enable(client, 'goal.create')
    monkeypatch.setattr(api, 'local_plan', lambda *args: api.Plan(reply='Done', tool='goal.create', arguments={
        'title': 'Ship launch', 'steps': [{'id': 'post', 'title': 'Post video', 'completed': True}]}))
    assert ask(client, 'Plan my launch')['proposal'] is None
    assert session.scalar(select(media.OSGoal)) is None


def test_planning_only_never_proposes_even_if_model_suggests_tool(workspace, monkeypatch):
    client, session, *_ = workspace
    enable(client, 'project.create')
    monkeypatch.setattr(api, 'local_plan', lambda *args: api.Plan(reply='First organize the source, then edit, then review.',
        tool='project.create', arguments={'name': 'Unexpected project'}))
    result = ask(client, 'Suggest a plan. Do not create anything.')
    assert result['proposal'] is None
    assert 'no tools executed' in result['message']['body']
    assert session.scalar(select(media.OSProject)) is None
    assert [row['role'] for row in client.get('/api/os/assistant/messages').json()] == ['user', 'assistant']


def test_guided_reminder_requires_explicit_date(workspace):
    client, *_ = workspace
    enable(client, 'workflow.create')
    action = ask(client, 'Remind me to review clips at 2026-12-10T12:00:00-05:00')['proposal']
    assert action['arguments']['run_at'] == '2026-12-10T17:00:00Z'
    assert action['arguments']['enabled'] is False
    assert ask(client, 'Remind me tomorrow')['proposal'] is None


def test_render_approval_bound_to_owned_unchanged_creation(workspace, monkeypatch):
    client, session, owner, other, actor, item, secret = workspace
    enable(client, 'render.create')
    assert ask(client, 'Render ' + secret.id)['proposal'] is None
    action = ask(client, 'Render ' + item.id)['proposal']
    item.data = item.data | {'title': 'Edited since approval'}; session.commit()
    assert approve(client, action).status_code == 409


def test_clear_export_and_delete_do_not_leak_other_owner(workspace):
    client, session, owner, other, actor, *_ = workspace
    enable(client, 'project.create')
    ask(client, 'Create project: Clear me')
    session.add(api.AssistantMessage(owner_id=other.id, role='user', body='Other conversation')); session.commit()
    exported = api.export_assistant_data(session, owner.id)
    assert len(exported['messages']) == 2 and 'Other conversation' not in json.dumps(exported)
    assert client.delete('/api/os/assistant/messages').status_code == 200
    assert client.get('/api/os/assistant/actions').json() == []
    assert client.get('/api/os/assistant/messages').json() == []
    api.delete_assistant_data(session, owner.id); session.commit()
    assert session.scalar(select(api.AssistantMessage).where(api.AssistantMessage.owner_id == other.id)).body == 'Other conversation'


@pytest.mark.parametrize('url', ['https://ollama.com', 'http://169.254.169.254', 'http://localhost/api', 'http://user:pass@localhost'])
def test_model_connection_is_fixed_local_only(url):
    with pytest.raises(ValueError): api.AssistantSettings(ollama_url=url)


def test_no_cloud_model():
    with pytest.raises(ValueError): api.AssistantSettings(model='qwen3-cloud')
