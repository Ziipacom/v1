"""Synthetic providers only: no credentials, card data or external transactions."""
import hashlib
import hmac
import json
import time
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select
import app  # Register the shared models/routes before importing their modules.
import marketplace as market
import marketplace_payments as payments
import marketplace_paypal as paypal
from test_marketplace import ctx, image, listing, storefront


@pytest.fixture
def pay(ctx):
    ctx.client.app.include_router(payments.router)
    ctx.client.app.include_router(payments.webhooks)
    ctx.client.app.include_router(paypal.router)
    ctx.client.app.include_router(paypal.webhooks)
    ctx.monkeypatch.setattr(payments.config, 'enabled', True)
    ctx.monkeypatch.setattr(payments.config, 'stripe_secret', 'sk_test_synthetic')
    ctx.monkeypatch.setattr(payments.config, 'stripe_webhook_secret', 'whsec_synthetic')
    ctx.monkeypatch.setattr(payments.config, 'public_origin', 'https://ziipa.com')
    ctx.monkeypatch.setattr(payments.config, 'paypal_secret', '')
    state = {'paid': False, 'refunded': False, 'bad': False, 'creates': 0, 'captures': 0}
    receipts = {}
    def stripe(method, path, fields=None, key=None):
        if path.startswith('accounts/'):
            return {'id': 'acct_seller', 'metadata': {'ziipa_owner': str(ctx.users[0].id)},
                    'charges_enabled': True, 'payouts_enabled': True, 'details_submitted': True}
        if path == 'accounts': return {'id': 'acct_seller'}
        if path == 'account_links': return {'url': 'https://connect.stripe.com/test/onboarding'}
        if path == 'checkout/sessions':
            state['creates'] += 1
            sid = 'cs_test_' + fields['client_reference_id']
            receipts[sid] = {'id': sid, 'livemode': False, 'client_reference_id': fields['client_reference_id'],
                'metadata': {'ziipa_order': fields['client_reference_id']}, 'amount_total': int(fields['line_items[0][price_data][unit_amount]']),
                'currency': 'usd', 'payment_status': 'unpaid', 'status': 'open',
                'url': 'https://checkout.stripe.com/c/pay/' + sid,
                'payment_intent': {'livemode': False, 'status': 'succeeded', 'amount_received': int(fields['line_items[0][price_data][unit_amount]']),
                    'currency': 'usd', 'transfer_data': {'destination': fields['payment_intent_data[transfer_data][destination]']},
                    'latest_charge': {'refunded': False}}}
            return receipts[sid]
        sid = path.split('/')[-1].split('?')[0]
        result = json.loads(json.dumps(receipts[sid]))
        if state['paid']: result.update(payment_status='paid', status='complete')
        if state['bad']: result['amount_total'] += 1
        result['payment_intent']['latest_charge']['refunded'] = state['refunded']
        return result
    ctx.monkeypatch.setattr(payments, 'stripe', stripe)
    assert storefront(ctx).status_code == 200
    product = listing(ctx, kind='merchandise', category='merch', condition='new', delivery='Includes shipping; return within 14 days.',
        photo_ids=[image(ctx)], status='published', rights_confirmed=True, adult_seller=True).json()
    with ctx.factory() as session:
        session.add(payments.SellerPaymentAccount(owner_id=ctx.users[0].id, account_id='acct_seller'));session.commit()
    ctx.actor['id'] = ctx.users[1].id
    request = {'listing_id': product['id'], 'revision': product['revision'], 'request_id': str(uuid.uuid4()), 'platform': 'ios'}
    return SimpleNamespace(**vars(ctx), state=state, receipts=receipts, product=product, request=request)


def test_sandbox_activation_rejects_live_keys_and_redirects(pay):
    assert payments.enabled()
    pay.monkeypatch.setattr(payments.config, 'stripe_secret', 'sk_live_never')
    assert not payments.enabled()
    for url in ['https://checkout.stripe.com.evil.test/pay', 'http://checkout.stripe.com/pay', 'https://user:pass@checkout.stripe.com/pay']:
        with pytest.raises(Exception): payments.provider_url(url, {'checkout.stripe.com'})


