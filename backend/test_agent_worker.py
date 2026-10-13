"""Crash, lease, revocation and concurrency acceptance for autonomous tasks."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
import threading
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from app import Base, User, engine
import agent_api as api
import agent_worker as worker
import assistant_api as assistant
import personal_media as media
from creator import CreatorItem, CreatorMedia
from test_agent_api import NOW, Hints, isolated, enable, create


def action(tool='project.create', arguments=None):
    return {'decision': 'action', 'detail': 'Prepare the requested private project.', 'tool': tool,
            'arguments': {'name': 'Autonomous launch'} if arguments is None else arguments}


def done():
    return {'decision': 'done', 'detail': 'The requested private project is ready.', 'tool': None, 'arguments': {}}


def claim(factory):
    with factory() as session:
        result = worker.claim_task(session)
    assert result is not None
    return result


def test_autonomous_project_receipt_then_explicit_done_with_one_step_budget(isolated):
    factory, _, owner, _, _, client = isolated
    enable(client, max_steps=1); row = create(client)
    worker.process_task(factory, *claim(factory), planner=lambda *_: action())
    worker.process_task(factory, *claim(factory), planner=lambda *_: done())
    with factory() as session:
        task = session.get(api.AgentTask, row['id'])
        steps = list(session.scalars(select(api.AgentStep)))
        assert task.status == 'completed' and task.step_count == 1 and task.model_calls == 2
        assert len(list(session.scalars(select(media.OSProject).where(media.OSProject.owner_id == owner.id)))) == 1
        assert len(steps) == 1 and steps[0].status == 'completed'
        assert steps[0].result['project_id'] and steps[0].action_id


def test_next_plan_uses_completed_request_receipt_to_link_three_unchecked_goal_steps(isolated):
    factory, _, owner, _, _, client = isolated
    enable(client, ('project.create', 'goal.create', 'library.search'))
    row = create(client, objective='Create Launch project, then link a three-step private review goal.')
    worker.process_task(factory, *claim(factory), planner=lambda *_: action(arguments={'name': 'Launch'}))
    def linked_goal(objective, context, tools):
        completed = json.loads(context)['completed_steps']
        assert completed[0]['request'] == {'name': 'Launch'}
        project_id = completed[0]['result']['project_id']
        return action('goal.create', {'title': 'Team demo', 'project_id': project_id,
            'steps': [{'id': f'step-{i}', 'title': title, 'completed': False} for i, title in enumerate(
                ('Pick a clip', 'Review captions', 'Review export'), 1)]})
    worker.process_task(factory, *claim(factory), planner=linked_goal)
    def finished(objective, context, tools):
        completed = json.loads(context)['completed_steps']
        assert [step['tool'] for step in completed] == ['goal.create', 'project.create']
        assert completed[0]['request']['checklist_titles'] == ['Pick a clip', 'Review captions', 'Review export']
        return done()
    worker.process_task(factory, *claim(factory), planner=finished)
    with factory() as session:
        project = session.scalar(select(media.OSProject).where(media.OSProject.owner_id == owner.id))
        goal = session.scalar(select(media.OSGoal).where(media.OSGoal.owner_id == owner.id))
        assert goal.project_id == project.id and len(goal.steps) == 3
        assert all(step['completed'] is False for step in goal.steps)
        assert session.get(api.AgentTask, row['id']).status == 'completed'


def test_planning_pause_and_permission_revocation_never_execute_a_late_plan(isolated):
    factory, _, _, _, _, client = isolated
    enable(client); row = create(client)
    def paused(*_):
        current = client.get(f'/api/os/agent/tasks/{row["id"]}').json()
        response = client.post(f'/api/os/agent/tasks/{row["id"]}/pause', json={'revision': current['revision']})
        assert response.status_code == 200
        return action()
    worker.process_task(factory, *claim(factory), planner=paused)
    with factory() as session:
        assert session.get(api.AgentTask, row['id']).status == 'paused'
        assert session.scalar(select(media.OSProject)) is None
    current = client.get(f'/api/os/agent/tasks/{row["id"]}').json()
    assert client.post(f'/api/os/agent/tasks/{row["id"]}/resume', json={'revision': current['revision']}).status_code == 200
    def revoked(*_):
        assert client.put('/api/os/assistant/permissions', json={'allowed_tools': []}).status_code == 200
        return action()
    worker.process_task(factory, *claim(factory), planner=revoked)
    with factory() as session:
        assert session.get(api.AgentTask, row['id']).status == 'paused'
        assert session.scalar(select(media.OSProject)) is None


def test_committed_action_crash_resumes_original_receipt_without_duplicate(isolated):
    factory, _, _, _, _, client = isolated
    enable(client); row = create(client)
    calls = []
    def interrupted(*args):
        result = assistant.approve(*args)
        calls.append(result)
        raise RuntimeError('Interrupted after committed receipt')
    worker.process_task(factory, *claim(factory), planner=lambda *_: action(), approve=interrupted)
    current = client.get(f'/api/os/agent/tasks/{row["id"]}').json()
    assert current['status'] == 'blocked'
    assert client.post(f'/api/os/agent/tasks/{row["id"]}/resume', json={'revision': current['revision']}).status_code == 200
    def no_replanning(*_):
        raise AssertionError('Pending receipt recovery must not replan.')
    worker.process_task(factory, *claim(factory), planner=no_replanning)
    with factory() as session:
        assert len(calls) == 1 and len(list(session.scalars(select(media.OSProject)))) == 1
        step = session.scalar(select(api.AgentStep))
        assert step.status == 'completed' and step.result['project_id']
        assert len(list(session.scalars(select(assistant.AssistantAction)))) == 1


def test_persisted_unexecuted_action_recovery_requires_current_permission(isolated):
    factory, _, owner, _, _, client = isolated
    enable(client); row = create(client)
    task_id, token = claim(factory)
    with factory() as session:
        user, task = worker.lock_claim(session, task_id, token)
        proposal, _ = assistant.proposal('project.create', {'name': 'Not executed'}, session, user)
        step = api.AgentStep(task_id=task.id, owner_id=owner.id, position=1, tool='project.create',
                             title='Create a project', arguments={'name': 'Not executed'}, action_id=proposal.id)
        session.add(step); task.step_count = 1; session.commit()
    client.put('/api/os/assistant/permissions', json={'allowed_tools': []})
    worker.process_task(factory, task_id, token, planner=lambda *_: action())
    with factory() as session:
        assert session.scalar(select(media.OSProject)) is None
        assert session.get(api.AgentTask, row['id']).status == 'paused'


def test_model_invalid_tools_unknown_args_and_repeated_steps_are_blocked(isolated):
    factory, _, _, _, _, client = isolated
    enable(client)
    row = create(client)
    worker.process_task(factory, *claim(factory), planner=lambda *_: {**action(), 'tool': 'shell.exec'})
    assert client.get(f'/api/os/agent/tasks/{row["id"]}').json()['status'] == 'blocked'
    second = create(client)
    worker.process_task(factory, *claim(factory), planner=lambda *_: action(arguments={'name': 'Private', 'owner_id': 999}))
    assert client.get(f'/api/os/agent/tasks/{second["id"]}').json()['status'] == 'blocked'
    third = create(client)
    worker.process_task(factory, *claim(factory), planner=lambda *_: action())
    worker.process_task(factory, *claim(factory), planner=lambda *_: action())
    assert client.get(f'/api/os/agent/tasks/{third["id"]}').json()['status'] == 'blocked'
    with factory() as session:
        assert len(list(session.scalars(select(media.OSProject)))) == 1


@pytest.mark.parametrize('tool,arguments,changed,model', [
    ('project.create', {'name': 'Same project'}, {'name': ' SAME PROJECT ', 'description': 'A different description'}, media.OSProject),
    ('goal.create', {'title': 'Same goal'}, {'title': ' SAME GOAL ', 'description': 'Different details'}, media.OSGoal),
])
def test_semantic_name_identity_stops_description_variants_only_within_current_task(isolated, tool, arguments, changed, model):
    factory, _, _, _, _, client = isolated
    enable(client, (tool,)); row = create(client)
    worker.process_task(factory, *claim(factory), planner=lambda *_: action(tool, arguments))
    worker.process_task(factory, *claim(factory), planner=lambda *_: action(tool, changed))
    assert client.get(f'/api/os/agent/tasks/{row["id"]}').json()['status'] == 'blocked'
    with factory() as session:
        assert len(list(session.scalars(select(model)))) == 1
    # A separate explicitly requested task may use the same name; this is not
    # global cross-task deduplication or a restriction on the owner's library.
    create(client)
    worker.process_task(factory, *claim(factory), planner=lambda *_: action(tool, arguments))
    with factory() as session:
        assert len(list(session.scalars(select(model)))) == 2


def test_context_grant_does_not_inject_unrelated_projects_or_unread_assets(isolated):
    factory, _, owner, _, _, client = isolated
    enable(client, ('project.create', 'library.search'))
    with factory() as session:
        selected = media.OSProject(owner_id=owner.id, name='Selected scope')
        previous = media.OSProject(owner_id=owner.id, name='Unrelated historical project')
        item = CreatorItem(owner_id=owner.id, data={'title': 'Unread private creation'})
        session.add_all([selected, previous, item]); session.flush()
        session.add(media.OSAssetMetadata(owner_id=owner.id, item_id=item.id,
                    rights={'basis': 'original', 'allow_ai': True})); session.commit(); selected_id = selected.id
    row = create(client, project_id=selected_id)
    with factory() as session:
        context = worker.task_context(session, session.get(User, owner.id), session.get(api.AgentTask, row['id']),
                                      ['project.create', 'library.search'])
        assert 'Selected scope' in context
        assert 'Unrelated historical project' not in context and 'Unread private creation' not in context


def test_read_snapshot_is_owned_and_contains_no_download_urls(isolated):
    factory, _, owner, stranger, _, client = isolated
    enable(client, ('library.search',))
    with factory() as session:
        session.add_all([CreatorItem(owner_id=owner.id, data={'title': 'Owned note'}),
                         CreatorItem(owner_id=stranger.id, data={'title': 'Other private secret'})]); session.commit()
    row = create(client, objective='Find my notes')
    worker.process_task(factory, *claim(factory), planner=lambda *_: action('library.search', {'q': ''}))
    detail = client.get(f'/api/os/agent/tasks/{row["id"]}').json()
    result = detail['steps'][0]['result']
    assert result['total'] == 1 and result['items'][0]['title'] == 'Owned note'
    assert 'url' not in str(result).lower() and 'Other private' not in str(result)
    with factory() as session:
        task = session.get(api.AgentTask, row['id'])
        context = worker.task_context(session, session.get(User, owner.id), task, ['library.search'])
        assert 'Owned note' not in context  # No explicit asset AI rights grant.
        assert json.loads(context)['completed_steps'][0]['result']['item_ids']


def test_step_budget_never_executes_extra_model_actions(isolated):
    factory, _, _, _, _, client = isolated
    enable(client, max_steps=1); row = create(client)
    worker.process_task(factory, *claim(factory), planner=lambda *_: action())
    worker.process_task(factory, *claim(factory), planner=lambda *_: action(arguments={'name': 'Forbidden extra'}))
    with factory() as session:
        assert session.get(api.AgentTask, row['id']).status == 'blocked'
        assert len(list(session.scalars(select(media.OSProject)))) == 1


def test_reduced_policy_step_budget_takes_effect_before_next_action(isolated):
    factory, _, _, _, _, client = isolated
    policy = enable(client, max_steps=3); row = create(client)
    worker.process_task(factory, *claim(factory), planner=lambda *_: action())
    assert client.put('/api/os/agent/policy', json={'revision': policy['revision'], 'enabled': True,
        'allowed_tools': ['project.create'], 'max_steps': 1}).status_code == 200
    worker.process_task(factory, *claim(factory), planner=lambda *_: action(arguments={'name': 'Extra'}))
    with factory() as session:
        assert session.get(api.AgentTask, row['id']).status == 'blocked'
        assert len(list(session.scalars(select(media.OSProject)))) == 1


def test_runtime_deadline_stops_late_inference_and_cannot_resume(isolated, monkeypatch):
    factory, _, _, _, _, client = isolated
    enable(client); row = create(client)
    def late(*_):
        monkeypatch.setattr(api, 'now', lambda: NOW + timedelta(seconds=api.TASK_SECONDS + 1))
        return action()
    worker.process_task(factory, *claim(factory), planner=late)
    current = client.get(f'/api/os/agent/tasks/{row["id"]}').json()
    assert current['status'] == 'failed'
    assert client.post(f'/api/os/agent/tasks/{row["id"]}/resume', json={'revision': current['revision']}).status_code == 409
    with factory() as session:
        assert session.scalar(select(media.OSProject)) is None


def test_selected_render_snapshot_change_blocks_before_existing_approval(isolated):
    factory, _, owner, _, _, client = isolated
    enable(client, ('render.create', 'project.create'))
    with factory() as session:
        video = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=10)
        item = CreatorItem(owner_id=owner.id, data={'title': 'Owned clip', 'media_id': video.id})
        session.add_all([video, item]); session.commit(); item_id = item.id
    row = create(client, render_item_id=item_id, objective='Queue this selected video export')
    def changed(*_):
        with factory() as session:
            item = session.get(CreatorItem, item_id)
            item.data = {**item.data, 'trim_start': 1}; session.commit()
        return action('render.create', {'item_id': item_id})
    worker.process_task(factory, *claim(factory), planner=changed)
    assert client.get(f'/api/os/agent/tasks/{row["id"]}').json()['status'] == 'blocked'
    with factory() as session:
        assert session.scalar(select(assistant.AssistantAction)) is None


def test_expired_lease_claim_is_not_duplicated_and_recovery_is_bounded(isolated):
    factory, _, _, _, _, client = isolated
    enable(client); row = create(client)
    first = claim(factory)
    with factory() as session:
        assert worker.claim_task(session) is None
        task = session.get(api.AgentTask, row['id']); task.lease_until = NOW - timedelta(seconds=1); session.commit()
    second = claim(factory)
    assert first[1] != second[1]
    worker.process_task(factory, *first, planner=lambda *_: action())
    with factory() as session:
        assert session.scalar(select(media.OSProject)) is None
        task = session.get(api.AgentTask, row['id']); task.lease_until = NOW - timedelta(seconds=1)
        task.recovery_attempts = api.MAX_RECOVERIES - 1; session.commit()
        assert worker.claim_task(session) is None
        session.refresh(task)
        assert task.status == 'failed'


def test_idle_agent_worker_does_not_poll_neon_every_minute(isolated, monkeypatch):
    factory, _, _, _, _, _ = isolated
    class Stop:
        ticks = 0
        def is_set(self): return self.ticks >= 61
        def wait(self, seconds): self.ticks += 1
    stop = Stop(); coordinator = Hints(); calls = []
    original = worker.claim_task
    def counted(session):
        calls.append(stop.ticks); return original(session)
    monkeypatch.setattr(worker, 'claim_task', counted)
    worker.run_worker(stop, coordinator=coordinator, factory=factory, clock=lambda: stop.ticks * 60)
    assert calls == [0, 60]
    assert api.heartbeat_key() in coordinator.writes
    assert coordinator.get(api.heartbeat_key()) is None  # Graceful shutdown.


def test_failed_scan_never_publishes_readiness_and_preserves_another_workers_heartbeat():
    coordinator = Hints()
    coordinator.set(api.heartbeat_key(), 'another-worker', ex=180)
    def unavailable():
        raise RuntimeError('private database connection details')
    with pytest.raises(RuntimeError, match='bounded database scan'):
        worker.run_worker(threading.Event(), once=True, coordinator=coordinator, factory=unavailable)
    assert coordinator.get(api.heartbeat_key()) == 'another-worker'
    assert coordinator.writes.count(api.heartbeat_key()) == 1


@pytest.fixture
def postgres_workspace(monkeypatch):
    if engine.dialect.name != 'postgresql':
        pytest.skip('PostgreSQL required for separate-session lock acceptance.')
    schema = 'agent_test_' + uuid.uuid4().hex
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA {schema}'))
    bound = engine.execution_options(schema_translate_map={None: schema})
    try:
        Base.metadata.create_all(bound)
        factory = sessionmaker(bound)
        with factory() as session:
            user = User(name='Concurrent agent', email='agent-race@example.test', password_hash='unused')
            session.add(user); session.flush()
            session.add_all([assistant.AssistantPermission(owner_id=user.id, allowed_tools=['project.create']),
                            api.AgentPolicy(owner_id=user.id, enabled=True, allowed_tools=['project.create'], max_steps=3, daily_task_limit=1)])
            session.commit(); owner_id = user.id
        monkeypatch.setattr(api.config, 'enabled', True)
        hints = Hints(); hints.set(api.heartbeat_key(), 'fixture', ex=180)
        monkeypatch.setattr(api, 'cache', hints)
        monkeypatch.setattr(assistant, 'inference_status', lambda: {'available': True, 'mode': 'local_ai', 'model': 'fixture'})
        yield factory, owner_id
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA {schema} CASCADE'))


def test_postgres_concurrent_admission_respects_one_task_budget(postgres_workspace):
    factory, owner_id = postgres_workspace
    barrier = threading.Barrier(2)
    def admit(_):
        with factory() as session:
            user = session.get(User, owner_id)
            barrier.wait(timeout=10)
            try:
                api.create_task(api.TaskInput(request_id=uuid.uuid4(), objective='Private race project'), user, session)
                return 200
            except Exception as exc:
                session.rollback(); return getattr(exc, 'status_code', 500)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(admit, range(2))) == [200, 429]
    with factory() as session:
        assert len(list(session.scalars(select(api.AgentTask)))) == 1


def test_postgres_claim_race_and_pause_during_inference_release_account_lock(postgres_workspace):
    factory, owner_id = postgres_workspace
    with factory() as session:
        row = api.create_task(api.TaskInput(request_id=uuid.uuid4(), objective='Private race project'), session.get(User, owner_id), session)
    barrier = threading.Barrier(2)
    def race(_):
        with factory() as session:
            barrier.wait(timeout=10); return worker.claim_task(session)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(race, range(2)))
    claims = [result for result in results if result]
    assert len(claims) == 1
    def pause_with_independent_connection(*_):
        with factory() as session:
            session.execute(text("SET LOCAL lock_timeout = '2s'"))
            task = session.get(api.AgentTask, row['id'])
            api.change_task(uuid.UUID(task.id), 'pause', api.RevisionInput(revision=task.revision), session.get(User, owner_id), session)
        return action()
    worker.process_task(factory, *claims[0], planner=pause_with_independent_connection)
    with factory() as session:
        assert session.get(api.AgentTask, row['id']).status == 'paused'
        assert session.scalar(select(media.OSProject)) is None
