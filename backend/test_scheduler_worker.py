"""Limited Micro scheduler: real SQL reminders/outbox, synthetic transport only."""
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import threading
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import SecretStr
import httpx
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


def test_full_reminder_scan_max_devices_real_transports_and_bounded_recovery(h, monkeypatch):
    """Exercise actual crypto/HTTP adapters against fake sockets, not a RAM filler.

    Fifty due reminders with ten opted-in devices exceed the owner's 200-row
    outbox cap. Each scheduler scan still hands off at most three jobs; explicit
    rejection can retry, ambiguous handoff cannot, and receipt reads are safe.
    """
    factory, cache, owner_id = h
    enable_web_push(monkeypatch)
    monkeypatch.setattr(notifications.config, 'expo_enabled', True)
    monkeypatch.setattr(notifications.config, 'expo_access_token', SecretStr('synthetic-stress-expo-sender-token'))
    current = [NOW]
    monkeypatch.setattr(notifications, 'now', lambda: current[0])
    monkeypatch.setattr(calendar, 'now', lambda: current[0])
    monkeypatch.setattr(worker, 'utcnow', lambda: current[0])
    # No DNS, sockets or provider connections are possible in this fixture.
    monkeypatch.setattr(notifications, 'resolve_public', lambda _host: [(2, '203.0.113.10')])
    web_public = b64(ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
    with factory() as session:
        event = session.scalar(select(calendar.CalendarEvent))
        event.data = {**event.data, 'title': 'Private title ' + 'x' * 126,
                      'notes': ('Private venue permission and plans. ' * 60)[:2000]}
        for offset in range(1, 50):
            session.add(calendar.CalendarOccurrence(event_id=event.id, owner_id=owner_id, event_revision=1,
                starts_at=NOW + timedelta(minutes=5 + offset), ends_at=NOW + timedelta(hours=2), remind_at=NOW))
        session.add(notifications.NotificationPreference(owner_id=owner_id, enabled=True, categories=['calendar']))
        session.flush()
        for index in range(notifications.MAX_DEVICES):
            provider = 'web' if index % 2 == 0 else 'expo'
            fields = {'installation_id': str(uuid.uuid4()), 'provider': provider,
                      'label': ('Synthetic review device ' + str(index)).ljust(60, 'x'), 'consent': True}
            if provider == 'web':
                fields['subscription'] = {'endpoint': 'https://fcm.googleapis.com/fcm/send/synthetic-' + uuid.uuid4().hex,
                    'expirationTime': None, 'keys': {'auth': b64(b'a' * 16), 'p256dh': web_public}}
            else:
                fields['expo_token'] = 'ExpoPushToken[' + uuid.uuid4().hex + ']'
            session_key = 'mobile_session:' + uuid.uuid4().hex
            cache.values[session_key] = str(owner_id)
            notifications.register_device(session, owner_id, notifications.DeviceInput.model_validate(fields), session_key)
        session.commit()
    effects = {'web': 0, 'expo': 0, 'receipts': 0, 'web_rejected': False,
               'expo_rejected': False, 'receipt_pending': False, 'uncertain_id': None}
    expo_attempts = {}

    class FakeWebConnection:
        def __init__(self, host, _resolved):
            assert host == 'fcm.googleapis.com'
        def request(self, method, path, *, body, headers):
            assert method == 'POST' and path.startswith('/fcm/send/synthetic-')
            assert isinstance(body, bytes) and len(body) < 4096
            assert b'Private title' not in body and b'Private venue' not in body
            effects['web'] += 1
        def getresponse(self):
            code = 201 if effects['web_rejected'] else 503
            effects['web_rejected'] = True
            class Response:
                status = code
                def read(self, _size): return b''
                def getheaders(self): return []
            return Response()
        def close(self): pass

    def expo_transport(request):
        assert request.headers['authorization'] == 'Bearer synthetic-stress-expo-sender-token'
        data = json.loads(request.content)
        if str(request.url) == notification_worker.EXPO_SEND:
            effects['expo'] += 1
            identifier = data['data']['delivery_id']
            expo_attempts[identifier] = expo_attempts.get(identifier, 0) + 1
            assert data['data']['route'] == 'Notifications' and data['data']['category'] == 'calendar'
            assert 'Private title' not in request.content.decode() and 'Private venue' not in request.content.decode()
            if not effects['expo_rejected']:
                effects['expo_rejected'] = True
                return httpx.Response(429, json={})
            if effects['uncertain_id'] is None:
                effects['uncertain_id'] = identifier
                raise httpx.ReadTimeout('synthetic ambiguous handoff', request=request)
            return httpx.Response(200, json={'data': {'status': 'ok', 'id': identifier}})
        assert str(request.url) == notification_worker.EXPO_RECEIPTS
        effects['receipts'] += 1
        assert len(data['ids']) == 1
        if not effects['receipt_pending']:
            effects['receipt_pending'] = True
            return httpx.Response(200, json={'data': {}})
        return httpx.Response(200, json={'data': {data['ids'][0]: {'status': 'ok'}}})

    real_http_client = httpx.Client
    monkeypatch.setattr(notification_worker, 'PinnedPushConnection', FakeWebConnection)
    monkeypatch.setattr(notification_worker.httpx, 'Client', lambda **options:
        real_http_client(transport=httpx.MockTransport(expo_transport), **options))
    worker.run_worker(threading.Event(), once=True, coordinator=cache, session_factory=factory)
    assert effects['web'] + effects['expo'] + effects['receipts'] == 3
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(calendar.CalendarOccurrence)
            .where(calendar.CalendarOccurrence.status == 'reminder_ready')) == 50
        assert session.scalar(select(func.count()).select_from(notifications.NotificationEvent)) == 50
        assert session.scalar(select(func.count()).select_from(notifications.NotificationDelivery)) == notifications.MAX_OWNER_QUEUE

    # Drain only bounded batches, advancing a deterministic clock for retries and
    # receipts instead of sleeping or contacting a provider. More than a complete
    # scan's pending work is retained in SQL, never loaded as one large batch.
    for minutes in (0, 15, 30):
        current[0] = NOW + timedelta(minutes=minutes)
        for _ in range(80):
            before = effects['web'] + effects['expo'] + effects['receipts']
            completed = notification_worker.tick(factory)
            assert effects['web'] + effects['expo'] + effects['receipts'] - before <= 3
            if completed == 0:
                break
        else:
            pytest.fail('A bounded outbox phase did not quiesce')
    with factory() as session:
        states = {status: count for status, count in session.execute(
            select(notifications.NotificationDelivery.status, func.count())
            .group_by(notifications.NotificationDelivery.status))}
        assert states == {'provider_accepted': notifications.MAX_OWNER_QUEUE - 1, 'uncertain': 1}
        uncertain = session.get(notifications.NotificationDelivery, effects['uncertain_id'])
        assert uncertain.attempts == 1 and uncertain.next_run is None
        assert session.scalar(select(func.max(notifications.NotificationDelivery.attempts))) == 2
        assert session.scalar(select(func.max(notifications.NotificationDelivery.receipt_checks))) == 2
    assert effects['web'] == 101 and effects['expo'] == 101 and effects['receipts'] == 100
    assert expo_attempts[effects['uncertain_id']] == 1
    before = dict(effects)
    stop = StopAfter(3)
    worker.run_worker(stop, coordinator=cache, session_factory=factory, clock=lambda: stop.time)
    assert effects == before and stop.waits == 3
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(notifications.NotificationEvent)) == 50
        assert session.scalar(select(func.count()).select_from(notifications.NotificationDelivery)) == notifications.MAX_OWNER_QUEUE
    assert notification_worker.provider_readiness(cache) == {'web_ready': True, 'expo_ready': True}
    assert media_workflows.heartbeat_key() not in cache.values


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
