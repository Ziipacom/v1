"""Cross-module notification transactions/auth revocation; no external sends."""
import base64
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import uuid

from fastapi.testclient import TestClient
from pydantic import SecretStr
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app as main
import account_services as accounts
import mobile_api as mobile
import calendar_services as calendar
import calendar_worker
import campaign_worker
from creation_campaigns import CampaignDelivery, CreationCampaign
import notification_services as notifications
import notification_worker

NOW = datetime(2026, 10, 19, 16, tzinfo=timezone.utc)
WEB_TOKEN = 'synthetic-web-session-only'
MOBILE_TOKEN = 'synthetic-mobile-session-only'


class Cache:
    def __init__(self):
        self.values, self.sets, self.pending = {}, {}, []
    def get(self, key):
        return self.values.get(key)
    def pipeline(self):
        return self
    def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None); self.sets.pop(key, None)
        return self
    def srem(self, name, key):
        self.sets.get(name, set()).discard(key)
        return self
    def smembers(self, name):
        return self.sets.get(name, set()).copy()
    def execute(self):
        return []
    def setex(self, key, ttl, value):
        self.values[key] = value


@pytest.fixture
def h(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    main.Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    cache = Cache()
    with factory() as session:
        owner = main.User(name='Notification integration', email='notification-integration@example.test', password_hash='old-synthetic-hash')
        other = main.User(name='Other notification owner', email='notification-integration-other@example.test', password_hash='unused')
        session.add_all([owner, other]); session.commit()
        owner_id, other_id = owner.id, other.id
        web_key = accounts.session_key('session:', WEB_TOKEN)
        mobile_key = accounts.session_key('mobile_session:', MOBILE_TOKEN)
        other_key = accounts.session_key('session:', 'synthetic-other-session')
        cache.values.update({web_key: str(owner_id), mobile_key: str(owner_id), other_key: str(other_id)})
        cache.sets.update({f'user_sessions:{owner_id}': {web_key, mobile_key}, f'user_sessions:{other_id}': {other_key}})
        for module in (main, mobile, accounts, notifications):
            monkeypatch.setattr(module, 'cache', cache)
        monkeypatch.setattr(notifications, 'now', lambda: NOW)
        monkeypatch.setattr(calendar, 'now', lambda: NOW)
        monkeypatch.setattr(notifications.config, 'enabled', True)
        monkeypatch.setattr(notifications.config, 'expo_enabled', True)
        monkeypatch.setattr(notifications.config, 'expo_access_token', SecretStr('synthetic-expo-integration-token'))
        monkeypatch.setattr(notifications.config, 'encryption_key', SecretStr(base64.urlsafe_b64encode(b'n' * 32).decode()))
        monkeypatch.setattr(calendar.config, 'enabled', True)
        monkeypatch.setattr(notification_worker, 'send_expo', lambda *a: pytest.fail('Auth/source integration must not send a notification'))
        def database():
            with factory() as request_session:
                yield request_session
        # Exercise the application's real registered routes (not copied wrappers)
        # without starting its lifespan or touching the configured development DB.
        monkeypatch.setattr(main.app, 'dependency_overrides', {main.db: database, main.guard: lambda: None})
        for uid in (owner_id, other_id):
            session.add(notifications.NotificationPreference(owner_id=uid, enabled=True, categories=list(notifications.CATEGORIES)))
        devices = {}
        for name, uid, key in (('web', owner_id, web_key), ('mobile', owner_id, mobile_key), ('other', other_id, other_key)):
            data = notifications.DeviceInput.model_validate({'installation_id': str(uuid.uuid4()), 'provider': 'expo',
                'label': name, 'consent': True, 'expo_token': 'ExpoPushToken[' + uuid.uuid4().hex + ']'})
            row = notifications.register_device(session, uid, data, key)
            devices[name] = row.id
        session.commit()
    client = TestClient(main.app)
    try:
        yield SimpleNamespace(factory=factory, owner_id=owner_id, other_id=other_id, cache=cache,
            web_key=web_key, mobile_key=mobile_key, other_key=other_key, devices=devices, client=client)
    finally:
        client.close(); engine.dispose()


def enqueue(h):
    with h.factory() as session:
        assert notifications.enqueue_notification(session, h.owner_id, 'calendar', uuid.uuid4())['queued'] == 2
        assert notifications.enqueue_notification(session, h.other_id, 'calendar', uuid.uuid4())['queued'] == 1
        session.commit()


def assert_revoked(h, names):
    with h.factory() as session:
        for name, identity in h.devices.items():
            device = session.get(notifications.PushDevice, identity)
            delivery = session.scalar(select(notifications.NotificationDelivery).where(notifications.NotificationDelivery.device_id == identity))
            if name in names:
                assert device.status == 'revoked' and not device.endpoint_cipher
                assert delivery.status == 'revoked' and delivery.next_run is None
            else:
                assert device.status == 'active' and device.endpoint_cipher
                assert delivery.status == 'queued'


def test_actual_cookie_logout_revokes_only_current_session_devices_and_pending_alerts(h):
    enqueue(h)
    h.client.cookies.set('ziipa_session', WEB_TOKEN)
    response = h.client.post('/api/auth/logout')
    assert response.status_code == 200 and response.json() == {'ok': True}
    assert 'Max-Age=0' in response.headers['set-cookie']
    assert h.cache.get(h.web_key) is None
    assert h.cache.get(h.mobile_key) == str(h.owner_id)
    assert_revoked(h, {'web'})


def test_actual_native_logout_revokes_only_bearer_bound_device_and_pending_alerts(h):
    enqueue(h)
    response = h.client.post('/api/mobile/auth/logout', headers={'Authorization': 'Bearer ' + MOBILE_TOKEN})
    assert response.status_code == 200 and response.json() == {'ok': True}
    assert h.cache.get(h.mobile_key) is None
    assert h.cache.get(h.web_key) == str(h.owner_id)
    assert_revoked(h, {'mobile'})


def test_actual_password_recovery_revokes_all_owner_devices_pending_alerts_and_sessions(h):
    enqueue(h)
    raw = 'synthetic-recovery-token-' + uuid.uuid4().hex
    with h.factory() as session:
        session.add(accounts.AccountToken(owner_id=h.owner_id, purpose='password_reset',
            token_hash=accounts.token_hash(raw), expires_at=datetime.now(timezone.utc) + timedelta(minutes=10)))
        session.commit()
    response = h.client.post('/api/auth/reset-password', json={'token': raw, 'password': 'New synthetic password 2!'})
    assert response.status_code == 200, response.text
    assert h.cache.get(h.web_key) is None and h.cache.get(h.mobile_key) is None
    assert h.cache.get(h.other_key) == str(h.other_id)
    assert_revoked(h, {'web', 'mobile'})
    with h.factory() as session:
        assert main.passwords.verify('New synthetic password 2!', session.get(main.User, h.owner_id).password_hash)
        assert session.scalar(select(accounts.AccountToken).where(accounts.AccountToken.owner_id == h.owner_id)).used_at is not None


def test_calendar_reminder_source_and_notification_commit_or_rollback_together(h, monkeypatch):
    import personal_media
    with h.factory() as session:
        event = calendar.CalendarEvent(owner_id=h.owner_id, request_id=str(uuid.uuid4()), request_hash='a' * 64,
            data={'kind': 'reminder', 'title': 'Private sensitive reminder', 'notes': 'never a lockscreen body'})
        session.add(event); session.flush()
        occurrence = calendar.CalendarOccurrence(event_id=event.id, owner_id=h.owner_id, event_revision=1,
            starts_at=NOW + timedelta(minutes=10), ends_at=NOW + timedelta(hours=1), remind_at=NOW - timedelta(seconds=1))
        session.add(occurrence); session.commit(); identifier = occurrence.id
    original = personal_media.record_activity
    def crash(*args, **kwargs):
        raise RuntimeError('synthetic transaction interruption after notification enqueue')
    monkeypatch.setattr(personal_media, 'record_activity', crash)
    with pytest.raises(RuntimeError):
        calendar_worker.tick(h.factory)
    with h.factory() as session:
        assert session.get(calendar.CalendarOccurrence, identifier).status == 'scheduled'
        assert session.scalar(select(func.count()).select_from(notifications.NotificationEvent)) == 0
        assert session.scalar(select(func.count()).select_from(notifications.NotificationDelivery)) == 0
    monkeypatch.setattr(personal_media, 'record_activity', original)
    assert calendar_worker.tick(h.factory) == 1
    assert calendar_worker.tick(h.factory) == 0
    with h.factory() as session:
        assert session.get(calendar.CalendarOccurrence, identifier).status == 'reminder_ready'
        assert session.scalar(select(func.count()).select_from(notifications.NotificationEvent)) == 1
        rows = list(session.scalars(select(notifications.NotificationDelivery)))
        assert len(rows) == 2 and all(row.status == 'queued' for row in rows)
        assert all('sensitive' not in notifications.payload(row)['body'] for row in rows)


def test_campaign_completion_notification_transaction_rollback_and_replay_are_atomic(h):
    with h.factory() as session:
        campaign = CreationCampaign(owner_id=h.owner_id, request_id=str(uuid.uuid4()), request_hash='b' * 64,
            item_id=str(uuid.uuid4()), name='Synthetic already delivered campaign', title='Private creator title', status='delivering')
        session.add(campaign); session.flush()
        destination = CampaignDelivery(campaign_id=campaign.id, owner_id=h.owner_id, campaign_revision=campaign.revision,
            provider='bluesky', target_id='synthetic-already-delivered', privacy='public', approval_hash='b' * 64,
            status='delivered')
        session.add(destination); session.commit(); identifier = campaign.id
    with h.factory() as session:
        row = session.get(CreationCampaign, identifier)
        deliveries = list(session.scalars(select(CampaignDelivery).where(CampaignDelivery.campaign_id == identifier)))
        campaign_worker._finish_deliveries(row, deliveries, session=session)
        assert row.status == 'completed'
        assert session.scalar(select(func.count()).select_from(notifications.NotificationDelivery)) == 2
        session.rollback()
    with h.factory() as session:
        assert session.get(CreationCampaign, identifier).status == 'delivering'
        assert session.scalar(select(func.count()).select_from(notifications.NotificationEvent)) == 0
        assert session.scalar(select(func.count()).select_from(notifications.NotificationDelivery)) == 0
    for _ in range(2):
        with h.factory() as session:
            row = session.get(CreationCampaign, identifier)
            deliveries = list(session.scalars(select(CampaignDelivery).where(CampaignDelivery.campaign_id == identifier)))
            campaign_worker._finish_deliveries(row, deliveries, session=session)
            session.commit()
    with h.factory() as session:
        assert session.get(CreationCampaign, identifier).status == 'completed'
        assert session.scalar(select(func.count()).select_from(notifications.NotificationEvent)) == 1
        rows = list(session.scalars(select(notifications.NotificationDelivery)))
        assert len(rows) == 2 and all(row.category == 'campaigns' and row.status == 'queued' for row in rows)
