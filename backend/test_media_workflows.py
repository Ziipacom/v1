"""Isolated workflow acceptance tests. Providers, clocks and Redis are controlled."""
from datetime import datetime, timedelta, timezone
import threading
import uuid

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, guard
from creator import CreatorConnection, CreatorItem, CreatorMedia
import personal_media  # register the shared activity ledger before isolated create_all
import media_workflows as workflows
import workflow_worker as worker
from render_services import RenderJob, input_snapshot, snapshot_hash

NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def isolated(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as session:
        owner = User(name='Workflow owner', email='workflow-owner@example.test', password_hash='unused')
        stranger = User(name='Another account', email='workflow-stranger@example.test', password_hash='unused')
        session.add_all([owner, stranger]); session.commit()
        selected = {'owner': owner}
        app = FastAPI()
        app.include_router(workflows.router)
        app.dependency_overrides[current_user] = lambda: selected['owner']
        app.dependency_overrides[guard] = lambda: None
        def get_session():
            with factory() as api_session:
                yield api_session
        app.dependency_overrides[db] = get_session
        monkeypatch.setattr(workflows, 'utcnow', lambda: NOW)
        monkeypatch.setattr(worker, 'utcnow', lambda: NOW)
        class LocalHints:
            def __init__(self):
                self.values = {}
            def get(self, key):
                return self.values.get(key)
            def set(self, key, value, *, ex=None, nx=False):
                if nx and key in self.values:
                    return False
                self.values[key] = value
                return True
        monkeypatch.setattr(workflows, 'cache', LocalHints())
        with TestClient(app) as client:
            yield factory, session, owner, stranger, selected, client
    engine.dispose()


def payload(**changes):
    return {'name': 'Review clips', 'action': 'reminder', 'trigger': 'scheduled',
            'run_at': NOW.isoformat(), **changes}


def add_item(session, owner, *, created_at=NOW, audio=False):
    video = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=10)
    session.add(video)
    soundtrack = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='audio/wav', size=10) if audio else None
    if soundtrack:
        session.add(soundtrack)
    item = CreatorItem(owner_id=owner.id, data={'title': 'Owned clip', 'media_id': video.id,
                      'soundtrack': {'media_id': soundtrack.id, 'name': 'Owned recording', 'volume': 0.5, 'start': 0} if soundtrack else None},
                      created_at=created_at)
    session.add(item); session.commit()
    return item


def create(client, **changes):
    response = client.post('/api/os/workflows', json=payload(**changes))
    assert response.status_code == 200, response.text
    return response.json()


def test_dates_must_be_timezone_aware_and_recurrence_bounded():
    with pytest.raises(ValidationError):
        workflows.WorkflowInput(**payload(run_at='2026-10-12T12:00:00'))
    for interval in (0, 14, 44641):
        with pytest.raises(ValidationError):
            workflows.WorkflowInput(**payload(interval_minutes=interval))
    data = workflows.WorkflowInput(**payload(run_at='2026-10-12T07:00:00-05:00', interval_minutes=15))
    assert data.run_at == NOW
    with pytest.raises(ValidationError):
        workflows.WorkflowInput(**payload(action='publish'))
    with pytest.raises(ValidationError):
        workflows.WorkflowInput(**payload(trigger='media_saved'))


def test_workflow_default_paused_owner_scoped_and_optimistic_review(isolated):
    _, session, owner, stranger, selected, client = isolated
    row = create(client)
    assert row['enabled'] is False and row['next_run'] is None
    assert worker.scan_due(session, now=NOW) == 0
    selected['owner'] = stranger
    assert client.get('/api/os/workflows').json() == []
    assert client.post(f"/api/os/workflows/{row['id']}/run").status_code == 404
    assert client.delete(f"/api/os/workflows/{row['id']}").status_code == 404
    selected['owner'] = owner
    edit = {**payload(enabled=True), 'revision': row['revision']}
    response = client.patch(f"/api/os/workflows/{row['id']}", json=edit)
    assert response.status_code == 200 and response.json()['revision'] == 2
    assert client.patch(f"/api/os/workflows/{row['id']}", json=edit).status_code == 409


