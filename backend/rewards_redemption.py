"""Creator-prefunded testnet rewards: read/encode/verify only, never sign or mint.

Snapshots reserve finite earned points. Once a publication intent exists its
public Merkle proof cannot be cancelled: the creator may broadcast that signed
transaction later, and the contract's reservation is irrevocable.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column
from web3 import Web3
from web3.exceptions import TransactionNotFound
from web3.logs import DISCARD

from app import Base, User, current_user, db, guard
from media_rewards import RewardLedger, RewardProgram, iso, lock_user, net_points_for_program, owned_program, reconcile_rewards
from web3_api import TransactionIntent, WalletLink, token_contract
import web3_services as svc

router = APIRouter(prefix='/api/rewards', dependencies=[Depends(current_user)])
MAX_TOKEN_UNITS = 1_000_000_000 * 10**18
MAX_BATCHES = 100
MAX_PARTICIPANTS = 100


def now():
    return datetime.now(timezone.utc)


class RewardBatch(Base):
    __tablename__ = 'media_reward_batches'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey('users.id', ondelete='SET NULL'), nullable=True, index=True)
    program_id: Mapped[str | None] = mapped_column(ForeignKey('media_reward_programs.id', ondelete='SET NULL'), nullable=True, index=True)
    program_name: Mapped[str] = mapped_column(String(100))
    request_hash: Mapped[str] = mapped_column(String(64))
    chain_id: Mapped[int]
    token_address: Mapped[str] = mapped_column(String(42))
    issuer_address: Mapped[str] = mapped_column(String(42))
    symbol: Mapped[str] = mapped_column(String(10))
    batch_id: Mapped[str] = mapped_column(String(66), unique=True)
    merkle_root: Mapped[str] = mapped_column(String(66))
    amount_per_point: Mapped[str] = mapped_column(String(78))
    total_amount: Mapped[str] = mapped_column(String(78))
    status: Mapped[str] = mapped_column(String(24), default='draft')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class RewardAllocation(Base):
    __tablename__ = 'media_reward_allocations'
    __table_args__ = (UniqueConstraint('batch_id', 'recipient'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    batch_id: Mapped[str] = mapped_column(ForeignKey('media_reward_batches.id', ondelete='CASCADE'), index=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey('users.id', ondelete='SET NULL'), nullable=True, index=True)
    recipient: Mapped[str] = mapped_column(String(42))
    points: Mapped[int]
    amount: Mapped[str] = mapped_column(String(78))
    proof: Mapped[list] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(24), default='ready')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class RewardTransaction(Base):
    __tablename__ = 'media_reward_transactions'
    __table_args__ = (UniqueConstraint('chain_id', 'tx_hash'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    program_id: Mapped[str | None] = mapped_column(ForeignKey('media_reward_programs.id', ondelete='SET NULL'), nullable=True, index=True)
    batch_id: Mapped[str | None] = mapped_column(ForeignKey('media_reward_batches.id', ondelete='SET NULL'), nullable=True, index=True)
    allocation_id: Mapped[str | None] = mapped_column(ForeignKey('media_reward_allocations.id', ondelete='SET NULL'), nullable=True)
    chain_id: Mapped[int]
    address: Mapped[str] = mapped_column(String(42))
    kind: Mapped[str] = mapped_column(String(24))
    request_hash: Mapped[str] = mapped_column(String(64))
    transaction: Mapped[dict] = mapped_column(JSON)
    summary: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    tx_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default='prepared')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class IntentInput(Input):
    request_id: uuid.UUID
    wallet_id: uuid.UUID


class FundingInput(IntentInput):
    amount: str = Field(pattern=r'^(0|[1-9][0-9]{0,9})(\.[0-9]{1,18})?$')


class BatchInput(IntentInput):
    token_amount_per_point: str = Field(pattern=r'^(0|[1-9][0-9]{0,9})(\.[0-9]{1,18})?$')


class SubmitInput(Input):
    tx_hash: str = Field(pattern=r'^0x[0-9a-fA-F]{64}$')


def units(value: str):
    amount = int(Decimal(value) * 10**18)
    if amount <= 0 or amount > MAX_TOKEN_UNITS:
        raise HTTPException(422, 'Choose an amount greater than zero and no more than one billion testnet tokens')
    return amount


def tokens(value):
    value = int(value)
    integer, fraction = divmod(value, 10**18)
    return str(integer) + ('.' + f'{fraction:018d}'.rstrip('0') if fraction else '')


def batch_domain(issuer: str, request_id: str):
    """Owner-bound IDs stop another creator from squatting a visible publication."""
    return '0x' + bytes.fromhex(issuer[2:]).hex() + Web3.keccak(text=request_id)[:12].hex()


def reward_leaf(batch_id: str, recipient: str, amount: int):
    from eth_abi import encode
    return bytes(Web3.keccak(Web3.keccak(encode(['bytes32', 'address', 'uint256'], [bytes.fromhex(batch_id[2:]), recipient, amount]))))


def merkle_tree(leaves: list[bytes]):
    """Sorted hash pairs; an unpaired node is promoted, never replaced by a fake leaf."""
    if not leaves:
        raise HTTPException(409, 'No eligible verified-wallet points are available for allocation')
    nodes = [(leaf, [index]) for index, leaf in enumerate(leaves)]
    proofs: list[list[str]] = [[] for _ in leaves]
    while len(nodes) > 1:
        next_level = []
        for index in range(0, len(nodes), 2):
            if index + 1 == len(nodes):
                next_level.append(nodes[index])
                continue
            left, right = nodes[index], nodes[index + 1]
            for original in left[1]:
                proofs[original].append(Web3.to_hex(right[0]))
            for original in right[1]:
                proofs[original].append(Web3.to_hex(left[0]))
            next_level.append((bytes(Web3.keccak(b''.join(sorted([left[0], right[0]])))), left[1] + right[1]))
        nodes = next_level
    return Web3.to_hex(nodes[0][0]), proofs


def allocated_points(session: Session, user_id: int, program_id: str):
    return int(session.scalar(select(func.coalesce(func.sum(RewardAllocation.points), 0)).join(RewardBatch,
        RewardBatch.id == RewardAllocation.batch_id).where(RewardAllocation.owner_id == user_id,
        RewardBatch.program_id == str(program_id), RewardBatch.status != 'cancelled')))


def allocation_json(row: RewardAllocation):
    return {'id': row.id, 'recipient': row.recipient, 'points': row.points, 'amount_tokens': tokens(row.amount), 'status': row.status}


def batch_json(session: Session, row: RewardBatch):
    allocations = session.scalars(select(RewardAllocation).where(RewardAllocation.batch_id == row.id).order_by(RewardAllocation.recipient)).all()
    return {'id': row.id, 'program_id': row.program_id, 'program_name': row.program_name, 'status': row.status,
            'chain_id': row.chain_id, 'token_address': row.token_address, 'symbol': row.symbol,
            'total_token_amount': tokens(row.total_amount), 'participant_count': len(allocations),
            'allocations': [allocation_json(allocation) for allocation in allocations], 'created_at': iso(row.created_at),
            'notice': 'After preparing publication, these allocations are irrevocable. Testnet tokens have no cash value.'}


def intent_json(row: RewardTransaction):
    return {'id': row.id, 'kind': row.kind, 'chain_id': row.chain_id, 'transaction': row.transaction,
            'summary': row.summary, 'status': row.status, 'tx_hash': row.tx_hash, 'result': row.result, 'created_at': iso(row.created_at)}


def _wallet(session: Session, wallet_id, user: User):
    wallet = session.get(WalletLink, str(wallet_id))
    if wallet is None or wallet.owner_id != user.id:
        raise HTTPException(404, 'Verified wallet not found')
    svc.chain_info(wallet.chain_id)
    return wallet


def _issuer_wallet(session: Session, program: RewardProgram, wallet_id, user: User):
    wallet = _wallet(session, wallet_id, user)
    if not program.token or not program.issuer_address or not program.token_address:
        raise HTTPException(409, 'Link a confirmed creator testnet token before funding or allocating rewards')
    if wallet.chain_id != program.chain_id or wallet.address.lower() != program.issuer_address.lower():
        raise HTTPException(409, 'Use the verified wallet that created this program token on its original test network')
    return wallet


def _previous(session: Session, request_id, digest, user: User):
    row = session.get(RewardTransaction, str(request_id))
    if row:
        if row.owner_id != user.id:
            raise HTTPException(404, 'Reward transaction not found')
        if row.request_hash != digest:
            raise HTTPException(409, 'Request ID already used with different transaction details')
        return row
    if session.get(TransactionIntent, str(request_id)):
        raise HTTPException(409, 'Request ID already belongs to another transaction')
    return None


def _digest(data, **scope):
    return svc.canonical({**data.model_dump(mode='json'), **scope})[1]


def _rpc_action(callback):
    try:
        return callback()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, 'Testnet verification or simulation failed. No transaction was signed or sent.') from exc


def _contracts(wallet, token_address):
    w3 = svc.rpc(wallet.chain_id)
    rewards = svc.contract(w3, wallet.chain_id, 'rewards')
    token = token_contract(w3, wallet.chain_id, token_address)
    if token.functions.decimals().call() != 18:
        raise HTTPException(422, 'Only fixed-supply Ziipa tokens with 18 decimals are supported')
    return w3, rewards, token


def _prepare_tx(session, data, digest, wallet, kind, contract, function, w3, summary,
                program_id=None, batch_id=None, allocation_id=None):
    tx = {'from': wallet.address, 'to': contract.address, 'data': function._encode_transaction_data(),
          'value': '0x0', 'chainId': hex(wallet.chain_id)}
    estimate = w3.eth.estimate_gas({**tx, 'chainId': wallet.chain_id, 'value': 0})
    tx['gas'] = hex(estimate * 120 // 100)
    summary = {'network': svc.chain_info(wallet.chain_id)['name'], 'sender': wallet.address,
               'testnet_only': True, 'estimated_fee_wei': str(estimate * w3.eth.gas_price), **summary}
    row = RewardTransaction(id=str(data.request_id), owner_id=wallet.owner_id, chain_id=wallet.chain_id,
        address=wallet.address, kind=kind, request_hash=digest, transaction=tx, summary=summary,
        program_id=program_id, batch_id=batch_id, allocation_id=allocation_id)
    session.add(row)
    session.flush()
    return row


@router.get('/programs/{program_id}/pool')
def pool(program_id: uuid.UUID, wallet_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    program = owned_program(session, program_id, user)
    wallet = _issuer_wallet(session, program, wallet_id, user)
    def read():
        _, rewards, token = _contracts(wallet, program.token_address)
        available = rewards.functions.poolCredits(wallet.address, token.address).call()
        reserved = rewards.functions.reservedCredits(wallet.address, token.address).call()
        return {'program_id': program.id, 'chain_id': wallet.chain_id, 'token_address': token.address, 'symbol': program.token.get('symbol', ''),
                'available_token_amount': tokens(available), 'reserved_token_amount': tokens(reserved),
                'source': 'Verified testnet contract read; points and wallet balances are separate.'}
    return _rpc_action(read)


@router.post('/programs/{program_id}/fund', dependencies=[Depends(guard)])
def fund(program_id: uuid.UUID, data: FundingInput, user: User = Depends(current_user), session: Session = Depends(db)):
    lock_user(session, user)
    digest = _digest(data, program_id=str(program_id), action='fund')
    previous = _previous(session, data.request_id, digest, user)
    if previous:
        return intent_json(previous)
    program = owned_program(session, program_id, user)
    wallet = _issuer_wallet(session, program, data.wallet_id, user)
    amount = units(data.amount)
    def prepare():
        w3, rewards, token = _contracts(wallet, program.token_address)
        if token.functions.balanceOf(wallet.address).call() < amount:
            raise HTTPException(409, 'The creator wallet does not hold enough tokens to fund this amount')
        allowance = token.functions.allowance(wallet.address, rewards.address).call()
        summary = {'program_id': program.id, 'name': program.name, 'symbol': program.token.get('symbol', ''),
                   'token_address': token.address, 'amount': tokens(amount), 'amount_units': str(amount), 'pool_contract': rewards.address}
        if allowance < amount:
            summary['next_step'] = 'Confirm this exact token allowance, then prepare funding again with a new request ID.'
            return _prepare_tx(session, data, digest, wallet, 'reward_approve', token,
                token.functions.approve(rewards.address, amount), w3, summary, program_id=program.id)
        return _prepare_tx(session, data, digest, wallet, 'reward_deposit', rewards,
            rewards.functions.deposit(token.address, amount), w3, summary, program_id=program.id)
    row = _rpc_action(prepare)
    session.commit()
    return intent_json(row)


@router.post('/programs/{program_id}/withdraw', dependencies=[Depends(guard)])
def withdraw(program_id: uuid.UUID, data: FundingInput, user: User = Depends(current_user), session: Session = Depends(db)):
    lock_user(session, user)
    digest = _digest(data, program_id=str(program_id), action='withdraw')
    previous = _previous(session, data.request_id, digest, user)
    if previous:
        return intent_json(previous)
    program = owned_program(session, program_id, user)
    wallet = _issuer_wallet(session, program, data.wallet_id, user)
    amount = units(data.amount)
    def prepare():
        w3, rewards, token = _contracts(wallet, program.token_address)
        if rewards.functions.poolCredits(wallet.address, token.address).call() < amount:
            raise HTTPException(409, 'Only unreserved creator pool funds can be withdrawn; promised batch rewards remain locked')
        return _prepare_tx(session, data, digest, wallet, 'reward_withdraw', rewards,
            rewards.functions.withdraw(token.address, amount), w3,
            {'program_id': program.id, 'name': program.name, 'symbol': program.token.get('symbol', ''),
             'token_address': token.address, 'amount': tokens(amount), 'amount_units': str(amount),
             'recipient': wallet.address, 'notice': 'Withdraws only unreserved funds back to the creator wallet. Published rewards remain protected.'},
            program_id=program.id)
    row = _rpc_action(prepare)
    session.commit()
    return intent_json(row)


def _eligible_participants(session: Session, program: RewardProgram):
    # SQL bounds only currently positive, unallocated balances. No fixed prefix
    # of historical earners can starve later users once earlier ones are settled.
    net = select(RewardLedger.owner_id.label('owner_id'), func.sum(RewardLedger.points).label('points')).where(
        RewardLedger.program_key == program.id).group_by(RewardLedger.owner_id).subquery()
    allocated = select(RewardAllocation.owner_id.label('owner_id'), func.sum(RewardAllocation.points).label('points')).join(
        RewardBatch, RewardBatch.id == RewardAllocation.batch_id).where(RewardBatch.program_id == program.id,
        RewardBatch.status != 'cancelled').group_by(RewardAllocation.owner_id).subquery()
    users = session.scalars(select(net.c.owner_id).outerjoin(allocated, allocated.c.owner_id == net.c.owner_id).where(
        net.c.points - func.coalesce(allocated.c.points, 0) > 0,
        net.c.owner_id.in_(select(WalletLink.owner_id).where(WalletLink.chain_id == program.chain_id)))
        .order_by(net.c.owner_id).limit(MAX_PARTICIPANTS)).all()
    participants = []
    for user_id in users:
        # The creator already holds the global rewards lock. Never wait on a
        # beneficiary account whose concurrent mutation may be waiting for it.
        query = select(User).where(User.id == user_id)
        if session.get_bind().dialect.name == 'postgresql':
            query = query.with_for_update(skip_locked=True)
        actor = session.scalar(query)
        if actor is None:
            continue
        reconcile_rewards(session, actor)
        points = max(0, net_points_for_program(session, user_id, program.id) - allocated_points(session, user_id, program.id))
        wallet = session.scalar(select(WalletLink).where(WalletLink.owner_id == user_id,
            WalletLink.chain_id == program.chain_id).order_by(WalletLink.verified_at, WalletLink.id))
        if points and wallet:
            participants.append((user_id, svc.address(wallet.address), points))
    return participants


@router.post('/programs/{program_id}/batches', status_code=201, dependencies=[Depends(guard)])
def create_batch(program_id: uuid.UUID, data: BatchInput, user: User = Depends(current_user), session: Session = Depends(db)):
    lock_user(session, user)
    digest = _digest(data, program_id=str(program_id), action='batch')
    existing = session.get(RewardBatch, str(data.request_id))
    if existing:
        if existing.owner_id != user.id:
            raise HTTPException(404, 'Reward batch not found')
        if existing.request_hash != digest:
            raise HTTPException(409, 'Request ID already used with different allocation details')
        return batch_json(session, existing)
    program = owned_program(session, program_id, user)
    wallet = _issuer_wallet(session, program, data.wallet_id, user)
    rate = units(data.token_amount_per_point)
    if session.scalar(select(RewardBatch.id).where(RewardBatch.program_id == program.id,
        RewardBatch.status.in_(['draft', 'awaiting_publish']))):
        raise HTTPException(409, 'Finish or cancel the existing draft before creating another snapshot')
    if session.scalar(select(func.count()).select_from(RewardBatch).where(RewardBatch.owner_id == user.id)) >= MAX_BATCHES:
        raise HTTPException(409, 'Creator batch history limit reached')
    participants = _eligible_participants(session, program)
    domain = batch_domain(wallet.address, str(data.request_id))
    total = sum(points * rate for _, _, points in participants)
    if total > MAX_TOKEN_UNITS:
        raise HTTPException(422, 'The snapshot exceeds one billion testnet tokens; choose a smaller conversion rate')
    root, proofs = merkle_tree([reward_leaf(domain, recipient, points * rate) for _, recipient, points in participants])
    row = RewardBatch(id=str(data.request_id), owner_id=user.id, program_id=program.id, program_name=program.name,
        request_hash=digest, chain_id=wallet.chain_id, token_address=svc.address(program.token_address),
        issuer_address=wallet.address, symbol=program.token.get('symbol', ''), batch_id=domain, merkle_root=root,
        amount_per_point=str(rate), total_amount=str(total), status='draft')
    session.add(row)
    session.flush()
    for (owner_id, recipient, points), proof in zip(participants, proofs):
        session.add(RewardAllocation(batch_id=row.id, owner_id=owner_id, recipient=recipient, points=points, amount=str(points * rate), proof=proof))
    session.commit()
    return batch_json(session, row)


@router.get('/batches')
def batches(user: User = Depends(current_user), session: Session = Depends(db)):
    return [batch_json(session, row) for row in session.scalars(select(RewardBatch).where(
        RewardBatch.owner_id == user.id).order_by(RewardBatch.created_at.desc()).limit(MAX_BATCHES)).all()]


def _owned_batch(session, batch_id, user):
    row = session.get(RewardBatch, str(batch_id))
    if row is None or row.owner_id != user.id:
        raise HTTPException(404, 'Reward batch not found')
    return row


@router.post('/batches/{batch_id}/cancel', dependencies=[Depends(guard)])
def cancel_batch(batch_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    lock_user(session, user)
    row = _owned_batch(session, batch_id, user)
    if row.status != 'draft':
        raise HTTPException(409, 'A prepared or published batch cannot be cancelled, even if its transaction has not been submitted')
    row.status = 'cancelled'
    session.commit()
    return batch_json(session, row)


def _check_draft_eligibility(session, batch: RewardBatch):
    if batch.program_id is None:
        raise HTTPException(409, 'The creator program no longer exists')
    for allocation in session.scalars(select(RewardAllocation).where(RewardAllocation.batch_id == batch.id)).all():
        query = select(User).where(User.id == allocation.owner_id)
        if session.get_bind().dialect.name == 'postgresql':
            query = query.with_for_update(skip_locked=True)
        actor = session.scalar(query) if allocation.owner_id is not None else None
        if actor is None:
            raise HTTPException(409, 'An allocated account was removed or is busy; retry, or cancel and rebuild the draft')
        reconcile_rewards(session, actor)
        # Includes this draft and all prior snapshots. Reversals invalidate only
        # unsealed drafts; already promised published tokens cannot be clawed back.
        if net_points_for_program(session, actor.id, batch.program_id) < allocated_points(session, actor.id, batch.program_id):
            raise HTTPException(409, 'Eligible points changed; cancel and rebuild this draft before publishing')
        if not session.scalar(select(WalletLink.id).where(WalletLink.owner_id == actor.id,
            WalletLink.chain_id == batch.chain_id, func.lower(WalletLink.address) == allocation.recipient.lower())):
            raise HTTPException(409, 'An allocated wallet was unlinked; cancel and rebuild this draft')


@router.post('/batches/{batch_id}/publish', dependencies=[Depends(guard)])
def publish_batch(batch_id: uuid.UUID, data: IntentInput, user: User = Depends(current_user), session: Session = Depends(db)):
    lock_user(session, user)
    digest = _digest(data, batch_id=str(batch_id), action='publish')
    previous = _previous(session, data.request_id, digest, user)
    if previous:
        return intent_json(previous)
    batch = _owned_batch(session, batch_id, user)
    prior_publication = session.scalar(select(RewardTransaction).where(RewardTransaction.batch_id == batch.id,
        RewardTransaction.kind == 'reward_publish').order_by(RewardTransaction.created_at.desc()))
    sealed_retry = batch.status == 'awaiting_publish' and prior_publication is not None and prior_publication.status == 'reverted'
    if batch.status != 'draft' and not sealed_retry:
        raise HTTPException(409, 'This batch already has a publication intent; resume that existing transaction')
    program = owned_program(session, batch.program_id, user)
    wallet = _issuer_wallet(session, program, data.wallet_id, user)
    if not sealed_retry:
        _check_draft_eligibility(session, batch)
    def prepare():
        w3, rewards, token = _contracts(wallet, batch.token_address)
        if rewards.functions.poolCredits(wallet.address, token.address).call() < int(batch.total_amount):
            raise HTTPException(409, 'Fund and confirm enough unreserved tokens in the creator pool before publishing')
        if token.functions.balanceOf(rewards.address).call() < rewards.functions.totalAccounted(token.address).call():
            raise HTTPException(409, 'Token pool balance does not cover its reservations')
        summary = {'program_id': batch.program_id, 'name': batch.program_name, 'symbol': batch.symbol,
            'token_address': batch.token_address, 'batch_id': batch.id, 'batch_domain': batch.batch_id,
            'root': batch.merkle_root, 'amount': tokens(batch.total_amount), 'amount_units': batch.total_amount,
            'notice': 'Signing publication permanently reserves these rewards. This snapshot cannot be cancelled after preparation.'}
        return _prepare_tx(session, data, digest, wallet, 'reward_publish', rewards,
            rewards.functions.publishBatch(batch.batch_id, token.address, batch.merkle_root, int(batch.total_amount)),
            w3, summary, program_id=batch.program_id, batch_id=batch.id)
    row = _rpc_action(prepare)
    batch.status = 'awaiting_publish'
    session.commit()
    return intent_json(row)


def _claim_query(session, user):
    # Removed-account public proofs can be recovered only by actual verified
    # control of their originally allocated chain/address, never an input address.
    wallets = session.scalars(select(WalletLink).where(WalletLink.owner_id == user.id)).all()
    removed_matches = [((RewardAllocation.owner_id.is_(None)) & (RewardBatch.chain_id == wallet.chain_id)
        & (func.lower(RewardAllocation.recipient) == wallet.address.lower())) for wallet in wallets]
    ownership = or_(RewardAllocation.owner_id == user.id, *removed_matches)
    return select(RewardAllocation, RewardBatch).join(RewardBatch, RewardBatch.id == RewardAllocation.batch_id).where(
        ownership, RewardBatch.status.in_(['published', 'awaiting_publish']))


@router.get('/claims')
def claims(user: User = Depends(current_user), session: Session = Depends(db)):
    lock_user(session, user)
    pairs = session.execute(_claim_query(session, user).order_by(RewardBatch.created_at.desc()).limit(100)).all()
    # A sealed publisher may remove their account and later broadcast an already
    # prepared transaction. Recover readiness from the exact public root without
    # needing their deleted private transaction history. Bound free RPC reads.
    checked = set()
    for _, batch in pairs:
        if batch.status != 'awaiting_publish' or batch.id in checked or len(checked) >= 5:
            continue
        checked.add(batch.id)
        try:
            w3 = svc.rpc(batch.chain_id)
            rewards = svc.contract(w3, batch.chain_id, 'rewards')
            _check_chain_batch(rewards, batch)
            batch.status = 'published'
        except Exception:
            # Unverified roots remain visibly pending; never fabricate readiness
            # when an RPC is unavailable or a different root was published.
            continue
    session.commit()
    return [{**allocation_json(allocation), 'batch_id': batch.id, 'program_name': batch.program_name,
             'chain_id': batch.chain_id, 'token_address': batch.token_address, 'symbol': batch.symbol,
             'status': 'claimed' if allocation.status == 'claimed' else ('ready' if batch.status == 'published' else 'awaiting_publish')}
            for allocation, batch in pairs]


def _check_chain_batch(rewards, batch):
    actual = rewards.functions.batches(batch.batch_id).call()
    if (str(actual[0]).lower() != batch.issuer_address.lower() or str(actual[1]).lower() != batch.token_address.lower()
            or Web3.to_hex(actual[2]).lower() != batch.merkle_root.lower() or int(actual[3]) != int(batch.total_amount)):
        raise HTTPException(409, 'The exact creator-approved reward root has not been verified on this test network')
    return actual


@router.post('/claims/{allocation_id}/prepare', dependencies=[Depends(guard)])
def prepare_claim(allocation_id: uuid.UUID, data: IntentInput, user: User = Depends(current_user), session: Session = Depends(db)):
    lock_user(session, user)
    digest = _digest(data, allocation_id=str(allocation_id), action='claim')
    previous = _previous(session, data.request_id, digest, user)
    if previous:
        return intent_json(previous)
    pair = session.execute(_claim_query(session, user).where(RewardAllocation.id == str(allocation_id))).first()
    if pair is None:
        raise HTTPException(404, 'Reward allocation not found')
    allocation, batch = pair
    wallet = _wallet(session, data.wallet_id, user)
    if wallet.chain_id != batch.chain_id or wallet.address.lower() != allocation.recipient.lower():
        raise HTTPException(409, 'Sign using the verified recipient wallet on this allocation’s test network')
    def prepare():
        w3, rewards, _ = _contracts(wallet, batch.token_address)
        _check_chain_batch(rewards, batch)
        if rewards.functions.claimed(batch.batch_id, wallet.address).call():
            allocation.status = 'claimed'
            batch.status = 'published'
            session.commit()
            raise HTTPException(409, 'This allocation is already claimed on the test network')
        if allocation.status == 'claimed':
            raise HTTPException(409, 'This allocation is already recorded as claimed')
        row = _prepare_tx(session, data, digest, wallet, 'reward_claim', rewards,
            rewards.functions.claim(batch.batch_id, int(allocation.amount), allocation.proof), w3,
            {'program_id': batch.program_id, 'name': batch.program_name, 'symbol': batch.symbol,
             'token_address': batch.token_address, 'batch_id': batch.id, 'batch_domain': batch.batch_id,
             'recipient': allocation.recipient, 'points': allocation.points, 'amount': tokens(allocation.amount), 'amount_units': allocation.amount},
            program_id=batch.program_id, batch_id=batch.id, allocation_id=allocation.id)
        batch.status = 'published'
        return row
    row = _rpc_action(prepare)
    session.commit()
    return intent_json(row)


def _event(receipt, contract, name):
    events = [event for event in getattr(contract.events, name)().process_receipt(receipt, errors=DISCARD)
              if event['address'].lower() == contract.address.lower()]
    if len(events) != 1:
        raise HTTPException(422, 'The exact expected testnet reward event was not found; no reward was credited')
    return events[0]['args']


def _reconcile(session, row, w3, tx_hash):
    tx = w3.eth.get_transaction(tx_hash)
    expected = row.transaction
    if (tx['from'].lower() != expected['from'].lower() or (tx['to'] or '').lower() != expected['to'].lower()
            or int(tx['value']) != 0 or Web3.to_hex(tx['input']).lower() != expected['data'].lower()
            or int(tx.get('chainId', row.chain_id)) != row.chain_id):
        raise HTTPException(422, 'Transaction does not exactly match the prepared reward request; it was not recorded')
    # A hash is reserved only after its actual transaction has passed all checks.
    status, result = 'pending', {}
    receipt = None
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except TransactionNotFound:
        pass
    if receipt is not None:
        block = w3.eth.get_block(receipt['blockNumber'])
        if block['hash'] == receipt['blockHash']:
            confirmations = max(0, w3.eth.block_number - receipt['blockNumber'] + 1)
            result = {'confirmations': confirmations, 'block_number': receipt['blockNumber']}
            if confirmations >= svc.chain_info(row.chain_id)['confirmations']:
                if receipt['status'] != 1:
                    status = 'reverted'
                else:
                    rewards = svc.contract(w3, row.chain_id, 'rewards')
                    amount = int(row.summary['amount_units'])
                    if row.kind == 'reward_approve':
                        token = token_contract(w3, row.chain_id, row.summary['token_address'])
                        event = _event(receipt, token, 'Approval')
                        if (event['owner'].lower() != row.address.lower() or event['spender'].lower() != rewards.address.lower()
                                or int(event['value']) != amount):
                            raise HTTPException(422, 'Token allowance event did not match the reviewed approval')
                    elif row.kind == 'reward_deposit':
                        event = _event(receipt, rewards, 'Deposited')
                        if (event['owner'].lower() != row.address.lower() or event['token'].lower() != row.summary['token_address'].lower()
                                or int(event['amount']) != amount):
                            raise HTTPException(422, 'Pool funding event did not match the reviewed deposit')
                    elif row.kind == 'reward_withdraw':
                        event = _event(receipt, rewards, 'Withdrawn')
                        if (event['owner'].lower() != row.address.lower() or event['token'].lower() != row.summary['token_address'].lower()
                                or int(event['amount']) != amount):
                            raise HTTPException(422, 'Pool withdrawal event did not match the creator’s reviewed unreserved amount')
                    elif row.kind == 'reward_publish':
                        event = _event(receipt, rewards, 'BatchPublished')
                        batch = session.get(RewardBatch, row.batch_id)
                        if batch is None or (Web3.to_hex(event['batchId']).lower() != batch.batch_id.lower()
                                or event['owner'].lower() != batch.issuer_address.lower() or event['token'].lower() != batch.token_address.lower()
                                or Web3.to_hex(event['root']).lower() != batch.merkle_root.lower() or int(event['totalAmount']) != int(batch.total_amount)):
                            raise HTTPException(422, 'Published reward root or funding total did not match this snapshot')
                        batch.status = 'published'
                    elif row.kind == 'reward_claim':
                        event = _event(receipt, rewards, 'Claimed')
                        allocation = session.get(RewardAllocation, row.allocation_id)
                        batch = session.get(RewardBatch, row.batch_id)
                        if allocation is None or batch is None or (Web3.to_hex(event['batchId']).lower() != batch.batch_id.lower()
                                or event['recipient'].lower() != allocation.recipient.lower() or int(event['amount']) != int(allocation.amount)):
                            raise HTTPException(422, 'Claim event did not match the verified recipient allocation')
                        allocation.status = 'claimed'
                    else:
                        raise HTTPException(422, 'Unsupported reward transaction type')
                    status = 'confirmed'
    row.tx_hash, row.status, row.result = tx_hash.lower(), status, result


@router.post('/settlement/intents/{intent_id}/submit', dependencies=[Depends(guard)])
def submit(intent_id: uuid.UUID, data: SubmitInput, user: User = Depends(current_user), session: Session = Depends(db)):
    lock_user(session, user)
    row = session.get(RewardTransaction, str(intent_id))
    if row is None or row.owner_id != user.id:
        raise HTTPException(404, 'Reward transaction not found')
    if row.tx_hash and row.tx_hash.lower() != data.tx_hash.lower():
        raise HTTPException(409, 'This request already tracks another transaction; refresh its existing hash')
    for model in (RewardTransaction, TransactionIntent):
        other = session.scalar(select(model).where(model.chain_id == row.chain_id, model.tx_hash == data.tx_hash.lower()))
        if other is not None and (model is TransactionIntent or other.id != row.id):
            raise HTTPException(409, 'This transaction is already tracked')
    try:
        _reconcile(session, row, svc.rpc(row.chain_id), data.tx_hash)
    except TransactionNotFound as exc:
        raise HTTPException(409, 'The transaction is not visible yet; retry the same hash. No hash or reward was recorded.') from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, 'Could not verify this testnet transaction; keep the hash and retry without signing again') from exc
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(409, 'The transaction hash is already tracked') from exc
    return intent_json(row)


@router.get('/settlement/intents')
def intents(user: User = Depends(current_user), session: Session = Depends(db)):
    return [intent_json(row) for row in session.scalars(select(RewardTransaction).where(
        RewardTransaction.owner_id == user.id).order_by(RewardTransaction.created_at.desc()).limit(100)).all()]


def export_settlement_data(session: Session, user_id: int):
    user = session.get(User, user_id)
    allocations = session.execute(select(RewardAllocation, RewardBatch).join(RewardBatch,
        RewardBatch.id == RewardAllocation.batch_id).where(RewardAllocation.owner_id == user_id)).all()
    if user is not None:
        allocations += session.execute(_claim_query(session, user).where(RewardAllocation.owner_id.is_(None))).all()
    return {'batches': [batch_json(session, row) for row in session.scalars(select(RewardBatch).where(RewardBatch.owner_id == user_id)).all()],
            'allocations': [{**allocation_json(allocation), 'batch_id': batch.id, 'chain_id': batch.chain_id,
                'token_address': batch.token_address, 'proof': allocation.proof} for allocation, batch in allocations],
            'transactions': [intent_json(row) for row in session.scalars(select(RewardTransaction).where(RewardTransaction.owner_id == user_id)).all()]}


def delete_settlement_data(session: Session, user_id: int):
    """Remove private account links, retain only irrevocable public-chain proofs; no commit."""
    session.execute(delete(RewardTransaction).where(RewardTransaction.owner_id == user_id))
    for batch in session.scalars(select(RewardBatch).where(RewardBatch.owner_id == user_id)).all():
        if batch.status in ('draft', 'cancelled'):
            session.execute(delete(RewardAllocation).where(RewardAllocation.batch_id == batch.id))
            session.delete(batch)
        else:
            batch.owner_id, batch.program_id, batch.program_name = None, None, 'Removed creator program'
            batch.request_hash = ''
            batch.amount_per_point = '0'
            for transaction in session.scalars(select(RewardTransaction).where(RewardTransaction.batch_id == batch.id)).all():
                transaction.program_id = None
                transaction.summary = {**transaction.summary, 'name': 'Removed creator program', 'program_id': None}
            for allocation in session.scalars(select(RewardAllocation).where(RewardAllocation.batch_id == batch.id)).all():
                allocation.owner_id, allocation.points = None, 0
    # A deleted recipient's unsealed private draft may be rebuilt by its creator;
    # sealed public proofs retain only their already-public recipient address.
    for allocation in session.scalars(select(RewardAllocation).where(RewardAllocation.owner_id == user_id)).all():
        batch = session.get(RewardBatch, allocation.batch_id)
        if batch is not None and batch.status in ('draft', 'cancelled'):
            batch.status = 'cancelled'
            session.delete(allocation)
        else:
            allocation.owner_id = None
            allocation.points = 0
    session.flush()
