"""Capability heartbeat must describe the recording worker, not generic uptime."""
from contextlib import contextmanager

import pytest

import app  # register shared models before importing dependent modules
import live_recordings as recordings
import live_recordings_worker as worker
import media_workflows as workflows


class Coordinator:
    def __init__(self):
        self.values, self.writes = {}, []
    def set(self, key, value, *, ex):
        self.values[key] = value
        self.writes.append((key, value, ex))
    def get(self, key):
        return self.values.get(key)


@pytest.fixture
def coordinator(monkeypatch):
    value = Coordinator()
    monkeypatch.setattr(worker, 'cache', value)
    monkeypatch.setattr(worker, '_successful_scan', False)
    monkeypatch.setattr(recordings.config, 'live_recordings_enabled', True)
    return value


def test_generic_workflow_heartbeat_does_not_advertise_recording_readiness(coordinator):
    coordinator.set(workflows.heartbeat_key(), 'generic-only', ex=180)
    assert worker.worker_ready() is False
    assert recordings.configuration()['worker_ready'] is False


def test_disabled_recording_worker_does_not_scan_or_emit_heartbeat(coordinator, monkeypatch):
    monkeypatch.setattr(recordings.config, 'live_recordings_enabled', False)
    monkeypatch.setattr(worker, '_successful_scan', True)
    def forbidden():
        pytest.fail('Disabled recording worker touched the database')
    assert worker.tick(forbidden) is False
    worker.heartbeat(coordinator)
    assert coordinator.writes == []
    coordinator.values[worker.heartbeat_key()] = 'an-expiring-previous-worker'
    assert worker.worker_ready() is False


def test_enabled_but_unscanned_process_cannot_claim_recording_capability(coordinator):
    worker.heartbeat(coordinator)
    assert coordinator.writes == []


def test_successful_empty_scan_allows_redis_only_idle_renewal(coordinator, monkeypatch):
    scans = []
    @contextmanager
    def factory():
        scans.append('database')
        yield object()
    monkeypatch.setattr(worker, 'claim', lambda session: None)
    assert worker.tick(factory) is False
    assert scans == ['database']
    assert coordinator.writes == []  # tick adds no real Redis dependency
    for _ in range(5):
        worker.heartbeat(coordinator)
    assert scans == ['database']
    assert len(coordinator.writes) == 5
    assert all(entry == (worker.heartbeat_key(), 'ready', 180) for entry in coordinator.writes)
    assert recordings.configuration()['worker_ready'] is True


def test_failed_scan_cannot_renew_a_previous_successful_capability(coordinator, monkeypatch):
    monkeypatch.setattr(worker, '_successful_scan', True)
    worker.heartbeat(coordinator)
    @contextmanager
    def factory():
        yield object()
    def failed(session):
        raise RuntimeError('synthetic database failure')
    monkeypatch.setattr(worker, 'claim', failed)
    with pytest.raises(RuntimeError):
        worker.tick(factory)
    before = len(coordinator.writes)
    worker.heartbeat(coordinator)
    assert len(coordinator.writes) == before  # previous lease expires normally


def test_heartbeat_and_configuration_fail_closed_during_cache_outage(coordinator, monkeypatch):
    monkeypatch.setattr(worker, '_successful_scan', True)
    def failed(*args, **kwargs):
        raise RuntimeError('synthetic cache failure')
    monkeypatch.setattr(coordinator, 'get', failed)
    monkeypatch.setattr(coordinator, 'set', failed)
    worker.heartbeat(coordinator)
    assert recordings.configuration()['worker_ready'] is False


def test_recording_heartbeat_is_database_scoped_without_exposing_connection_values(coordinator, monkeypatch):
    original = worker.heartbeat_key()
    monkeypatch.setattr(workflows.settings, 'database_url', 'postgresql://owner:private@different.invalid/another')
    assert worker.heartbeat_key() != original
    assert 'private' not in worker.heartbeat_key()
    assert 'different.invalid' not in worker.heartbeat_key()
