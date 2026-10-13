"""Controlled RPC acceptance tests: exact funding, owner isolation, irreversible proofs.

Actual EVM transfer and Merkle behavior are separately exercised by contracts/tests.
These cases prove that private API state cannot be credited by a forged receipt.
"""
from dataclasses import dataclass
from types import SimpleNamespace
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from web3 import Web3
from web3.exceptions import TransactionNotFound

from app import User, db
from media_rewards import RewardLedger, RewardProgram
from test_api import client, native_headers
from web3_api import WalletLink
import rewards_redemption as redemption


CREATOR = Web3.to_checksum_address('0x' + '11' * 20)
ALICE = Web3.to_checksum_address('0x' + '22' * 20)
BOB = Web3.to_checksum_address('0x' + '33' * 20)
TOKEN = Web3.to_checksum_address('0x' + '44' * 20)
REWARDS = Web3.to_checksum_address('0x' + '55' * 20)


class Function:
    def __init__(self, contract, name, args):
        self.contract, self.name, self.args = contract, name, args
    def call(self):
        return self.contract.state(self.name, self.args)
    def _encode_transaction_data(self):
        return self.contract.encoding.functions[self.name](*self.args)._encode_transaction_data()


class Contract:
    def __init__(self, address, abi_name, state):
        self.address, self.state = address, state
        self.encoding = Web3().eth.contract(address=address, abi=redemption.svc.abi(abi_name))
        self.functions = self
        self.events = self
    def __getattr__(self, name):
        if name[0].isupper():
            return lambda: SimpleNamespace(process_receipt=lambda receipt, errors: [event for event in receipt.get('events', []) if event.get('name') == name])
        return lambda *args: Function(self, name, args)


class ControlledRPC:
    def __init__(self):
        self.eth = self
        self.allowance = 0
        self.balance = 1_000 * 10**18
        self.available = 100 * 10**18
        self.reserved = 0
        self.accounted = 100 * 10**18
        self.pool_balance = 100 * 10**18
        self.actual_batches = {}
        self.claimed = False
        self.block_number, self.gas_price = 10, 2
        self.transactions, self.receipts = {}, {}
        self.rewards = Contract(REWARDS, 'ZiipaMediaRewards', self.reward_state)
        self.token = Contract(TOKEN, 'ZiipaCreatorToken', self.token_state)
    def token_state(self, name, args):
        return {'decimals': 18, 'allowance': self.allowance, 'balanceOf': self.pool_balance if args and args[0].lower() == REWARDS.lower() else self.balance}[name]
    def reward_state(self, name, args):
        return {'poolCredits': self.available, 'reservedCredits': self.reserved, 'totalAccounted': self.accounted,
                'claimed': self.claimed, 'batches': self.actual_batches.get(args[0] if args else '', [redemption.svc.ZERO, redemption.svc.ZERO, bytes(32), 0, 0])}[name]
    def estimate_gas(self, tx):
        return 100_000
    def get_transaction(self, tx_hash):
        if tx_hash not in self.transactions:
            raise TransactionNotFound(tx_hash)
        return self.transactions[tx_hash]
    def get_transaction_receipt(self, tx_hash):
        if tx_hash not in self.receipts:
            raise TransactionNotFound(tx_hash)
        return self.receipts[tx_hash]
    def get_block(self, block):
        return {'hash': bytes.fromhex('ab' * 32)}
    def mined(self, intent, event_name=None, event_args=None, event_address=REWARDS, status=1):
        tx_hash = '0x' + uuid.uuid4().hex * 2
        tx = intent['transaction']
        self.transactions[tx_hash] = {'from': tx['from'], 'to': tx['to'], 'input': bytes.fromhex(tx['data'][2:]),
                                     'value': 0, 'chainId': intent['chain_id']}
        self.receipts[tx_hash] = {'status': status, 'blockNumber': 10, 'blockHash': bytes.fromhex('ab' * 32),
                                'events': [] if event_name is None else [{'name': event_name, 'address': event_address, 'args': event_args}]}
        return tx_hash


