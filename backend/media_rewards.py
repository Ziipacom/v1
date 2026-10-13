"""Finite noncash rewards for persisted media interactions, never client-asserted views.

Helpers participate in the caller's transaction. A permanent interaction marker
prevents toggling likes/saves or repeating comments from farming points. Token
links describe confirmed testnet creation receipts; points are not token balances.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, case, delete, func, select, text
from sqlalchemy.orm import Mapped, Session, mapped_column
from web3 import Web3

from app import Base, User, current_user, db, guard
from creator import CreatorComment, CreatorItem, CreatorMedia, CreatorPreferences, account_allows_view
from web3_api import TransactionIntent, WalletLink, wallet_json
import web3_services as svc

router = APIRouter(prefix='/api/rewards', dependencies=[Depends(current_user)])
PLATFORM_KEY = 'ziipa'
MAX_PROGRAMS = 10
MAX_OWNER_BUDGET = 200_000
LOCK_ID = 0x5A495250
COMMENT_MIN_CHARACTERS = 20
COMMENT_MIN_ALPHANUMERIC = 10


def now():
    return datetime.now(timezone.utc)


def iso(value):
    if value is None:
        return None
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value).isoformat()


class RewardSettings(BaseSettings):
    rewards_enabled: bool = True
    rewards_daily_points: int = Field(default=100, ge=0, le=1000)
    rewards_global_daily_points: int = Field(default=50_000, ge=0, le=1_000_000)
    rewards_platform_budget: int = Field(default=1_000_000, ge=0, le=10_000_000)
    rewards_like_points: int = Field(default=1, ge=0, le=20)
    rewards_save_points: int = Field(default=2, ge=0, le=20)
    rewards_comment_points: int = Field(default=3, ge=0, le=20)
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')


config = RewardSettings()


class RewardState(Base):
    __tablename__ = 'media_reward_state'
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    platform_points_issued: Mapped[int] = mapped_column(default=0)
    daily_day: Mapped[str] = mapped_column(String(10), default='')
    daily_points_issued: Mapped[int] = mapped_column(default=0)


class RewardProgram(Base):
    __tablename__ = 'media_reward_programs'
    __table_args__ = (UniqueConstraint('token_intent_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    name: Mapped[str] = mapped_column(String(100))
    request_hash: Mapped[str] = mapped_column(String(64))
    token_intent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    token: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    enabled: Mapped[bool] = mapped_column(default=False)
    point_budget: Mapped[int]
    points_issued: Mapped[int] = mapped_column(default=0)
    per_user_daily_cap: Mapped[int]
    rates: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    @property
    def token_address(self):
        return (self.token or {}).get('address')

    @property
    def chain_id(self):
        return (self.token or {}).get('chain_id')

    @property
    def issuer_address(self):
        return (self.token or {}).get('wallet_address')


class RewardInteraction(Base):
    __tablename__ = 'media_reward_interactions'
    __table_args__ = (UniqueConstraint('owner_id', 'item_id', 'kind'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    kind: Mapped[str] = mapped_column(String(12))
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class RewardLedger(Base):
    __tablename__ = 'media_reward_ledger'
    __table_args__ = (UniqueConstraint('reference_id', 'program_key', 'kind'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    program_id: Mapped[str | None] = mapped_column(ForeignKey('media_reward_programs.id', ondelete='SET NULL'), nullable=True, index=True)
    program_key: Mapped[str] = mapped_column(String(36), index=True)
    program_name: Mapped[str] = mapped_column(String(100))
    interaction_id: Mapped[str | None] = mapped_column(ForeignKey('media_reward_interactions.id', ondelete='CASCADE'), nullable=True, index=True)
    reference_id: Mapped[str] = mapped_column(String(36))
    kind: Mapped[str] = mapped_column(String(16))
    points: Mapped[int]
    interaction_kind: Mapped[str] = mapped_column(String(12), default='')
    item_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class ProgramFields(Input):
    name: str = Field(min_length=1, max_length=100, pattern=r'.*\S.*')
    enabled: bool = False
    point_budget: int = Field(default=5000, strict=True, ge=1, le=100_000)
    per_user_daily_cap: int = Field(default=25, strict=True, ge=1, le=100)
    like_points: int = Field(default=1, strict=True, ge=0, le=20)
    save_points: int = Field(default=2, strict=True, ge=0, le=20)
    comment_points: int = Field(default=3, strict=True, ge=0, le=20)

    @model_validator(mode='after')
    def finite_rates(self):
        rates = (self.like_points, self.save_points, self.comment_points)
        if not any(rates) or max(rates) > self.per_user_daily_cap:
            raise ValueError('Choose at least one rate within the per-user daily cap')
        return self


class ProgramInput(ProgramFields):
    request_id: uuid.UUID
    token_intent_id: uuid.UUID | None = None


class ProgramUpdate(ProgramFields):
    revision: int = Field(strict=True, ge=1)


def _lock(session: Session, user: User):
    # Same account-first order as account deletion; the global advisory lock
    # serializes cross-account finite budgets and unique interaction admission.
    # PostgreSQL NO KEY UPDATE still serializes account writes but permits the
    # FK KEY SHARE checks required by a creator's cross-account allocations.
    if not session.scalar(select(User.id).where(User.id == user.id).with_for_update(key_share=True)):
        raise HTTPException(404, 'Account no longer exists')
    if session.get_bind().dialect.name == 'postgresql':
        session.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': LOCK_ID})


def lock_user(session: Session, user: User):
    """Expose the shared lock order to interaction and redemption adapters."""
    _lock(session, user)


def _state(session: Session, moment=None):
    state = session.get(RewardState, PLATFORM_KEY)
    if state is None:
        state = RewardState(id=PLATFORM_KEY, platform_points_issued=0, daily_day='', daily_points_issued=0)
        session.add(state)
        session.flush()
    day = (moment or now()).date().isoformat()
    if state.daily_day != day:
        state.daily_day, state.daily_points_issued = day, 0
    return state


def program_json(row):
    return {'id': row.id, 'name': row.name, 'enabled': row.enabled, 'revision': row.revision,
            'point_budget': row.point_budget, 'points_issued': row.points_issued,
            'budget_remaining': max(0, row.point_budget - row.points_issued),
            'per_user_daily_cap': row.per_user_daily_cap, 'rates': row.rates,
            'token': row.token, 'created_at': iso(row.created_at), 'updated_at': iso(row.updated_at)}


def ledger_json(row):
    return {'id': row.id, 'kind': row.kind, 'points': row.points, 'interaction_kind': row.interaction_kind,
            'item_id': row.item_id, 'program_id': row.program_id, 'program_key': row.program_key,
            'program_name': row.program_name, 'created_at': iso(row.created_at)}


def owned_program(session: Session, program_id, user: User):
    row = session.get(RewardProgram, str(program_id))
    if row is None or row.owner_id != user.id:
        raise HTTPException(404, 'Reward program not found')
    return row


def confirmed_token(session: Session, intent_id, user: User):
    row = session.get(TransactionIntent, str(intent_id))
    if row is None or row.owner_id != user.id:
        raise HTTPException(404, 'Token creation receipt not found')
    if row.kind != 'create_token' or row.status != 'confirmed' or not row.tx_hash:
        raise HTTPException(409, 'Confirm your token creation transaction before linking rewards')
    token_address = row.result.get('token_address')
    if row.chain_id not in (31337, 84532, 11155111) or not Web3.is_address(token_address) or int(token_address, 16) == 0:
        raise HTTPException(409, 'No verified supported testnet token was returned')
    wallet = session.scalar(select(WalletLink).where(WalletLink.owner_id == user.id,
                         WalletLink.chain_id == row.chain_id, func.lower(WalletLink.address) == row.address.lower()))
    if wallet is None:
        raise HTTPException(409, 'Verify the token creator wallet before linking rewards')
    return {'intent_id': row.id, 'chain_id': row.chain_id, 'address': Web3.to_checksum_address(token_address),
            'symbol': row.summary.get('symbol', ''), 'name': row.summary.get('name', ''),
            'wallet_id': wallet.id, 'wallet_address': wallet.address}


@router.get('/config')
def configuration():
    networks = [{'chain_id': chain['id'], 'name': chain['name'],
                 'configured': bool(svc.registry(chain['id']).get('rewards'))} for chain in svc.chains()]
    return {'enabled': config.rewards_enabled, 'unit': 'Ziipa points', 'cash_value': None,
            'testnet_only': True, 'platform_rates': {'like': config.rewards_like_points,
                 'save': config.rewards_save_points, 'comment': config.rewards_comment_points},
            'per_user_daily_cap': config.rewards_daily_points,
            'global_daily_cap': config.rewards_global_daily_points,
            'platform_point_budget': config.rewards_platform_budget,
            'max_programs': MAX_PROGRAMS, 'max_owner_budget': MAX_OWNER_BUDGET,
            'comment_min_characters': COMMENT_MIN_CHARACTERS,
            'comment_min_alphanumeric': COMMENT_MIN_ALPHANUMERIC,
            'earning_rules': ['Only persisted likes, saves and meaningful comments on another creator’s published owned uploads qualify.',
                'A qualifying comment has at least 20 trimmed characters, including at least 10 letters or numbers. This is a basic quality threshold, not proof of a human interaction.',
                'Samples, your own posts, private or draft posts, views and unverified external interactions earn no points.',
                'Each account earns once per post and interaction type. Removing a like or save reverses its award; adding it again never earns a second award.',
                'Daily caps and lifetime program budgets count gross awards and are not replenished by reversals.',
                'Points have no cash value. A linked testnet token is separate from the points ledger.'],
            'redemption': {'available': False, 'scope': 'creator-funded testnet distributions',
                'points_conversion': False, 'requires_wallet_review': True,
                'infrastructure_available': any(network['configured'] for network in networks),
                'infrastructure_networks': networks,
                'infrastructure_source': 'Deployment registry; each transaction verifies the actual testnet contract separately.',
                'reason': 'Points have no automatic token or cash conversion. Separate creator-funded testnet distributions require verified wallets, reviewed publication and verified chain receipts.'}}


@router.get('/programs')
def programs(user: User = Depends(current_user), session: Session = Depends(db)):
    return [program_json(row) for row in session.scalars(select(RewardProgram).where(
        RewardProgram.owner_id == user.id).order_by(RewardProgram.created_at.desc())).all()]


@router.post('/programs', status_code=201, dependencies=[Depends(guard)])
def create_program(data: ProgramInput, user: User = Depends(current_user), session: Session = Depends(db)):
    _lock(session, user)
    digest = hashlib.sha256(json.dumps(data.model_dump(mode='json'), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    existing = session.get(RewardProgram, str(data.request_id))
    if existing is not None:
        if existing.owner_id != user.id:
            raise HTTPException(404, 'Reward program not found')
        if existing.request_hash != digest:
            raise HTTPException(409, 'Request ID already used with different program details')
        return program_json(existing)
    count, budget = session.execute(select(func.count(), func.coalesce(func.sum(RewardProgram.point_budget), 0)).where(
        RewardProgram.owner_id == user.id)).one()
    if count >= MAX_PROGRAMS or budget + data.point_budget > MAX_OWNER_BUDGET:
        raise HTTPException(409, 'Creator reward program count or total point budget limit reached')
    token = confirmed_token(session, data.token_intent_id, user) if data.token_intent_id else None
    if token and session.scalar(select(RewardProgram.id).where(RewardProgram.token_intent_id == token['intent_id'])):
        raise HTTPException(409, 'This token already has a reward program')
    row = RewardProgram(id=str(data.request_id), owner_id=user.id, name=data.name, request_hash=digest,
                        token_intent_id=token['intent_id'] if token else None, token=token,
                        enabled=data.enabled, point_budget=data.point_budget, points_issued=0,
                        per_user_daily_cap=data.per_user_daily_cap,
                        rates={'like': data.like_points, 'save': data.save_points, 'comment': data.comment_points})
    session.add(row)
    session.commit()
    return program_json(row)


@router.patch('/programs/{program_id}', dependencies=[Depends(guard)])
def update_program(program_id: uuid.UUID, data: ProgramUpdate, user: User = Depends(current_user), session: Session = Depends(db)):
    _lock(session, user)
    row = owned_program(session, program_id, user)
    if row.revision != data.revision:
        raise HTTPException(409, 'Reward program changed; reload before editing')
    if data.point_budget < row.points_issued:
        raise HTTPException(409, 'Point budget cannot be smaller than the gross points already issued')
    other_budget = session.scalar(select(func.coalesce(func.sum(RewardProgram.point_budget), 0)).where(
        RewardProgram.owner_id == user.id, RewardProgram.id != row.id))
    if other_budget + data.point_budget > MAX_OWNER_BUDGET:
        raise HTTPException(409, 'Total creator point budget limit reached')
    row.name, row.enabled, row.point_budget = data.name, data.enabled, data.point_budget
    row.per_user_daily_cap = data.per_user_daily_cap
    row.rates = {'like': data.like_points, 'save': data.save_points, 'comment': data.comment_points}
    row.revision, row.updated_at = row.revision + 1, now()
    session.commit()
    return program_json(row)


def _eligible(session: Session, user: User, item: CreatorItem | None, preferences: dict | None = None):
    if item is None or item.owner_id == user.id or item.visibility != 'published' or item.data.get('demo'):
        return False
    media = session.get(CreatorMedia, item.data.get('media_id')) if item.data.get('media_id') else None
    owner = session.get(User, item.owner_id)
    if media is None or media.owner_id != item.owner_id or owner is None or not account_allows_view(session, item.owner_id):
        return False
    actor_row = session.get(CreatorPreferences, user.id)
    prefs = preferences if preferences is not None else (actor_row.data if actor_row else {})
    creator_row = session.get(CreatorPreferences, item.owner_id)
    creator_prefs = creator_row.data if creator_row else {}
    return not (item.owner_id in prefs.get('blocked_user_ids', []) or owner.name in prefs.get('blocked_creators', [])
                or user.id in creator_prefs.get('blocked_user_ids', []) or user.name in creator_prefs.get('blocked_creators', []))


def _gross_daily(session: Session, owner_id: int, program_key: str | None = None, moment=None):
    day = (moment or now()).replace(hour=0, minute=0, second=0, microsecond=0)
    query = select(func.coalesce(func.sum(RewardLedger.points), 0)).where(
        RewardLedger.owner_id == owner_id, RewardLedger.kind == 'earned', RewardLedger.created_at >= day)
    if program_key is not None:
        query = query.where(RewardLedger.program_key == program_key)
    return int(session.scalar(query))


def _award(session: Session, user: User, item: CreatorItem, interaction: RewardInteraction):
    if not config.rewards_enabled:
        return
    moment = now()
    state = _state(session, moment)
    daily = _gross_daily(session, user.id, moment=moment)
    programs = session.scalars(select(RewardProgram).where(RewardProgram.owner_id == item.owner_id,
                             RewardProgram.enabled == True).order_by(RewardProgram.created_at, RewardProgram.id)).all()
    platform_rates = {'like': config.rewards_like_points, 'save': config.rewards_save_points, 'comment': config.rewards_comment_points}
    candidates = [(None, platform_rates.get(interaction.kind, 0)),
                  *[(program, program.rates.get(interaction.kind, 0)) for program in programs]]
    for program, points in candidates:
        if type(points) is not int or points <= 0:
            continue
        key = program.id if program else PLATFORM_KEY
        if daily + points > config.rewards_daily_points or state.daily_points_issued + points > config.rewards_global_daily_points:
            continue
        if program:
            if program.points_issued + points > program.point_budget or _gross_daily(session, user.id, key, moment) + points > program.per_user_daily_cap:
                continue
        elif state.platform_points_issued + points > config.rewards_platform_budget:
            continue
        session.add(RewardLedger(owner_id=user.id, program_id=program.id if program else None,
            program_key=key, program_name=program.name if program else 'Ziipa media rewards',
            interaction_id=interaction.id, reference_id=interaction.id, kind='earned', points=points,
            interaction_kind=interaction.kind, item_id=item.id, created_at=moment))
        if program:
            program.points_issued += points
        else:
            state.platform_points_issued += points
        state.daily_points_issued += points
        daily += points
        session.flush()


def _record_interaction(session: Session, user: User, item_id: str, kind: str, active: bool, preferences=None):
    marker = session.scalar(select(RewardInteraction).where(RewardInteraction.owner_id == user.id,
                            RewardInteraction.item_id == item_id, RewardInteraction.kind == kind))
    if marker is not None:
        if marker.active and not active:
            _reverse_interaction(session, marker)
        marker.active = active
        return
    if not active:
        return
    item = session.get(CreatorItem, item_id)
    if not _eligible(session, user, item, preferences):
        return
    marker = RewardInteraction(owner_id=user.id, item_id=item_id, kind=kind, active=True)
    session.add(marker)
    session.flush()
    _award(session, user, item, marker)


def _reverse_interaction(session: Session, marker: RewardInteraction):
    entries = session.scalars(select(RewardLedger).where(RewardLedger.interaction_id == marker.id,
                             RewardLedger.kind == 'earned')).all()
    for entry in entries:
        if not session.scalar(select(RewardLedger.id).where(RewardLedger.reference_id == marker.id,
            RewardLedger.program_key == entry.program_key, RewardLedger.kind == 'reversed')):
            session.add(RewardLedger(owner_id=marker.owner_id, program_id=entry.program_id,
                program_key=entry.program_key, program_name=entry.program_name, interaction_id=marker.id,
                reference_id=marker.id, kind='reversed', points=-entry.points,
                interaction_kind=marker.kind, item_id=marker.item_id))
    marker.active = False
    session.flush()


def reconcile_rewards(session: Session, user: User):
    """Invalidate awards no longer eligible. Caller holds the rewards lock."""
    markers = session.scalars(select(RewardInteraction).where(RewardInteraction.owner_id == user.id,
        RewardInteraction.active == True, RewardInteraction.id.in_(select(RewardLedger.interaction_id).where(
        RewardLedger.owner_id == user.id, RewardLedger.kind == 'earned')))).all()
    for marker in markers:
        source_exists = True
        if marker.kind == 'comment':
            bodies = session.scalars(select(CreatorComment.body).where(CreatorComment.owner_id == user.id,
                CreatorComment.item_id == marker.item_id, func.length(func.trim(CreatorComment.body)) >= COMMENT_MIN_CHARACTERS))
            source_exists = any(_comment_qualifies(body) for body in bodies)
        elif marker.kind in ('like', 'save'):
            prefs = session.get(CreatorPreferences, user.id)
            key = 'liked' if marker.kind == 'like' else 'saved'
            source_exists = prefs is not None and marker.item_id in (prefs.data or {}).get(key, [])
        if not source_exists or not _eligible(session, user, session.get(CreatorItem, marker.item_id)):
            _reverse_interaction(session, marker)


def invalidate_item_rewards(session: Session, item_id: str):
    """Moderation hook; caller holds the global lock. Busy accounts defer to read reconciliation."""
    markers = session.scalars(select(RewardInteraction).where(RewardInteraction.item_id == item_id,
                             RewardInteraction.active == True)).all()
    for marker in markers:
        # Never wait on a user deleting its account while that transaction
        # waits for our global lock. Own-wallet reconciliation does not skip.
        if not session.scalar(select(User.id).where(User.id == marker.owner_id).with_for_update(read=True, key_share=True, skip_locked=True)):
            continue
        _reverse_interaction(session, marker)


def net_points_for_program(session: Session, user_id: int, program_id: str):
    return int(session.scalar(select(func.coalesce(func.sum(RewardLedger.points), 0)).where(
        RewardLedger.owner_id == user_id, RewardLedger.program_key == str(program_id))))


def sync_preferences_rewards(session: Session, user: User, previous: dict, current: dict):
    """Call before the committed preference mutation. Never commits itself."""
    changes = []
    for key, kind in (('liked', 'like'), ('saved', 'save')):
        before, after = set(previous.get(key, [])), set(current.get(key, []))
        changes.extend((item_id, kind, False) for item_id in sorted(before - after))
        changes.extend((item_id, kind, True) for item_id in sorted(after - before))
    if not changes:
        return
    _lock(session, user)
    for item_id, kind, active in changes:
        _record_interaction(session, user, item_id, kind, active, current)


def award_comment_reward(session: Session, user: User, item: CreatorItem | None, comment: CreatorComment):
    """Only an actual pending/persisted comment row, no client event endpoint."""
    if (comment.owner_id != user.id or item is None or comment.item_id != item.id
            or not _comment_qualifies(comment.body)
            or comment not in session):
        return
    _lock(session, user)
    _record_interaction(session, user, item.id, 'comment', True)


def _comment_qualifies(body: str):
    return (len(body.strip()) >= COMMENT_MIN_CHARACTERS
            and sum(character.isalnum() for character in body) >= COMMENT_MIN_ALPHANUMERIC)


@router.get('/wallet')
def wallet(user: User = Depends(current_user), session: Session = Depends(db)):
    _lock(session, user)
    reconcile_rewards(session, user)
    session.commit()
    totals = session.execute(select(RewardLedger.program_key, RewardLedger.program_id,
        func.max(RewardLedger.program_name), func.sum(RewardLedger.points),
        func.sum(case((RewardLedger.kind == 'earned', RewardLedger.points), else_=0)),
        func.sum(case((RewardLedger.kind == 'reversed', -RewardLedger.points), else_=0))).where(
        RewardLedger.owner_id == user.id).group_by(RewardLedger.program_key, RewardLedger.program_id)).all()
    grouped = []
    for key, program_id, name, balance, earned, reversed_points in totals:
        program = session.get(RewardProgram, program_id) if program_id else None
        grouped.append({'program_id': program_id, 'program_key': key,
            'name': program.name if program else name,
            'balance': int(balance), 'earned_total': int(earned),
            'reversed_total': int(reversed_points),
            'token': program.token if program else None})
    history = session.scalars(select(RewardLedger).where(RewardLedger.owner_id == user.id).order_by(
        RewardLedger.created_at.desc(), RewardLedger.id).limit(100)).all()
    return {'unit': 'Ziipa points', 'cash_value': None, 'balance': sum(row['balance'] for row in grouped),
            'earned_total': sum(row['earned_total'] for row in grouped),
            'reversed_total': sum(row['reversed_total'] for row in grouped),
            'by_program': grouped, 'history': [ledger_json(row) for row in history],
            'wallets': [wallet_json(row) for row in session.scalars(select(WalletLink).where(WalletLink.owner_id == user.id)).all()],
            'redemption': configuration()['redemption']}


def export_rewards_data(session: Session, user_id: int):
    return {'programs': [program_json(row) for row in session.scalars(select(RewardProgram).where(RewardProgram.owner_id == user_id)).all()],
            'ledger': [ledger_json(row) for row in session.scalars(select(RewardLedger).where(RewardLedger.owner_id == user_id)).all()],
            'interactions': [{'item_id': row.item_id, 'kind': row.kind, 'active': row.active, 'created_at': iso(row.created_at)}
                             for row in session.scalars(select(RewardInteraction).where(RewardInteraction.owner_id == user_id)).all()]}


def delete_rewards_data(session: Session, user_id: int):
    user = session.get(User, user_id)
    if user is not None:
        _lock(session, user)
    # Keep other users' points receipts but detach a deleted creator's program.
    program_ids = session.scalars(select(RewardProgram.id).where(RewardProgram.owner_id == user_id)).all()
    if program_ids:
        from sqlalchemy import update
        session.execute(update(RewardLedger).where(RewardLedger.program_id.in_(program_ids)).values(
            program_id=None, program_name='Removed creator program'))
    session.execute(delete(RewardLedger).where(RewardLedger.owner_id == user_id))
    session.execute(delete(RewardInteraction).where(RewardInteraction.owner_id == user_id))
    session.execute(delete(RewardProgram).where(RewardProgram.owner_id == user_id))
