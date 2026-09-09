"""Isolated deployment/coordination tests: no cloud services or real user data."""
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from alembic.script import ScriptDirectory
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import create_engine, text

import app  # Populate model registrations before renderer imports.
import render_migrate as migration
import render_services as render
import render_worker as worker


class Coordinator:
    def __init__(self):
        self.values = {}
        self.calls = []

    def set(self, key, value, **options):
        self.calls.append(('set', key, options))
        self.values[key] = value

    def get(self, key):
        self.calls.append(('get', key))
        return self.values.get(key)

    def eval(self, script, count, key, identity):
        self.calls.append(('eval', key))
        assert count == 1 and "redis.call('get'" in script
        if self.values.get(key) == identity:
            del self.values[key]


class Stop:
    def __init__(self, wait_count):
        self.stopped = False
        self.time = 0
        self.waits = 0
        self.wait_count = wait_count

    def is_set(self):
        return self.stopped

    def wait(self, seconds):
        self.time += seconds
        self.waits += 1
        if self.waits >= self.wait_count:
            self.stopped = True


@contextmanager
def session_factory():
    yield object()


def test_idle_worker_uses_redis_without_polling_neon_every_cycle(monkeypatch):
    monkeypatch.setattr(worker.config, 'poll_seconds', 30)
    monkeypatch.setattr(worker.config, 'reconcile_seconds', 1800)
    stop, coordinator = Stop(5), Coordinator()
    claim, process = Mock(return_value=None), Mock()
    worker.run_worker(stop, coordinator=coordinator, session_factory=session_factory,
                      claim=claim, process=process, clock=lambda: stop.time)
    assert claim.call_count == 1
    assert len([c for c in coordinator.calls if c[0] != 'eval']) == 10
    process.assert_not_called()
    assert worker.HEARTBEAT_KEY not in coordinator.values


def test_enqueue_racing_an_empty_scan_is_not_lost(monkeypatch):
    monkeypatch.setattr(worker.config, 'poll_seconds', 30)
    stop, coordinator = Stop(2), Coordinator()
    scans, delivered = [], []

    def claim(_session):
        scans.append(stop.time)
        if len(scans) == 1:
            # The durable commit and wake arrive just after the empty DB read.
            coordinator.set(worker.WAKE_KEY, 'new-durable-job')
            return None
        return ('owned-job', 'claim-token') if len(scans) == 2 else None

    worker.run_worker(stop, coordinator=coordinator, session_factory=session_factory,
                      claim=claim, process=lambda _factory, *job: delivered.append(job), clock=lambda: stop.time)
    assert delivered == [('owned-job', 'claim-token')]
    assert scans == [0, 30, 30]  # Drain after success without an extra poll delay.


def test_lost_redis_wake_recovers_from_durable_queue(monkeypatch):
    monkeypatch.setattr(worker.config, 'poll_seconds', 30)
    monkeypatch.setattr(worker.config, 'reconcile_seconds', 600)
    stop, coordinator = Stop(21), Coordinator()
    times = []
    worker.run_worker(stop, coordinator=coordinator, session_factory=session_factory,
                      claim=lambda _session: times.append(stop.time), process=Mock(), clock=lambda: stop.time)
    assert times == [0, 600]


def test_graceful_shutdown_finishes_active_work_without_another_claim():
    stop, coordinator = Stop(1), Coordinator()
    claim = Mock(return_value=('owned-job', 'claim-token'))
    completed = []

    def process(_factory, job, token):
        stop.stopped = True  # SIGTERM requests exit; it does not interrupt the render.
        completed.append((job, token))

    worker.run_worker(stop, coordinator=coordinator, session_factory=session_factory,
                      claim=claim, process=process)
    assert completed == [('owned-job', 'claim-token')]
    claim.assert_called_once()
    assert any(c[0] == 'set' and c[2].get('ex') == worker.LEASE_SECONDS for c in coordinator.calls)


def test_old_worker_shutdown_cannot_remove_replacement_heartbeat():
    stop, coordinator = Stop(1), Coordinator()

    def process(*_args):
        coordinator.values[worker.HEARTBEAT_KEY] = 'replacement-worker'
        stop.stopped = True

    worker.run_worker(stop, coordinator=coordinator, session_factory=session_factory,
                      claim=lambda _session: ('job', 'token'), process=process)
    assert coordinator.values[worker.HEARTBEAT_KEY] == 'replacement-worker'


def test_wake_outage_does_not_reject_already_durable_jobs(monkeypatch):
    cache = Mock()
    cache.set.side_effect = RedisConnectionError('Unreachable test Redis')
    monkeypatch.setattr(render, 'cache', cache)
    render.notify_worker()
    cache.set.assert_called_once()


