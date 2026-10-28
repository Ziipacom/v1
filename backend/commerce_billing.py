"""Server-authoritative subscription snapshots shared by web, Android and iOS.

Disabled until products, prices, provider agreements and budget caps are reviewed.
Client receipts and webhook entitlement claims are NEVER accepted as grants.
"""
from datetime import datetime, timedelta, timezone
import hmac
import json
from pathlib import Path
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
import httpx
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, JSON, String, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard

CATALOG = json.loads((Path(__file__).parent / 'commerce-catalog.json').read_text(encoding='utf8'))
PLANS = {plan['id']: plan for plan in CATALOG['plans']}
router = APIRouter(prefix='/api/services', dependencies=[Depends(current_user)])
webhooks = APIRouter(prefix='/api/services/webhooks')


class BillingSettings(BaseSettings):
    enabled: bool = False
    storage_upgrades_enabled: bool = False
    allow_sandbox: bool = False
    revenuecat_secret: str = Field(default='', repr=False)
    webhook_authorization: str = Field(default='', repr=False)
    ios_public_key: str = ''
    android_public_key: str = ''
    web_public_key: str = ''
    # Explicit allowlist: product identifier -> one reviewed package ID.
    product_plans: dict[str, str] = Field(default_factory=dict)
    model_config = SettingsConfigDict(env_prefix='BILLING_', env_file='.env', extra='ignore')


config = BillingSettings()


class BillingAccount(Base):
    __tablename__ = 'billing_accounts'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), primary_key=True)
    external_id: Mapped[str] = mapped_column(String(48), unique=True, default=lambda: 'ziipa_' + uuid.uuid4().hex)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


def utc(value):
    if not isinstance(value, str): return None
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (ValueError, OverflowError):
        return None


def clock():
    return datetime.now(timezone.utc)


def enabled():
    return bool(config.enabled and config.revenuecat_secret and config.product_plans)


def account(session, owner_id):
    from marketplace import lock_owner
    lock_owner(session, owner_id)
    row = session.get(BillingAccount, owner_id)
    if not row:
        row = BillingAccount(owner_id=owner_id); session.add(row); session.flush()
    return row


def verified_snapshot(value, now=None):
    """Subscription-only allowlist; reject sandbox, refunds, promotions and lifetime grants."""
    current = now or clock()
    if not isinstance(value, dict) or not isinstance(value.get('subscriber'), dict):
        raise ValueError('Invalid provider snapshot')
    subscriber = value['subscriber']
    entitlements = subscriber.get('entitlements', {})
    subscriptions = subscriber.get('subscriptions', {})
    if not isinstance(entitlements, dict) or not isinstance(subscriptions, dict):
        raise ValueError('Invalid provider snapshot')
    grants = []
    for entitlement in entitlements.values():
        if not isinstance(entitlement, dict): continue
        product = entitlement.get('product_identifier')
        plan = config.product_plans.get(product) if isinstance(product, str) else None
        subscription = subscriptions.get(product, {})
        if plan not in PLANS or plan == 'free' or not isinstance(subscription, dict): continue
        expires = utc(entitlement.get('expires_date'))
        source_expires = utc(subscription.get('expires_date'))
        purchased = utc(subscription.get('purchase_date'))
        if (not expires or not source_expires or not purchased or purchased > current + timedelta(minutes=5)
                or min(expires, source_expires) <= current or subscription.get('refunded_at')
                or type(subscription.get('is_sandbox')) is not bool
                or (subscription['is_sandbox'] and not config.allow_sandbox)
                or subscription.get('store') not in ('app_store', 'play_store', 'stripe', 'rc_billing', 'paddle')):
            continue
        grants.append({'plan': plan, 'product': product, 'expires_at': min(expires, source_expires).isoformat(),
                       'store': subscription['store'], 'sandbox': subscription['is_sandbox']})
    return {'grants': grants}


def fetch_snapshot(external_id):
    # Fixed origin, random own-account ID, no user URL or redirects.
    try:
        with httpx.Client(timeout=10, follow_redirects=False, trust_env=False) as client:
            with client.stream('GET', 'https://api.revenuecat.com/v1/subscribers/' + external_id,
                               headers={'Authorization': 'Bearer ' + config.revenuecat_secret}) as response:
                response.raise_for_status()
                pieces, size = [], 0
                for part in response.iter_bytes():
                    size += len(part)
                    if size > 256000: raise ValueError('Oversized snapshot')
                    pieces.append(part)
        return verified_snapshot(json.loads(b''.join(pieces)))
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(503, 'Purchases cannot be verified right now. No new access was granted; please retry.') from None


