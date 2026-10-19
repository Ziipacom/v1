"""Isolated SQL and synthetic push endpoints. No real device notifications."""
import base64
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
from pydantic import SecretStr, ValidationError
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app as main
import notification_api as api
import notification_services as s
import notification_worker as w

NOW = datetime(2026, 10, 19, 14, tzinfo=timezone.utc)
PREFIX = '/api/notifications'


def encoded(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def web_subscription():
    public = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {'endpoint': 'https://fcm.googleapis.com/fcm/send/synthetic-only-' + str(uuid.uuid4()),
        'expirationTime': None, 'keys': {'p256dh': encoded(public), 'auth': encoded(b'a' * 16)}}


def device(**changes):
    return {'installation_id': str(uuid.uuid4()), 'provider': 'expo', 'label': 'Synthetic device',
        'consent': True, 'expo_token': 'ExpoPushToken[' + uuid.uuid4().hex + ']', **changes}


@pytest.fixture
def h(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    main.Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as session:
        owner = main.User(name='Push owner', email='push-owner@example.test', password_hash='unused')
        other = main.User(name='Push other', email='push-other@example.test', password_hash='unused')
        session.add_all([owner, other]); session.commit()
        chosen = {'user': owner}
        cache = SimpleNamespace(get=lambda key: str(chosen['user'].id), setex=lambda *args: None)
        monkeypatch.setattr(s, 'cache', cache)
        monkeypatch.setattr(s, 'now', lambda: NOW)
        monkeypatch.setattr(s.config, 'enabled', True)
        monkeypatch.setattr(s.config, 'expo_enabled', True)
        monkeypatch.setattr(s.config, 'encryption_key', SecretStr(encoded(b'k' * 32)))
        monkeypatch.setattr(api, 'notify', lambda: None)
        app = FastAPI(); app.include_router(api.router)
        app.dependency_overrides[main.current_user] = lambda: chosen['user']
        app.dependency_overrides[main.guard] = lambda: None
        def database():
            with factory() as request_session:
                yield request_session
        app.dependency_overrides[main.db] = database
        with TestClient(app) as client:
            client.cookies.set('ziipa_session', 'synthetic-session')
            yield SimpleNamespace(client=client, factory=factory, session=session, owner=owner,
                other=other, chosen=chosen, cache=cache)
    engine.dispose()


def optin(h, categories=None):
    previous = h.client.get(PREFIX + '/preferences').json()
    response = h.client.put(PREFIX + '/preferences', json={'enabled': True, 'categories': categories or list(s.CATEGORIES),
        'consent': True, 'revision': previous['revision']})
    assert response.status_code == 200, response.text
    return response.json()


def register(h, data=None):
    response = h.client.post(PREFIX + '/devices', json=data or device())
    assert response.status_code == 201, response.text
    return response.json()


def enqueue(h, category='calendar', identifier=None, **kwargs):
    with h.factory() as session:
        result = s.enqueue_notification(session, h.owner.id, category, identifier or str(uuid.uuid4()), **kwargs)
        session.commit()
        return result


def delivery(h):
    with h.factory() as session:
        return session.scalar(select(s.NotificationDelivery).order_by(s.NotificationDelivery.created_at.desc()))


def test_default_off_private_owner_preferences_and_no_implicit_consent(h):
    response = h.client.get(PREFIX + '/preferences')
    assert response.json() == {'enabled': False, 'categories': [], 'revision': 1, 'updated_at': None}
    assert response.headers['cache-control'] == 'private, no-store'
    assert h.client.post(PREFIX + '/devices', json=device()).status_code == 409
    assert h.client.put(PREFIX + '/preferences', json={'enabled': True, 'categories': ['calendar'], 'revision': 1}).status_code == 422
    settings = optin(h)
    assert settings['revision'] == 2
    h.chosen['user'] = h.other
    assert h.client.get(PREFIX + '/preferences').json()['enabled'] is False
    assert h.client.put(PREFIX + '/preferences', json={'enabled': False, 'categories': [], 'revision': 2}).status_code == 409


@pytest.mark.parametrize('changes', [
    {'expo_token': 'secret-invalid-do-not-echo'}, {'consent': False}, {'provider': 'wrong'},
    {'subscription': web_subscription()}, {'installation_id': 'invalid'}, {'expo_token': 'ExpoPushToken[short]'}])
def test_registration_errors_never_echo_credentials(h, changes):
    data = device(**changes)
    response = h.client.post(PREFIX + '/devices', json=data)
    assert response.status_code == 422
    assert (data.get('expo_token') or 'not present') not in response.text
    assert 'endpoint' not in response.text


def test_registration_bounded_and_disabled_configuration(h, monkeypatch):
    assert h.client.post(PREFIX + '/devices', content=b'x' * 8193).status_code == 413
    optin(h)
    monkeypatch.setattr(s.config, 'enabled', False)
    assert h.client.post(PREFIX + '/devices', json=device()).status_code == 503


def test_encrypted_at_rest_owner_bound_and_safe_export(h):
    optin(h); data = device(); receipt = register(h, data)
    with h.factory() as session:
        row = session.get(s.PushDevice, receipt['id'])
        assert data['expo_token'] not in row.endpoint_cipher
        assert s.decrypt_device(row) == {'token': data['expo_token']}
        row.owner_id = h.other.id
        with pytest.raises(Exception):
            s.decrypt_device(row)
    text = json.dumps(h.client.get(PREFIX + '/devices').json())
    assert data['expo_token'] not in text and 'session_key' not in text and 'fingerprint' not in text
    exported = s.export_notification_data(h.session, h.owner.id)
    assert data['expo_token'] not in json.dumps(exported)


def test_foreign_owner_revoke_open_and_token_transfer_require_previous_revoke(h):
    optin(h); data = device(); registered = register(h, data); enqueue(h)
    receipt = delivery(h)
    h.chosen['user'] = h.other; optin(h)
    assert h.client.get(PREFIX + '/devices').json() == []
    assert h.client.get(PREFIX + '/deliveries').json() == []
    assert h.client.delete(PREFIX + '/devices/' + registered['id'] + '?revision=1').status_code == 404
    assert h.client.post(PREFIX + '/deliveries/' + receipt.id + '/opened', json={}).status_code == 404
    assert h.client.post(PREFIX + '/devices', json=data).status_code == 409
    h.chosen['user'] = h.owner
    assert h.client.delete(PREFIX + '/devices/' + registered['id'] + '?revision=1').status_code == 200
    h.chosen['user'] = h.other
    assert h.client.post(PREFIX + '/devices', json=data).status_code == 201


def test_device_limit_cannot_be_bypassed_reactivating_revoked_installation(h):
    optin(h); old = device(); registered = register(h, old)
    h.client.delete(PREFIX + '/devices/' + registered['id'] + '?revision=1')
    for _ in range(10):
        register(h)
    assert h.client.post(PREFIX + '/devices', json=old).status_code == 429
    assert h.client.post(PREFIX + '/devices', json=device()).status_code == 429


def test_recipient_idempotency_no_late_backfill_and_fixed_payload(h):
    identifier = str(uuid.uuid4())
    assert enqueue(h, identifier=identifier)['reason'] == 'not_opted_in'
    optin(h); register(h)
    assert enqueue(h, identifier=identifier)['reason'] == 'already_recorded'
    event = str(uuid.uuid4())
    assert enqueue(h, identifier=event)['queued'] == 1
    assert enqueue(h, identifier=event)['queued'] == 0
    row = delivery(h)
    content = s.payload(row)
    assert set(content) == {'title', 'body', 'data'}
    assert set(content['data']) == {'kind', 'category', 'delivery_id', 'route'}
    assert event not in json.dumps(content)


def test_expiry_category_optout_capacity_and_defaultoff_no_database(h, monkeypatch):
    optin(h, ['calendar']); register(h)
    assert enqueue(h, 'recordings')['reason'] == 'not_opted_in'
    assert enqueue(h, expires_at=NOW - timedelta(seconds=1))['reason'] == 'expired'
    monkeypatch.setattr(s, 'MAX_OWNER_QUEUE', 1)
    assert enqueue(h)['queued'] == 1
    assert enqueue(h)['reason'] == 'queue_capacity'
    monkeypatch.setattr(s.config, 'enabled', False)
    assert s.enqueue_notification(None, 1, 'calendar', uuid.uuid4())['reason'] == 'disabled'
    assert w.tick(None) == 0 and w.next_wakeup_at(None) is None


def test_expo_ticket_receipt_and_explicit_open_not_display(h, monkeypatch):
    optin(h); register(h); enqueue(h)
    monkeypatch.setattr(w, 'send_expo', lambda *args: {'status': 'awaiting_receipt', 'ticket_id': 'synthetic-ticket-id'})
    assert w.tick(h.factory) == 1
    row = delivery(h)
    assert row.status == 'awaiting_receipt' and row.provider_accepted_at is None
    assert s.aware(row.next_run) == NOW + timedelta(minutes=15)
    assert w.tick(h.factory) == 0
    monkeypatch.setattr(s, 'now', lambda: NOW + timedelta(minutes=15))
    monkeypatch.setattr(w, 'poll_expo', lambda *args: {'status': 'provider_accepted'})
    assert w.tick(h.factory) == 1
    row = delivery(h)
    assert row.status == 'provider_accepted' and row.opened_at is None
    opened = h.client.post(PREFIX + '/deliveries/' + row.id + '/opened', json={}).json()
    assert opened['opened_at'] and opened['status'] == 'provider_accepted'


def test_logout_missing_session_revokes_before_any_send(h, monkeypatch):
    optin(h); registered = register(h); enqueue(h)
    monkeypatch.setattr(h.cache, 'get', lambda key: None)
    monkeypatch.setattr(w, 'send_expo', lambda *args: pytest.fail('Revoked session sent a push'))
    w.tick(h.factory)
    assert delivery(h).status == 'revoked'
    with h.factory() as session:
        row = session.get(s.PushDevice, registered['id'])
        assert row.status == 'revoked' and not row.endpoint_cipher


def test_revoke_after_claim_cannot_send_and_old_device_revision_invalidates(h, monkeypatch):
    optin(h); data = device(); registered = register(h, data); enqueue(h)
    claimed = w.claim(h.factory)
    register(h, data)
    monkeypatch.setattr(w, 'send_expo', lambda *args: pytest.fail('Stale device sent push'))
    w.process(h.factory, claimed)
    assert delivery(h).status == 'revoked'


def test_expired_sending_lease_is_uncertain_never_duplicate(h, monkeypatch):
    optin(h); register(h); enqueue(h)
    with h.factory() as session:
        row = session.get(s.NotificationDelivery, delivery(h).id)
        row.status = 'sending'; row.submitted_at = NOW - timedelta(minutes=2)
        row.lease_until = NOW - timedelta(seconds=1); row.lease_token = str(uuid.uuid4())
        session.commit()
    monkeypatch.setattr(w, 'send_expo', lambda *args: pytest.fail('Crash retried an ambiguous handoff'))
    assert w.tick(h.factory) == 0
    assert delivery(h).status == 'uncertain'


@pytest.mark.parametrize('result, expected', [({'status': 'retry'}, 'retry'), ({'status': 'uncertain'}, 'uncertain'),
    ({'status': 'revoked'}, 'revoked'), ({'status': 'failed'}, 'failed')])
def test_delivery_outcome_and_bounded_retry(h, monkeypatch, result, expected):
    optin(h); register(h); enqueue(h)
    monkeypatch.setattr(w, 'send_expo', lambda *args: result)
    assert w.tick(h.factory) == 1
    row = delivery(h)
    assert row.status == expected and row.attempts == 1
    if expected == 'retry':
        assert s.aware(row.next_run) == NOW + timedelta(seconds=60)


def test_optout_while_send_inflight_preserves_revocation_and_no_receipt_poll(h, monkeypatch):
    optin(h); register(h); enqueue(h)
    def send(*args):
        with h.factory() as session:
            s.revoke_all_devices(session, h.owner.id); session.commit()
        return {'status': 'awaiting_receipt', 'ticket_id': 'synthetic-ticket'}
    monkeypatch.setattr(w, 'send_expo', send)
    w.tick(h.factory)
    assert delivery(h).status == 'revoked'


def test_receipt_wait_survives_configuration_outage_without_resend(h, monkeypatch):
    optin(h); register(h); enqueue(h)
    monkeypatch.setattr(w, 'send_expo', lambda *args: {'status': 'awaiting_receipt', 'ticket_id': 'synthetic-ticket'})
    w.tick(h.factory)
    monkeypatch.setattr(s, 'now', lambda: NOW + timedelta(minutes=16))
    monkeypatch.setattr(h.cache, 'get', lambda key: (_ for _ in ()).throw(RuntimeError('synthetic outage')))
    w.tick(h.factory)
    assert delivery(h).status == 'awaiting_receipt'


@pytest.mark.parametrize('endpoint', ['http://fcm.googleapis.com/path', 'https://localhost/path',
    'https://fcm.googleapis.com.evil.test/path', 'https://fcm.googleapis.com:444/path',
    'https://x@fcm.googleapis.com/path', 'https://fcm.googleapis.com/path#fragment'])
def test_web_origin_ssrf_rejected(endpoint):
    with pytest.raises(ValueError):
        s.validate_endpoint(endpoint)


def test_web_private_dns_rejected(h, monkeypatch):
    monkeypatch.setattr(s.socket, 'getaddrinfo', lambda *args, **kwargs: [(2, 1, 6, '', ('127.0.0.1', 443))])
    with pytest.raises(ValueError):
        s.validate_endpoint(web_subscription()['endpoint'], resolve=True)


def test_real_expo_transport_fixed_url_no_proxy_redirect_credentials_echo(h, monkeypatch):
    optin(h); register(h); enqueue(h)
    seen = []
    real_client = httpx.Client
    def handle(request):
        seen.append(request)
        assert str(request.url) == w.EXPO_SEND
        body = json.loads(request.content)
        assert body['title'] == 'Ziipa' and body['data']['route'] == 'Notifications'
        return httpx.Response(200, json={'data': {'status': 'ok', 'id': 'synthetic-ticket'}})
    def client(**kwargs):
        assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        return real_client(transport=httpx.MockTransport(handle), **kwargs)
    monkeypatch.setattr(w.httpx, 'Client', client)
    w.tick(h.factory)
    assert delivery(h).status == 'awaiting_receipt' and len(seen) == 1


def test_expo_device_not_registered_and_missing_receipts():
    assert w.expo_result({'status': 'error', 'details': {'error': 'DeviceNotRegistered'}})['status'] == 'revoked'
    assert w.expo_result({'status': 'ok', 'id': 'unsafe\nvalue'})['status'] == 'uncertain'
    assert w.expo_result({'status': 'ok'}, receipt=True)['status'] == 'provider_accepted'


def test_real_webpush_encryption_with_synthetic_subscription_never_network(h, monkeypatch):
    private = ec.generate_private_key(ec.SECP256R1())
    monkeypatch.setattr(s.config, 'vapid_private_key', SecretStr(encoded(private.private_bytes(
        serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))))
    monkeypatch.setattr(s.config, 'vapid_public_key', encoded(private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)))
    monkeypatch.setattr(s.config, 'vapid_subject', 'mailto:push@example.test')
    monkeypatch.setattr(s.socket, 'getaddrinfo', lambda *args, **kwargs: [(2, 1, 6, '', ('8.8.8.8', 443))])
    optin(h)
    register(h, device(provider='web', expo_token=None, subscription=web_subscription()))
    enqueue(h)
    seen = []
    class Connection:
        def __init__(self, host, resolved):
            assert host == 'fcm.googleapis.com' and resolved == [(2, '8.8.8.8')]
        def request(self, method, path, body, headers):
            assert method == 'POST' and path.startswith('/fcm/send/synthetic-only-')
            assert headers['content-encoding'] == 'aes128gcm'
            assert b'private reminder' not in body and b'delivery_id' not in body
            seen.append(path)
        def getresponse(self):
            return SimpleNamespace(status=201, read=lambda size: b'', getheaders=lambda: [])
        def close(self):
            pass
    monkeypatch.setattr(w, 'PinnedPushConnection', Connection)
    assert w.tick(h.factory) == 1
    assert len(seen) == 1 and delivery(h).status == 'provider_accepted'


def requests_response(code):
    from requests import Response
    response = Response(); response.status_code = code
    response._content = b''; response._content_consumed = True
    return response


def test_account_export_delete_and_server_logout_hook(h):
    optin(h); registered = register(h); enqueue(h)
    with h.factory() as session:
        row = session.get(s.PushDevice, registered['id'])
        s.revoke_session_devices(session, h.owner.id, row.session_key)
        session.commit()
    assert delivery(h).status == 'revoked'
    with h.factory() as session:
        s.delete_notification_data(session, h.owner.id); session.commit()
        for model in (s.NotificationPreference, s.PushDevice, s.NotificationEvent, s.NotificationDelivery):
            assert session.scalar(select(func.count()).select_from(model)) == 0


def test_bounded_dns_single_slot_and_private_mapped_address(h, monkeypatch):
    import threading
    import time
    slot = threading.BoundedSemaphore(1)
    monkeypatch.setattr(s, '_DNS_SLOT', slot)
    entered, release = threading.Event(), threading.Event()
    def slow(*args, **kwargs):
        entered.set(); release.wait(2)
        return [(2, 1, 6, '', ('8.8.8.8', 443))]
    monkeypatch.setattr(s.socket, 'getaddrinfo', slow)
    result = []
    thread = threading.Thread(target=lambda: result.append(s.resolve_public('fcm.googleapis.com')))
    thread.start(); assert entered.wait(1)
    started = time.monotonic()
    with pytest.raises(ValueError):
        s.resolve_public('fcm.googleapis.com')
    assert time.monotonic() - started < 0.5
    release.set(); thread.join(2)
    assert result == [[(2, '8.8.8.8')]]
    monkeypatch.setattr(s.socket, 'getaddrinfo', lambda *args, **kwargs: [(10, 1, 6, '', ('::ffff:127.0.0.1', 443))])
    with pytest.raises(ValueError):
        s.resolve_public('fcm.googleapis.com')


def test_prune_retains_recent_uncertain_and_active_and_caps_batch(h):
    optin(h); register(h)
    for _ in range(3):
        enqueue(h)
    with h.factory() as session:
        rows = list(session.scalars(select(s.NotificationDelivery).order_by(s.NotificationDelivery.id)))
        rows[0].status = 'uncertain'; rows[0].updated_at = NOW - timedelta(days=89)
        rows[1].status = 'uncertain'; rows[1].updated_at = NOW - timedelta(days=91)
        rows[2].status = 'queued'; rows[2].updated_at = NOW - timedelta(days=91)
        keep = {rows[0].id, rows[2].id}
        session.commit()
    w.prune_history(h.factory)
    with h.factory() as session:
        assert set(session.scalars(select(s.NotificationDelivery.id))) == keep


def test_lease_wakeup_uses_expiry_not_past_next_run(h):
    optin(h); register(h); enqueue(h)
    assert w.claim(h.factory)
    with h.factory() as session:
        assert w.next_wakeup_at(session) == NOW + timedelta(seconds=s.LEASE_SECONDS)


@pytest.mark.parametrize('code,outcome', [(302, 'failed'), (410, 'revoked'), (429, 'retry'), (503, 'retry')])
def test_web_redirect_never_followed_and_provider_rejections(h, monkeypatch, code, outcome):
    private = ec.generate_private_key(ec.SECP256R1())
    monkeypatch.setattr(s.config, 'vapid_private_key', SecretStr(encoded(private.private_bytes(
        serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))))
    monkeypatch.setattr(s.config, 'vapid_public_key', encoded(private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)))
    monkeypatch.setattr(s.config, 'vapid_subject', 'mailto:push@example.test')
    monkeypatch.setattr(s, 'resolve_public', lambda host: [(2, '8.8.8.8')])
    called = []
    class Connection:
        def __init__(self, host, resolved):
            assert host == 'fcm.googleapis.com'
        def request(self, method, path, body, headers):
            called.append(path)
        def getresponse(self):
            return SimpleNamespace(status=code, read=lambda size: b'',
                getheaders=lambda: [('Location', 'http://127.0.0.1/private')])
        def close(self):
            pass
    monkeypatch.setattr(w, 'PinnedPushConnection', Connection)
    row = SimpleNamespace(id=str(uuid.uuid4()), category='calendar', expires_at=NOW + timedelta(hours=1))
    assert w.send_web(web_subscription(), row)['status'] == outcome
    assert len(called) == 1