def test_manual_run_is_explicit_idempotent_while_queued_and_reminder_persists(isolated):
    factory, session, owner, _, _, client = isolated
    row = create(client)
    first = client.post(f"/api/os/workflows/{row['id']}/run").json()
    second = client.post(f"/api/os/workflows/{row['id']}/run").json()
    assert first['id'] == second['id'] and first['status'] == 'queued'
    claimed = worker.claim_run(session, now=NOW)
    worker.dispatch(factory, *claimed)
    result = client.get('/api/os/workflows/runs').json()[0]
    assert result['status'] == 'completed' and result['attempts'] == 1
    assert 'Reminder ready in Ziipa' in result['detail']
    activities = list(session.scalars(select(personal_media.OSActivity).where(personal_media.OSActivity.owner_id == owner.id)))
    assert activities


def test_schedule_durable_dedupe_skips_missed_intervals_and_aligns_utc(isolated):
    _, session, _, _, _, client = isolated
    row = create(client, enabled=True, interval_minutes=15, run_at=(NOW - timedelta(hours=1)).isoformat())
    assert worker.scan_due(session, now=NOW) == 1
    assert worker.scan_due(session, now=NOW) == 0
    session.expire_all()
    saved = session.get(workflows.OsWorkflow, row['id'])
    assert workflows.aware(saved.next_run) == NOW + timedelta(minutes=15)
    assert len(list(session.scalars(select(workflows.OsWorkflowRun)))) == 1
    assert worker.scan_due(session, now=NOW + timedelta(minutes=15)) == 1


def test_media_event_cursor_is_durable_owner_scoped_and_handles_equal_timestamp(isolated):
    _, session, owner, stranger, _, client = isolated
    add_item(session, owner, created_at=NOW - timedelta(days=1))
    row = create(client, enabled=True, trigger='media_saved', run_at=None)
    event_at = NOW + timedelta(seconds=1)
    own1 = add_item(session, owner, created_at=event_at)
    own2 = add_item(session, owner, created_at=event_at)
    add_item(session, stranger, created_at=event_at)
    assert worker.scan_due(session, now=event_at) == 2
    assert worker.scan_due(session, now=event_at) == 0
    runs = list(session.scalars(select(workflows.OsWorkflowRun)))
    assert {run.snapshot['event_id'] for run in runs} == {own1.id, own2.id}
    session.expire_all()
    assert session.get(workflows.OsWorkflow, row['id']).event_cursor['id'] == max(own1.id, own2.id)


def test_equal_time_history_is_not_replayed_and_reenable_skips_paused_events(isolated):
    _, session, owner, _, _, client = isolated
    add_item(session, owner, created_at=NOW)
    row = create(client, enabled=True, trigger='media_saved', run_at=None)
    assert worker.scan_due(session, now=NOW + timedelta(seconds=1)) == 0
    client.post(f"/api/os/workflows/{row['id']}/pause")
    latest = client.get('/api/os/workflows').json()[0]
    add_item(session, owner, created_at=NOW - timedelta(seconds=1))
    response = client.patch(f"/api/os/workflows/{row['id']}", json={**payload(enabled=True, trigger='media_saved', run_at=None), 'revision': latest['revision']})
    assert response.status_code == 200
    assert worker.scan_due(session, now=NOW + timedelta(seconds=1)) == 0


def test_edited_schedule_is_a_new_reviewed_occurrence(isolated):
    _, session, _, _, _, client = isolated
    row = create(client, enabled=True)
    assert worker.scan_due(session, now=NOW) == 1
    response = client.patch(f"/api/os/workflows/{row['id']}", json={**payload(enabled=True, name='New reviewed reminder'), 'revision': row['revision']})
    assert response.status_code == 200
    assert worker.scan_due(session, now=NOW) == 1
    session.expire_all()
    runs = list(session.scalars(select(workflows.OsWorkflowRun)))
    assert sorted(run.status for run in runs) == ['cancelled', 'queued']


def test_event_queue_full_retains_unprocessed_cursor(isolated, monkeypatch):
    _, session, owner, _, _, client = isolated
    row = create(client, enabled=True, trigger='media_saved', run_at=None)
    add_item(session, owner, created_at=NOW + timedelta(seconds=1))
    monkeypatch.setattr(workflows, 'MAX_OWNER_QUEUE', 0)
    assert worker.scan_due(session, now=NOW + timedelta(seconds=2)) == 0
    session.expire_all()
    assert session.get(workflows.OsWorkflow, row['id']).event_cursor['at'] == NOW.isoformat()
    monkeypatch.setattr(workflows, 'MAX_OWNER_QUEUE', 20)
    assert worker.scan_due(session, now=NOW + timedelta(seconds=2)) == 1


