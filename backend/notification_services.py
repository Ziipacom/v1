"""Opt-in, generic device notifications. No arbitrary message/agent send surface.

Push endpoints are credentials: encrypted at rest and never returned in receipts.
Provider acceptance is not proof that a notification appeared on a device.
"""
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import queue
import re
import socket
import threading
from typing import Literal
from urllib.parse import urlsplit
import uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StrictBool, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, func, select, update
from sqlalchemy.orm import Mapped, mapped_column

from app import Base, User, cache

Category = Literal['calendar', 'recordings', 'campaigns']
CATEGORIES = ('calendar', 'recordings', 'campaigns')
ACTIVE = ('queued', 'retry', 'sending', 'awaiting_receipt')
MAX_DEVICES = 10
MAX_QUEUE = 5000
MAX_OWNER_QUEUE = 200
LEASE_SECONDS = 90
KNOWN_WEB_ORIGINS = frozenset(('https://fcm.googleapis.com', 'https://updates.push.services.mozilla.com', 'https://web.push.apple.com'))
MESSAGES = {
    'calendar': 'A private reminder is ready. Open Ziipa to review it.',
    'recordings': 'Your private recording or clip is ready. Open Ziipa to review it.',
    'campaigns': 'A campaign finished. Open Ziipa to review its delivery receipts.',
}
_DNS_SLOT = threading.BoundedSemaphore(1)


def resolve_public(host):
    """One daemon resolver at most; a blocked OS resolver cannot grow threads."""
    if not _DNS_SLOT.acquire(blocking=False):
        raise ValueError('Push DNS verification is busy')
    result = queue.Queue(maxsize=1)
    def lookup():
        try:
            result.put(socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM))
        except Exception:
            result.put(None)
        finally:
            _DNS_SLOT.release()
    threading.Thread(target=lookup, daemon=True, name='ziipa-push-dns').start()
    try:
        answers = result.get(timeout=5)
        if not answers or len(answers) > 32:
            raise ValueError()
        resolved = []
        for family, _, _, _, address in answers:
            ip = ipaddress.ip_address(address[0])
            if (family not in (socket.AF_INET, socket.AF_INET6) or not ip.is_global
                    or getattr(ip, 'ipv4_mapped', None) and not ip.ipv4_mapped.is_global):
                raise ValueError()
            if (family, str(ip)) not in resolved:
                resolved.append((family, str(ip)))
        return resolved
    except (queue.Empty, ValueError, TypeError):
        raise ValueError('Push DNS could not be safely verified') from None


class NotificationSettings(BaseSettings):
    enabled: bool = False
    encryption_key: SecretStr = SecretStr('')
    expo_enabled: bool = False
    expo_access_token: SecretStr = SecretStr('')
    vapid_private_key: SecretStr = SecretStr('')
    vapid_public_key: str = ''
    vapid_subject: str = ''
    web_allowed_origins: str = ','.join(sorted(KNOWN_WEB_ORIGINS))
    model_config = SettingsConfigDict(env_prefix='PUSH_', env_file='.env', extra='ignore', hide_input_in_errors=True)


config = NotificationSettings()


def now():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def stamp(value):
    return aware(value).isoformat() if value else None


def b64decode(value, length=None):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+={0,2}', value) or len(value) > 4096:
        raise ValueError('Invalid encoded key')
    raw = base64.b64decode(value.rstrip('=') + '=' * (-len(value.rstrip('=')) % 4), altchars=b'-_', validate=True)
    if length is not None and len(raw) != length:
        raise ValueError('Invalid key length')
    return raw


def encryption_key():
    raw = b64decode(config.encryption_key.get_secret_value(), 32)
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b'ziipa:device-push:v1').derive(raw)


