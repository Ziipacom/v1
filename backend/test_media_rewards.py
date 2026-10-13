"""Rewards acceptance tests exercise PostgreSQL locks and rollback-only data."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import threading
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, delete, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, engine, guard
from account_services import AccountState
from creator import CreatorComment, CreatorItem, CreatorMedia, CreatorPreferences
from web3_api import TransactionIntent, WalletLink
import media_rewards as rewards


@pytest.fixture
def workspace(monkeypatch):
    for key, value in {'rewards_enabled': True, 'rewards_daily_points': 100,
        'rewards_global_daily_points': 50_000, 'rewards_platform_budget': 1_000_000,
        'rewards_like_points': 1, 'rewards_save_points': 2, 'rewards_comment_points': 3}.items():
        monkeypatch.setattr(rewards.config, key, value)
    # A rollback around newly generated users does not isolate the global
    # RewardState singleton or historical ledger rows already in a review DB.
    # Build all fixture tables in a transaction-local PostgreSQL schema. Both
    # schema DDL and every nested API commit disappear in the outer rollback;
    # no production/review ledger row is deleted, reset or committed.
    fixture_engine = engine if engine.dialect.name == 'postgresql' else create_engine(
        'sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    with fixture_engine.connect() as connection:
        transaction = connection.begin()
        if connection.dialect.name == 'postgresql':
            schema = 'reward_case_' + uuid.uuid4().hex
            connection.execute(text(f'CREATE SCHEMA {schema}'))
            connection = connection.execution_options(schema_translate_map={None: schema})
        Base.metadata.create_all(connection)
        session = Session(bind=connection, join_transaction_mode='create_savepoint')
        author = User(name='Rewards creator', email=f'{uuid.uuid4()}@example.test', password_hash='unused')
        viewer = User(name='Rewards viewer', email=f'{uuid.uuid4()}@example.test', password_hash='unused')
        stranger = User(name='Other viewer', email=f'{uuid.uuid4()}@example.test', password_hash='unused')
        session.add_all([author, viewer, stranger]); session.flush()
        media = CreatorMedia(id=str(uuid.uuid4()), owner_id=author.id, content_type='video/mp4', size=100)
        item = CreatorItem(owner_id=author.id, visibility='published', data={'title': 'Actual upload', 'media_id': media.id})
        session.add_all([media, item]); session.commit()
        acting = {'user': viewer, 'guards': 0}
        application = FastAPI()
        application.include_router(rewards.router)
        def test_db():
            yield session
        def test_user():
            if acting['user'] is None:
                raise HTTPException(401, 'Please sign in')
            return acting['user']
        def test_guard(request: Request):
            acting['guards'] += 1
            if request.headers.get('origin') == 'https://untrusted.test':
                raise HTTPException(403, 'Untrusted origin')
        application.dependency_overrides.update({db: test_db, current_user: test_user, guard: test_guard})
        with TestClient(application) as client:
            yield client, session, author, viewer, stranger, acting, item
        session.close(); transaction.rollback()
    if fixture_engine is not engine:
        fixture_engine.dispose()


def preference(session, user, **changes):
    rewards.lock_user(session, user)
    row = session.get(CreatorPreferences, user.id)
    previous = deepcopy(row.data) if row else {}
    current = {**previous, **changes}
    if row is None:
        row = CreatorPreferences(owner_id=user.id, data=current)
        session.add(row)
    rewards.sync_preferences_rewards(session, user, previous, current)
    row.data = current
    session.commit()


def comment(session, user, item, body='Thoughtful feedback about this clip'):
    row = CreatorComment(owner_id=user.id, item_id=item.id, body=body)
    session.add(row)
    rewards.award_comment_reward(session, user, item, row)
    session.commit()


def program(client, acting, author, **details):
    acting['user'] = author
    payload = {'request_id': str(uuid.uuid4()), 'name': 'Creator media rewards', **details}
    result = client.post('/api/rewards/programs', json=payload)
    assert result.status_code == 201, result.text
    return result.json(), payload


def edit_program(client, row, **changes):
    payload = {'name': row['name'], 'enabled': row['enabled'], 'point_budget': row['point_budget'],
        'per_user_daily_cap': row['per_user_daily_cap'], 'like_points': row['rates']['like'],
        'save_points': row['rates']['save'], 'comment_points': row['rates']['comment'],
        'revision': row['revision'], **changes}
    return client.patch(f"/api/rewards/programs/{row['id']}", json=payload)


def token_receipt(session, author, *, status='confirmed', kind='create_token', wallet=True):
    address = '0x1111111111111111111111111111111111111111'
    if wallet:
        session.add(WalletLink(owner_id=author.id, chain_id=31337, address=address))
    receipt = TransactionIntent(id=str(uuid.uuid4()), owner_id=author.id, chain_id=31337,
        address=address, kind=kind, request_hash='a'*64, transaction={},
        summary={'symbol': 'MEDIA', 'name': 'Media reward token'},
        result={'token_address': '0x2222222222222222222222222222222222222222', 'confirmations': 1},
        tx_hash='0x'+'a'*64, status=status)
    session.add(receipt); session.commit()
    return receipt


def test_actual_interactions_reward_once_and_never_store_comment_content(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    preference(session, viewer, liked=[item.id], saved=[item.id])
    comment(session, viewer, item)
    comment(session, viewer, item, 'Another thoughtful comment')
    preference(session, viewer, liked=[item.id], saved=[item.id])
    value = client.get('/api/rewards/wallet').json()
    assert value['balance'] == 6 and value['earned_total'] == 6
    assert len(value['history']) == 3 and value['cash_value'] is None
    assert value['unit'] == 'Ziipa points' and not value['redemption']['available']
    assert 'Thoughtful feedback' not in str(value)
    assert {row.kind for row in session.scalars(select(rewards.RewardInteraction)).all()} == {'like', 'save', 'comment'}
    acting['user'] = stranger
    assert client.get('/api/rewards/wallet').json()['balance'] == 0
    acting['user'] = None
    assert client.get('/api/rewards/wallet').status_code == 401


def test_removing_then_readding_never_earns_again_and_counters_stay_gross(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    preference(session, viewer, liked=[item.id], saved=[item.id])
    preference(session, viewer, liked=[], saved=[])
    value = client.get('/api/rewards/wallet').json()
    assert (value['balance'], value['earned_total'], value['reversed_total']) == (0, 3, 3)
    for _ in range(3):
        preference(session, viewer, liked=[item.id], saved=[item.id])
        preference(session, viewer, liked=[], saved=[])
    assert len(client.get('/api/rewards/wallet').json()['history']) == 4
    state = session.get(rewards.RewardState, rewards.PLATFORM_KEY)
    assert state.platform_points_issued == state.daily_points_issued == 3


@pytest.mark.parametrize('case', ['self', 'draft', 'hidden', 'sample', 'no_media', 'wrong_media_owner', 'private', 'actor_block', 'creator_block'])
def test_ineligible_media_never_earns_points(workspace, case):
    client, session, author, viewer, stranger, acting, item = workspace
    if case == 'self':
        viewer = author
    elif case in ('draft', 'hidden'):
        item.visibility = case
    elif case == 'sample':
        item.data = {**item.data, 'demo': True}
    elif case == 'no_media':
        item.data = {'title': 'No actual upload'}
    elif case == 'wrong_media_owner':
        session.get(CreatorMedia, item.data['media_id']).owner_id = stranger.id
    elif case == 'private':
        session.add(AccountState(owner_id=author.id, privacy={'profile_visibility': 'private'}))
    elif case == 'actor_block':
        preference(session, viewer, blocked_user_ids=[author.id])
    elif case == 'creator_block':
        preference(session, author, blocked_user_ids=[viewer.id])
    session.commit()
    preference(session, viewer, liked=[item.id, 'demo-concert'], saved=[item.id])
    comment(session, viewer, item)
    assert session.scalars(select(rewards.RewardLedger).where(rewards.RewardLedger.owner_id == viewer.id)).all() == []


def test_comment_reward_requires_real_session_owned_meaningful_comment(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    comment(session, viewer, item, '...')
    comment(session, viewer, item, 'ab')
    transient = CreatorComment(owner_id=viewer.id, item_id=item.id, body='Fake transient event')
    rewards.award_comment_reward(session, viewer, item, transient)
    wrong = CreatorComment(owner_id=stranger.id, item_id=item.id, body='Other person’s comment')
    session.add(wrong)
    rewards.award_comment_reward(session, viewer, item, wrong)
    assert client.get('/api/rewards/wallet').json()['balance'] == 0
    assert client.post('/api/rewards/events', json={'kind': 'view', 'points': 100}).status_code == 404


@pytest.mark.parametrize('body,expected', [
    ('abcdefghij!!!!!!!!!!', 3),
    ('abcdefghij!!!!!!!!!', 0),
    ('abcdefghi!!!!!!!!!!!', 0),
    ('   abcdefghij!!!!!!!!!   ', 0),
    ('   abcdefghij!!!!!!!!!!   ', 3),
])
def test_comment_quality_threshold_boundaries(workspace, body, expected):
    client, session, author, viewer, stranger, acting, item = workspace
    comment(session, viewer, item, body)
    assert client.get('/api/rewards/wallet').json()['balance'] == expected
    config = client.get('/api/rewards/config').json()
    assert config['comment_min_characters'] == 20 and config['comment_min_alphanumeric'] == 10


def test_removed_qualified_comments_reverse_once_without_refarming(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    comment(session, viewer, item, 'This is the first qualified comment')
    comment(session, viewer, item, 'This is another qualified comment')
    comment(session, viewer, item, 'ok')
    rows = session.scalars(select(CreatorComment).where(CreatorComment.owner_id == viewer.id).order_by(CreatorComment.created_at)).all()
    session.delete(rows[0]); session.commit()
    assert client.get('/api/rewards/wallet').json()['balance'] == 3
    session.delete(rows[1]); session.commit()
    value = client.get('/api/rewards/wallet').json()
    assert value['balance'] == 0 and value['reversed_total'] == 3
    comment(session, viewer, item, 'This later qualified comment never farms another award')
    assert client.get('/api/rewards/wallet').json()['balance'] == 0
    assert len(client.get('/api/rewards/wallet').json()['history']) == 2


def test_missing_persisted_like_or_save_source_reconciles_legacy_changes(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    preference(session, viewer, liked=[item.id], saved=[item.id])
    # Simulate a legacy cleanup path that changes preferences without the hook.
    prefs = session.get(CreatorPreferences, viewer.id)
    prefs.data = {'liked': [], 'saved': []}
    session.commit()
    assert client.get('/api/rewards/wallet').json()['balance'] == 0
    preference(session, viewer, liked=[item.id], saved=[item.id])
    assert client.get('/api/rewards/wallet').json()['balance'] == 0


def test_config_separates_funded_testnet_distribution_infrastructure_from_points_conversion(workspace, monkeypatch):
    client, session, author, viewer, stranger, acting, item = workspace
    monkeypatch.setattr(rewards.svc, 'chains', lambda: [{'id': 31337, 'name': 'Local test'}])
    monkeypatch.setattr(rewards.svc, 'registry', lambda _: {'rewards': {'address': '0x'+'1'*40}})
    value = client.get('/api/rewards/config').json()['redemption']
    assert value['scope'] == 'creator-funded testnet distributions'
    assert value['points_conversion'] is False and value['available'] is False
    assert value['requires_wallet_review'] is True and value['infrastructure_available'] is True
    monkeypatch.setattr(rewards.svc, 'registry', lambda _: {})
    assert client.get('/api/rewards/config').json()['redemption']['infrastructure_available'] is False


def test_paused_default_program_explicit_enable_and_bounded_per_creator_budget(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    row, payload = program(client, acting, author, like_points=2, save_points=0, comment_points=0,
                           point_budget=2, per_user_daily_cap=2)
    assert row['enabled'] is False and row['token'] is None
    preference(session, viewer, saved=[item.id])
    updated = edit_program(client, row, enabled=True).json()
    assert updated['revision'] == 2
    preference(session, viewer, liked=[item.id])
    acting['user'] = viewer
    value = client.get('/api/rewards/wallet').json()
    assert value['balance'] == 5
    assert rewards.net_points_for_program(session, viewer.id, row['id']) == 2
    preference(session, stranger, liked=[item.id])
    assert rewards.net_points_for_program(session, stranger.id, row['id']) == 0
    acting['user'] = author
    issued = client.get('/api/rewards/programs').json()[0]
    assert issued['points_issued'] == 2 and issued['budget_remaining'] == 0
    assert edit_program(client, issued, point_budget=1).status_code == 409
    preference(session, viewer, liked=[])
    assert client.get('/api/rewards/programs').json()[0]['budget_remaining'] == 0


def test_program_idempotency_revision_owner_and_origin_checks(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    row, payload = program(client, acting, author)
    assert client.post('/api/rewards/programs', json=payload).json()['id'] == row['id']
    assert client.post('/api/rewards/programs', json={**payload, 'name': 'Changed'}).status_code == 409
    assert edit_program(client, row, enabled=True).status_code == 200
    assert edit_program(client, row, enabled=False).status_code == 409
    assert client.post('/api/rewards/programs', json={**payload, 'request_id': str(uuid.uuid4())},
                       headers={'origin': 'https://untrusted.test'}).status_code == 403
    acting['user'] = stranger
    assert client.get('/api/rewards/programs').json() == []
    assert edit_program(client, row, enabled=True).status_code == 404
    assert client.post('/api/rewards/programs', json=payload).status_code == 404


@pytest.mark.parametrize('invalid', [
    {'point_budget': 0}, {'point_budget': 100_001}, {'point_budget': 5.1}, {'point_budget': True},
    {'like_points': 21}, {'like_points': True}, {'like_points': 0, 'save_points': 0, 'comment_points': 0},
    {'per_user_daily_cap': 1, 'save_points': 2}, {'cash_value': 1}, {'name': '   '},
])
def test_strict_whole_point_program_validation(workspace, invalid):
    client, session, author, viewer, stranger, acting, item = workspace
    acting['user'] = author
    assert client.post('/api/rewards/programs', json={'request_id': str(uuid.uuid4()), 'name': 'Finite points', **invalid}).status_code == 422


def test_owner_total_budget_and_count_caps(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    program(client, acting, author, point_budget=100_000)
    program(client, acting, author, point_budget=100_000)
    assert client.post('/api/rewards/programs', json={'request_id': str(uuid.uuid4()), 'name': 'Over cap'}).status_code == 409


@pytest.mark.parametrize('status,kind,has_wallet', [('prepared', 'create_token', True), ('pending', 'create_token', True),
    ('reverted', 'create_token', True), ('confirmed', 'mint_nft', True), ('confirmed', 'create_token', False)])
def test_token_reward_link_requires_confirmed_own_token_and_verified_wallet(workspace, status, kind, has_wallet):
    client, session, author, viewer, stranger, acting, item = workspace
    receipt = token_receipt(session, author, status=status, kind=kind, wallet=has_wallet)
    acting['user'] = author
    payload = {'request_id': str(uuid.uuid4()), 'name': 'Token rewards', 'token_intent_id': receipt.id}
    assert client.post('/api/rewards/programs', json=payload).status_code == 409
    acting['user'] = stranger
    assert client.post('/api/rewards/programs', json=payload).status_code == 404


def test_confirmed_token_binding_never_claims_token_or_cash_balance(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    receipt = token_receipt(session, author)
    row, payload = program(client, acting, author, token_intent_id=receipt.id, enabled=True)
    assert row['token']['address'] == receipt.result['token_address']
    assert row['token']['symbol'] == 'MEDIA'
    stored = session.get(rewards.RewardProgram, row['id'])
    assert stored.chain_id == 31337 and stored.issuer_address == receipt.address
    assert client.post('/api/rewards/programs', json={**payload, 'request_id': str(uuid.uuid4())}).status_code == 409
    preference(session, viewer, liked=[item.id])
    acting['user'] = viewer
    value = client.get('/api/rewards/wallet').json()
    assert value['balance'] == 2 and value['cash_value'] is None
    assert value['wallets'] == [] and value['redemption']['available'] is False


def test_daily_global_lifetime_caps_and_no_retoggle_after_exhaustion(workspace, monkeypatch):
    client, session, author, viewer, stranger, acting, item = workspace
    monkeypatch.setattr(rewards.config, 'rewards_daily_points', 2)
    monkeypatch.setattr(rewards.config, 'rewards_global_daily_points', 2)
    monkeypatch.setattr(rewards.config, 'rewards_platform_budget', 2)
    preference(session, viewer, liked=[item.id], saved=[item.id])
    preference(session, stranger, liked=[item.id])
    comment(session, viewer, item)
    assert client.get('/api/rewards/wallet').json()['balance'] == 1
    state = session.get(rewards.RewardState, rewards.PLATFORM_KEY)
    assert state.platform_points_issued == state.daily_points_issued == 2
    monkeypatch.setattr(rewards.config, 'rewards_daily_points', 100)
    monkeypatch.setattr(rewards.config, 'rewards_global_daily_points', 100)
    monkeypatch.setattr(rewards.config, 'rewards_platform_budget', 100)
    preference(session, viewer, saved=[])
    preference(session, viewer, saved=[item.id])
    assert client.get('/api/rewards/wallet').json()['balance'] == 1


def test_cross_program_gross_user_daily_cap_prevents_creator_campaign_multiplier(workspace, monkeypatch):
    client, session, author, viewer, stranger, acting, item = workspace
    monkeypatch.setattr(rewards.config, 'rewards_daily_points', 5)
    for _ in range(3):
        program(client, acting, author, enabled=True, like_points=3, save_points=0, comment_points=0)
    preference(session, viewer, liked=[item.id])
    acting['user'] = viewer
    assert client.get('/api/rewards/wallet').json()['balance'] == 4
    preference(session, viewer, liked=[])
    assert rewards._gross_daily(session, viewer.id) == 4


@pytest.mark.parametrize('case', ['draft', 'hidden', 'private', 'deleted_media', 'creator_block', 'actor_block'])
def test_wallet_reconciliation_reverses_newly_ineligible_awards_once(workspace, case):
    client, session, author, viewer, stranger, acting, item = workspace
    preference(session, viewer, liked=[item.id], saved=[item.id])
    if case in ('draft', 'hidden'):
        item.visibility = case
    elif case == 'private':
        session.add(AccountState(owner_id=author.id, privacy={'profile_visibility': 'private'}))
    elif case == 'deleted_media':
        session.delete(session.get(CreatorMedia, item.data['media_id']))
    elif case == 'creator_block':
        preference(session, author, blocked_user_ids=[viewer.id])
    elif case == 'actor_block':
        preference(session, viewer, blocked_user_ids=[author.id])
    session.commit()
    value = client.get('/api/rewards/wallet').json()
    assert (value['balance'], value['reversed_total']) == (0, 3)
    assert len(client.get('/api/rewards/wallet').json()['history']) == 4
    item.visibility = 'published'
    session.commit()
    preference(session, viewer, liked=[])
    preference(session, viewer, liked=[item.id])
    assert client.get('/api/rewards/wallet').json()['balance'] == 0


def test_helpers_export_delete_and_rollback_never_commit_their_caller(workspace):
    client, session, author, viewer, stranger, acting, item = workspace
    row, _ = program(client, acting, author, enabled=True)
    preference(session, viewer, liked=[item.id])
    exported = rewards.export_rewards_data(session, viewer.id)
    assert len(exported['ledger']) == 2 and exported['programs'] == []
    assert len(rewards.export_rewards_data(session, author.id)['programs']) == 1
    commit = session.commit
    session.commit = lambda: pytest.fail('Helper must not commit')
    rewards.delete_rewards_data(session, author.id)
    assert session.get(rewards.RewardProgram, row['id']) is None
    assert rewards.net_points_for_program(session, viewer.id, row['id']) == 1
    assert rewards.export_rewards_data(session, viewer.id)['ledger'][0]['program_id'] is None
    assert row['name'] not in str(rewards.export_rewards_data(session, viewer.id))
    rewards.delete_rewards_data(session, viewer.id)
    assert rewards.export_rewards_data(session, viewer.id)['ledger'] == []
    session.commit = commit
    session.rollback()
    assert rewards.net_points_for_program(session, viewer.id, row['id']) == 1


def test_concurrent_accounts_cannot_overspend_one_campaign(monkeypatch):
    # Dedicated temporary schema allows genuinely separate committed sessions
    # without test fixtures leaking into the app's local review data.
    if engine.dialect.name != 'postgresql':
        pytest.skip('PostgreSQL is required to verify the admission lock')
    monkeypatch.setattr(rewards.config, 'rewards_daily_points', 100)
    monkeypatch.setattr(rewards.config, 'rewards_global_daily_points', 50_000)
    monkeypatch.setattr(rewards.config, 'rewards_platform_budget', 1_000_000)
    schema = 'reward_test_' + uuid.uuid4().hex
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA {schema}'))
    isolated = engine.execution_options(schema_translate_map={None: schema})
    try:
        Base.metadata.create_all(isolated)
        with Session(isolated) as session:
            author = User(name='Concurrent author', email='author@example.test', password_hash='unused')
            viewers = [User(name=f'Viewer {i}', email=f'{i}@example.test', password_hash='unused') for i in range(2)]
            session.add_all([author, *viewers]); session.flush()
            media = CreatorMedia(id=str(uuid.uuid4()), owner_id=author.id, content_type='video/mp4', size=100)
            item = CreatorItem(owner_id=author.id, visibility='published', data={'title': 'Race clip', 'media_id': media.id})
            row = rewards.RewardProgram(id=str(uuid.uuid4()), owner_id=author.id, name='Finite race', request_hash='a'*64,
                enabled=True, point_budget=2, points_issued=0, per_user_daily_cap=10,
                rates={'like': 2, 'save': 0, 'comment': 0})
            session.add_all([media, item, row]); session.commit()
            ids, item_id, program_id = [user.id for user in viewers], item.id, row.id
        barrier = threading.Barrier(2)
        def earn(user_id):
            with Session(isolated) as session:
                user = session.get(User, user_id)
                barrier.wait(timeout=10)
                preference(session, user, liked=[item_id])
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(earn, ids))
        with Session(isolated) as session:
            row = session.get(rewards.RewardProgram, program_id)
            assert row.points_issued == 2
            awarded = [rewards.net_points_for_program(session, user_id, program_id) for user_id in ids]
            assert sorted(awarded) == [0, 2]
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA {schema} CASCADE'))