def test_pause_after_claim_prevents_dispatch_and_stale_token_cannot_finish(isolated):
    factory, session, _, _, _, client = isolated
    row = create(client, enabled=True)
    worker.scan_due(session, now=NOW)
    run_id, token = worker.claim_run(session, now=NOW)
    assert client.post(f"/api/os/workflows/{row['id']}/pause").status_code == 200
    worker.dispatch(factory, run_id, token)
    session.expire_all()
    assert session.get(workflows.OsWorkflowRun, run_id).status == 'cancelled'
    assert worker._finish(session, run_id, token, 'completed', 'Must not appear') is False


def test_lease_recovery_changes_token_and_stops_after_three_attempts(isolated):
    _, session, _, _, _, client = isolated
    row = create(client)
    client.post(f"/api/os/workflows/{row['id']}/run")
    first = worker.claim_run(session, now=NOW)
    assert worker.claim_run(session, now=NOW) is None
    second = worker.claim_run(session, now=NOW + timedelta(seconds=121))
    assert second[0] == first[0] and second[1] != first[1]
    third = worker.claim_run(session, now=NOW + timedelta(seconds=242))
    assert third and third[1] != second[1]
    assert worker.claim_run(session, now=NOW + timedelta(seconds=363)) is None
    session.expire_all()
    assert session.get(workflows.OsWorkflowRun, first[0]).status == 'failed'


def test_cancelled_run_and_account_deletion_never_dispatch(isolated):
    factory, session, owner, _, _, client = isolated
    row = create(client)
    run = client.post(f"/api/os/workflows/{row['id']}/run").json()
    claim = worker.claim_run(session, now=NOW)
    assert client.post(f"/api/os/workflows/runs/{run['id']}/cancel").status_code == 200
    worker.dispatch(factory, *claim)
    workflows.delete_workflows_data(session, owner.id); session.commit()
    worker.dispatch(factory, *claim)
    assert not list(session.scalars(select(workflows.OsWorkflowRun)))
    assert not list(session.scalars(select(workflows.OsWorkflow)))


def test_render_owned_target_rights_and_changed_edit_require_review(isolated):
    _, session, owner, stranger, _, client = isolated
    item = add_item(session, owner, audio=True)
    other = add_item(session, stranger)
    assert client.post('/api/os/workflows', json=payload(action='render', target_id=other.id)).status_code == 404
    assert client.post('/api/os/workflows', json=payload(action='render', target_id=item.id)).status_code == 422
    row = create(client, action='render', target_id=item.id, rights_confirmed=True)
    item.data = {**item.data, 'overlays': [{'id': 'new', 'text': 'New edit', 'position': 'center', 'theme': 'purple'}]}
    session.commit()
    assert client.post(f"/api/os/workflows/{row['id']}/run").status_code == 409


def test_render_submission_waits_for_real_job_and_retry_reuses_fingerprint(isolated):
    factory, session, owner, _, _, client = isolated
    item = add_item(session, owner)
    row = create(client, action='render', target_id=item.id)
    client.post(f"/api/os/workflows/{row['id']}/run")
    claim = worker.claim_run(session, now=NOW)
    calls = []
    def fake_render(data, user, own_session):
        calls.append((str(data.item_id), user.id))
        job = own_session.scalar(select(RenderJob).where(RenderJob.owner_id == user.id, RenderJob.item_id == str(data.item_id)))
        if not job:
            job = RenderJob(owner_id=user.id, item_id=str(data.item_id), input_fingerprint=snapshot_hash(input_snapshot(own_session, item)),
                            snapshot=input_snapshot(own_session, item), status='queued')
            own_session.add(job); own_session.commit()
        return {'id': job.id, 'status': job.status}
    worker.dispatch(factory, *claim, render_dispatch=fake_render)
    session.expire_all()
    run = session.get(workflows.OsWorkflowRun, claim[0])
    assert run.status == 'running' and run.external_ref and run.lease_token == ''
    assert worker.claim_run(session, now=NOW + timedelta(hours=1)) is None
    job = session.get(RenderJob, run.external_ref)
    job.status = 'failed'; session.commit()
    assert worker.reconcile_render_runs(session) == 1
    assert client.post(f"/api/os/workflows/runs/{run.id}/retry").status_code == 200
    claim2 = worker.claim_run(session, now=NOW)
    worker.dispatch(factory, *claim2, render_dispatch=fake_render)
    assert len(calls) == 2 and len(list(session.scalars(select(RenderJob)))) == 1


