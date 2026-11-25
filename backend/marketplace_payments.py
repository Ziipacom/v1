"""Sandbox-only hosted marketplace checkout. No card or bank credentials enter Ziipa.

Seller onboarding and purchases are explicit user actions. There is no live-mode
switch: this beta adapter rejects live keys, accounts, sessions and receipts.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import time
from urllib.parse import urlparse
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
import httpx
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, JSON, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard

router = APIRouter(prefix='/api/store/payments', dependencies=[Depends(current_user)])
webhooks = APIRouter(prefix='/api/store/payments/webhooks')
HEADERS = {'Cache-Control': 'private, no-store'}


class Settings(BaseSettings):
    enabled: bool = False
    stripe_secret: str = Field(default='', repr=False)
    stripe_webhook_secret: str = Field(default='', repr=False)
    paypal_client_id: str = ''
    paypal_secret: str = Field(default='', repr=False)
    paypal_partner_id: str = ''
    paypal_bn_code: str = ''
    paypal_webhook_id: str = ''
    public_origin: str = 'https://ziipa.com'
    model_config = SettingsConfigDict(env_prefix='MARKETPLACE_', env_file='.env', extra='ignore')


config = Settings()


class SellerPaymentAccount(Base):
    __tablename__ = 'store_payment_accounts'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), primary_key=True)
    account_id: Mapped[str] = mapped_column(String(80), unique=True)


class MarketOrder(Base):
    __tablename__ = 'store_orders'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    buyer_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    seller_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    listing_id: Mapped[str] = mapped_column(String(36), index=True)
    status: Mapped[str] = mapped_column(String(16), default='pending')
    data: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def valid_origin():
    origin = urlparse(config.public_origin)
    return bool(origin.scheme == 'https' and origin.netloc
                and not origin.username and not origin.password and origin.path in ('', '/')
                and not origin.query and not origin.fragment)


def enabled():
    return bool(config.enabled and config.stripe_secret.startswith(('sk_test_', 'rk_test_'))
                and config.stripe_webhook_secret and valid_origin())


def require_enabled():
    if not enabled():
        raise HTTPException(503, 'Sandbox payments are not configured yet. No payment was taken.')


def stripe(method, path, fields=None, key=None):
    require_enabled()
    try:
        response = httpx.request(method, 'https://api.stripe.com/v1/' + path,
            auth=(config.stripe_secret, ''), data=fields,
            headers={'Stripe-Version': '2025-06-30.basil', **({'Idempotency-Key': key} if key else {})},
            timeout=20, follow_redirects=False)
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict): raise ValueError('Invalid response')
        return result
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, 'Payment provider unavailable. Keep this order and refresh its status before retrying.')


def provider_url(value, hosts):
    if not isinstance(value, str): raise HTTPException(503, 'Provider link unavailable.')
    parsed = urlparse(value)
    if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise HTTPException(503, 'Provider returned an invalid checkout link.')
    return value


def seller_ready(account):
    return bool(account and account.get('livemode') is not True and account.get('charges_enabled') is True
                and account.get('payouts_enabled') is True and account.get('details_submitted') is True)


def seller_snapshot(session, owner_id):
    row = session.get(SellerPaymentAccount, owner_id)
    if not row: return None
    account = stripe('GET', 'accounts/' + row.account_id)
    if account.get('id') != row.account_id or account.get('metadata', {}).get('ziipa_owner') != str(owner_id):
        raise HTTPException(503, 'Seller account verification failed.')
    return account


@router.get('/config')
def payment_config(response: Response):
    import marketplace_paypal as paypal
    response.headers.update(HEADERS)
    return {'mode': 'sandbox', 'enabled': enabled() or paypal.configured(), 'provider': 'stripe',
            'methods': ['card'], 'physical_goods_only': True, 'live_payments': False,
            'providers': {'stripe': enabled(), 'paypal': paypal.configured()},
            'paypal_available': paypal.configured(), 'bank_linking_available': False}


@router.get('/seller')
def seller(response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers.update(HEADERS)
    if not enabled(): return {'connected': False, 'ready': False, 'mode': 'sandbox', 'configured': False}
    account = seller_snapshot(session, user.id)
    return {'connected': bool(account), 'ready': seller_ready(account), 'mode': 'sandbox', 'configured': True}


@router.post('/seller/connect', dependencies=[Depends(guard)])
def connect_seller(user: User = Depends(current_user), session: Session = Depends(db)):
    from marketplace import lock_owner
    require_enabled(); lock_owner(session, user.id)
    row = session.get(SellerPaymentAccount, user.id)
    if not row:
        account = stripe('POST', 'accounts', {'type': 'express',
            'capabilities[card_payments][requested]': 'true', 'capabilities[transfers][requested]': 'true',
            'metadata[ziipa_owner]': str(user.id)}, key=f'ziipa-sandbox-seller-{user.id}')
        if account.get('livemode') is True or not str(account.get('id', '')).startswith('acct_'):
            raise HTTPException(503, 'Only sandbox seller accounts are accepted.')
        row = SellerPaymentAccount(owner_id=user.id, account_id=account['id']); session.add(row); session.commit()
    origin = config.public_origin.rstrip('/') + '/studio/?view=store&tab=sell'
    link = stripe('POST', 'account_links', {'account': row.account_id, 'type': 'account_onboarding',
        'refresh_url': origin, 'return_url': origin})
    return {'url': provider_url(link.get('url'), {'connect.stripe.com'}), 'mode': 'sandbox'}


def order_json(row):
    return {'id': row.id, 'listing_id': row.listing_id, 'title': row.data['title'],
            'price_cents': row.data['price_cents'], 'currency': 'USD', 'status': row.status,
            'provider': row.data.get('provider', 'stripe'), 'revision': row.data['revision'],
            'mode': 'sandbox', 'created_at': row.created_at.isoformat()}


def validate_receipt(row, receipt):
    data = row.data
    if (receipt.get('id') != data.get('session_id') or receipt.get('livemode') is not False
        or receipt.get('client_reference_id') != row.id or receipt.get('metadata', {}).get('ziipa_order') != row.id
        or receipt.get('amount_total') != data['price_cents'] or receipt.get('currency') != 'usd'):
        raise HTTPException(409, 'The provider receipt does not match this test order.')
    if receipt.get('payment_status') == 'paid':
        payment = receipt.get('payment_intent')
        if not isinstance(payment, dict) or payment.get('livemode') is not False or payment.get('status') != 'succeeded' or payment.get('amount_received') != data['price_cents'] or payment.get('currency') != 'usd' or payment.get('transfer_data', {}).get('destination') != data['seller_account']:
            raise HTTPException(409, 'Seller settlement could not be verified for this test order.')
        charge = payment.get('latest_charge')
        if isinstance(charge, dict):
            if charge.get('refunded') is True: return 'refunded'
            if charge.get('disputed') is True: return 'disputed'
            if isinstance(charge.get('amount_refunded'), int) and charge['amount_refunded'] > 0: return 'partial_refund'
        return 'paid'
    if receipt.get('status') == 'expired': return 'expired'
    return 'pending'


def refresh_order(session, row, *, commit=True):
    if not row.data.get('session_id'): return row
    if row.data.get('provider') == 'paypal':
        import marketplace_paypal as paypal
        status = paypal.refresh(row)
    else:
        receipt = stripe('GET', 'checkout/sessions/' + row.data['session_id'] + '?expand[]=payment_intent.latest_charge')
        status = validate_receipt(row, receipt)
    # Once paid, never downgrade a receipt from a delayed/out-of-order event.
    terminal = ('paid', 'refunded', 'disputed', 'partial_refund')
    if row.status not in terminal or status in ('refunded', 'disputed', 'partial_refund'): row.status = status
    if row.status in terminal:
        from marketplace import StoreListing
        listing = session.get(StoreListing, row.listing_id)
        if listing and listing.status != 'hidden': listing.status = 'sold'
    if commit: session.commit()
    return row


class CheckoutInput(BaseModel):
    provider: Literal['stripe', 'paypal'] = 'stripe'
    listing_id: uuid.UUID
    revision: int = Field(ge=1)
    request_id: uuid.UUID
    platform: str = Field(pattern='^(web|ios|android)$')


@router.post('/checkout', dependencies=[Depends(guard)])
def checkout(data: CheckoutInput, user: User = Depends(current_user), session: Session = Depends(db)):
    from marketplace import StoreListing, lock_owner, visible
    import marketplace_paypal as paypal
    if data.provider == 'paypal':
        if not paypal.configured(): raise HTTPException(503, 'PayPal sandbox setup is pending.')
    else: require_enabled()
    listing = session.get(StoreListing, str(data.listing_id))
    if not listing: raise HTTPException(404, 'Listing unavailable.')
    if listing.owner_id == user.id: raise HTTPException(409, 'You cannot buy your own listing.')
    lock_owner(session, listing.owner_id)
    row = session.get(MarketOrder, str(data.request_id))
    if row:
        if row.buyer_id != user.id or row.listing_id != listing.id or row.data.get('provider', 'stripe') != data.provider:
            raise HTTPException(404, 'Order unavailable.')
        if row.status != 'pending': return {'order': order_json(row), 'url': None}
    else:
        if not visible(session, listing): raise HTTPException(404, 'Listing unavailable.')
        if listing.revision != data.revision: raise HTTPException(409, 'The listing changed. Review its current price before checkout.')
        if listing.kind != 'merchandise':
            raise HTTPException(409, 'This beta checkout supports physical merchandise only. Digital purchases require a separate platform-billing and delivery setup.')
        for previous in session.scalars(select(MarketOrder).where(MarketOrder.listing_id == listing.id, MarketOrder.status.in_(['pending', 'approved', 'paid']))):
            if previous.status == 'paid': raise HTTPException(409, 'This product has already sold.')
            previous = refresh_order(session, previous, commit=False)
            if previous.status != 'expired': raise HTTPException(409, 'This product has an active checkout. Try again after it expires.')
        account = paypal.snapshot(session, listing.owner_id) if data.provider == 'paypal' else seller_snapshot(session, listing.owner_id)
        ready = bool(account and account['ready']) if data.provider == 'paypal' else seller_ready(account)
        if not ready: raise HTTPException(409, 'The seller must finish sandbox payment setup before checkout.')
        row = MarketOrder(id=str(data.request_id), buyer_id=user.id, seller_id=listing.owner_id, listing_id=listing.id,
            data={'title': listing.title, 'price_cents': listing.price_cents, 'seller_account': account['id'],
                  'provider': data.provider, 'revision': listing.revision, 'delivery': listing.data.get('delivery', '')})
        session.add(row); session.commit()
    if row.data.get('session_id'):
        refresh_order(session, row)
        return {'order': order_json(row), 'url': row.data.get('checkout_url') if row.status == 'pending' else None}
    if data.provider == 'paypal':
        provider_id, url = paypal.create_order(row)
        row.data = {**row.data, 'session_id': provider_id, 'checkout_url': url}; session.commit()
        return {'url': url, 'order': order_json(row)}
    origin = config.public_origin.rstrip('/') + '/studio/?view=store'
    receipt = stripe('POST', 'checkout/sessions', {'mode': 'payment',
        'success_url': origin, 'cancel_url': origin, 'client_reference_id': row.id,
        'metadata[ziipa_order]': row.id, 'payment_method_types[0]': 'card',
        'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': str(row.data['price_cents']),
        'line_items[0][price_data][product_data][name]': row.data['title'], 'line_items[0][quantity]': '1',
        'payment_intent_data[transfer_data][destination]': row.data['seller_account'],
        'payment_intent_data[metadata][ziipa_order]': row.id,
        'shipping_address_collection[allowed_countries][0]': 'US',
        'shipping_address_collection[allowed_countries][1]': 'GB',
        'expires_at': str(int((row.created_at.replace(tzinfo=timezone.utc) + timedelta(minutes=30)).timestamp()))},
        key='ziipa-sandbox-checkout-' + row.id)
    if receipt.get('livemode') is not False or not str(receipt.get('id', '')).startswith('cs_test_'):
        raise HTTPException(503, 'Only sandbox checkout sessions are accepted.')
    url = provider_url(receipt.get('url'), {'checkout.stripe.com'})
    row.data = {**row.data, 'session_id': receipt['id'], 'checkout_url': url}; session.commit()
    return {'url': url, 'order': order_json(row)}


@router.get('/orders')
def orders(response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers.update(HEADERS)
    return {'orders': [order_json(row) for row in session.scalars(select(MarketOrder).where(
        (MarketOrder.buyer_id == user.id) | (MarketOrder.seller_id == user.id)).order_by(MarketOrder.created_at.desc()).limit(100))]}


@router.post('/orders/{order_id}/refresh', dependencies=[Depends(guard)])
def verify_order(order_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    from marketplace import lock_owner
    row = session.get(MarketOrder, str(order_id))
    if not row or user.id not in (row.buyer_id, row.seller_id): raise HTTPException(404, 'Order unavailable.')
    lock_owner(session, row.seller_id)
    return order_json(refresh_order(session, row))


@webhooks.post('/stripe')
async def stripe_webhook(request: Request, session: Session = Depends(db)):
    require_enabled()
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 1024 * 1024: raise HTTPException(413, 'Webhook too large.')
    try:
        parts = [part.split('=', 1) for part in request.headers.get('stripe-signature', '').split(',')]
        stamp = next(value for key, value in parts if key == 't')
        if abs(time.time() - int(stamp)) > 300: raise ValueError('Expired')
        expected = hmac.new(config.stripe_webhook_secret.encode(), stamp.encode() + b'.' + raw, hashlib.sha256).hexdigest()
        if not any(key == 'v1' and hmac.compare_digest(value, expected) for key, value in parts): raise ValueError('Signature')
        event = json.loads(raw)
        if not isinstance(event, dict): raise ValueError('Invalid event')
        if event.get('livemode') is not False: raise ValueError('Not sandbox')
    except (ValueError, TypeError, StopIteration):
        raise HTTPException(400, 'Invalid sandbox webhook signature.')
    obj = event.get('data', {}).get('object', {})
    if not isinstance(obj, dict): raise HTTPException(400, 'Invalid webhook object.')
    session_id = obj.get('id')
    if event.get('type') in ('checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded') and isinstance(session_id, str):
        # The event selects a local order, never supplies proof of payment.
        row = session.scalar(select(MarketOrder).where(MarketOrder.data['session_id'].as_string() == session_id,
                                                      MarketOrder.data['provider'].as_string() == 'stripe'))
        if row: refresh_order(session, row)
    return {'received': True}
