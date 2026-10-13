"""Opt-in, owner-scoped autonomous tasks with durable receipts and hard budgets.

Autonomy is limited to the owner's explicitly granted Ziipa tools. Public
publishing, wallets, account deletion and arbitrary code are never agent tools.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, cache, current_user, db, guard, settings
import assistant_api as assistant
import personal_media as media

router = APIRouter(prefix='/api/os/agent', dependencies=[Depends(current_user)])
TOOLS = {key: assistant.TOOLS[key] for key in (
    'library.search', 'insights.read', 'rewards.read', 'project.create', 'goal.create', 'render.create')}
READ_TOOLS = frozenset({'library.search', 'insights.read', 'rewards.read'})
ACTIVE = ('queued', 'running')
LEASE_SECONDS = 120
TASK_SECONDS = 900
MAX_RECOVERIES = 3


def now():
    return datetime.now(timezone.utc)


class AgentSettings(BaseSettings):
    enabled: bool = False
    poll_seconds: int = Field(default=60, ge=5, le=300)
    reconcile_seconds: int = Field(default=3600, ge=600, le=3600)
    global_queue_limit: int = Field(default=50, ge=1, le=100)
    model_config = SettingsConfigDict(env_prefix='OS_AGENT_', env_file='.env', extra='ignore')


config = AgentSettings()


class AgentPolicy(Base):
    __tablename__ = 'os_agent_policies'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    allowed_tools: Mapped[list] = mapped_column(JSON, default=list)
    max_steps: Mapped[int] = mapped_column(default=5)
    daily_task_limit: Mapped[int] = mapped_column(default=5)
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AgentTask(Base):
    __tablename__ = 'os_agent_tasks'
    __table_args__ = (UniqueConstraint('owner_id', 'request_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    request_id: Mapped[str] = mapped_column(String(36))
    request_hash: Mapped[str] = mapped_column(String(64))
    objective: Mapped[str] = mapped_column(String(3000))
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    render_item_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    render_snapshot: Mapped[str | None] = mapped_column(String(64), nullable=True)
    allowed_tools: Mapped[list] = mapped_column(JSON, default=list)
    max_steps: Mapped[int] = mapped_column(default=5)
    step_count: Mapped[int] = mapped_column(default=0)
    model_calls: Mapped[int] = mapped_column(default=0)
    recovery_attempts: Mapped[int] = mapped_column(default=0)
    status: Mapped[str] = mapped_column(String(20), default='queued', index=True)
    detail: Mapped[str] = mapped_column(String(2000), default='Waiting for the autonomous task worker.')
    revision: Mapped[int] = mapped_column(default=1)
    lease_token: Mapped[str] = mapped_column(String(64), default='')
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AgentStep(Base):
    __tablename__ = 'os_agent_steps'
    __table_args__ = (UniqueConstraint('task_id', 'position'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    task_id: Mapped[str] = mapped_column(ForeignKey('os_agent_tasks.id', ondelete='CASCADE'), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    position: Mapped[int]
    tool: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(160))
    arguments: Mapped[dict] = mapped_column(JSON, default=dict)
    action_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(20), default='prepared')
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class PolicyInput(Input):
    enabled: bool = False
    allowed_tools: list[str] = Field(default_factory=list, max_length=len(TOOLS))
    max_steps: int = Field(default=5, ge=1, le=10)
    daily_task_limit: int = Field(default=5, ge=1, le=20)
    revision: int = Field(ge=1)

    @field_validator('allowed_tools')
    @classmethod
    def allowed(cls, value):
        if len(set(value)) != len(value) or any(tool not in TOOLS for tool in value):
            raise ValueError('Choose supported Ziipa tools once each.')
        return value


class TaskInput(Input):
    request_id: uuid.UUID
    objective: str = Field(min_length=1, max_length=3000, pattern=r'.*\S.*')
    project_id: uuid.UUID | None = None
    render_item_id: uuid.UUID | None = None
    max_steps: int | None = Field(default=None, ge=1, le=10)


class RevisionInput(Input):
    revision: int = Field(ge=1)


class AgentPlan(Input):
    decision: Literal['done', 'action', 'blocked']
    detail: str = Field(min_length=1, max_length=1800)
    tool: Literal['library.search', 'insights.read', 'rewards.read', 'project.create', 'goal.create', 'render.create'] | None = None
    arguments: dict = Field(default_factory=dict)


def heartbeat_key():
    from media_workflows import coordination_scope
    return 'ziipa:os:agent-worker:' + coordination_scope()


def wake_key():
    from media_workflows import coordination_scope
    return 'ziipa:os:agent-wake:' + coordination_scope()


def notify():
    try:
        cache.set(wake_key(), str(uuid.uuid4()), ex=7200)
    except Exception:
        pass


def policy_json(row):
    return {'enabled': bool(row.enabled) if row else False, 'allowed_tools': list(row.allowed_tools) if row else [],
            'max_steps': row.max_steps if row else 5, 'daily_task_limit': row.daily_task_limit if row else 5,
            'revision': row.revision if row else 1, 'updated_at': media.iso(row.updated_at) if row else None}


def effective_tools(session, owner_id, task=None):
    row = session.get(AgentPolicy, owner_id, populate_existing=True)
    if not row or not row.enabled:
        return []
    allowed = set(row.allowed_tools) & set(assistant.permissions(session, owner_id)) & set(TOOLS)
    if task is not None:
        allowed &= set(task.allowed_tools)
        if not task.render_item_id:
            allowed.discard('render.create')
    return sorted(allowed)


def task_json(row):
    return {key: getattr(row, key) for key in ('id', 'objective', 'project_id', 'render_item_id', 'allowed_tools',
            'max_steps', 'step_count', 'model_calls', 'status', 'detail', 'revision')} | {
            'created_at': media.iso(row.created_at), 'updated_at': media.iso(row.updated_at),
            'started_at': media.iso(row.started_at), 'deadline': media.iso(row.deadline)}


def step_json(row):
    return {key: getattr(row, key) for key in ('id', 'position', 'tool', 'title', 'action_id', 'status', 'result')} | {
            'created_at': media.iso(row.created_at), 'updated_at': media.iso(row.updated_at)}


def lock_owner(session, owner_id, *, skip_locked=False):
    return session.scalar(select(User).where(User.id == owner_id).with_for_update(skip_locked=skip_locked)
                          .execution_options(populate_existing=True))


def owned_task(session, owner_id, task_id, *, lock=False):
    query = select(AgentTask).where(AgentTask.id == str(task_id), AgentTask.owner_id == owner_id)
    row = session.scalar((query.with_for_update() if lock else query).execution_options(populate_existing=True))
    if not row:
        raise HTTPException(404, 'Your autonomous task was not found.')
    return row


def activity(session, owner_id, kind, detail, task_id=None, status='completed'):
    media.record_activity(session, owner_id, kind, detail[:280], status=status,
                          details={'task_id': task_id} if task_id else {})


def stop_task(task, status, detail):
    task.status = status; task.detail = detail[:2000]; task.lease_token = ''; task.lease_until = None
    task.updated_at = now(); task.revision += 1


@router.get('/config')
def configuration(user: User = Depends(current_user), session: Session = Depends(db)):
    try:
        online = bool(cache.get(heartbeat_key()))
    except Exception:
        online = False
    inference = assistant.inference_status()
    return {'enabled': config.enabled, 'worker_ready': online,
            'can_run': bool(config.enabled and online and inference.get('available')),
            'inference': inference, 'tools': [{'id': key, 'title': title} for key, title in TOOLS.items()],
            'effective_tools': effective_tools(session, user.id), 'max_steps': 10,
            'detail': 'Opt-in private tasks can run without per-step review within your grants and budgets. '
                      'Publishing, wallet payments/signatures, deletion, arbitrary code and permission changes are never automatic.'}


@router.get('/policy')
def get_policy(user: User = Depends(current_user), session: Session = Depends(db)):
    return policy_json(session.get(AgentPolicy, user.id))


@router.put('/policy', dependencies=[Depends(guard)])
def set_policy(data: PolicyInput, user: User = Depends(current_user), session: Session = Depends(db)):
    if not lock_owner(session, user.id):
        raise HTTPException(401, 'Please sign in.')
    row = session.get(AgentPolicy, user.id, populate_existing=True)
    if data.revision != (row.revision if row else 1):
        raise HTTPException(409, 'Your autonomy policy changed. Refresh before saving.')
    if row is None:
        row = AgentPolicy(owner_id=user.id); session.add(row)
    for key in ('enabled', 'allowed_tools', 'max_steps', 'daily_task_limit'):
        setattr(row, key, getattr(data, key))
    row.revision = data.revision + 1; row.updated_at = now()
    if not data.enabled:
        for task in session.scalars(select(AgentTask).where(AgentTask.owner_id == user.id, AgentTask.status.in_(ACTIVE))):
            stop_task(task, 'paused', 'Autonomy is disabled. Existing completed steps are retained; no further steps will run.')
    activity(session, user.id, 'agent.policy', 'Reviewed autonomous private-tool permissions and budgets.')
    session.commit(); notify()
    return policy_json(row)


@router.post('/tasks', dependencies=[Depends(guard)])
def create_task(data: TaskInput, user: User = Depends(current_user), session: Session = Depends(db)):
    # Readiness checks can contact the local/gateway service; do that before
    # obtaining the account lock, and never fetch a user-provided endpoint.
    try:
        worker_ready = bool(cache.get(heartbeat_key()))
    except Exception:
        worker_ready = False
    inference_ready = bool(assistant.inference_status().get('available')) if config.enabled else False
    if not lock_owner(session, user.id):
        raise HTTPException(401, 'Please sign in.')
    fingerprint = hashlib.sha256(json.dumps(data.model_dump(mode='json'), sort_keys=True).encode()).hexdigest()
    previous = session.scalar(select(AgentTask).where(AgentTask.owner_id == user.id, AgentTask.request_id == str(data.request_id)))
    if previous:
        if previous.request_hash != fingerprint:
            raise HTTPException(409, 'This task request identifier was already used with different details.')
        return task_json(previous)
    policy = session.get(AgentPolicy, user.id)
    tools = effective_tools(session, user.id)
    if not config.enabled or not policy or not policy.enabled or not tools:
        raise HTTPException(409, 'Enable autonomy and grant the matching Assistant tools before creating a task.')
    if not worker_ready or not inference_ready:
        raise HTTPException(503, 'The autonomous task worker and model must be ready before starting a new task.')
    steps = data.max_steps or policy.max_steps
    if steps > policy.max_steps:
        raise HTTPException(422, 'The task exceeds your reviewed step budget.')
    since = now().replace(hour=0, minute=0, second=0, microsecond=0)
    count = session.scalar(select(func.count()).select_from(AgentTask).where(AgentTask.owner_id == user.id, AgentTask.created_at >= since))
    if count >= policy.daily_task_limit:
        raise HTTPException(429, 'Your daily autonomous task budget is reached. Cancelled tasks still count.')
    if session.scalar(select(func.count()).select_from(AgentTask).where(AgentTask.owner_id == user.id, AgentTask.status.in_(ACTIVE))) >= 3:
        raise HTTPException(429, 'Finish or pause an existing task before adding more.')
    # Serialize global queue admission on PostgreSQL, after the account lock.
    if session.bind.dialect.name == 'postgresql':
        from sqlalchemy import text
        session.execute(text('SELECT pg_advisory_xact_lock(25413261051740164)'))
    if session.scalar(select(func.count()).select_from(AgentTask).where(AgentTask.status.in_(ACTIVE))) >= config.global_queue_limit:
        raise HTTPException(429, 'The autonomous task queue is full. Try later.')
    project_id = media.optional_project(session, str(data.project_id) if data.project_id else None, user.id)
    snapshot = None
    if data.render_item_id:
        if 'render.create' not in tools:
            raise HTTPException(403, 'Grant rendering in both Assistant and autonomy permissions first.')
        from creator import CreatorItem
        from render_services import input_snapshot, snapshot_hash
        item = media.owned(session, CreatorItem, str(data.render_item_id), user.id)
        values = input_snapshot(session, item)
        if values.get('audio'):
            raise HTTPException(422, 'Review soundtrack rights in Exports. Automatic rendering only accepts a soundtrack-free creation.')
        snapshot = snapshot_hash(values)
    task = AgentTask(owner_id=user.id, request_id=str(data.request_id), request_hash=fingerprint,
                     objective=data.objective, project_id=project_id,
                     render_item_id=str(data.render_item_id) if data.render_item_id else None,
                     render_snapshot=snapshot, allowed_tools=tools, max_steps=steps)
    session.add(task); session.flush()
    activity(session, user.id, 'agent.created', 'Queued an autonomous task within reviewed private-tool grants.', task.id, 'pending')
    session.commit(); notify()
    return task_json(task)


@router.get('/tasks')
def tasks(limit: int = Query(default=30, ge=1, le=100), user: User = Depends(current_user), session: Session = Depends(db)):
    return [task_json(row) for row in session.scalars(select(AgentTask).where(AgentTask.owner_id == user.id)
            .order_by(AgentTask.created_at.desc(), AgentTask.id).limit(limit))]


@router.get('/tasks/{task_id}')
def task_detail(task_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned_task(session, user.id, task_id)
    return task_json(row) | {'steps': [step_json(step) for step in session.scalars(select(AgentStep)
                            .where(AgentStep.task_id == row.id, AgentStep.owner_id == user.id).order_by(AgentStep.position))]}


@router.post('/tasks/{task_id}/{operation}', dependencies=[Depends(guard)])
def change_task(task_id: uuid.UUID, operation: Literal['pause', 'resume', 'cancel'], data: RevisionInput,
                user: User = Depends(current_user), session: Session = Depends(db)):
    if not lock_owner(session, user.id):
        raise HTTPException(401, 'Please sign in.')
    row = owned_task(session, user.id, task_id, lock=True)
    if row.revision != data.revision:
        raise HTTPException(409, 'The task changed. Refresh before changing its state.')
    if row.status in ('completed', 'cancelled', 'failed'):
        raise HTTPException(409, 'This task is finished. Completed steps cannot be undone.')
    if operation == 'resume':
        if row.status not in ('paused', 'blocked'):
            raise HTTPException(409, 'Only paused or blocked tasks can resume.')
        if not config.enabled or not effective_tools(session, user.id, row):
            raise HTTPException(409, 'Enable the matching reviewed permissions before resuming.')
        if row.deadline and media.aware(row.deadline) <= now():
            raise HTTPException(409, 'The task runtime budget expired. Create a new task.')
        if row.model_calls >= row.max_steps + 2:
            raise HTTPException(409, 'The task inference budget is exhausted. Create a new task.')
        if session.scalar(select(func.count()).select_from(AgentTask).where(AgentTask.owner_id == user.id, AgentTask.status.in_(ACTIVE))) >= 3:
            raise HTTPException(429, 'Finish or pause another task first.')
        if session.bind.dialect.name == 'postgresql':
            from sqlalchemy import text
            session.execute(text('SELECT pg_advisory_xact_lock(25413261051740164)'))
        if session.scalar(select(func.count()).select_from(AgentTask).where(AgentTask.status.in_(ACTIVE))) >= config.global_queue_limit:
            raise HTTPException(429, 'The autonomous task queue is full. Try later.')
        stop_task(row, 'queued', 'Resumed within the original tool grants and budgets.')
    elif operation == 'pause':
        stop_task(row, 'paused', 'Paused. Completed steps remain; no further steps will run.')
    else:
        stop_task(row, 'cancelled', 'Cancelled. Completed private changes and queued exports are retained.')
    activity(session, user.id, 'agent.' + operation, row.detail, row.id)
    session.commit(); notify()
    return task_json(row)


def export_agent_data(session, owner_id):
    return {'policy': policy_json(session.get(AgentPolicy, owner_id)),
            'tasks': [task_json(row) for row in session.scalars(select(AgentTask).where(AgentTask.owner_id == owner_id))],
            'steps': [step_json(row) for row in session.scalars(select(AgentStep).where(AgentStep.owner_id == owner_id))]}


def delete_agent_data(session, owner_id):
    session.execute(delete(AgentStep).where(AgentStep.owner_id == owner_id))
    session.execute(delete(AgentTask).where(AgentTask.owner_id == owner_id))
    session.execute(delete(AgentPolicy).where(AgentPolicy.owner_id == owner_id))