def test_bluesky_is_linked_read_only_and_never_fabricates_import_success(isolated):
    factory, session, owner, _, _, client = isolated
    assert client.post('/api/os/workflows', json=payload(action='bluesky_sync')).status_code == 409
    session.add(CreatorConnection(owner_id=owner.id, provider='bluesky', data={'auth_type': 'public_profile', 'handle': 'owner.bsky.social'})); session.commit()
    row = create(client, action='bluesky_sync')
    client.post(f"/api/os/workflows/{row['id']}/run")
    claim = worker.claim_run(session, now=NOW)
    calls = []
    async def fake_sync(provider, user, own_session):
        calls.append((provider, user.id))
        return {'providers': [{'provider': 'bluesky', 'sync_status': 'error'}]}
    worker.dispatch(factory, *claim, sync_dispatch=fake_sync)
    session.expire_all()
    run = session.get(workflows.OsWorkflowRun, claim[0])
    assert calls == [('bluesky', owner.id)] and run.status == 'failed'


def test_disconnected_profile_blocks_claimed_sync_and_error_details_are_redacted(isolated):
    factory, session, owner, _, _, client = isolated
    link = CreatorConnection(owner_id=owner.id, provider='bluesky', data={'auth_type': 'public_profile', 'handle': 'owner.bsky.social'})
    session.add(link); session.commit()
    row = create(client, action='bluesky_sync')
    client.post(f"/api/os/workflows/{row['id']}/run")
    claim = worker.claim_run(session, now=NOW)
    session.delete(link); session.commit()
    async def must_not_call(*args):
        raise AssertionError('A revoked profile must not be contacted')
    worker.dispatch(factory, *claim, sync_dispatch=must_not_call)
    session.expire_all()
    assert session.get(workflows.OsWorkflowRun, claim[0]).status == 'blocked'
    session.add(CreatorConnection(owner_id=owner.id, provider='bluesky', data={'auth_type': 'public_profile', 'handle': 'owner.bsky.social'})); session.commit()
    assert client.post(f"/api/os/workflows/runs/{claim[0]}/retry").status_code == 200
    claim2 = worker.claim_run(session, now=NOW)
    async def bad_provider(*args):
        raise HTTPException(503, 'Bearer super-secret-provider-key')
    worker.dispatch(factory, *claim2, sync_dispatch=bad_provider)
    exported = workflows.export_workflows_data(session, owner.id)
    assert 'super-secret' not in str(exported)
    assert client.get('/api/os/workflows/runs').json()[0]['status'] == 'blocked'


def test_queue_caps_are_shared_and_retry_does_not_admit_over_capacity(isolated, monkeypatch):
    _, session, _, stranger, selected, client = isolated
    monkeypatch.setattr(workflows, 'MAX_GLOBAL_QUEUE', 1)
    first = create(client)
    run = client.post(f"/api/os/workflows/{first['id']}/run").json()
    selected['owner'] = stranger
    second = create(client)
    assert client.post(f"/api/os/workflows/{second['id']}/run").status_code == 429
    assert client.post(f"/api/os/workflows/runs/{run['id']}/cancel").status_code == 404
    assert client.get('/api/os/workflows/runs').json() == []


def test_render_ready_trigger_imports_only_new_owned_ready_jobs(isolated):
    _, session, owner, stranger, _, client = isolated
    own = add_item(session, owner)
    other = add_item(session, stranger)
    row = create(client, enabled=True, trigger='render_ready', run_at=None)
    def job(user, item, status):
        return RenderJob(owner_id=user.id, item_id=item.id, input_fingerprint=snapshot_hash(input_snapshot(session, item)),
                         snapshot=input_snapshot(session, item), status=status, updated_at=NOW + timedelta(seconds=1))
    ready = job(owner, own, 'ready')
    session.add_all([ready, job(stranger, other, 'ready')]); session.commit()
    assert worker.scan_due(session, now=NOW + timedelta(seconds=2)) == 1
    assert worker.scan_due(session, now=NOW + timedelta(seconds=3)) == 0
    run = session.scalar(select(workflows.OsWorkflowRun).where(workflows.OsWorkflowRun.workflow_id == row['id']))
    assert run.snapshot['event_id'] == ready.id