@dataclass
class Fixture:
    session: object
    owner: dict
    alice: dict
    bob: dict
    owner_id: int
    alice_id: int
    bob_id: int
    wallet_id: str
    alice_wallet: str
    bob_wallet: str
    program_id: str
    rpc: ControlledRPC


@pytest.fixture
def data(client, monkeypatch):
    owner = native_headers(client, 'reward-issuer@example.com', 'Issuer')
    alice = native_headers(client, 'reward-earner@example.com', 'Earner')
    bob = native_headers(client, 'reward-other@example.com', 'Other')
    session = next(client.app.dependency_overrides[db]())
    owner_id = client.get('/api/me', headers=owner).json()['id']
    alice_id = client.get('/api/me', headers=alice).json()['id']
    bob_id = client.get('/api/me', headers=bob).json()['id']
    wallets = []
    for owner_key, address in ((owner_id, CREATOR), (alice_id, ALICE), (bob_id, BOB)):
        wallet = WalletLink(owner_id=owner_key, chain_id=31337, address=address)
        session.add(wallet)
        session.flush()
        wallets.append(wallet.id)
    program_id = str(uuid.uuid4())
    program = RewardProgram(id=program_id, owner_id=owner_id, name='Creator audience rewards', request_hash='fixture',
        token={'address': TOKEN, 'chain_id': 31337, 'wallet_address': CREATOR, 'symbol': 'MEDIA'}, enabled=True,
        point_budget=1000, points_issued=10, per_user_daily_cap=25, rates={'like': 1})
    session.add(program)
    session.flush()
    for actor, points in ((alice_id, 3), (bob_id, 7)):
        session.add(RewardLedger(owner_id=actor, program_id=program_id, program_key=program_id,
            program_name=program.name, reference_id=str(uuid.uuid4()), kind='earned', points=points, interaction_kind='like'))
    session.commit()
    rpc = ControlledRPC()
    monkeypatch.setattr(redemption.svc, 'rpc', lambda chain: rpc)
    monkeypatch.setattr(redemption.svc, 'chain_info', lambda chain: {'id': chain, 'name': 'Local fixture', 'confirmations': 1} if chain == 31337 else (_ for _ in ()).throw(HTTPException(422, 'Only configured testnets')))
    monkeypatch.setattr(redemption.svc, 'contract', lambda w3, chain, kind: rpc.rewards)
    monkeypatch.setattr(redemption, 'token_contract', lambda w3, chain, token: rpc.token)
    return Fixture(session, owner, alice, bob, owner_id, alice_id, bob_id, *wallets, program_id, rpc)


def create_batch(client, data, rate='1', request_id=None):
    response = client.post(f'/api/rewards/programs/{data.program_id}/batches', headers=data.owner,
        json={'request_id': request_id or str(uuid.uuid4()), 'wallet_id': data.wallet_id, 'token_amount_per_point': rate})
    assert response.status_code == 201, response.text
    return response.json()


def publish(client, data, batch, request_id=None):
    response = client.post(f"/api/rewards/batches/{batch['id']}/publish", headers=data.owner,
        json={'request_id': request_id or str(uuid.uuid4()), 'wallet_id': data.wallet_id})
    assert response.status_code == 200, response.text
    return response.json()


def publish_chain_state(data, batch):
    row = data.session.get(redemption.RewardBatch, batch['id'])
    data.rpc.actual_batches[row.batch_id] = [CREATOR, TOKEN, bytes.fromhex(row.merkle_root[2:]), int(row.total_amount), int(row.total_amount)]
    return row


def submit(client, headers, intent, tx_hash):
    return client.post(f"/api/rewards/settlement/intents/{intent['id']}/submit", headers=headers, json={'tx_hash': tx_hash})


