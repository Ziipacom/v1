"""Limited Micro scheduler: real SQL reminders/outbox, synthetic transport only."""
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import threading
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import SecretStr
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app
import calendar_api
import calendar_services as calendar
import calendar_worker
import media_workflows
import notification_services as notifications
import notification_worker
import scheduler_worker as worker

NOW = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)


class Cache:
    def __init__(self):
        self.values, self.calls = {}, []
    def get(self, key):
        self.calls.append(('get', key))
        return self.values.get(key)
    def set(self, key, value, *, ex, nx=False):
        self.calls.append(('set', key))
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True
    def setex(self, key, ttl, value):
        return self.set(key, value, ex=ttl)


class StopAfter:
    def __init__(self, polls):
        self.time, self.waits, self.polls = 0, 0, polls
    def is_set(self):
        return self.waits >= self.polls
    def wait(self, seconds):
        self.time += seconds
        self.waits += 1


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


@pytest.fixture
def h(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    app.Base.metadata.create_all(engine)
    factory, cache = sessionmaker(engine), Cache()
    monkeypatch.setattr(calendar.config, 'enabled', True)
    monkeypatch.setattr(calendar, 'now', lambda: NOW)
    monkeypatch.setattr(notifications, 'now', lambda: NOW)
    monkeypatch.setattr(calendar_worker, 'cache', cache)
    monkeypatch.setattr(notifications, 'cache', cache)
    monkeypatch.setattr(calendar_worker, '_successful_scan', False)
    monkeypatch.setattr(notifications.config, 'enabled', False)
    monkeypatch.setattr(notifications.config, 'expo_enabled', False)
    monkeypatch.setattr(media_workflows.config, 'enabled', False)
    with factory() as session:
        owner = app.User(name='Micro synthetic owner', email='micro@example.test', password_hash='unused')
        session.add(owner); session.commit()
        event = calendar.CalendarEvent(owner_id=owner.id, request_id=str(uuid.uuid4()), request_hash='0' * 64,
            data={'kind': 'reminder', 'title': 'Private text must not enter push payload'})
        session.add(event); session.flush()
        occurrence = calendar.CalendarOccurrence(event_id=event.id, owner_id=owner.id, event_revision=1,
            starts_at=NOW + timedelta(minutes=5), ends_at=NOW + timedelta(hours=1), remind_at=NOW)
        session.add(occurrence); session.commit()
        identity = owner.id
    yield factory, cache, identity
    engine.dispose()


def test_real_reminder_is_transactional_and_no_general_workflow_readiness(h):
    factory, cache, _ = h
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    with factory() as session:
        occurrence = session.scalar(select(calendar.CalendarOccurrence))
        assert occurrence.status == 'reminder_ready' and occurrence.revision == 2
    assert calendar_worker.worker_ready() is True
    assert calendar_api.calendar_config()['reminders_enabled'] is True
    assert not media_workflows.config.enabled
    assert media_workflows.heartbeat_key() not in cache.values


def enable_web_push(monkeypatch):
    private = ec.generate_private_key(ec.SECP256R1())
    monkeypatch.setattr(notifications.config, 'enabled', True)
    monkeypatch.setattr(notifications.config, 'encryption_key', SecretStr(b64(b's' * 32)))
    monkeypatch.setattr(notifications.config, 'vapid_private_key', SecretStr(b64(private.private_bytes(
        serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))))
    monkeypatch.setattr(notifications.config, 'vapid_public_key', b64(private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)))
    monkeypatch.setattr(notifications.config, 'vapid_subject', 'https://ziipa.com')


def test_real_web_outbox_synthetic_transport_and_idempotent_second_scan(h, monkeypatch):
    factory, cache, owner_id = h
    enable_web_push(monkeypatch)
    with factory() as session:
        session.add(notifications.NotificationPreference(owner_id=owner_id, enabled=True, categories=['calendar']))
        device = notifications.PushDevice(owner_id=owner_id, installation_id=str(uuid.uuid4()),
            provider='web', session_key='session:' + '0' * 64, fingerprint='0' * 64, label='Synthetic browser')
        session.add(device); session.flush()
        device.endpoint_cipher = notifications.device_cipher(device,
            {'endpoint': 'https://fcm.googleapis.com/fcm/send/synthetic', 'keys': {'auth': 'synthetic', 'p256dh': 'synthetic'}})
        cache.values[device.session_key] = str(owner_id)
        session.commit()
    sends = []
    monkeypatch.setattr(notification_worker, 'send_web', lambda *args: sends.append('bounded-web') or {'status': 'provider_accepted'})
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    with factory() as session:
        rows = list(session.scalars(select(notifications.NotificationDelivery)))
        assert len(rows) == 1 and rows[0].status == 'provider_accepted'
    assert sends == ['bounded-web']
    assert notification_worker.provider_readiness(cache) == {'web_ready': True, 'expo_ready': False}
    assert media_workflows.heartbeat_key() not in cache.values


