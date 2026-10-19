"""Bounded durable generic push outbox. Never re-send an uncertain handoff.

Exactly-once display is not promised by Expo/APNs/FCM. SQL prevents duplicate
enqueue, retries only explicit rejection/pre-connect failures, and retains an
uncertain receipt across process crashes after the durable send checkpoint.
"""
from datetime import timedelta
import json
import http.client
import ipaddress
import re
import socket
import ssl
import time
from urllib.parse import urlsplit
import uuid

import httpx
import requests
from sqlalchemy import case, delete, exists, func, or_, select

import notification_services as service
from notification_services import NotificationDelivery as Delivery, NotificationPreference, PushDevice

MAX_RESPONSE = 16384
EXPO_SEND = 'https://exp.host/--/api/v2/push/send'
EXPO_RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts'
HEARTBEAT_SECONDS = 180
MAX_HEARTBEAT_BYTES = 512


def heartbeat_key():
    from media_workflows import coordination_scope
    return 'ziipa:push-worker:' + coordination_scope()


def heartbeat(coordinator=None, *, providers=None):
    allowed = selected_providers(providers)
    try:
        expires = int(service.now().timestamp()) + HEARTBEAT_SECONDS
        ready = service.sender_capabilities()
        providers = {provider: service.provider_heartbeat_proof(provider, expires)
            for provider in allowed if ready[provider + '_ready']}
        # An explicit empty provider set also clears a previous configuration's
        # readiness on the next heartbeat. No credential/config values are kept.
        target = coordinator if coordinator is not None else service.cache
        target.setex(heartbeat_key(), HEARTBEAT_SECONDS,
            json.dumps({'version': 2, 'expires_at': expires, 'providers': providers}, separators=(',', ':')))
    except Exception:
        pass


def provider_readiness(coordinator=None):
    result = {'web_ready': False, 'expo_ready': False}
    configured = service.capabilities()
    if not configured['enabled'] or not configured['encryption_ready']:
        return result
    try:
        target = coordinator if coordinator is not None else service.cache
        raw = target.get(heartbeat_key())
        if not isinstance(raw, (str, bytes)) or len(raw.encode('utf-8') if isinstance(raw, str) else raw) > MAX_HEARTBEAT_BYTES:
            return result
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) != {'version', 'expires_at', 'providers'}
                or type(value['version']) is not int or value['version'] != 2
                or type(value['expires_at']) is not int):
            return result
        expires, current = value['expires_at'], int(service.now().timestamp())
        if not current < expires <= current + HEARTBEAT_SECONDS + 15:
            return result
        providers = value['providers']
        if (not isinstance(providers, dict) or len(providers) > 2
                or any(provider not in ('web', 'expo') or not isinstance(proof, str)
                    or not re.fullmatch(r'[0-9a-f]{64}', proof) for provider, proof in providers.items())):
            return result
        for provider, proof in providers.items():
            if configured[provider + '_ready']:
                import hmac
                result[provider + '_ready'] = hmac.compare_digest(
                    proof, service.provider_heartbeat_proof(provider, expires))
    except Exception:
        pass
    return result


def worker_ready():
    return any(provider_readiness().values())


def expo_request(url, data):
    """Fixed destination, no proxies, redirects, credentials in diagnostics."""
    headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
    if url not in (EXPO_SEND, EXPO_RECEIPTS) or not service.config.enabled or not service.config.expo_enabled:
        return {'status': 'configuration_required'}
    try:
        headers['Authorization'] = 'Bearer ' + service.expo_sender_token()
    except Exception:
        return {'status': 'configuration_required'}
    try:
        with httpx.Client(timeout=httpx.Timeout(10, connect=5), trust_env=False, follow_redirects=False) as client:
            with client.stream('POST', url, json=data, headers=headers) as response:
                if response.status_code == 429 or 500 <= response.status_code <= 599:
                    return {'status': 'retry'}
                if not 200 <= response.status_code < 300:
                    return {'status': 'failed'}
                raw = bytearray()
                deadline = time.monotonic() + 15
                for chunk in response.iter_bytes():
                    raw.extend(chunk)
                    if len(raw) > MAX_RESPONSE or time.monotonic() > deadline:
                        return {'status': 'uncertain'}
                result = json.loads(raw)
                return {'status': 'response', 'data': result.get('data')} if isinstance(result, dict) else {'status': 'uncertain'}
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return {'status': 'retry'}
    except Exception:
        # A timeout after writing may mean the provider accepted it. Do not guess.
        return {'status': 'uncertain'}