def vapid_key():
    value = b64decode(config.vapid_private_key.get_secret_value())
    private = serialization.load_der_private_key(value, password=None)
    if not isinstance(private, ec.EllipticCurvePrivateKey) or not isinstance(private.curve, ec.SECP256R1):
        raise ValueError('VAPID requires P256')
    public = private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    if not hmac.compare_digest(public, b64decode(config.vapid_public_key, 65)):
        raise ValueError('VAPID key pair mismatch')
    subject = urlsplit(config.vapid_subject)
    if not ((subject.scheme == 'mailto' and re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', subject.path)) or
            (subject.scheme == 'https' and subject.hostname and not subject.username and not subject.password and not subject.query and not subject.fragment)):
        raise ValueError('A VAPID contact is required')
    return private


def capabilities():
    crypto = False
    web = False
    try:
        encryption_key(); crypto = True
    except Exception:
        pass
    try:
        from pywebpush import webpush  # pinned optional transport; never called here
        vapid_key(); allowed_web_origins(); web = bool(webpush)
    except Exception:
        pass
    return {'enabled': config.enabled, 'encryption_ready': crypto,
            'expo_ready': bool(config.enabled and crypto and config.expo_enabled),
            'web_ready': bool(config.enabled and crypto and web),
            'vapid_public_key': config.vapid_public_key if config.enabled and crypto and web else None}


def allowed_web_origins():
    result = {value.strip().rstrip('/') for value in config.web_allowed_origins.split(',') if value.strip()}
    if not result or any(value not in KNOWN_WEB_ORIGINS for value in result):
        raise ValueError('Choose exact supported Web Push origins')
    return result


def validate_endpoint(endpoint, *, resolve=False):
    if not isinstance(endpoint, str) or not 20 <= len(endpoint) <= 2048:
        raise ValueError('Invalid push endpoint')
    parsed = urlsplit(endpoint)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.fragment or not parsed.path or parsed.path == '/'
            or any(c.isspace() or ord(c) < 32 for c in endpoint)
            or f'https://{parsed.hostname}' not in allowed_web_origins()):
        raise ValueError('Unsupported Web Push origin')
    if resolve:
        resolve_public(parsed.hostname)
    return endpoint


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True, hide_input_in_errors=True)


class SubscriptionKeys(Input):
    p256dh: str = Field(min_length=80, max_length=100)
    auth: str = Field(min_length=20, max_length=30)

    @model_validator(mode='after')
    def keys(self):
        public = b64decode(self.p256dh, 65)
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)
        b64decode(self.auth, 16)
        return self


class WebSubscription(Input):
    endpoint: str = Field(min_length=20, max_length=2048)
    expirationTime: int | None = None
    keys: SubscriptionKeys

    @model_validator(mode='after')
    def valid(self):
        validate_endpoint(self.endpoint)
        if self.expirationTime is not None and (type(self.expirationTime) is not int or self.expirationTime <= int(now().timestamp() * 1000)):
            raise ValueError('Expired subscription')
        return self


class DeviceInput(Input):
    installation_id: uuid.UUID
    provider: Literal['expo', 'web']
    label: str = Field(default='My device', min_length=1, max_length=60)
    consent: StrictBool = False
    expo_token: str | None = Field(default=None, max_length=180)
    subscription: WebSubscription | None = None

    @model_validator(mode='after')
    def shape(self):
        if not self.consent:
            raise ValueError('Explicit device consent is required')
        if self.provider == 'expo':
            if self.subscription is not None or not self.expo_token or not re.fullmatch(r'(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{16,128}\]', self.expo_token):
                raise ValueError('Use a valid Expo push token')
        elif self.expo_token is not None or self.subscription is None:
            raise ValueError('Use a browser PushSubscription')
        return self


class PreferenceInput(Input):
    enabled: StrictBool = False
    categories: list[Category] = Field(default_factory=list, max_length=3)
    consent: StrictBool = False
    revision: int = Field(ge=1, strict=True)

    @model_validator(mode='after')
    def unique(self):
        if len(set(self.categories)) != len(self.categories) or self.enabled and (not self.consent or not self.categories):
            raise ValueError('Explicitly choose your notification categories')
        return self