def test_optional_native_and_web_share_bounded_outbox_and_receipts(h, monkeypatch):
    factory, cache, owner_id = h
    enable_web_push(monkeypatch)
    monkeypatch.setattr(notifications.config, 'expo_enabled', True)
    monkeypatch.setattr(notifications.config, 'expo_access_token', SecretStr('synthetic-expo-sender-token-only'))
    now = [NOW]
    monkeypatch.setattr(notifications, 'now', lambda: now[0])
    with factory() as session:
        session.add(notifications.NotificationPreference(owner_id=owner_id, enabled=True, categories=['calendar']))
        for provider in ('web', 'expo'):
            device = notifications.PushDevice(owner_id=owner_id, installation_id=str(uuid.uuid4()),
                provider=provider, session_key='session:' + provider, fingerprint=provider[0] * 64, label='Synthetic only')
            session.add(device); session.flush()
            device.endpoint_cipher = notifications.device_cipher(device, {'token': 'ExpoPushToken[synthetic_only_token]'}
                if provider == 'expo' else {'endpoint': 'https://fcm.googleapis.com/fcm/send/synthetic',
                    'keys': {'auth': 'synthetic', 'p256dh': 'synthetic'}})
            cache.values[device.session_key] = str(owner_id)
        session.commit()
    sends = []
    monkeypatch.setattr(notification_worker, 'send_web', lambda *args: sends.append('web') or {'status': 'provider_accepted'})
    monkeypatch.setattr(notification_worker, 'send_expo', lambda *args: sends.append('expo') or
        {'status': 'awaiting_receipt', 'ticket_id': 'synthetic-ticket-only'})
    monkeypatch.setattr(notification_worker, 'poll_expo', lambda *args: sends.append('receipt') or {'status': 'provider_accepted'})
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    now[0] += timedelta(minutes=15)
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    with factory() as session:
        rows = list(session.scalars(select(notifications.NotificationDelivery)))
        assert len(rows) == 2 and all(row.status == 'provider_accepted' for row in rows)
    assert sorted(sends) == ['expo', 'receipt', 'web']
    assert notification_worker.provider_readiness(cache) == {'web_ready': True, 'expo_ready': True}
    assert media_workflows.heartbeat_key() not in cache.values


def test_idle_polling_only_reconciles_sql_hourly(h, monkeypatch):
    factory, cache, _ = h
    stop = StopAfter(61)
    scans = []
    original = calendar_worker.tick
    monkeypatch.setattr(calendar_worker, 'tick', lambda factory: scans.append(stop.time) or original(factory))
    monkeypatch.setattr(worker, 'utcnow', lambda: NOW + timedelta(seconds=stop.time))
    worker.run_worker(stop, coordinator=cache, session_factory=factory, clock=lambda: stop.time)
    assert scans == [0, 3600]
    assert sum(key == calendar_worker.heartbeat_key() for call, key in cache.calls if call == 'set') == 61


def test_cached_reminder_deadline_wakes_without_minute_sql_reads(h, monkeypatch):
    factory, cache, _ = h
    with factory() as session:
        occurrence = session.scalar(select(calendar.CalendarOccurrence))
        occurrence.remind_at = NOW + timedelta(minutes=10)
        session.commit()
    stop, scans = StopAfter(12), []
    original = calendar_worker.tick
    monkeypatch.setattr(calendar_worker, 'tick', lambda factory: scans.append(stop.time) or original(factory))
    monkeypatch.setattr(worker, 'utcnow', lambda: NOW + timedelta(seconds=stop.time))
    monkeypatch.setattr(calendar, 'now', lambda: NOW + timedelta(seconds=stop.time))
    worker.run_worker(stop, coordinator=cache, session_factory=factory, clock=lambda: stop.time)
    assert scans == [0, 600]
    with factory() as session:
        assert session.scalar(select(calendar.CalendarOccurrence.status)) == 'reminder_ready'


def test_due_reminders_are_capped_at_fifty_per_scan(h):
    factory, cache, owner_id = h
    with factory() as session:
        event = session.scalar(select(calendar.CalendarEvent))
        for offset in range(1, 53):
            session.add(calendar.CalendarOccurrence(event_id=event.id, owner_id=owner_id, event_revision=1,
                starts_at=NOW + timedelta(minutes=offset + 5), ends_at=NOW + timedelta(hours=2), remind_at=NOW))
        session.commit()
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(calendar.CalendarOccurrence)
            .where(calendar.CalendarOccurrence.status == 'reminder_ready')) == 50
        assert session.scalar(select(func.count()).select_from(calendar.CalendarOccurrence)
            .where(calendar.CalendarOccurrence.status == 'scheduled')) == 3


