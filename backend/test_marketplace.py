"""Store privacy, persisted revisions, factual AI review and purchase authority."""
import base64
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import uuid

from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import app as core
import creator
from account_services import AccountState
from admin_services import AdminUserState
import commerce_billing as billing
import marketplace as market
from media_quota import available_bytes
from storage_services import LocalStorage

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'store.sqlite'), connect_args={'check_same_thread': False})
    core.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        users = [core.User(name=name, email=name + '@example.test', password_hash='unused') for name in ('seller', 'buyer', 'moderator')]
        session.add_all(users); session.commit()
        session.add(AdminUserState(user_id=users[2].id, role='moderator')); session.commit()
    actor = {'id': users[0].id}
    api = FastAPI(); api.include_router(market.router); api.include_router(billing.router); api.include_router(billing.webhooks)
    def db():
        with factory() as session: yield session
    def user(session=Depends(core.db)):
        if not actor['id']: raise HTTPException(401, 'Sign in')
        return session.get(core.User, actor['id'])
    api.dependency_overrides.update({core.db: db, core.current_user: user, core.guard: lambda: None})
    provider = LocalStorage(); provider.root = tmp_path / 'photos'; provider.root.mkdir()
    monkeypatch.setattr(creator, 'storage', lambda: provider)
    monkeypatch.setattr(billing.config, 'enabled', False)
    monkeypatch.setattr(billing.config, 'storage_upgrades_enabled', False)
    monkeypatch.setattr(billing.config, 'allow_sandbox', False)
    monkeypatch.setattr(billing.config, 'revenuecat_secret', '')
    monkeypatch.setattr(billing.config, 'product_plans', {'ziipa_creator_monthly': 'creator'})
    import music_api
    monkeypatch.setattr(music_api, 'provider_status', lambda: {'available': False, 'model': None})
    with TestClient(api) as client:
        yield SimpleNamespace(client=client, factory=factory, users=users, actor=actor, provider=provider, monkeypatch=monkeypatch)
    engine.dispose()


def image(ctx, owner_id=None, content=PNG, mime='image/png'):
    with ctx.factory() as session:
        row = creator.CreatorMedia(id=str(uuid.uuid4()), owner_id=owner_id or ctx.users[0].id, content_type=mime, size=len(content))
        session.add(row); session.commit()
        ctx.provider.path(row.id).write_bytes(content)
        return row.id


def storefront(ctx):
    return ctx.client.post('/api/store/storefront', json={'name': 'Originals studio', 'description': 'Independent work', 'enabled': True, 'revision': 0})


def listing(ctx, **changes):
    value = {'title': 'Original ambient EP', 'description': 'Five original tracks.', 'kind': 'digital', 'category': 'music',
             'price_cents': 1200, 'photo_ids': [], 'delivery': 'WAV download; personal listening license.', 'status': 'draft'}
    value.update(changes)
    return ctx.client.post('/api/store/listings', json=value)


def published(ctx, **changes):
    assert storefront(ctx).status_code == 200
    return listing(ctx, photo_ids=[image(ctx)], status='published', rights_confirmed=True, adult_seller=True, **changes)


def test_storefront_and_draft_survive_new_request_sessions_and_reject_stale_edits(ctx):
    first = storefront(ctx)
    assert first.status_code == 200 and first.json()['revision'] == 1
    assert storefront(ctx).status_code == 409
    draft = listing(ctx, id=str(uuid.uuid4())).json()
    loaded = ctx.client.get('/api/store/mine').json()
    assert loaded['storefront'] == first.json()
    assert loaded['listings'][0]['id'] == draft['id']
    saved = listing(ctx, id=draft['id'], revision=1, title='Revised EP')
    assert saved.status_code == 200 and saved.json()['revision'] == 2
    assert listing(ctx, id=draft['id'], revision=1, title='Stale overwrite').status_code == 409
    assert ctx.client.get('/api/store/mine').json()['listings'][0]['title'] == 'Revised EP'