def test_checkout_snapshot_idempotency_owner_and_receipt_truth(pay):
    result = pay.client.post('/api/store/payments/checkout', json={**pay.request, 'price_cents': 1})
    assert result.status_code == 200, result.text
    order = result.json()['order']; assert order['price_cents'] == pay.product['price_cents'] and order['status'] == 'pending'
    assert pay.client.post('/api/store/payments/checkout', json=pay.request).status_code == 200
    assert pay.state['creates'] == 1
    pay.actor['id'] = pay.users[2].id
    assert pay.client.post(f"/api/store/payments/orders/{order['id']}/refresh", json={}).status_code == 404
    assert pay.client.post('/api/store/payments/checkout', json=pay.request).status_code == 404
    pay.actor['id'] = pay.users[1].id
    pay.state.update(paid=True, bad=True)
    assert pay.client.post(f"/api/store/payments/orders/{order['id']}/refresh", json={}).status_code == 409
    pay.state['bad'] = False
    assert pay.client.post(f"/api/store/payments/orders/{order['id']}/refresh", json={}).json()['status'] == 'paid'
    with pay.factory() as session: assert session.get(market.StoreListing, pay.product['id']).status == 'sold'
    pay.state['refunded'] = True
    assert pay.client.post(f"/api/store/payments/orders/{order['id']}/refresh", json={}).json()['status'] == 'refunded'


def test_checkout_rejects_stale_digital_self_and_parallel_buyers(pay):
    assert pay.client.post('/api/store/payments/checkout', json={**pay.request, 'revision': 999}).status_code == 409
    pay.actor['id'] = pay.users[0].id
    assert pay.client.post('/api/store/payments/checkout', json=pay.request).status_code == 409
    pay.actor['id'] = pay.users[1].id
    with pay.factory() as session:
        row = session.get(market.StoreListing, pay.product['id']); row.kind = 'digital'; session.commit()
    assert pay.client.post('/api/store/payments/checkout', json=pay.request).status_code == 409
    with pay.factory() as session:
        row = session.get(market.StoreListing, pay.product['id']); row.kind = 'merchandise'; session.commit()
    assert pay.client.post('/api/store/payments/checkout', json=pay.request).status_code == 200
    pay.actor['id'] = pay.users[2].id
    assert pay.client.post('/api/store/payments/checkout', json={**pay.request, 'request_id':str(uuid.uuid4())}).status_code == 409


def test_stripe_webhook_never_trusts_event_payment_claims(pay):
    first = pay.client.post('/api/store/payments/checkout', json=pay.request).json()['order']
    body = json.dumps({'livemode': False, 'type': 'checkout.session.completed', 'data': {'object': {'id': 'cs_test_' + first['id'], 'payment_status':'paid'}}}).encode()
    assert pay.client.post('/api/store/payments/webhooks/stripe', content=body).status_code == 400
    stamp = str(int(time.time())); signature = hmac.new(b'whsec_synthetic', stamp.encode()+b'.'+body, hashlib.sha256).hexdigest()
    headers = {'Stripe-Signature':f't={stamp},v1={signature}'}
    assert pay.client.post('/api/store/payments/webhooks/stripe', content=body, headers=headers).status_code == 200
    assert pay.client.get('/api/store/payments/orders').json()['orders'][0]['status'] == 'pending'
    pay.state['paid'] = True
    for _ in range(2): assert pay.client.post('/api/store/payments/webhooks/stripe', content=body, headers=headers).status_code == 200
    assert pay.client.get('/api/store/payments/orders').json()['orders'][0]['status'] == 'paid'