def test_wake_during_scan_is_observed_and_failed_scan_never_renews(h, monkeypatch):
    factory, cache, _ = h
    stop = StopAfter(3)
    scans = []
    original = calendar_worker.tick
    def tick(factory):
        scans.append(stop.time)
        if stop.time == 0:
            cache.values[media_workflows.wake_key()] = 'new-committed-hint'
        if stop.time == 60:
            raise RuntimeError('synthetic sensitive diagnostic never printed')
        return original(factory)
    monkeypatch.setattr(calendar_worker, 'tick', tick)
    worker.run_worker(stop, coordinator=cache, session_factory=factory, clock=lambda: stop.time)
    assert scans == [0, 60, 120]
    assert sum(key == calendar_worker.heartbeat_key() for call, key in cache.calls if call == 'set') == 2


def test_failed_once_sanitizes_exception(h, monkeypatch):
    factory, cache, _ = h
    monkeypatch.setattr(calendar_worker, 'tick', lambda *_: (_ for _ in ()).throw(RuntimeError('private-synthetic')))
    with pytest.raises(RuntimeError, match='bounded scan') as result:
        worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    assert 'private-synthetic' not in str(result.value)


def test_calendar_specific_readiness_fails_closed_without_scan(h, monkeypatch):
    factory, cache, _ = h
    cache.values[media_workflows.heartbeat_key()] = 'generic-only'
    calendar_worker.heartbeat(cache)
    assert calendar_api.calendar_config()['worker_ready'] is False


def test_calendar_failed_scan_cannot_keep_renewing_old_success(h, monkeypatch):
    factory, cache, _ = h
    calendar_worker.tick(factory)
    calendar_worker.heartbeat(cache)
    writes = len(cache.calls)
    @contextmanager
    def failed():
        raise RuntimeError('synthetic')
        yield
    with pytest.raises(RuntimeError):
        calendar_worker.tick(failed)
    calendar_worker.heartbeat(cache)
    assert len(cache.calls) == writes
    calendar_worker.tick(factory)
    calendar_worker.heartbeat(cache)
    assert calendar_api.calendar_config()['worker_ready'] is True
    monkeypatch.setattr(calendar.config, 'enabled', False)
    calendar_worker.heartbeat(cache)
    assert calendar_api.calendar_config()['worker_ready'] is False


def test_runtime_requires_all_unsupported_flags_explicitly_off(monkeypatch):
    for name in worker.FORBIDDEN_FLAGS:
        monkeypatch.setenv(name, 'false')
    monkeypatch.setenv('SCHEDULER_ENABLED', 'true')
    monkeypatch.setenv('PUSH_EXPO_ENABLED', 'false')
    monkeypatch.delenv('PUSH_EXPO_ACCESS_TOKEN', raising=False)
    monkeypatch.setattr(calendar.config, 'enabled', True)
    monkeypatch.setattr(notifications.config, 'enabled', False)
    monkeypatch.setattr(notifications.config, 'expo_enabled', False)
    import agent_api, assistant_api, creation_campaigns, live_recordings, media_transcription, render_services
    for config, field in [(agent_api.config, 'enabled'), (assistant_api.config, 'local_ai_enabled'),
        (creation_campaigns.config, 'enabled'), (live_recordings.config, 'live_recordings_enabled'),
        (media_transcription.config, 'enabled'), (render_services.config, 'enabled'), (media_workflows.config, 'enabled'),
        (app.settings, 'social_public_sync_enabled')]:
        monkeypatch.setattr(config, field, False)
    worker.validate_runtime()
    for name in worker.FORBIDDEN_FLAGS:
        monkeypatch.setenv(name, 'true')
        with pytest.raises(ValueError, match='unsupported'):
            worker.validate_runtime()
        monkeypatch.setenv(name, 'false')
    enable_web_push(monkeypatch)
    monkeypatch.setenv('PUSH_EXPO_ENABLED', 'true')
    monkeypatch.setenv('PUSH_EXPO_ACCESS_TOKEN', 'synthetic-expo-sender-token-only')
    monkeypatch.setattr(notifications.config, 'expo_enabled', True)
    monkeypatch.setattr(notifications.config, 'expo_access_token', SecretStr('synthetic-expo-sender-token-only'))
    worker.validate_runtime()
    monkeypatch.setattr(render_services.config, 'enabled', True)
    with pytest.raises(ValueError, match='media/agent'):
        worker.validate_runtime()