def test_private_drafts_and_foreign_product_photos_never_leak(ctx):
    draft = listing(ctx, photo_ids=[image(ctx)]).json()
    photo = draft['photos'][0]
    ctx.actor['id'] = ctx.users[1].id
    assert ctx.client.get('/api/store/mine').json()['listings'] == []
    assert ctx.client.get('/api/store/listings').json()['items'] == []
    assert ctx.client.get(photo).status_code == 404
    assert listing(ctx, id=draft['id'], revision=1).status_code == 404
    assert listing(ctx, photo_ids=[draft['photo_ids'][0]]).status_code == 422


@pytest.mark.parametrize('change', [{'rights_confirmed': False}, {'adult_seller': False}, {'photo_ids': []},
                                   {'price_cents': 0}, {'description': ''}, {'delivery': ''},
                                   {'kind': 'merchandise', 'condition': 'not_applicable'}])
def test_publishing_requires_reviewed_facts_photos_price_and_rights(ctx, change):
    storefront(ctx)
    values = dict(photo_ids=[image(ctx)], status='published', rights_confirmed=True, adult_seller=True)
    values.update(change)
    assert listing(ctx, **values).status_code == 422
    assert ctx.client.get('/api/store/listings').json()['items'] == []


def test_malformed_image_cannot_be_published_even_with_image_mime(ctx):
    storefront(ctx)
    response = listing(ctx, photo_ids=[image(ctx, content=b'not a real image')], status='published', rights_confirmed=True, adult_seller=True)
    assert response.status_code == 415


def test_published_photos_and_products_follow_store_privacy_and_seller_status(ctx):
    response = published(ctx)
    assert response.status_code == 200
    row = response.json()
    ctx.actor['id'] = ctx.users[1].id
    public = ctx.client.get('/api/store/listings').json()['items'][0]
    assert 'photo_ids' not in public and 'rights_confirmed' not in public
    assert public['checkout_ready'] is False
    photo = ctx.client.get(public['photos'][0])
    assert photo.status_code == 200 and photo.content == PNG and 'no-store' in photo.headers['cache-control']
    with ctx.factory() as session:
        session.add(AccountState(owner_id=ctx.users[0].id, privacy={'profile_visibility': 'private'})); session.commit()
    assert ctx.client.get('/api/store/listings').json()['items'] == []
    assert ctx.client.get(public['photos'][0]).status_code == 404
    ctx.actor['id'] = ctx.users[0].id
    assert ctx.client.get('/api/store/mine').json()['listings'][0]['id'] == row['id']


def test_search_filter_price_sort_and_pagination_across_members(ctx):
    published(ctx)
    listing(ctx, title='Original T shirt', kind='merchandise', category='merch', condition='new', price_cents=2500,
            photo_ids=[image(ctx)], status='published', rights_confirmed=True, adult_seller=True)
    assert len(ctx.client.get('/api/store/listings?kind=digital').json()['items']) == 1
    assert ctx.client.get('/api/store/listings?q=SHIRT').json()['items'][0]['category'] == 'merch'
    assert ctx.client.get('/api/store/listings?min_price=2000').json()['items'][0]['price_cents'] == 2500
    assert ctx.client.get('/api/store/listings?sort=price_high').json()['items'][0]['price_cents'] == 2500
    assert ctx.client.get('/api/store/listings?q=%25').json()['items'] == []  # literal %, not a wildcard
    assert ctx.client.get('/api/store/listings?after=100001').status_code == 422


def test_disabled_store_sold_and_archived_products_leave_market_immediately(ctx):
    row = published(ctx).json()
    assert listing(ctx, id=row['id'], revision=1, status='sold').status_code == 200
    assert ctx.client.get('/api/store/listings').json()['items'] == []
    assert ctx.client.post('/api/store/storefront', json={'name': 'Originals studio', 'enabled': False, 'revision': 1}).status_code == 200
    assert ctx.client.get('/api/store/mine').json()['listings'][0]['status'] == 'sold'