def test_configuration_heartbeat_scope_and_no_secret_output(isolated, monkeypatch):
    _, _, _, _, _, client = isolated
    monkeypatch.setattr(workflows.config, 'enabled', True)
    class Coordinator:
        def get(self, key):
            assert key.startswith('ziipa:os:workflow-worker:')
            return None
    monkeypatch.setattr(workflows, 'cache', Coordinator())
    result = client.get('/api/os/workflows/config').json()
    assert result['can_run'] is False and result['worker_ready'] is False
    assert 'database' not in result and 'scope' not in result
    original = workflows.coordination_scope()
    monkeypatch.setattr(workflows.settings, 'database_url', 'postgresql://other:private@different.invalid/another')
    assert workflows.coordination_scope() != original
    assert 'private' not in workflows.heartbeat_key()


def test_worker_once_publishes_scoped_heartbeat_without_outbound_work(isolated, monkeypatch):
    factory, _, _, _, _, _ = isolated
    seen = []
    class Coordinator:
        def __init__(self):
            self.values = {}
        def get(self, key):
            return self.values.get(key)
        def set(self, key, identity, ex, nx=False):
            self.values[key] = identity
            seen.append((key, ex))
        def eval(self, script, count, key, identity):
            seen.append(('cleanup', key))
    worker.run_worker(threading.Event(), once=True, coordinator=Coordinator(), session_factory=factory)
    assert any(key == workflows.heartbeat_key() and ex >= 180 for key, ex in seen[:-1])
    assert seen[-1][0] == 'cleanup'


class StopAfter:
    def __init__(self, polls):
        self.polls = polls
        self.waits = 0
        self.time = 0.0
    def is_set(self):
        return self.waits >= self.polls
    def wait(self, seconds):
        self.waits += 1
        self.time += seconds


class WakeCoordinator:
    def __init__(self, on_get=None):
        self.values = {}
        self.calls = []
        self.on_get = on_get
    def get(self, key):
        if self.on_get:
            self.on_get(self, key)
        self.calls.append(('get', key))
        return self.values.get(key)
    def set(self, key, value, *, ex, nx=False):
        self.calls.append(('set', key))
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True
    def eval(self, script, count, key, identity):
        self.calls.append(('eval', key))
        if self.values.get(key) == identity:
            self.values.pop(key)


def test_idle_worker_uses_redis_polls_and_only_hourly_database_reconciliation(isolated, monkeypatch):
    factory, _, _, _, _, _ = isolated
    stop = StopAfter(61)
    coordinator = WakeCoordinator()
    scans = []
    original = worker.scan_due
    def scan(session):
        scans.append(stop.time)
        return original(session)
    monkeypatch.setattr(worker, 'scan_due', scan)
    monkeypatch.setattr(worker, 'utcnow', lambda: NOW + timedelta(seconds=stop.time))
    worker.run_worker(stop, coordinator=coordinator, session_factory=factory, clock=lambda: stop.time)
    assert scans == [0, 3600]
    assert sum(call == ('set', workflows.heartbeat_key()) for call in coordinator.calls) == 61
    assert sum(call == ('get', workflows.wake_key()) for call in coordinator.calls) == 62  # startup NX seed re-read


def test_missing_hint_forces_database_scan_without_permanent_minute_polling(isolated, monkeypatch):
    factory, _, _, _, _, _ = isolated
    stop = StopAfter(4)
    deleted = []
    def restart(coordinator, key):
        if key == workflows.wake_key() and stop.time == 60 and not deleted:
            coordinator.values.clear(); deleted.append(True)
    coordinator = WakeCoordinator(on_get=restart)
    scans = []
    original = worker.scan_due
    monkeypatch.setattr(worker, 'scan_due', lambda session: scans.append(stop.time) or original(session))
    worker.run_worker(stop, coordinator=coordinator, session_factory=factory, clock=lambda: stop.time)
    assert scans == [0, 60]


