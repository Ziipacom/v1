"""PayPal marketplace SANDBOX adapter. URLs are fixed; live processing is absent."""
import base64
from decimal import Decimal, InvalidOperation
from urllib.parse import quote
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
import httpx
from pydantic import BaseModel
from sqlalchemy import ForeignKey, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard

router = APIRouter(prefix='/api/store/payments/paypal', dependencies=[Depends(current_user)])
webhooks = APIRouter(prefix='/api/store/payments/webhooks')


class PayPalSellerAccount(Base):
    __tablename__ = 'store_paypal_accounts'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), primary_key=True)
    tracking_id: Mapped[str] = mapped_column(String(36), unique=True, default=lambda: str(uuid.uuid4()))


def configured():
    from marketplace_payments import config, valid_origin
    return bool(config.enabled and config.paypal_client_id and config.paypal_secret and config.paypal_partner_id
                and config.paypal_bn_code and config.paypal_webhook_id and valid_origin())


def api(method, path, body=None, key=None, seller=None):
    from marketplace_payments import config
    if not configured(): raise HTTPException(503, 'PayPal sandbox setup is pending. No payment was taken.')
    try:
        response = httpx.post('https://api-m.sandbox.paypal.com/v1/oauth2/token',
            auth=(config.paypal_client_id, config.paypal_secret), data={'grant_type': 'client_credentials'},
            timeout=15, follow_redirects=False)
        response.raise_for_status(); token = response.json()['access_token']
        headers = {'Authorization': 'Bearer ' + token, 'PayPal-Partner-Attribution-Id': config.paypal_bn_code,
                   'Content-Type': 'application/json', 'Prefer': 'return=representation'}
        if key: headers['PayPal-Request-Id'] = key
        if seller:
            def encode(value): return base64.urlsafe_b64encode(__import__('json').dumps(value).encode()).decode().rstrip('=')
            headers['PayPal-Auth-Assertion'] = encode({'alg': 'none'}) + '.' + encode({'iss': config.paypal_client_id, 'payer_id': seller}) + '.'
        response = httpx.request(method, 'https://api-m.sandbox.paypal.com' + path, headers=headers,
                                json=body, timeout=20, follow_redirects=False)
        response.raise_for_status(); value = response.json()
        if not isinstance(value, dict): raise ValueError('Invalid response')
        return value
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HTTPException(503, 'PayPal sandbox is unavailable. Keep the order and refresh before retrying.')


def snapshot(session, owner_id):
    from marketplace_payments import config
    row = session.get(PayPalSellerAccount, owner_id)
    if not row: return None
    value = api('GET', f'/v1/customer/partners/{quote(config.paypal_partner_id, safe="")}/merchant-integrations?tracking_id={row.tracking_id}')
    # Never trust browser return parameters for the merchant/seller association.
    if value.get('tracking_id') != row.tracking_id: raise HTTPException(409, 'PayPal seller verification is pending.')
    integrations = [entry for integration in value.get('oauth_integrations', []) for entry in integration.get('oauth_third_party', [])]
    authorized = any(entry.get('partner_client_id') == config.paypal_client_id
                     and 'https://uri.paypal.com/services/payments/payment/authcapture' in entry.get('scopes', []) for entry in integrations)
    return {'id': value.get('merchant_id'), 'ready': bool(value.get('merchant_id') and value.get('payments_receivable') is True
            and value.get('primary_email_confirmed') is True and authorized)}


@router.get('/seller')
def seller_status(user: User = Depends(current_user), session: Session = Depends(db)):
    if not configured(): return {'connected': False, 'ready': False, 'configured': False, 'mode': 'sandbox'}
    value = snapshot(session, user.id)
    return {'connected': bool(value), 'ready': bool(value and value['ready']), 'configured': True, 'mode': 'sandbox'}


class Consent(BaseModel):
    share_data_consent: bool = False


@router.post('/seller/connect', dependencies=[Depends(guard)])
def connect(data: Consent, user: User = Depends(current_user), session: Session = Depends(db)):
    from marketplace import lock_owner
    from marketplace_payments import config, provider_url
    if not data.share_data_consent: raise HTTPException(422, 'Approve sharing the PayPal seller connection with Ziipa first.')
    if not configured(): raise HTTPException(503, 'PayPal marketplace sandbox setup is pending.')
    lock_owner(session, user.id)
    row = session.get(PayPalSellerAccount, user.id)
    if not row:
        row = PayPalSellerAccount(owner_id=user.id); session.add(row); session.commit()
    result = api('POST', '/v2/customer/partner-referrals', {
        'tracking_id': row.tracking_id,
        'partner_config_override': {'return_url': config.public_origin.rstrip('/') + '/studio/?view=store&tab=sell'},
        'operations': [{'operation': 'API_INTEGRATION', 'api_integration_preference': {'rest_api_integration': {
            'integration_method': 'PAYPAL', 'integration_type': 'THIRD_PARTY', 'third_party_details': {'features': ['PAYMENT', 'REFUND']}}}}],
        'products': ['EXPRESS_CHECKOUT'], 'legal_consents': [{'type': 'SHARE_DATA_CONSENT', 'granted': True}]})
    link = next((entry.get('href') for entry in result.get('links', []) if entry.get('rel') == 'action_url'), None)
    return {'url': provider_url(link, {'www.sandbox.paypal.com', 'sandbox.paypal.com'}), 'mode': 'sandbox'}