def test_reporting_and_moderator_hiding_cannot_be_bypassed_by_seller(ctx):
    row = published(ctx).json()
    ctx.actor['id'] = ctx.users[1].id
    for _ in range(2):
        assert ctx.client.post(f"/api/store/listings/{row['id']}/report", json={'reason': 'Possible rights problem'}).status_code == 200
    assert ctx.client.get('/api/store/moderation').status_code == 403
    ctx.actor['id'] = ctx.users[2].id
    reports = ctx.client.get('/api/store/moderation').json()['reports']
    assert len(reports) == 1
    assert ctx.client.post(f"/api/store/listings/{row['id']}/moderate", json={'revision': 1, 'hidden': True, 'reason': 'Review rights'}).status_code == 200
    ctx.actor['id'] = ctx.users[0].id
    assert listing(ctx, id=row['id'], revision=2).status_code == 403
    assert ctx.client.get('/api/store/listings').json()['items'] == []


def test_ai_unavailable_leaves_manual_draft_unchanged_and_requires_consent(ctx):
    row = listing(ctx).json()
    assert ctx.client.post('/api/store/suggest', json={'prompt': 'Original ambient music', 'kind': 'digital', 'consent': False}).status_code == 422
    assert ctx.client.post('/api/store/suggest', json={'prompt': 'Original ambient music', 'kind': 'digital', 'consent': True}).status_code == 503
    assert ctx.client.get('/api/store/mine').json()['listings'][0]['id'] == row['id']
    assert market.Suggestion.model_validate({'title': 'Original EP', 'description': 'Five original tracks', 'storefront_name': 'Originals', 'descriptor': 'Ambient music'}).title == 'Original EP'
    with pytest.raises(ValueError):
        market.Suggestion.model_validate({'title': '<script>', 'description': 'x', 'storefront_name': 'AI', 'descriptor': ''})


def test_ai_suggestions_are_text_only_reviewed_and_never_save_or_publish(ctx, monkeypatch):
    from contextlib import nullcontext
    import music_api
    monkeypatch.setattr(music_api, 'provider_status', lambda: {'available': True, 'model': 'test-model'})
    monkeypatch.setattr(music_api, 'inference_budget', lambda _: nullcontext())
    monkeypatch.setattr(music_api.config, 'inference_provider', 'private')
    captured = []
    def infer(messages, schema, **_kwargs):
        captured.append(messages)
        return {'title': 'Original EP', 'description': 'Five original tracks.', 'storefront_name': 'Originals', 'descriptor': 'Ambient music'}
    monkeypatch.setattr(music_api.assistant, 'infer_json', infer)
    result = ctx.client.post('/api/store/suggest', json={'prompt': 'I made five original ambient tracks.', 'kind': 'digital', 'consent': True})
    assert result.status_code == 200 and result.json()['review_required'] is True
    assert result.json()['suggestion']['title'] == 'Original EP'
    assert 'photo_ids' not in str(captured) and ctx.users[0].email not in str(captured)
    assert ctx.client.get('/api/store/mine').json()['listings'] == []


def test_seller_store_header_respects_public_visibility_and_disable(ctx):
    published(ctx)
    seller_id = ctx.users[0].id
    ctx.actor['id'] = ctx.users[1].id
    header = ctx.client.get(f'/api/store/listings?seller_id={seller_id}').json()['storefront']
    assert header['name'] == 'Originals studio'
    with ctx.factory() as session:
        row = session.get(market.Storefront, seller_id); row.data = {**row.data, 'enabled': False}; session.commit()
    result = ctx.client.get(f'/api/store/listings?seller_id={seller_id}').json()
    assert result['storefront'] is None and result['items'] == []


def provider_value(**changes):
    expiry = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    sub = {'purchase_date': datetime.now(timezone.utc).isoformat(), 'expires_date': expiry,
           'is_sandbox': False, 'store': 'app_store', 'refunded_at': None, **changes}
    return {'subscriber': {'entitlements': {'creator': {'product_identifier': 'ziipa_creator_monthly', 'expires_date': expiry}},
                           'subscriptions': {'ziipa_creator_monthly': sub}}}


@pytest.mark.parametrize('change', [{'is_sandbox': True}, {'is_sandbox': 'false'}, {'store': 'promotional'},
                                   {'refunded_at': '2026-01-01T00:00:00Z'}, {'expires_date': None},
                                   {'expires_date': '2000-01-01T00:00:00Z'}, {'purchase_date': '2099-01-01T00:00:00Z'}])