def test_batch_domain_and_merkle_proofs_bind_every_recipient_and_amount():
    domain = redemption.batch_domain(CREATOR, str(uuid.uuid4()))
    assert domain[2:42] == CREATOR[2:].lower()
    assert len(domain) == 66
    leaves = [redemption.reward_leaf(domain, address, value) for address, value in ((ALICE, 1), (BOB, 2), (CREATOR, 3))]
    root, proofs = redemption.merkle_tree(leaves)
    for leaf, proof in zip(leaves, proofs):
        value = leaf
        for sibling in proof:
            value = bytes(Web3.keccak(b''.join(sorted([value, bytes.fromhex(sibling[2:])]))))
        assert Web3.to_hex(value) == root
    assert redemption.reward_leaf(domain, ALICE, 1) != redemption.reward_leaf(domain, ALICE, 2)
    assert redemption.reward_leaf(domain, ALICE, 1) != redemption.reward_leaf(domain, BOB, 1)
    with pytest.raises(HTTPException):
        redemption.units('1000000001')
    with pytest.raises(HTTPException):
        redemption.units('0')
    assert redemption.tokens(redemption.units('0.000000000000000001')) == '0.000000000000000001'


def test_pool_and_funding_require_exact_verified_issuer_wallet(client, data):
    path = f'/api/rewards/programs/{data.program_id}'
    pool = client.get(path + '/pool', headers=data.owner, params={'wallet_id': data.wallet_id})
    assert pool.status_code == 200, pool.text
    assert pool.json()['program_id'] == data.program_id
    assert pool.json()['available_token_amount'] == '100'
    assert client.get(path + '/pool', headers=data.bob, params={'wallet_id': data.bob_wallet}).status_code == 404
    payload = {'request_id': str(uuid.uuid4()), 'wallet_id': data.wallet_id, 'amount': '5.5'}
    response = client.post(path + '/fund', headers=data.owner, json=payload)
    assert response.status_code == 200, response.text
    intent = response.json()
    assert intent['kind'] == 'reward_approve'
    assert intent['transaction']['to'] == TOKEN
    assert intent['summary']['amount_units'] == str(55 * 10**17)
    assert client.post(path + '/fund', headers=data.owner, json=payload).json()['id'] == intent['id']
    assert client.post(path + '/fund', headers=data.owner, json={**payload, 'amount': '6'}).status_code == 409
    assert client.post(path + '/fund', headers=data.owner, json={**payload, 'request_id': str(uuid.uuid4()), 'wallet_id': data.bob_wallet}).status_code == 404
    data.rpc.allowance = 10 * 10**18
    response = client.post(path + '/fund', headers=data.owner, json={**payload, 'request_id': str(uuid.uuid4())})
    assert response.json()['kind'] == 'reward_deposit'
    assert response.json()['transaction']['to'] == REWARDS
    data.rpc.balance = 1
    assert client.post(path + '/fund', headers=data.owner, json={**payload, 'request_id': str(uuid.uuid4())}).status_code == 409


def test_withdrawal_preserves_reserved_funds_and_verifies_exact_creator_receipt(client, data):
    data.rpc.available = 4 * 10**18
    data.rpc.reserved = 6 * 10**18
    path = f'/api/rewards/programs/{data.program_id}/withdraw'
    payload = {'request_id': str(uuid.uuid4()), 'wallet_id': data.wallet_id, 'amount': '5'}
    assert client.post(path, headers=data.owner, json=payload).status_code == 409
    assert client.post(path, headers=data.bob, json={**payload, 'wallet_id': data.bob_wallet}).status_code == 404
    payload = {**payload, 'amount': '4'}
    response = client.post(path, headers=data.owner, json=payload)
    assert response.status_code == 200, response.text
    intent = response.json()
    assert intent['kind'] == 'reward_withdraw'
    assert intent['summary']['recipient'] == CREATOR
    tx_hash = data.rpc.mined(intent, 'Withdrawn', {'owner': BOB, 'token': TOKEN, 'amount': 4 * 10**18})
    assert submit(client, data.owner, intent, tx_hash).status_code == 422
    data.rpc.receipts[tx_hash]['events'][0]['args']['owner'] = CREATOR
    assert submit(client, data.owner, intent, tx_hash).json()['status'] == 'confirmed'
    assert data.rpc.reserved == 6 * 10**18