def create_order(row):
    from marketplace_payments import config, provider_url
    origin = config.public_origin.rstrip('/') + '/studio/?view=store'
    result = api('POST', '/v2/checkout/orders', {'intent': 'CAPTURE', 'purchase_units': [{
        'reference_id': row.id, 'custom_id': row.id, 'invoice_id': row.id,
        'payee': {'merchant_id': row.data['seller_account']},
        'amount': {'currency_code': 'USD', 'value': f"{Decimal(row.data['price_cents']) / 100:.2f}"}}],
        'payment_source': {'paypal': {'experience_context': {'return_url': origin, 'cancel_url': origin,
            'user_action': 'CONTINUE', 'shipping_preference': 'GET_FROM_FILE'}}}},
        key=row.id, seller=row.data['seller_account'])
    order_id = result.get('id')
    if not isinstance(order_id, str) or not order_id.isalnum() or not 6 <= len(order_id) <= 40:
        raise HTTPException(503, 'PayPal did not return a test order.')
    link = next((entry.get('href') for entry in result.get('links', []) if entry.get('rel') in ('payer-action', 'approve')), None)
    return order_id, provider_url(link, {'www.sandbox.paypal.com', 'sandbox.paypal.com'})


def receipt_status(row, result):
    try:
        units = result['purchase_units']
        if result['id'] != row.data['session_id'] or len(units) != 1: raise ValueError('Identity')
        unit = units[0]
        if unit.get('custom_id') != row.id or unit.get('payee', {}).get('merchant_id') != row.data['seller_account']:
            raise ValueError('Seller')
        if unit['amount']['currency_code'] != 'USD' or Decimal(unit['amount']['value']) * 100 != row.data['price_cents']:
            raise ValueError('Amount')
        captures = unit.get('payments', {}).get('captures', [])
        if result.get('status') == 'COMPLETED':
            if len(captures) != 1: raise ValueError('Captures')
            capture = captures[0]
            if capture['amount']['currency_code'] != 'USD' or Decimal(capture['amount']['value']) * 100 != row.data['price_cents']:
                raise ValueError('Captured amount')
            if capture.get('status') == 'REFUNDED': return 'refunded'
            if capture.get('status') == 'PARTIALLY_REFUNDED': return 'partial_refund'
            if capture.get('status') != 'COMPLETED': raise ValueError('Capture status')
            return 'paid'
        if result.get('status') == 'VOIDED': return 'expired'
        if result.get('status') == 'APPROVED': return 'approved'
        return 'pending'
    except (ValueError, KeyError, TypeError, InvalidOperation):
        raise HTTPException(409, 'PayPal receipt does not match this seller, amount or order.')


def refresh(row):
    result = api('GET', '/v2/checkout/orders/' + row.data['session_id'], seller=row.data['seller_account'])
    return receipt_status(row, result)


@router.post('/orders/{order_id}/capture', dependencies=[Depends(guard)])
def capture(order_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    from marketplace import lock_owner
    from marketplace_payments import MarketOrder, order_json, refresh_order
    row = session.get(MarketOrder, str(order_id))
    if not row or row.buyer_id != user.id or row.data.get('provider') != 'paypal': raise HTTPException(404, 'Order unavailable.')
    lock_owner(session, row.seller_id)
    status = refresh(row)
    if status == 'approved':
        # Only this buyer-initiated action captures the approved SANDBOX order.
        api('POST', '/v2/checkout/orders/' + row.data['session_id'] + '/capture', {},
            key=str(uuid.uuid5(uuid.NAMESPACE_URL, row.id + '-capture')), seller=row.data['seller_account'])
    elif status not in ('paid', 'refunded'):
        raise HTTPException(409, 'Approve this order on PayPal before confirming the test purchase.')
    return order_json(refresh_order(session, row))


@webhooks.post('/paypal', dependencies=[Depends(guard)])
async def webhook(request: Request, session: Session = Depends(db)):
    from marketplace_payments import config, MarketOrder, refresh_order
    if not configured(): raise HTTPException(503, 'PayPal sandbox is not configured.')
    # Do not spend provider calls verifying obviously unsigned traffic.
    signature_fields = ('auth-algo', 'cert-url', 'transmission-id', 'transmission-sig', 'transmission-time')
    if any(not request.headers.get('paypal-' + field) or len(request.headers['paypal-' + field]) > 2048 for field in signature_fields):
        raise HTTPException(400, 'Missing PayPal webhook signature.')
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 1024 * 1024: raise HTTPException(413, 'Webhook too large.')
    try: event = __import__('json').loads(raw)
    except ValueError: raise HTTPException(400, 'Invalid webhook.')
    if not isinstance(event, dict): raise HTTPException(400, 'Invalid webhook.')
    result = api('POST', '/v1/notifications/verify-webhook-signature', {
        **{field.replace('-', '_'): request.headers.get('paypal-' + field, '') for field in
           signature_fields},
        'webhook_id': config.paypal_webhook_id, 'webhook_event': event})
    if result.get('verification_status') != 'SUCCESS': raise HTTPException(400, 'Invalid PayPal webhook signature.')
    resource = event.get('resource', {})
    provider_id = resource.get('supplementary_data', {}).get('related_ids', {}).get('order_id') or (resource.get('id') if event.get('event_type', '').startswith('CHECKOUT.ORDER.') else None)
    if isinstance(provider_id, str):
        row = session.scalar(select(MarketOrder).where(MarketOrder.data['session_id'].as_string() == provider_id,
                                                      MarketOrder.data['provider'].as_string() == 'paypal'))
        if row: refresh_order(session, row)
    return {'received': True}
