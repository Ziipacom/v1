"""Owner grants, hard admission budgets and task privacy; no external inference."""
from datetime import datetime, timezone
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, guard
import agent_api as api
import assistant_api as assistant

NOW = datetime(2026, 10, 13, 16, 0, tzinfo=timezone.utc)


class Hints:
    def __init__(self):
        self.values = {}
        self.writes = []
    def get(self, key):
        return self.values.get(key)
    def set(self, key, value, *, ex=None, nx=False):
        if nx and key in self.values:
            return False
        self.values[key] = value
        self.writes.append(key)
        return True
    def eval(self, script, count, key, identity):
        if self.values.get(key) == identity:
            return self.values.pop(key, None)


@pytest.fixture
def isolated(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as session:
        owner = User(name='Agent owner', email='agent-owner@example.test', password_hash='unused')
        stranger = User(name='Stranger', email='agent-stranger@example.test', password_hash='unused')
        session.add_all([owner, stranger]); session.commit()
        actor = {'user': owner}
        app = FastAPI(); app.include_router(api.router); app.include_router(assistant.router)
        app.dependency_overrides[current_user] = lambda: actor['user']
        app.dependency_overrides[guard] = lambda: None
        def connection():
            with factory() as own_session:
                yield own_session
        app.dependency_overrides[db] = connection
        hints = Hints()
        hints.set(api.heartbeat_key(), 'fixture', ex=180)
        monkeypatch.setattr(api, 'cache', hints)
        monkeypatch.setattr(api.config, 'enabled', True)
        monkeypatch.setattr(api.config, 'global_queue_limit', 50)
        monkeypatch.setattr(api, 'now', lambda: NOW)
        monkeypatch.setattr(assistant, 'inference_status', lambda: {'mode': 'local_ai', 'available': True, 'model': 'fixture'})
        with TestClient(app) as client:
            yield factory, session, owner, stranger, actor, client
    engine.dispose()


def enable(client, tools=('project.create',), **changes):
    assert client.put('/api/os/assistant/permissions', json={'allowed_tools': list(tools)}).status_code == 200
    policy = client.get('/api/os/agent/policy').json()
    response = client.put('/api/os/agent/policy', json={
        'revision': policy['revision'], 'enabled': True, 'allowed_tools': list(tools),
        'max_steps': 5, 'daily_task_limit': 5, **changes})
    assert response.status_code == 200, response.text
    return response.json()


def create(client, **changes):
    response = client.post('/api/os/agent/tasks', json={
        'request_id': str(uuid.uuid4()), 'objective': 'Create a private launch project.', **changes})
    assert response.status_code == 200, response.text
    return response.json()


def test_disabled_default_and_matching_assistant_grants_are_required(isolated):
    *_, client = isolated
    initial = client.get('/api/os/agent/policy').json()
    assert initial['enabled'] is False and initial['allowed_tools'] == []
    payload = {'request_id': str(uuid.uuid4()), 'objective': 'Create launch project'}
    assert client.post('/api/os/agent/tasks', json=payload).status_code == 409
    assert client.put('/api/os/agent/policy', json={'revision': 1, 'enabled': True,
        'allowed_tools': ['project.create']}).status_code == 200
    assert client.post('/api/os/agent/tasks', json=payload).status_code == 409
    client.put('/api/os/assistant/permissions', json={'allowed_tools': ['project.create']})
    assert client.post('/api/os/agent/tasks', json=payload).status_code == 200


@pytest.mark.parametrize('tool', ['shell.exec', 'wallet.claim', 'publishing.create', 'memory.create', 'account.delete'])
def test_unsafe_or_implicit_memory_tools_are_not_agent_grants(isolated, tool):
    *_, client = isolated
    assert client.put('/api/os/agent/policy', json={'revision': 1, 'allowed_tools': [tool]}).status_code == 422


def test_idempotent_creation_is_owner_scoped_and_rejects_reused_payload(isolated):
    _, _, _, stranger, actor, client = isolated
    enable(client)
    request_id = str(uuid.uuid4())
    first = create(client, request_id=request_id)
    assert create(client, request_id=request_id)['id'] == first['id']
    assert client.post('/api/os/agent/tasks', json={'request_id': request_id, 'objective': 'Different task'}).status_code == 409
    actor['user'] = stranger
    assert client.get('/api/os/agent/tasks').json() == []
    assert client.get(f'/api/os/agent/tasks/{first["id"]}').status_code == 404
    assert client.post(f'/api/os/agent/tasks/{first["id"]}/pause', json={'revision': 1}).status_code == 404


def test_daily_cap_counts_cancelled_tasks_and_step_cap_is_policy_bound(isolated):
    *_, client = isolated
    enable(client, daily_task_limit=1, max_steps=2)
    assert client.post('/api/os/agent/tasks', json={'request_id': str(uuid.uuid4()),
        'objective': 'Project', 'max_steps': 3}).status_code == 422
    row = create(client)
    assert client.post(f'/api/os/agent/tasks/{row["id"]}/cancel', json={'revision': row['revision']}).status_code == 200
    assert client.post('/api/os/agent/tasks', json={'request_id': str(uuid.uuid4()), 'objective': 'Second task'}).status_code == 429


def test_policy_revision_disable_pauses_and_task_grants_do_not_expand(isolated):
    factory, _, owner, _, _, client = isolated
    policy = enable(client)
    row = create(client)
    assert client.put('/api/os/agent/policy', json={'revision': 1}).status_code == 409
    assert client.put('/api/os/agent/policy', json={'revision': policy['revision'], 'enabled': False}).status_code == 200
    paused = client.get(f'/api/os/agent/tasks/{row["id"]}').json()
    assert paused['status'] == 'paused'
    assert client.post(f'/api/os/agent/tasks/{row["id"]}/resume', json={'revision': paused['revision']}).status_code == 409
    enable(client, ('project.create', 'goal.create'))
    with factory() as session:
        task = session.get(api.AgentTask, row['id'])
        assert api.effective_tools(session, owner.id, task) == ['project.create']


def test_global_queue_capacity_applies_to_resume_and_new_owners(isolated, monkeypatch):
    _, _, owner, stranger, actor, client = isolated
    monkeypatch.setattr(api.config, 'global_queue_limit', 1)
    enable(client)
    first = create(client)
    paused = client.post(f'/api/os/agent/tasks/{first["id"]}/pause', json={'revision': first['revision']}).json()
    actor['user'] = stranger
    enable(client); create(client)
    actor['user'] = owner
    assert client.post(f'/api/os/agent/tasks/{first["id"]}/resume', json={'revision': paused['revision']}).status_code == 429
    assert client.post('/api/os/agent/tasks', json={'request_id': str(uuid.uuid4()), 'objective': 'Another'}).status_code == 429


def test_exports_and_deletion_include_private_agent_data_without_leases(isolated):
    factory, _, owner, stranger, actor, client = isolated
    enable(client); first = create(client)
    actor['user'] = stranger; enable(client); second = create(client)
    with factory() as session:
        exported = api.export_agent_data(session, owner.id)
        assert exported['tasks'][0]['id'] == first['id']
        assert 'lease_token' not in str(exported) and second['id'] not in str(exported)
        api.delete_agent_data(session, owner.id); session.commit()
        assert session.get(api.AgentTask, first['id']) is None
        assert session.get(api.AgentTask, second['id']) is not None


def test_new_task_requires_model_and_worker_but_idempotent_receipt_survives_outage(isolated, monkeypatch):
    *_, client = isolated
    enable(client); request_id = str(uuid.uuid4()); first = create(client, request_id=request_id)
    monkeypatch.setattr(assistant, 'inference_status', lambda: {'available': False, 'mode': 'guided', 'model': None})
    assert create(client, request_id=request_id)['id'] == first['id']
    assert client.post('/api/os/agent/tasks', json={'request_id': str(uuid.uuid4()), 'objective': 'Offline'}).status_code == 503