def test_retry_budget_and_receipt_window_are_finite(h, monkeypatch):
    optin(h); register(h); enqueue(h)
    calls = []
    monkeypatch.setattr(w, 'send_expo', lambda *args: calls.append(1) or {'status': 'retry'})
    for minute in (0, 2, 6, 14, 30):
        monkeypatch.setattr(s, 'now', lambda minute=minute: NOW + timedelta(minutes=minute))
        w.tick(h.factory)
    assert len(calls) == 4 and delivery(h).status == 'failed'
    with h.factory() as session:
        row = session.get(s.NotificationDelivery, delivery(h).id)
        row.status, row.submitted_at, row.next_run = 'awaiting_receipt', NOW - timedelta(hours=25), NOW
        session.commit()
    monkeypatch.setattr(w, 'poll_expo', lambda *args: pytest.fail('Expired receipt was queried'))
    w.tick(h.factory)
    assert delivery(h).status == 'uncertain'


def test_expo_read_timeout_ambiguous_and_connect_timeout_retry(h, monkeypatch):
    real_client = httpx.Client
    def client_for(error):
        def fail(request):
            raise error('synthetic only', request=request)
        return lambda **kwargs: real_client(transport=httpx.MockTransport(fail), **kwargs)
    monkeypatch.setattr(w.httpx, 'Client', client_for(httpx.ReadTimeout))
    assert w.expo_request(w.EXPO_SEND, {})['status'] == 'uncertain'
    monkeypatch.setattr(w.httpx, 'Client', client_for(httpx.ConnectTimeout))
    assert w.expo_request(w.EXPO_SEND, {})['status'] == 'retry'