def test_worker_scope_changes_with_data_location_but_not_password_rotation(monkeypatch):
    monkeypatch.setattr(render.settings, 'database_url', 'postgresql://owner:first@db.example.test:5432/ziipa?sslmode=require')
    monkeypatch.setattr(render.settings, 'media_storage_backend', 'r2')
    monkeypatch.setattr(render.settings, 'r2_endpoint_url', 'https://account.r2.cloudflarestorage.com')
    monkeypatch.setattr(render.settings, 'r2_bucket_name', 'private-media')
    original = render.coordination_scope()
    monkeypatch.setattr(render.settings, 'database_url', 'postgresql://owner:second@db.example.test:5432/ziipa?sslmode=require')
    assert render.coordination_scope() == original
    monkeypatch.setattr(render.settings, 'r2_bucket_name', 'another-bucket')
    assert render.coordination_scope() != original
    monkeypatch.setattr(render.settings, 'r2_bucket_name', 'private-media')
    monkeypatch.setattr(render.settings, 'database_url', 'postgresql://owner:second@db.example.test:5432/another?sslmode=require')
    assert render.coordination_scope() != original


@pytest.fixture
def hosted(monkeypatch):
    monkeypatch.setattr(worker, 'engine', SimpleNamespace(dialect=SimpleNamespace(name='postgresql')))
    values = dict(database_url='postgresql://owner:example@db.example.test/ziipa?sslmode=require',
                  media_storage_backend='r2', r2_endpoint_url='https://account.r2.cloudflarestorage.com',
                  r2_bucket_name='private-media', r2_access_key_id='example', r2_secret_access_key='example',
                  redis_url='rediss://default:example@cache.example.test:6379')
    for key, value in values.items():
        monkeypatch.setattr(worker.settings, key, value)
    client = Mock()
    monkeypatch.setattr(worker, '_r2_client', lambda: client)
    return client


@pytest.mark.parametrize('key,value', [
    ('database_url', 'postgresql://owner:example@db.example.test/ziipa'),
    ('media_storage_backend', 'local'),
    ('redis_url', 'redis://cache.example.test:6379'),
    ('r2_endpoint_url', 'http://account.r2.cloudflarestorage.com'),
    ('r2_endpoint_url', 'https://user:password@account.r2.cloudflarestorage.com'),
    ('r2_secret_access_key', ''),
])
def test_hosted_worker_fails_closed_before_storage_access(hosted, monkeypatch, key, value):
    monkeypatch.setattr(worker.settings, key, value)
    with pytest.raises(RuntimeError):
        worker.validate_hosted_settings()
    hosted.head_bucket.assert_not_called()


def test_hosted_worker_checks_bucket_without_creating_media(hosted):
    worker.validate_hosted_settings()
    hosted.head_bucket.assert_called_once_with(Bucket='private-media')
    assert len(hosted.mock_calls) == 1


def test_schema_readiness_requires_current_release_migration():
    engine = create_engine('sqlite://')
    try:
        with pytest.raises(RuntimeError, match='release revision'):
            migration.ensure_schema_ready(engine)
        expected = ScriptDirectory.from_config(migration.migration_config()).get_heads()
        with engine.begin() as connection:
            connection.execute(text('CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)'))
            connection.execute(text('INSERT INTO alembic_version VALUES (:revision)'), {'revision': '20260901_0001'})
        with pytest.raises(RuntimeError, match='release revision'):
            migration.ensure_schema_ready(engine)
        with engine.begin() as connection:
            connection.execute(text('DELETE FROM alembic_version'))
            for revision in expected:
                connection.execute(text('INSERT INTO alembic_version VALUES (:revision)'), {'revision': revision})
        migration.ensure_schema_ready(engine)
    finally:
        engine.dispose()


@pytest.mark.parametrize('fail', [False, True])
def test_neon_migration_lock_and_alembic_share_one_transaction(monkeypatch, fail):
    events = []
    connection = SimpleNamespace(dialect=SimpleNamespace(name='postgresql'),
                                 execute=lambda sql: events.append(str(sql)))

    @contextmanager
    def transaction():
        events.append('begin')
        try:
            yield connection
        except RuntimeError:
            events.append('rollback')
            raise
        else:
            events.append('commit')

    def upgrade(configuration, revision):
        assert configuration.attributes['connection'] is connection and revision == 'head'
        events.append('upgrade')
        if fail:
            raise RuntimeError('Deliberate test migration failure')

    monkeypatch.setattr(migration.command, 'upgrade', upgrade)
    bind = SimpleNamespace(begin=transaction)
    if fail:
        with pytest.raises(RuntimeError, match='Deliberate'):
            migration.upgrade_database(bind)
    else:
        migration.upgrade_database(bind)
    assert events == ['begin', "SET LOCAL lock_timeout = '60s'",
                      'SELECT pg_advisory_xact_lock(25413261051740161)', 'upgrade',
                      'rollback' if fail else 'commit']