def active_grants(row):
    if not enabled() or not row or not row.verified_at: return []
    stamp = row.verified_at.replace(tzinfo=timezone.utc) if row.verified_at.tzinfo is None else row.verified_at
    # A short freshness window also bounds refund/transfer propagation if webhooks fail.
    if stamp < clock() - timedelta(minutes=15): return []
    return [grant for grant in row.snapshot.get('grants', [])
            if grant.get('plan') in PLANS and utc(grant.get('expires_at')) and utc(grant['expires_at']) > clock()
            and (config.allow_sandbox or not grant.get('sandbox'))]


def storage_limit(session, owner_id, free_limit):
    if not config.storage_upgrades_enabled: return free_limit
    grants = active_grants(session.get(BillingAccount, owner_id))
    return max([free_limit, *(PLANS[grant['plan']]['storage_gib'] * 1024 ** 3 for grant in grants)])


def status(session, user):
    from media_quota import usage, config as quota
    row = session.get(BillingAccount, user.id)
    grants = active_grants(row)
    return {'catalog': CATALOG, 'billing_enabled': enabled(), 'grants': grants,
            'storage': {'used_bytes': usage(session, user.id), 'limit_bytes': storage_limit(session, user.id, quota.owner_max_bytes)},
            'purchase_requirements': 'Prices are drafts. Purchases require configured store products, commercial terms and budget approval.',
            'provider': 'revenuecat', 'available_platforms': [platform for platform, key in
                [('ios', config.ios_public_key), ('android', config.android_public_key), ('web', config.web_public_key)]
                if enabled() and key]}


@router.get('/catalog')
def catalog(response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers['Cache-Control'] = 'private, no-store'
    row = session.get(BillingAccount, user.id)
    if enabled() and row:
        stamp = row.verified_at
        stamp = stamp.replace(tzinfo=timezone.utc) if stamp and stamp.tzinfo is None else stamp
        if not stamp or stamp < clock() - timedelta(minutes=5):
            row = account(session, user.id)
            row.snapshot = fetch_snapshot(row.external_id); row.verified_at = clock(); session.commit()
    return status(session, user)


@router.post('/purchase-context', dependencies=[Depends(guard)])
def purchase_context(data: dict, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers['Cache-Control'] = 'private, no-store'
    platform = data.get('platform')
    key = {'ios': config.ios_public_key, 'android': config.android_public_key, 'web': config.web_public_key}.get(platform)
    if not enabled() or not key:
        raise HTTPException(503, 'Purchases are not activated. These packages and prices are proposals only.')
    row = account(session, user.id); session.commit()
    return {'app_user_id': row.external_id, 'public_key': key,
            'product_plans': config.product_plans, 'storage_upgrades_enabled': config.storage_upgrades_enabled}


@router.post('/refresh', dependencies=[Depends(guard)])
def refresh(user: User = Depends(current_user), session: Session = Depends(db)):
    if not enabled(): raise HTTPException(503, 'Purchase verification is not configured.')
    row = account(session, user.id)
    row.snapshot = fetch_snapshot(row.external_id); row.verified_at = clock()
    session.commit()
    return status(session, user)


@webhooks.post('/revenuecat')
async def webhook(request: Request, session: Session = Depends(db)):
    secret = config.webhook_authorization
    if not enabled() or len(secret) < 32:
        raise HTTPException(503, 'Billing is not activated.')
    if not hmac.compare_digest(request.headers.get('authorization', '').encode('utf8'), secret.encode('utf8')):
        raise HTTPException(401, 'Not authorized.')
    body = b''
    async for part in request.stream():
        body += part
        if len(body) > 65536: raise HTTPException(413, 'Event too large.')
    try:
        event = json.loads(body)['event']
        ids = {event.get('app_user_id')}
        if event.get('type') == 'TRANSFER':
            ids.update(event.get('transferred_from', [])); ids.update(event.get('transferred_to', []))
        ids = {value for value in ids if isinstance(value, str) and len(value) <= 48}
        if len(ids) > 20: raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise HTTPException(400, 'Invalid event.') from None
    # Ignore all embedded grant/payment claims. Re-fetch current provider truth;
    # duplicated and out-of-order events cannot replay old access.
    owners = list(session.scalars(select(BillingAccount.owner_id).where(BillingAccount.external_id.in_(ids)).order_by(BillingAccount.owner_id)))
    for owner_id in owners:
        row = account(session, owner_id)
        row.snapshot = fetch_snapshot(row.external_id); row.verified_at = clock()
    session.commit()
    return {'ok': True}


def export_billing(session, owner_id):
    row = session.get(BillingAccount, owner_id)
    return {'grants': active_grants(row), 'verified_at': row.verified_at.isoformat() if row and row.verified_at else None}


def delete_billing(session, owner_id):
    # Provider financial records have independent retention. Removing this random
    # mapping immediately prevents future webhooks attaching to a deleted user.
    session.execute(delete(BillingAccount).where(BillingAccount.owner_id == owner_id))