def test_paypal_capture_is_buyer_initiated_and_merchant_amount_verified(pay):
    for key in ('paypal_client_id','paypal_secret','paypal_partner_id','paypal_bn_code','paypal_webhook_id'):
        pay.monkeypatch.setattr(payments.config,key,'synthetic')
    pay.monkeypatch.setattr(paypal, 'snapshot', lambda session,owner: {'id':'MERCHANT123','ready':True})
    pay.monkeypatch.setattr(paypal, 'create_order', lambda row: ('PAYPAL123456','https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL123456'))
    request = {**pay.request, 'provider':'paypal'}
    result = pay.client.post('/api/store/payments/checkout', json=request)
    assert result.status_code == 200, result.text
    order = result.json()['order']
    def provider(method,path,body=None,key=None,seller=None):
        if path.endswith('/capture'): pay.state['captures'] += 1
        return {'id':'PAYPAL123456','status':'COMPLETED' if pay.state['captures'] else 'APPROVED', 'purchase_units':[{
            'custom_id':order['id'],'payee':{'merchant_id':'WRONG' if pay.state['bad'] else 'MERCHANT123'},
            'amount':{'currency_code':'USD','value':'12.00'},'payments':{'captures':[{'status':'COMPLETED','amount':{'currency_code':'USD','value':'12.00'}}]}}]}
    pay.monkeypatch.setattr(paypal,'api',provider)
    assert pay.client.post(f"/api/store/payments/orders/{order['id']}/refresh",json={}).json()['status'] == 'approved'
    assert pay.state['captures'] == 0
    pay.actor['id'] = pay.users[0].id
    assert pay.client.post(f"/api/store/payments/paypal/orders/{order['id']}/capture",json={}).status_code == 404
    pay.actor['id'] = pay.users[1].id;pay.state['bad'] = True
    assert pay.client.post(f"/api/store/payments/paypal/orders/{order['id']}/capture",json={}).status_code == 409
    assert pay.state['captures'] == 0
    pay.state['bad'] = False
    assert pay.client.post(f"/api/store/payments/paypal/orders/{order['id']}/capture",json={}).json()['status'] == 'paid'
    assert pay.state['captures'] == 1


def test_unsigned_paypal_webhook_is_rejected_before_any_provider_call(pay):
    for key in ('paypal_client_id','paypal_secret','paypal_partner_id','paypal_bn_code','paypal_webhook_id'):
        pay.monkeypatch.setattr(payments.config,key,'synthetic')
    def never(*args,**kwargs): raise AssertionError('Unsigned request must not call PayPal')
    pay.monkeypatch.setattr(paypal,'api',never)
    assert pay.client.post('/api/store/payments/webhooks/paypal',json={'event_type':'CHECKOUT.ORDER.COMPLETED'}).status_code == 400


def test_store_media_previews_are_owned_bounded_and_private_until_published(ctx):
    photo = image(ctx); audio = image(ctx, content=b'RIFF' + b'0'*44, mime='audio/wav')
    draft = listing(ctx, photo_ids=[photo], media_ids=[audio]).json()
    path = draft['media'][0]['path']
    assert ctx.client.get(path).status_code == 200
    ctx.actor['id'] = ctx.users[1].id
    assert ctx.client.get(path).status_code == 404
    assert listing(ctx, media_ids=[audio]).status_code == 422
    ctx.actor['id'] = ctx.users[0].id
    assert storefront(ctx).status_code == 200
    published = listing(ctx, id=draft['id'], revision=draft['revision'], photo_ids=[photo], media_ids=[audio],
                        status='published', rights_confirmed=True, adult_seller=True)
    assert published.status_code == 200
    ctx.actor['id'] = ctx.users[1].id
    assert ctx.client.get(path).status_code == 200
    with ctx.factory() as session:
        row=session.get(market.StoreListing,draft['id']);row.status='hidden';session.commit()
    assert ctx.client.get(path).status_code == 404
    ctx.actor['id'] = ctx.users[0].id
    assert listing(ctx, photo_ids=[image(ctx) for _ in range(10)],media_ids=[audio]).status_code == 422