def expo_result(result, *, receipt=False):
    if not isinstance(result, dict):
        return {'status': 'uncertain'}
    if result.get('status') == 'ok':
        if receipt:
            return {'status': 'provider_accepted'}
        ticket = result.get('id')
        if isinstance(ticket, str) and re.fullmatch(r'[A-Za-z0-9_-]{8,128}', ticket):
            return {'status': 'awaiting_receipt', 'ticket_id': ticket}
        return {'status': 'uncertain'}
    error = result.get('details', {}).get('error') if isinstance(result.get('details'), dict) else None
    if error == 'DeviceNotRegistered':
        return {'status': 'revoked'}
    if error == 'MessageRateExceeded':
        return {'status': 'retry'}
    return {'status': 'failed'}


def send_expo(device_data, row):
    message = service.payload(row) | {'to': device_data['token'], 'priority': 'normal',
        'ttl': max(1, int((service.aware(row.expires_at) - service.now()).total_seconds())),
        'collapseId': row.id}
    result = expo_request(EXPO_SEND, message)
    if result['status'] != 'response':
        return result
    data = result['data']
    if isinstance(data, list):
        data = data[0] if len(data) == 1 else None
    return expo_result(data)


def poll_expo(row):
    result = expo_request(EXPO_RECEIPTS, {'ids': [row.ticket_id]})
    if result['status'] != 'response':
        # Receipt reads are safe to repeat, including ambiguous read failures.
        return {'status': 'receipt_pending'}
    data = result['data']
    if not isinstance(data, dict) or row.ticket_id not in data:
        return {'status': 'receipt_pending'}
    output = expo_result(data[row.ticket_id], receipt=True)
    return {'status': 'receipt_pending'} if output['status'] in ('retry', 'uncertain') else output


class PinnedPushConnection(http.client.HTTPSConnection):
    def __init__(self, host, resolved):
        super().__init__(host, port=443, timeout=8, context=ssl.create_default_context())
        self.resolved = resolved

    def connect(self):
        family, ip = self.resolved[0]
        raw = socket.socket(family, socket.SOCK_STREAM)
        raw.settimeout(5)
        try:
            raw.connect((ip, 443))
            if ipaddress.ip_address(raw.getpeername()[0]) != ipaddress.ip_address(ip):
                raise ValueError('Push provider address changed')
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
            self.sock.settimeout(8)
        except Exception:
            raw.close()
            raise