class NotificationPreference(Base):
    __tablename__ = 'notification_preferences'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    enabled: Mapped[bool] = mapped_column(default=False)
    categories: Mapped[list] = mapped_column(JSON, default=list)
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PushDevice(Base):
    __tablename__ = 'push_devices'
    __table_args__ = (UniqueConstraint('fingerprint'), UniqueConstraint('owner_id', 'installation_id', 'provider'))
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    installation_id: Mapped[str] = mapped_column(String(36))
    provider: Mapped[str] = mapped_column(String(8))
    label: Mapped[str] = mapped_column(String(60))
    fingerprint: Mapped[str] = mapped_column(String(64))
    endpoint_cipher: Mapped[str] = mapped_column(String(6000), default='')
    session_key: Mapped[str] = mapped_column(String(100), index=True)
    status: Mapped[str] = mapped_column(String(16), default='active')
    revision: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_registered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class NotificationEvent(Base):
    __tablename__ = 'notification_events'
    __table_args__ = (UniqueConstraint('owner_id', 'category', 'event_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    category: Mapped[str] = mapped_column(String(16))
    event_id: Mapped[str] = mapped_column(String(36))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class NotificationDelivery(Base):
    __tablename__ = 'notification_deliveries'
    __table_args__ = (UniqueConstraint('event_id', 'device_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    event_id: Mapped[str] = mapped_column(ForeignKey('notification_events.id', ondelete='CASCADE'), index=True)
    device_id: Mapped[str] = mapped_column(ForeignKey('push_devices.id', ondelete='CASCADE'), index=True)
    device_revision: Mapped[int]
    category: Mapped[str] = mapped_column(String(16))
    provider: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(24), default='queued', index=True)
    detail: Mapped[str] = mapped_column(String(300), default='Waiting for the opted-in notification worker.')
    attempts: Mapped[int] = mapped_column(default=0)
    receipt_checks: Mapped[int] = mapped_column(default=0)
    ticket_id: Mapped[str] = mapped_column(String(128), default='')
    lease_token: Mapped[str] = mapped_column(String(36), default='')
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=now, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    provider_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


def owner_lock(session, owner_id):
    if session.bind.dialect.name == 'sqlite':
        session.execute(update(User).where(User.id == owner_id).values(id=owner_id))
    return session.scalar(select(User).where(User.id == owner_id).with_for_update().execution_options(populate_existing=True))


def preference_receipt(row):
    return {'enabled': bool(row.enabled) if row else False, 'categories': list(row.categories) if row else [],
            'revision': row.revision if row else 1, 'updated_at': stamp(row.updated_at) if row else None}


def device_receipt(row):
    return {key: getattr(row, key) for key in ('id', 'provider', 'label', 'status', 'revision')} | {
            'created_at': stamp(row.created_at), 'last_registered_at': stamp(row.last_registered_at)}


def delivery_receipt(row):
    return {key: getattr(row, key) for key in ('id', 'category', 'provider', 'status', 'detail', 'attempts')} | {
            key: stamp(getattr(row, key)) for key in ('created_at', 'provider_accepted_at', 'opened_at')}


def device_cipher(row, data):
    nonce = os.urandom(12)
    aad = f'ziipa:push:v1:{row.owner_id}:{row.id}:{row.provider}'.encode()
    value = AESGCM(encryption_key()).encrypt(nonce, json.dumps(data, separators=(',', ':')).encode(), aad)
    return base64.urlsafe_b64encode(nonce + value).decode()


def decrypt_device(row):
    value = base64.urlsafe_b64decode(row.endpoint_cipher)
    aad = f'ziipa:push:v1:{row.owner_id}:{row.id}:{row.provider}'.encode()
    return json.loads(AESGCM(encryption_key()).decrypt(value[:12], value[12:], aad))


def revoke_device(session, row):
    row.status = 'revoked'; row.endpoint_cipher = ''; row.revision += 1
    session.execute(update(NotificationDelivery).where(NotificationDelivery.owner_id == row.owner_id,
        NotificationDelivery.device_id == row.id, NotificationDelivery.status.in_(ACTIVE)).values(
        status='revoked', detail='Device consent or its sign-in session was revoked.', next_run=None, lease_token='', lease_until=None, updated_at=now()))


def revoke_session_devices(session, owner_id, session_key):
    for row in session.scalars(select(PushDevice).where(PushDevice.owner_id == owner_id, PushDevice.session_key == session_key, PushDevice.status == 'active')):
        revoke_device(session, row)


def revoke_all_devices(session, owner_id):
    for row in session.scalars(select(PushDevice).where(PushDevice.owner_id == owner_id, PushDevice.status == 'active')):
        revoke_device(session, row)


def session_for_request(request):
    from account_services import session_key
    authorization = request.headers.get('authorization')
    if authorization:
        scheme, _, token = authorization.partition(' ')
        if scheme.lower() != 'bearer' or not token:
            raise HTTPException(401, 'Sign in again before managing device notifications.')
        return session_key('mobile_session:', token)
    token = request.cookies.get('ziipa_session', '')
    if not token:
        raise HTTPException(401, 'Sign in again before managing device notifications.')
    return session_key('session:', token)


def register_device(session, owner_id, data, session_key):
    ready = capabilities()
    if not ready.get(data.provider + '_ready'):
        raise HTTPException(503, 'This notification provider is disabled or not configured. No device was registered.')
    owner_lock(session, owner_id)
    pref = session.get(NotificationPreference, owner_id)
    if not pref or not pref.enabled:
        raise HTTPException(409, 'Explicitly enable notification preferences before registering this device.')
    if data.provider == 'web':
        try:
            validate_endpoint(data.subscription.endpoint, resolve=True)
        except Exception:
            raise HTTPException(422, 'The browser push endpoint is not a supported public provider.') from None
    value = {'token': data.expo_token} if data.provider == 'expo' else data.subscription.model_dump()
    identity = data.expo_token if data.provider == 'expo' else data.subscription.endpoint
    fingerprint = hashlib.sha256((data.provider + ':' + identity).encode()).hexdigest()
    duplicate = session.scalar(select(PushDevice).where(PushDevice.fingerprint == fingerprint).with_for_update())
    if duplicate and duplicate.owner_id != owner_id:
        if duplicate.status == 'active':
            raise HTTPException(409, 'This device is still associated with another signed-in account. Sign out of that account and revoke its device first.')
        session.execute(delete(NotificationDelivery).where(NotificationDelivery.device_id == duplicate.id))
        session.delete(duplicate); session.flush()
        duplicate = None
    row = session.scalar(select(PushDevice).where(PushDevice.owner_id == owner_id, PushDevice.installation_id == str(data.installation_id), PushDevice.provider == data.provider))
    if duplicate and row and duplicate.id != row.id:
        raise HTTPException(409, 'This push endpoint is already registered on another installation. Unregister it before replacing it.')
    row = row or duplicate
    if (row is None or row.status != 'active') and session.scalar(select(func.count()).select_from(PushDevice).where(PushDevice.owner_id == owner_id, PushDevice.status == 'active')) >= MAX_DEVICES:
        raise HTTPException(429, 'You can enable up to ten devices. Revoke another device first.')
    if row is None:
        row = PushDevice(id=str(uuid.uuid4()), owner_id=owner_id, installation_id=str(data.installation_id), provider=data.provider,
            label=data.label, fingerprint=fingerprint, session_key=session_key)
        session.add(row)
    else:
        revoke_device(session, row)
        row.installation_id = str(data.installation_id); row.label = data.label; row.fingerprint = fingerprint
    row.session_key = session_key; row.status = 'active'; row.last_registered_at = now()
    row.endpoint_cipher = device_cipher(row, value)
    session.flush()
    return row


def enqueue_notification(session, owner_id, category, event_id, expires_at=None):
    """Fixed producer hook; caller commits with the source event. Never raises
    a normal preference/config/capacity problem into the core creator operation.
    No historical backfill on later enrollment and no custom message content.
    """
    if not config.enabled:
        return {'queued': 0, 'reason': 'disabled'}
    try:
        identifier = str(uuid.UUID(str(event_id)))
        if category not in CATEGORIES:
            return {'queued': 0, 'reason': 'unsupported_category'}
        ready = capabilities()
        if not ready['encryption_ready']:
            return {'queued': 0, 'reason': 'configuration_required'}
        current = now()
        expiry = min(aware(expires_at) if expires_at else current + timedelta(hours=24), current + timedelta(hours=24))
        if expiry <= current:
            return {'queued': 0, 'reason': 'expired'}
        with session.begin_nested():
            if not owner_lock(session, owner_id):
                return {'queued': 0, 'reason': 'account_removed'}
            previous = session.scalar(select(NotificationEvent).where(NotificationEvent.owner_id == owner_id,
                        NotificationEvent.category == category, NotificationEvent.event_id == identifier))
            if previous:
                return {'queued': 0, 'reason': 'already_recorded'}
            event = NotificationEvent(owner_id=owner_id, category=category, event_id=identifier, expires_at=expiry)
            session.add(event); session.flush()
            pref = session.get(NotificationPreference, owner_id)
            if not pref or not pref.enabled or category not in pref.categories:
                return {'queued': 0, 'reason': 'not_opted_in'}
            if session.bind.dialect.name == 'postgresql':
                from sqlalchemy import text
                session.execute(text('SELECT pg_advisory_xact_lock(25413261051740171)'))
            total = session.scalar(select(func.count()).select_from(NotificationDelivery).where(NotificationDelivery.status.in_(ACTIVE)))
            owned = session.scalar(select(func.count()).select_from(NotificationDelivery).where(NotificationDelivery.owner_id == owner_id, NotificationDelivery.status.in_(ACTIVE)))
            devices = list(session.scalars(select(PushDevice).where(PushDevice.owner_id == owner_id, PushDevice.status == 'active').limit(MAX_DEVICES)))
            if total + len(devices) > MAX_QUEUE or owned + len(devices) > MAX_OWNER_QUEUE:
                return {'queued': 0, 'reason': 'queue_capacity'}
            count = 0
            for device in devices:
                if not ready[device.provider + '_ready']:
                    continue
                session.add(NotificationDelivery(owner_id=owner_id, event_id=event.id, device_id=device.id,
                    device_revision=device.revision, provider=device.provider, category=category, expires_at=expiry, next_run=current))
                count += 1
            return {'queued': count, 'reason': 'queued' if count else 'no_eligible_devices'}
    except Exception:
        return {'queued': 0, 'reason': 'notification_unavailable'}


def payload(row):
    return {'title': 'Ziipa', 'body': MESSAGES[row.category],
            'data': {'kind': 'ziipa_notification', 'category': row.category, 'delivery_id': row.id, 'route': 'Notifications'}}


def export_notification_data(session, owner_id):
    return {'preferences': preference_receipt(session.get(NotificationPreference, owner_id)),
        'devices': [device_receipt(row) for row in session.scalars(select(PushDevice).where(PushDevice.owner_id == owner_id))],
        'deliveries': [delivery_receipt(row) for row in session.scalars(select(NotificationDelivery).where(NotificationDelivery.owner_id == owner_id).order_by(NotificationDelivery.created_at.desc()).limit(500))]}


def delete_notification_data(session, owner_id):
    for model in (NotificationDelivery, NotificationEvent, PushDevice, NotificationPreference):
        session.execute(delete(model).where(model.owner_id == owner_id))