def test_draft_reserves_net_points_once_and_allows_only_unsealed_cancellation(client, data):
    request_id = str(uuid.uuid4())
    batch = create_batch(client, data, rate='0.5', request_id=request_id)
    assert batch['participant_count'] == 2
    assert batch['total_token_amount'] == '5'
    assert {row['points'] for row in batch['allocations']} == {3, 7}
    assert redemption.allocated_points(data.session, data.alice_id, data.program_id) == 3
    assert redemption.export_settlement_data(data.session, data.alice_id)['allocations'][0]['points'] == 3
    assert create_batch(client, data, rate='0.5', request_id=request_id)['id'] == batch['id']
    response = client.post(f'/api/rewards/programs/{data.program_id}/batches', headers=data.owner,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': data.wallet_id, 'token_amount_per_point': '1'})
    assert response.status_code == 409
    assert client.get('/api/rewards/batches', headers=data.bob).json() == []
    assert client.post(f"/api/rewards/batches/{batch['id']}/cancel", headers=data.bob).status_code == 404
    assert client.post(f"/api/rewards/batches/{batch['id']}/cancel", headers=data.owner).status_code == 200
    assert redemption.allocated_points(data.session, data.alice_id, data.program_id) == 0
    second = create_batch(client, data)
    intent = publish(client, data, second)
    assert intent['kind'] == 'reward_publish'
    assert data.session.get(redemption.RewardBatch, second['id']).status == 'awaiting_publish'
    assert client.post(f"/api/rewards/batches/{second['id']}/cancel", headers=data.owner).status_code == 409


def test_publication_rechecks_points_wallet_and_actual_funding_before_sealing(client, data):
    batch = create_batch(client, data)
    data.rpc.available = 0
    response = client.post(f"/api/rewards/batches/{batch['id']}/publish", headers=data.owner,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': data.wallet_id})
    assert response.status_code == 409
    assert data.session.get(redemption.RewardBatch, batch['id']).status == 'draft'
    data.rpc.available = 100 * 10**18
    data.session.add(RewardLedger(owner_id=data.alice_id, program_id=data.program_id, program_key=data.program_id,
        program_name='Creator audience rewards', reference_id=str(uuid.uuid4()), kind='reversed', points=-3, interaction_kind='like'))
    data.session.commit()
    response = client.post(f"/api/rewards/batches/{batch['id']}/publish", headers=data.owner,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': data.wallet_id})
    assert response.status_code == 409
    assert data.session.get(redemption.RewardBatch, batch['id']).status == 'draft'


def test_unknown_and_mismatched_hashes_do_not_reserve_or_credit_transactions(client, data):
    batch = create_batch(client, data)
    intent = publish(client, data, batch)
    unknown = '0x' + 'aa' * 32
    assert submit(client, data.owner, intent, unknown).status_code == 409
    row = data.session.get(redemption.RewardTransaction, intent['id'])
    assert row.tx_hash is None and row.status == 'prepared'
    tx_hash = data.rpc.mined(intent)
    data.rpc.transactions[tx_hash]['from'] = BOB
    assert submit(client, data.owner, intent, tx_hash).status_code == 422
    assert row.tx_hash is None
    assert submit(client, data.bob, intent, tx_hash).status_code == 404
    assert client.get('/api/rewards/settlement/intents', headers=data.bob).json() == []


def test_receipt_event_fields_and_confirmations_control_publication_truth(client, data, monkeypatch):
    batch = create_batch(client, data)
    intent = publish(client, data, batch)
    row = data.session.get(redemption.RewardBatch, batch['id'])
    expected = {'batchId': bytes.fromhex(row.batch_id[2:]), 'owner': CREATOR, 'token': TOKEN,
                'root': bytes.fromhex(row.merkle_root[2:]), 'totalAmount': int(row.total_amount)}
    tx_hash = data.rpc.mined(intent, 'BatchPublished', {**expected, 'totalAmount': 1})
    assert submit(client, data.owner, intent, tx_hash).status_code == 422
    assert row.status == 'awaiting_publish'
    assert data.session.get(redemption.RewardTransaction, intent['id']).tx_hash is None
    data.rpc.receipts[tx_hash]['events'][0]['args'] = expected
    monkeypatch.setattr(redemption.svc, 'chain_info', lambda chain: {'id': chain, 'name': 'Local fixture', 'confirmations': 2})
    result = submit(client, data.owner, intent, tx_hash)
    assert result.json()['status'] == 'pending'
    assert row.status == 'awaiting_publish'
    data.rpc.block_number = 11
    result = submit(client, data.owner, intent, tx_hash)
    assert result.json()['status'] == 'confirmed'
    assert row.status == 'published'
    assert submit(client, data.owner, intent, tx_hash).json()['status'] == 'confirmed'


def test_reverted_publication_never_releases_sealed_points_or_labels_claims_ready(client, data):
    batch = create_batch(client, data)
    intent = publish(client, data, batch)
    tx_hash = data.rpc.mined(intent, status=0)
    assert submit(client, data.owner, intent, tx_hash).json()['status'] == 'reverted'
    assert data.session.get(redemption.RewardBatch, batch['id']).status == 'awaiting_publish'
    assert redemption.allocated_points(data.session, data.alice_id, data.program_id) == 3
    assert client.get('/api/rewards/claims', headers=data.alice).json()[0]['status'] == 'awaiting_publish'
    # A confirmed revert may be retried with a new wallet intent, but the sealed
    # promise is unchanged even if a later interaction reversal removes points.
    data.session.add(RewardLedger(owner_id=data.alice_id, program_id=data.program_id, program_key=data.program_id,
        program_name='Creator audience rewards', reference_id=str(uuid.uuid4()), kind='reversed', points=-3, interaction_kind='like'))
    data.session.commit()
    retried = publish(client, data, batch)
    assert retried['id'] != intent['id']
    assert retried['transaction']['data'] == intent['transaction']['data']
    assert client.post(f"/api/rewards/batches/{batch['id']}/cancel", headers=data.owner).status_code == 409


def test_claim_requires_exact_live_root_and_verified_recipient_and_receipt(client, data):
    batch = create_batch(client, data)
    publish(client, data, batch)
    claim = client.get('/api/rewards/claims', headers=data.alice).json()[0]
    payload = {'request_id': str(uuid.uuid4()), 'wallet_id': data.alice_wallet}
    path = f"/api/rewards/claims/{claim['id']}/prepare"
    assert client.post(path, headers=data.bob, json={'request_id': str(uuid.uuid4()), 'wallet_id': data.bob_wallet}).status_code == 404
    assert client.post(path, headers=data.alice, json=payload).status_code == 409
    row = publish_chain_state(data, batch)
    result = client.post(path, headers=data.alice, json=payload)
    assert result.status_code == 200, result.text
    intent = result.json()
    assert intent['kind'] == 'reward_claim'
    assert intent['transaction']['from'] == ALICE
    assert row.status == 'published'
    tx_hash = data.rpc.mined(intent, 'Claimed', {'batchId': bytes.fromhex(row.batch_id[2:]), 'recipient': BOB, 'amount': 3 * 10**18})
    assert submit(client, data.alice, intent, tx_hash).status_code == 422
    data.rpc.receipts[tx_hash]['events'][0]['args']['recipient'] = ALICE
    assert submit(client, data.alice, intent, tx_hash).json()['status'] == 'confirmed'
    assert client.get('/api/rewards/claims', headers=data.alice).json()[0]['status'] == 'claimed'


def test_account_deletion_keeps_only_sealed_public_proofs_and_requires_actual_wallet_recovery(client, data):
    batch = create_batch(client, data)
    publish(client, data, batch)
    publish_chain_state(data, batch)
    original_claim = client.get('/api/rewards/claims', headers=data.alice).json()[0]
    prepared_claim = client.post(f"/api/rewards/claims/{original_claim['id']}/prepare", headers=data.alice,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': data.alice_wallet})
    assert prepared_claim.status_code == 200, prepared_claim.text
    assert prepared_claim.json()['summary']['name'] == 'Creator audience rewards'
    owner_export = redemption.export_settlement_data(data.session, data.owner_id)
    assert len(owner_export['batches']) == 1
    assert len(owner_export['transactions']) == 1
    redemption.delete_settlement_data(data.session, data.owner_id)
    data.session.flush()
    row = data.session.get(redemption.RewardBatch, batch['id'])
    assert row.owner_id is None and row.program_id is None
    assert row.program_name == 'Removed creator program'
    allocations = data.session.scalars(select(redemption.RewardAllocation).where(redemption.RewardAllocation.batch_id == row.id)).all()
    assert all(allocation.owner_id is None and allocation.points == 0 for allocation in allocations)
    assert not data.session.scalars(select(redemption.RewardTransaction).where(redemption.RewardTransaction.owner_id == data.owner_id)).all()
    data.session.commit()
    recipient_history = client.get('/api/rewards/settlement/intents', headers=data.alice).json()
    assert recipient_history[0]['summary']['name'] == 'Removed creator program'
    assert recipient_history[0]['summary']['program_id'] is None
    alice_claims = client.get('/api/rewards/claims', headers=data.alice).json()
    assert len(alice_claims) == 1 and alice_claims[0]['recipient'] == ALICE
    assert len(client.get('/api/rewards/claims', headers=data.bob).json()) == 1
    result = client.post(f"/api/rewards/claims/{alice_claims[0]['id']}/prepare", headers=data.alice,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': data.alice_wallet})
    assert result.status_code == 200, result.text


def test_unsealed_deleted_creator_drafts_release_point_allocations(client, data):
    batch = create_batch(client, data)
    redemption.delete_settlement_data(data.session, data.owner_id)
    data.session.flush()
    assert data.session.get(redemption.RewardBatch, batch['id']) is None
    assert redemption.allocated_points(data.session, data.alice_id, data.program_id) == 0


def test_real_local_reward_approve_deposit_publish_claim_round_trip(client, monkeypatch, tmp_path):
    """Actual wallet signatures and token transfers, not simulated credits."""
    import base64
    from eth_account import Account
    import creator
    from web3_api import MetadataRecord
    from test_web3 import link, send
    monkeypatch.setattr(redemption.svc.config, 'web3_enable_local', True)
    monkeypatch.setattr(creator, 'MEDIA_ROOT', tmp_path)
    w3 = redemption.svc.rpc(31337)
    assert w3.eth.chain_id == 31337
    issuer_headers = native_headers(client, 'evm-reward-issuer@example.com', 'Real local issuer')
    earner_headers = native_headers(client, 'evm-reward-earner@example.com', 'Real local earner')
    issuer, earner = Account.create(), Account.create()
    for account in (issuer, earner):
        w3.eth.wait_for_transaction_receipt(w3.eth.send_transaction({'from': w3.eth.accounts[0], 'to': account.address, 'value': 10**18}))
    issuer_wallet, earner_wallet = link(client, issuer_headers, issuer), link(client, earner_headers, earner)
    session = next(client.app.dependency_overrides[db]())
    issuer_id = client.get('/api/me', headers=issuer_headers).json()['id']
    metadata = MetadataRecord(id=str(uuid.uuid4()), owner_id=issuer_id, uri='ipfs://local-reward-acceptance-token',
        sha256='0' * 64, request_hash='0' * 64, document={'name': 'Local audience rewards'})
    session.add(metadata)
    session.commit()
    response = client.post('/api/web3/intents', headers=issuer_headers,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': issuer_wallet['id'], 'kind': 'create_token',
              'metadata_id': metadata.id, 'symbol': 'MEDIA', 'supply': '1000'})
    assert response.status_code == 200, response.text
    token_intent = response.json()
    token_hash = send(w3, issuer, token_intent)
    result = client.post(f"/api/web3/intents/{token_intent['id']}/submit", headers=issuer_headers, json={'tx_hash': token_hash})
    assert result.status_code == 200 and result.json()['status'] == 'confirmed', result.text
    token_address = result.json()['result']['token_address']
    response = client.post('/api/rewards/programs', headers=issuer_headers,
        json={'request_id': str(uuid.uuid4()), 'name': 'Actual local testnet rewards', 'token_intent_id': token_intent['id'],
              'enabled': True, 'point_budget': 100, 'per_user_daily_cap': 25, 'like_points': 1, 'save_points': 2, 'comment_points': 3})
    assert response.status_code == 201, response.text
    program = response.json()
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')
    media = client.post('/api/creator/media', headers={**issuer_headers, 'content-type': 'image/png'}, content=png).json()
    response = client.post('/api/creator/items', headers=issuer_headers,
        json={'title': 'Generated local reward media', 'category': 'store', 'media_id': media['id'], 'visibility': 'published'})
    assert response.status_code == 201, response.text
    item_id = response.json()['id']
    response = client.post('/api/creator/preferences', headers=earner_headers, json={'liked': [item_id]})
    assert response.status_code == 200, response.text
    balance = client.get('/api/rewards/wallet', headers=earner_headers).json()
    assert next(entry for entry in balance['by_program'] if entry['program_id'] == program['id'])['balance'] == 1
    fund_path = f"/api/rewards/programs/{program['id']}/fund"
    for kind in ('reward_approve', 'reward_deposit'):
        response = client.post(fund_path, headers=issuer_headers,
            json={'request_id': str(uuid.uuid4()), 'wallet_id': issuer_wallet['id'], 'amount': '10'})
        assert response.status_code == 200, response.text
        intent = response.json()
        assert intent['kind'] == kind
        response = submit(client, issuer_headers, intent, send(w3, issuer, intent))
        assert response.status_code == 200 and response.json()['status'] == 'confirmed', response.text
    pool_path = f"/api/rewards/programs/{program['id']}/pool"
    assert client.get(pool_path, headers=issuer_headers, params={'wallet_id': issuer_wallet['id']}).json()['available_token_amount'] == '10'
    response = client.post(f"/api/rewards/programs/{program['id']}/batches", headers=issuer_headers,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': issuer_wallet['id'], 'token_amount_per_point': '0.5'})
    assert response.status_code == 201, response.text
    batch = response.json()
    assert batch['participant_count'] == 1 and batch['total_token_amount'] == '0.5'
    response = client.post(f"/api/rewards/batches/{batch['id']}/publish", headers=issuer_headers,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': issuer_wallet['id']})
    assert response.status_code == 200, response.text
    intent = response.json()
    response = submit(client, issuer_headers, intent, send(w3, issuer, intent))
    assert response.status_code == 200 and response.json()['status'] == 'confirmed', response.text
    withdraw_path = f"/api/rewards/programs/{program['id']}/withdraw"
    assert client.post(withdraw_path, headers=issuer_headers,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': issuer_wallet['id'], 'amount': '10'}).status_code == 409
    claim = client.get('/api/rewards/claims', headers=earner_headers).json()[0]
    assert claim['status'] == 'ready' and claim['amount_tokens'] == '0.5'
    response = client.post(f"/api/rewards/claims/{claim['id']}/prepare", headers=earner_headers,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': earner_wallet['id']})
    assert response.status_code == 200, response.text
    intent = response.json()
    response = submit(client, earner_headers, intent, send(w3, earner, intent))
    assert response.status_code == 200 and response.json()['status'] == 'confirmed', response.text
    token = redemption.token_contract(w3, 31337, token_address)
    assert token.functions.balanceOf(earner.address).call() == 5 * 10**17
    assert client.get('/api/rewards/claims', headers=earner_headers).json()[0]['status'] == 'claimed'
    pool_result = client.get(pool_path, headers=issuer_headers, params={'wallet_id': issuer_wallet['id']}).json()
    assert pool_result['available_token_amount'] == '9.5' and pool_result['reserved_token_amount'] == '0'
    response = client.post(withdraw_path, headers=issuer_headers,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': issuer_wallet['id'], 'amount': '9.5'})
    assert response.status_code == 200, response.text
    withdrawal = response.json()
    assert withdrawal['kind'] == 'reward_withdraw'
    response = submit(client, issuer_headers, withdrawal, send(w3, issuer, withdrawal))
    assert response.status_code == 200 and response.json()['status'] == 'confirmed', response.text
    assert token.functions.balanceOf(issuer.address).call() == 9995 * 10**17
    assert client.get(pool_path, headers=issuer_headers, params={'wallet_id': issuer_wallet['id']}).json()['available_token_amount'] == '0'
    assert client.post(f"/api/rewards/claims/{claim['id']}/prepare", headers=earner_headers,
        json={'request_id': str(uuid.uuid4()), 'wallet_id': earner_wallet['id']}).status_code == 409