def test_server_does_not_grant_unverified_unsupported_or_expired_purchases(ctx, change):
    assert billing.verified_snapshot(provider_value(**change))['grants'] == []


def test_native_and_web_have_same_account_entitlements_and_project_cap_still_applies(ctx, monkeypatch):
    monkeypatch.setattr(billing.config, 'enabled', True)
    monkeypatch.setattr(billing.config, 'storage_upgrades_enabled', True)
    monkeypatch.setattr(billing.config, 'revenuecat_secret', 'server-only-test-key')
    monkeypatch.setattr(billing.config, 'ios_public_key', 'appl_public')
    monkeypatch.setattr(billing.config, 'web_public_key', 'rcb_public')
    monkeypatch.setattr(billing, 'fetch_snapshot', lambda _: billing.verified_snapshot(provider_value()))
    ios = ctx.client.post('/api/services/purchase-context', json={'platform': 'ios'}).json()
    web = ctx.client.post('/api/services/purchase-context', json={'platform': 'web'}).json()
    assert ios['app_user_id'] == web['app_user_id'] and ios['public_key'] != web['public_key']
    assert 'revenuecat_secret' not in ios
    refreshed = ctx.client.post('/api/services/refresh', json={}).json()
    assert refreshed['storage']['limit_bytes'] == 10 * 1024 ** 3
    assert ctx.client.get('/api/services/catalog').json()['grants'] == refreshed['grants']
    import media_quota
    monkeypatch.setattr(media_quota.config, 'project_max_bytes', 12345)
    with ctx.factory() as session: assert available_bytes(session, ctx.users[0].id) == 12345
    ctx.actor['id'] = ctx.users[1].id
    assert ctx.client.get('/api/services/catalog').json()['grants'] == []
    assert ctx.client.post('/api/services/purchase-context', json={'platform': 'web'}).json()['app_user_id'] != ios['app_user_id']


def test_webhook_auth_and_replay_use_latest_provider_truth_not_event_claims(ctx, monkeypatch):
    monkeypatch.setattr(billing.config, 'enabled', True)
    monkeypatch.setattr(billing.config, 'revenuecat_secret', 'test-secret')
    monkeypatch.setattr(billing.config, 'webhook_authorization', 'Bearer ' + 'x' * 40)
    with ctx.factory() as session:
        row = billing.account(session, ctx.users[0].id); session.commit(); identity = row.external_id
    body = {'event': {'app_user_id': identity, 'type': 'INITIAL_PURCHASE', 'entitlement_ids': ['studio']}}
    assert ctx.client.post('/api/services/webhooks/revenuecat', json=body).status_code == 401
    monkeypatch.setattr(billing, 'fetch_snapshot', lambda _: {'grants': []})
    headers = {'Authorization': 'Bearer ' + 'x' * 40}
    for _ in range(2): assert ctx.client.post('/api/services/webhooks/revenuecat', json=body, headers=headers).status_code == 200
    assert ctx.client.get('/api/services/catalog').json()['grants'] == []


def test_store_export_and_delete_remove_public_photos_and_purchase_mapping(ctx):
    published(ctx)
    with ctx.factory() as session:
        assert len(market.export_store(session, ctx.users[0].id)['listings']) == 1
        billing.account(session, ctx.users[0].id)
        market.delete_store(session, ctx.users[0].id); billing.delete_billing(session, ctx.users[0].id); session.commit()
        assert session.scalar(select(market.StoreListing)) is None
        assert session.get(billing.BillingAccount, ctx.users[0].id) is None
    assert ctx.client.get('/api/store/listings').json()['items'] == []


def test_services_are_proposals_and_no_checkout_when_not_configured(ctx):
    result = ctx.client.get('/api/services/catalog').json()
    assert result['billing_enabled'] is False and result['catalog']['pricing_status'] == 'draft'
    assert ctx.client.post('/api/services/purchase-context', json={'platform': 'ios', 'plan': 'studio'}).status_code == 503
    assert ctx.client.post('/api/services/refresh', json={'entitlement': 'studio'}).status_code == 503