class BoundedPushSession(requests.Session):
    def __init__(self, endpoint):
        super().__init__()
        self.trust_env = False
        self.endpoint = endpoint

    def post(self, url, *args, **kwargs):
        if url != self.endpoint:
            raise ValueError('Unexpected push destination')
        service.validate_endpoint(url)
        parsed = urlsplit(url)
        # Resolve once with a deadline and connect to that exact verified IP;
        # hostname remains the TLS SNI/certificate identity. No requests DNS
        # re-resolution, proxy env or redirect request can bypass verification.
        connection = PinnedPushConnection(parsed.hostname, service.resolve_public(parsed.hostname))
        try:
            path = parsed.path + ('?' + parsed.query if parsed.query else '')
            connection.request('POST', path, body=kwargs['data'], headers=kwargs['headers'])
            incoming = connection.getresponse()
            raw = bytearray()
            deadline = time.monotonic() + 15
            while True:
                chunk = incoming.read(min(4096, MAX_RESPONSE + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > MAX_RESPONSE or time.monotonic() > deadline:
                    raise ValueError('Oversized push response')
            response = requests.Response()
            response.status_code = incoming.status
            response.headers.update(dict(incoming.getheaders()))
            response._content = bytes(raw)
            response._content_consumed = True
        finally:
            connection.close()
        return response


def send_web(device_data, row):
    try:
        from pywebpush import webpush, WebPushException
        from py_vapid import Vapid
        service.validate_endpoint(device_data['endpoint'])
        expiry = device_data.get('expirationTime')
        if expiry is not None and expiry <= int(service.now().timestamp() * 1000):
            return {'status': 'revoked'}
        with BoundedPushSession(device_data['endpoint']) as client:
            response = webpush(subscription_info={key: device_data[key] for key in ('endpoint', 'keys')},
                data=json.dumps(service.payload(row), separators=(',', ':')),
                vapid_private_key=Vapid(service.vapid_key()), vapid_claims={'sub': service.config.vapid_subject},
                ttl=max(1, int((service.aware(row.expires_at) - service.now()).total_seconds())),
                content_encoding='aes128gcm', timeout=10, verbose=False, requests_session=client,
                headers={'Urgency': 'normal', 'Topic': row.id.replace('-', '')})
            code = response.status_code
    except requests.ConnectTimeout:
        return {'status': 'retry'}
    except requests.ConnectionError:
        # requests.ConnectionError can include a write/reset after handoff. Only
        # explicit ConnectTimeout is known to be before transmission.
        return {'status': 'uncertain'}
    except Exception as exc:
        # Never stringify pywebpush exceptions: they can contain endpoint URLs,
        # ciphertext or provider responses. Status alone is safe to classify.
        response = getattr(exc, 'response', None)
        code = getattr(response, 'status_code', None)
        if code is None:
            return {'status': 'uncertain'}
    if code in (200, 201, 202):
        return {'status': 'provider_accepted'}
    if code in (404, 410):
        return {'status': 'revoked'}
    if code == 429 or 500 <= code <= 599:
        return {'status': 'retry'}
    return {'status': 'failed'}


def current_permission(session, row):
    device = session.scalar(select(PushDevice).where(PushDevice.id == row.device_id,
        PushDevice.owner_id == row.owner_id).execution_options(populate_existing=True))
    pref = session.get(NotificationPreference, row.owner_id, populate_existing=True)
    if not device or device.status != 'active' or device.revision != row.device_revision:
        return device, 'revoked'
    if not pref or not pref.enabled or row.category not in pref.categories:
        return device, 'revoked'
    try:
        owner = service.cache.get(device.session_key)
    except Exception:
        return device, 'session_unavailable'
    if str(owner) != str(row.owner_id):
        service.revoke_device(session, device)
        return device, 'revoked'
    if not service.sender_capabilities().get(row.provider + '_ready'):
        return device, 'configuration_required'
    return device, None


def finish(row, status, detail, *, next_run=None):
    row.status, row.detail, row.next_run = status, detail, next_run
    row.lease_token, row.lease_until, row.updated_at = '', None, service.now()


def selected_providers(providers=None):
    """Internal scheduler allowlist; never infer a provider from queued work."""
    if providers is None:
        return ('web', 'expo')
    if (not isinstance(providers, (tuple, list, set, frozenset)) or not 1 <= len(providers) <= 2
            or any(not isinstance(provider, str) or provider not in ('web', 'expo') for provider in providers)
            or len(set(providers)) != len(providers)):
        raise ValueError('Choose a nonempty subset of supported push providers')
    return tuple(provider for provider in ('web', 'expo') if provider in providers)


def claim(session_factory, *, providers=None):
    allowed = selected_providers(providers)
    current = service.now()
    with session_factory() as session:
        candidates = list(session.execute(select(Delivery.id, Delivery.owner_id).where(
            Delivery.provider.in_(allowed),
            Delivery.status.in_(service.ACTIVE),
            or_(Delivery.lease_until.is_(None), Delivery.lease_until <= current),
            or_(Delivery.next_run <= current, Delivery.status == 'sending'))
            .order_by(Delivery.created_at).limit(20)))
    for identifier, owner_id in candidates:
        with session_factory() as session:
            if not service.owner_lock(session, owner_id):
                continue
            row = session.scalar(select(Delivery).where(Delivery.id == identifier,
                Delivery.provider.in_(allowed)).with_for_update(skip_locked=True).execution_options(populate_existing=True))
            if not row or row.status not in service.ACTIVE or row.lease_until and service.aware(row.lease_until) > current:
                continue
            if row.status == 'sending':
                finish(row, 'uncertain', 'The worker stopped after its send checkpoint. Delivery may have occurred; automatic resend was suppressed.')
                session.commit(); continue
            if row.status != 'awaiting_receipt' and service.aware(row.expires_at) <= current:
                finish(row, 'expired', 'The notification expired before a confirmed handoff.')
                session.commit(); continue
            if row.status == 'awaiting_receipt' and (not row.submitted_at or service.aware(row.submitted_at) + timedelta(hours=24) <= current):
                finish(row, 'uncertain', 'The provider receipt window expired. Display was not verified.')
                session.commit(); continue
            if row.next_run and service.aware(row.next_run) > current:
                continue
            row.lease_token, row.lease_until = str(uuid.uuid4()), current + timedelta(seconds=service.LEASE_SECONDS)
            session.commit()
            return row.id, row.owner_id, row.lease_token
    return None


def process(session_factory, claimed):
    identifier, owner_id, lease = claimed
    with session_factory() as session:
        if not service.owner_lock(session, owner_id):
            return
        row = session.scalar(select(Delivery).where(Delivery.id == identifier, Delivery.owner_id == owner_id).with_for_update().execution_options(populate_existing=True))
        if not row or row.lease_token != lease or row.status not in ('queued', 'retry', 'awaiting_receipt'):
            return
        device, error = current_permission(session, row)
        if error:
            if error == 'revoked':
                finish(row, 'revoked', 'Device, category or sign-in consent was revoked.')
            else:
                finish(row, 'awaiting_receipt' if row.status == 'awaiting_receipt' else 'retry',
                    'Notification configuration or session verification is unavailable.', next_run=service.now() + timedelta(minutes=1))
            session.commit(); return
        receipt = row.status == 'awaiting_receipt'
        try:
            credential = service.decrypt_device(device) if not receipt else None
        except Exception:
            finish(row, 'failed', 'The encrypted device registration is unavailable. Register the device again.')
            session.commit(); return
        if not receipt:
            if row.attempts >= 4:
                finish(row, 'failed', 'The bounded delivery retry limit was reached.')
                session.commit(); return
            # Last authoritative checkpoint before a network call. A revocation
            # committed later cannot recall an already handed-off notification.
            row.status, row.submitted_at = 'sending', service.now()
            row.attempts += 1
        else:
            row.receipt_checks += 1
        row.updated_at = service.now()
        session.commit()
        result = poll_expo(row) if receipt else send_expo(credential, row) if row.provider == 'expo' else send_web(credential, row)
    with session_factory() as session:
        if not service.owner_lock(session, owner_id):
            return
        row = session.scalar(select(Delivery).where(Delivery.id == identifier, Delivery.owner_id == owner_id).with_for_update().execution_options(populate_existing=True))
        if not row or row.lease_token != lease or row.status not in ('sending', 'awaiting_receipt'):
            return
        outcome = result.get('status', 'uncertain')
        if outcome == 'provider_accepted':
            row.provider_accepted_at = service.now()
            finish(row, outcome, 'The push provider accepted this notification. Device display was not verified.')
        elif outcome == 'awaiting_receipt':
            row.ticket_id = result['ticket_id']
            finish(row, outcome, 'Expo accepted a ticket. Awaiting its APNs/FCM provider receipt.', next_run=service.now() + timedelta(minutes=15))
        elif outcome == 'receipt_pending':
            finish(row, 'awaiting_receipt', 'The provider receipt is not available yet.', next_run=service.now() + timedelta(minutes=15))
        elif outcome == 'retry':
            finish(row, 'retry', 'The provider explicitly rejected this attempt or the connection did not begin. A bounded retry is scheduled.',
                next_run=service.now() + timedelta(seconds=min(3600, 30 * 2 ** row.attempts)))
        elif outcome == 'configuration_required':
            finish(row, 'awaiting_receipt' if receipt else 'retry',
                'Authenticated notification sender configuration is unavailable. No new handoff was attempted.',
                next_run=service.now() + timedelta(minutes=1))
        elif outcome == 'revoked':
            device = session.get(PushDevice, row.device_id)
            if device:
                service.revoke_device(session, device)
            finish(row, 'revoked', 'The provider reported that this device registration is no longer valid.')
        elif outcome == 'failed':
            finish(row, 'failed', 'The push provider rejected this notification. Review configuration or register the device again.')
        else:
            finish(row, 'uncertain', 'The provider outcome is unknown. Automatic resend was suppressed to avoid duplicate alerts.')
        session.commit()


def tick(session_factory, limit=3, *, providers=None):
    allowed = selected_providers(providers)
    if not service.config.enabled:
        return 0
    started, completed = time.monotonic(), 0
    for _ in range(max(0, min(limit, 3))):
        if time.monotonic() - started > 25:
            break
        claimed = claim(session_factory, providers=allowed)
        if not claimed:
            break
        try:
            process(session_factory, claimed)
        except Exception:
            # Never emit credential-bearing transport exceptions. The durable
            # checkpoint/lease determines safe recovery after an interrupted call.
            pass
        completed += 1
    heartbeat(providers=allowed)
    prune_history(session_factory, providers=allowed)
    return completed


def prune_history(session_factory, *, providers=None):
    """Keep receipts (including uncertain handoffs) 90 days; bounded batches.

    Old event dedupe tombstones survive at least as long as all their receipts.
    Producers already have their own durable occurrence/completion identities.
    This maintenance never erases active work or retries a historical event.
    """
    allowed = selected_providers(providers)
    cutoff = service.now() - timedelta(days=90)
    with session_factory() as session:
        stale = list(session.scalars(select(Delivery.id).where(Delivery.provider.in_(allowed), Delivery.status.not_in(service.ACTIVE),
            Delivery.updated_at < cutoff).order_by(Delivery.updated_at).limit(100)))
        if stale:
            session.execute(delete(Delivery).where(Delivery.id.in_(stale)))
        from notification_services import NotificationEvent
        events = list(session.scalars(select(NotificationEvent.id).where(NotificationEvent.created_at < cutoff,
            ~exists().where(Delivery.event_id == NotificationEvent.id)).order_by(NotificationEvent.created_at).limit(100)))
        if events:
            session.execute(delete(NotificationEvent).where(NotificationEvent.id.in_(events)))
        session.commit()


def next_wakeup_at(session, *, providers=None):
    allowed = selected_providers(providers)
    if not service.config.enabled:
        return None
    value = session.scalar(select(func.min(case((Delivery.lease_until.is_not(None), Delivery.lease_until),
        else_=Delivery.next_run))).where(Delivery.status.in_(service.ACTIVE), Delivery.provider.in_(allowed)))
    return service.aware(value)