def test_cached_deadline_wakes_without_database_polling_until_due(isolated, monkeypatch):
    factory, _, _, _, _, client = isolated
    create(client, enabled=True, run_at=(NOW + timedelta(minutes=10)).isoformat())
    stop = StopAfter(12)
    coordinator = WakeCoordinator()
    scans = []
    original = worker.scan_due
    monkeypatch.setattr(worker, 'scan_due', lambda session: scans.append(stop.time) or original(session))
    monkeypatch.setattr(worker, 'utcnow', lambda: NOW + timedelta(seconds=stop.time))
    worker.run_worker(stop, coordinator=coordinator, session_factory=factory, clock=lambda: stop.time)
    assert scans == [0, 600]
    assert client.get('/api/os/workflows/runs').json()[0]['status'] == 'completed'


def test_calendar_deadline_uses_shared_worker_without_minute_database_polling(isolated, monkeypatch):
    import calendar_worker
    factory, _, _, _, _, _ = isolated
    stop = StopAfter(12)
    coordinator = WakeCoordinator()
    scans, calendar_ticks = [], []
    original = worker.scan_due
    monkeypatch.setattr(worker, 'scan_due', lambda session: scans.append(stop.time) or original(session))
    monkeypatch.setattr(worker, 'utcnow', lambda: NOW + timedelta(seconds=stop.time))
    monkeypatch.setattr(calendar_worker, 'next_wakeup_at',
                        lambda session: NOW + timedelta(minutes=10) if stop.time < 600 else None)
    monkeypatch.setattr(calendar_worker, 'tick', lambda factory: calendar_ticks.append(stop.time))
    worker.run_worker(stop, coordinator=coordinator, session_factory=factory, clock=lambda: stop.time)
    assert scans == calendar_ticks == [0, 600]
    assert sum(call == ('set', workflows.heartbeat_key()) for call in coordinator.calls) == 12


def test_wake_hint_arriving_during_scan_is_not_lost(isolated, monkeypatch):
    factory, _, _, _, _, _ = isolated
    stop = StopAfter(3)
    coordinator = WakeCoordinator()
    scans = []
    original = worker.scan_due
    def scan(session):
        scans.append(stop.time)
        if len(scans) == 1:
            coordinator.values[workflows.wake_key()] = 'a-later-committed-revision'
        return original(session)
    monkeypatch.setattr(worker, 'scan_due', scan)
    worker.run_worker(stop, coordinator=coordinator, session_factory=factory, clock=lambda: stop.time)
    assert scans == [0, 60]


def test_failed_database_scan_clears_worker_readiness_without_logging_secrets(isolated, monkeypatch):
    factory, _, _, _, _, _ = isolated
    stop = StopAfter(3)
    coordinator = WakeCoordinator()
    original = worker.scan_due
    scans = []
    def scan(session):
        scans.append(stop.time)
        if stop.time:
            raise RuntimeError('postgresql://secret-password@private-host')
        return original(session)
    monkeypatch.setattr(worker, 'scan_due', scan)
    def changed_hint(coordinator, key):
        if key == workflows.wake_key() and stop.time == 60:
            coordinator.values[key] = 'new-revision'
    coordinator.on_get = changed_hint
    worker.run_worker(stop, coordinator=coordinator, session_factory=factory, clock=lambda: stop.time)
    assert scans == [0, 60, 120]
    assert workflows.heartbeat_key() not in coordinator.values


def test_workflow_hints_follow_commit_and_failed_hint_preserves_durable_run(isolated, monkeypatch):
    _, session, _, _, _, client = isolated
    row = create(client)
    observed = []
    class BrokenHints:
        def set(self, key, value, **kwargs):
            with session.get_bind().connect() as connection:
                count = connection.execute(select(workflows.OsWorkflowRun.id)).all()
                observed.append(len(count))
            raise RuntimeError('Redis unavailable')
    monkeypatch.setattr(workflows, 'cache', BrokenHints())
    response = client.post(f"/api/os/workflows/{row['id']}/run")
    assert response.status_code == 200 and observed == [1]
    session.expire_all()
    assert session.get(workflows.OsWorkflowRun, response.json()['id']).status == 'queued'
