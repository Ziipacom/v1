"""Durable, owner-reviewed Media OS workflows. No automatic social publishing."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ConfigDict, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, func, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, cache, current_user, db, guard, settings
from creator import CreatorConnection, CreatorItem

router = APIRouter(prefix='/api/os/workflows', dependencies=[Depends(current_user)])
Action = Literal['reminder', 'render', 'bluesky_sync']
Trigger = Literal['scheduled', 'media_saved', 'render_ready']
ACTIVE = ('queued', 'running')
LEASE_SECONDS = 120
MAX_ATTEMPTS = 3
MAX_WORKFLOWS = 20
MAX_OWNER_QUEUE = 20
MAX_GLOBAL_QUEUE = 50
INITIAL_CURSOR_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
WORKFLOW_PROTOCOL_VERSION = 1


class WorkflowSettings(BaseSettings):
    enabled: bool = False
    poll_seconds: int = Field(default=60, ge=30, le=300)
    reconcile_seconds: int = Field(default=3600, ge=600, le=3600)
    model_config = SettingsConfigDict(env_prefix='OS_WORKFLOW_', env_file='.env', extra='ignore')


config = WorkflowSettings()


def utcnow():
    return datetime.now(timezone.utc)


def aware(value: datetime | None):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def coordination_scope():
    url = make_url(settings.database_url)
    identity = [WORKFLOW_PROTOCOL_VERSION, url.get_backend_name(), url.host, url.port, url.database, url.username]
    return hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]


def heartbeat_key():
    return 'ziipa:os:workflow-worker:' + coordination_scope()


def wake_key():
    return 'ziipa:os:workflow-revision:' + coordination_scope()


def notify_workflows(owner_id=None):
    """Best-effort hint after a DB commit; no owner data or credentials in Redis."""
    try:
        cache.set(wake_key(), str(uuid.uuid4()), ex=max(7200, config.reconcile_seconds * 2))
    except Exception:
        pass  # The bounded database reconciliation is authoritative.


class OsWorkflow(Base):
    __tablename__ = 'os_workflows'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    name: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(24))
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    trigger: Mapped[str] = mapped_column(String(24), default='scheduled')
    run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    interval_minutes: Mapped[int | None] = mapped_column(nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    rights_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(default=1)
    next_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    event_cursor: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OsWorkflowRun(Base):
    __tablename__ = 'os_workflow_runs'
    __table_args__ = (UniqueConstraint('workflow_id', 'occurrence_key'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    workflow_id: Mapped[str] = mapped_column(ForeignKey('os_workflows.id', ondelete='CASCADE'), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    occurrence_key: Mapped[str] = mapped_column(String(120))
    snapshot: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default='queued', index=True)
    detail: Mapped[str] = mapped_column(String(400), default='Waiting for the workflow worker.')
    attempts: Mapped[int] = mapped_column(default=0)
    lease_token: Mapped[str] = mapped_column(String(64), default='')
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    external_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WorkflowInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=120, pattern=r'.*\S.*')
    action: Action
    target_id: uuid.UUID | None = None
    trigger: Trigger = 'scheduled'
    run_at: datetime | None = None
    interval_minutes: int | None = Field(default=None, ge=15, le=44640)
    enabled: bool = False
    rights_confirmed: bool = False

    @model_validator(mode='after')
    def shape(self):
        if self.run_at is not None:
            if self.run_at.tzinfo is None or self.run_at.utcoffset() is None:
                raise ValueError('Use a date and time with an explicit timezone.')
            self.run_at = self.run_at.astimezone(timezone.utc)
        if self.trigger == 'scheduled' and self.run_at is None:
            raise ValueError('Choose the first scheduled date and time.')
        if self.trigger != 'scheduled' and (self.run_at is not None or self.interval_minutes is not None):
            raise ValueError('Event workflows do not take a date or recurrence.')
        if self.action != 'render' and self.target_id is not None:
            raise ValueError('Only rendering takes a saved creation target.')
        if self.action == 'render' and self.target_id is None:
            raise ValueError('Choose your saved creation before enabling rendering.')
        return self


class WorkflowUpdate(WorkflowInput):
    revision: int = Field(ge=1)


def _activity(session, owner_id, kind, status, detail, target_id=None):
    # Optional only during rolling boot; integration installs this shared ledger.
    from personal_media import record_activity
    record_activity(session, owner_id, kind=kind, status=status, summary=detail,
                    details={'workflow_id': target_id} if target_id else {})


def _owner_lock(session, user):
    if not session.scalar(select(User).where(User.id == user.id).with_for_update()):
        raise HTTPException(401, 'Your account is no longer available.')
    from admin_services import require_mutations_open
    require_mutations_open(session, user)


def _owned(session, user, workflow_id, *, lock=False):
    query = select(OsWorkflow).where(OsWorkflow.id == str(workflow_id), OsWorkflow.owner_id == user.id)
    row = session.scalar(query.with_for_update() if lock else query)
    if not row:
        raise HTTPException(404, 'Your workflow was not found.')
    return row


def _owned_run(session, user, run_id):
    row = session.scalar(select(OsWorkflowRun).where(OsWorkflowRun.id == str(run_id), OsWorkflowRun.owner_id == user.id).with_for_update())
    if not row:
        raise HTTPException(404, 'Your workflow run was not found.')
    return row


def validate_target(session, user, data):
    from admin_services import enforce_content_visible, require_mutations_open
    require_mutations_open(session, user)
    fingerprint = None
    if data.action == 'render':
        item = session.get(CreatorItem, str(data.target_id))
        if not item or item.owner_id != user.id:
            raise HTTPException(404, 'Your saved creation was not found.')
        enforce_content_visible(session, item)
        from render_services import input_snapshot, snapshot_hash
        snapshot = input_snapshot(session, item)
        fingerprint = snapshot_hash(snapshot)
        if snapshot.get('audio') and not data.rights_confirmed:
            raise HTTPException(422, 'Confirm your right to use the selected soundtrack before creating this render workflow.')
        if isinstance(data, OsWorkflow) and (data.event_cursor or {}).get('reviewed_fingerprint') != fingerprint:
            raise HTTPException(409, 'Your saved creation changed. Review and save this workflow again before rendering.')
    if data.action == 'bluesky_sync':
        row = session.scalar(select(CreatorConnection).where(CreatorConnection.owner_id == user.id, CreatorConnection.provider == 'bluesky'))
        if not row or row.data.get('auth_type') != 'public_profile':
            raise HTTPException(409, 'Link a public Bluesky profile before creating a sync workflow.')
        if not settings.social_public_sync_enabled:
            raise HTTPException(503, 'Public Bluesky sync is disabled in this environment.')
    return fingerprint


def workflow_receipt(row):
    return {'id': row.id, 'name': row.name, 'action': row.action, 'target_id': row.target_id,
            'trigger': row.trigger, 'run_at': aware(row.run_at), 'interval_minutes': row.interval_minutes,
            'enabled': row.enabled, 'rights_confirmed': row.rights_confirmed, 'revision': row.revision,
            'next_run': aware(row.next_run), 'created_at': aware(row.created_at), 'updated_at': aware(row.updated_at)}


def run_receipt(row):
    return {'id': row.id, 'workflow_id': row.workflow_id, 'status': row.status, 'detail': row.detail,
            'action': row.snapshot.get('action'), 'target_id': row.snapshot.get('target_id'),
            'attempts': row.attempts, 'external_ref': row.external_ref,
            'created_at': aware(row.created_at), 'updated_at': aware(row.updated_at)}


def _snapshot(workflow, *, manual=False, event_id=None):
    return {'action': workflow.action, 'target_id': workflow.target_id, 'rights_confirmed': workflow.rights_confirmed,
            'revision': workflow.revision, 'manual': manual, 'event_id': event_id}


def _capacity(session, owner_id):
    # Serialize cross-owner admission too: per-owner locks alone cannot enforce
    # the shared free-tier queue ceiling during concurrent worker/API admission.
    if session.get_bind().dialect.name == 'postgresql':
        session.execute(text('SELECT pg_advisory_xact_lock(25413261051740163)'))
    owned = session.scalar(select(func.count()).select_from(OsWorkflowRun).where(OsWorkflowRun.owner_id == owner_id, OsWorkflowRun.status.in_(ACTIVE)))
    total = session.scalar(select(func.count()).select_from(OsWorkflowRun).where(OsWorkflowRun.status.in_(ACTIVE)))
    return owned < MAX_OWNER_QUEUE and total < MAX_GLOBAL_QUEUE


def enqueue(session, workflow, occurrence, *, manual=False, event_id=None):
    from admin_services import account_is_active
    if not account_is_active(session, workflow.owner_id):
        return None
    prior = session.scalar(select(OsWorkflowRun).where(OsWorkflowRun.workflow_id == workflow.id, OsWorkflowRun.occurrence_key == occurrence))
    if prior:
        return prior
    if not _capacity(session, workflow.owner_id):
        return None
    run = OsWorkflowRun(workflow_id=workflow.id, owner_id=workflow.owner_id, occurrence_key=occurrence,
                        snapshot=_snapshot(workflow, manual=manual, event_id=event_id))
    session.add(run)
    session.flush()
    return run


def _cancel_active(session, workflow, detail):
    session.execute(update(OsWorkflowRun).where(OsWorkflowRun.workflow_id == workflow.id, OsWorkflowRun.owner_id == workflow.owner_id,
                    OsWorkflowRun.status.in_(ACTIVE)).values(status='cancelled', detail=detail, lease_token='', lease_until=None, updated_at=utcnow()))


@router.get('/config')
def configuration():
    try:
        online = bool(cache.get(heartbeat_key()))
    except Exception:
        online = False
    return {'enabled': config.enabled, 'worker_ready': online, 'can_run': bool(config.enabled and online),
            'actions': ['reminder', 'render', 'bluesky_sync'], 'triggers': ['scheduled', 'media_saved', 'render_ready'],
            'poll_seconds': config.poll_seconds, 'max_workflows': MAX_WORKFLOWS,
            'reconcile_seconds': config.reconcile_seconds,
            'notice': 'Workflows run only after you enable them or choose Run once. Bluesky sync reads a limited public profile; reminders stay in Ziipa. Publishing, invitations and payments require separate approval.'}


@router.get('')
@router.get('/')
def list_workflows(user: User = Depends(current_user), session: Session = Depends(db)):
    return [workflow_receipt(row) for row in session.scalars(select(OsWorkflow).where(OsWorkflow.owner_id == user.id).order_by(OsWorkflow.created_at.desc()).limit(MAX_WORKFLOWS))]


@router.post('', dependencies=[Depends(guard)])
@router.post('/', dependencies=[Depends(guard)])
def create_workflow(data: WorkflowInput, user: User = Depends(current_user), session: Session = Depends(db)):
    _owner_lock(session, user)
    count = session.scalar(select(func.count()).select_from(OsWorkflow).where(OsWorkflow.owner_id == user.id))
    if count >= MAX_WORKFLOWS:
        raise HTTPException(429, 'You can keep up to 20 workflows. Delete one before creating another.')
    fingerprint = validate_target(session, user, data)
    now = utcnow()
    row = OsWorkflow(owner_id=user.id, **data.model_dump(exclude={'target_id'}), target_id=str(data.target_id) if data.target_id else None,
                     next_run=data.run_at if data.enabled and data.trigger == 'scheduled' else None,
                     event_cursor={'at': now.isoformat(), 'id': INITIAL_CURSOR_ID, 'reviewed_fingerprint': fingerprint})
    session.add(row); session.flush()
    _activity(session, user.id, 'workflow_created', 'completed', 'Created an enabled workflow.' if data.enabled else 'Saved a paused workflow for review.', row.id)
    session.commit()
    notify_workflows(user.id)
    return workflow_receipt(row)


@router.patch('/{workflow_id}', dependencies=[Depends(guard)])
def edit_workflow(workflow_id: uuid.UUID, data: WorkflowUpdate, user: User = Depends(current_user), session: Session = Depends(db)):
    _owner_lock(session, user)
    row = _owned(session, user, workflow_id, lock=True)
    if row.revision != data.revision:
        raise HTTPException(409, 'This workflow changed. Refresh before saving your review.')
    fingerprint = validate_target(session, user, data)
    _cancel_active(session, row, 'Workflow review changed; this previous run was cancelled.')
    was_enabled = row.enabled
    old_shape = (row.trigger, row.target_id, row.action)
    for key, value in data.model_dump(exclude={'revision', 'target_id'}).items():
        setattr(row, key, value)
    row.target_id = str(data.target_id) if data.target_id else None
    row.revision += 1; row.updated_at = utcnow()
    row.next_run = data.run_at if data.enabled and data.trigger == 'scheduled' else None
    if not was_enabled or old_shape != (row.trigger, row.target_id, row.action):
        row.event_cursor = {'at': row.updated_at.isoformat(), 'id': INITIAL_CURSOR_ID, 'reviewed_fingerprint': fingerprint}
    else:
        row.event_cursor = {**row.event_cursor, 'reviewed_fingerprint': fingerprint}
    _activity(session, user.id, 'workflow_updated', 'completed', 'Updated the reviewed workflow and cancelled previous pending runs.', row.id)
    session.commit()
    notify_workflows(user.id)
    return workflow_receipt(row)


@router.post('/{workflow_id}/pause', dependencies=[Depends(guard)])
def pause_workflow(workflow_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    _owner_lock(session, user)
    row = _owned(session, user, workflow_id, lock=True)
    row.enabled = False; row.next_run = None; row.revision += 1; row.updated_at = utcnow()
    _cancel_active(session, row, 'You paused this workflow before completion.')
    _activity(session, user.id, 'workflow_paused', 'completed', 'Paused the workflow and cancelled its pending runs.', row.id)
    session.commit()
    notify_workflows(user.id)
    return workflow_receipt(row)


@router.delete('/{workflow_id}', dependencies=[Depends(guard)])
def delete_workflow(workflow_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    _owner_lock(session, user)
    row = _owned(session, user, workflow_id, lock=True)
    session.execute(delete(OsWorkflowRun).where(OsWorkflowRun.workflow_id == row.id, OsWorkflowRun.owner_id == user.id))
    session.delete(row)
    _activity(session, user.id, 'workflow_deleted', 'completed', 'Deleted this workflow and its run history.', str(workflow_id))
    session.commit()
    notify_workflows(user.id)
    return {'deleted': True}


@router.post('/{workflow_id}/run', dependencies=[Depends(guard)])
def run_once(workflow_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    _owner_lock(session, user)
    row = _owned(session, user, workflow_id, lock=True)
    validate_target(session, user, row)
    # Repeated taps while the same reviewed workflow is queued return one run.
    prior = session.scalar(select(OsWorkflowRun).where(OsWorkflowRun.workflow_id == row.id, OsWorkflowRun.status.in_(ACTIVE)).order_by(OsWorkflowRun.created_at.desc()))
    if prior:
        return run_receipt(prior)
    run = enqueue(session, row, 'manual:' + str(uuid.uuid4()), manual=True)
    if not run:
        raise HTTPException(429, 'The workflow queue is full. Wait for an existing run to finish.')
    _activity(session, user.id, 'workflow_queued', 'queued', 'You requested one reviewed workflow run.', row.id)
    session.commit()
    notify_workflows(user.id)
    return run_receipt(run)


@router.get('/runs')
def list_runs(workflow_id: uuid.UUID | None = None, limit: int = Query(default=50, ge=1, le=100), user: User = Depends(current_user), session: Session = Depends(db)):
    query = select(OsWorkflowRun).where(OsWorkflowRun.owner_id == user.id)
    if workflow_id:
        query = query.where(OsWorkflowRun.workflow_id == str(workflow_id))
    return [run_receipt(row) for row in session.scalars(query.order_by(OsWorkflowRun.created_at.desc()).limit(limit))]


@router.post('/runs/{run_id}/retry', dependencies=[Depends(guard)])
def retry_run(run_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    _owner_lock(session, user)
    run = _owned_run(session, user, run_id)
    row = _owned(session, user, run.workflow_id, lock=True)
    if run.status not in ('failed', 'blocked', 'cancelled') or run.attempts >= MAX_ATTEMPTS:
        raise HTTPException(409, 'This run cannot be retried. Review your workflow and choose Run once instead.')
    validate_target(session, user, row)
    if not _capacity(session, user.id):
        raise HTTPException(429, 'The workflow queue is full.')
    run.snapshot = _snapshot(row, manual=True)
    run.status = 'queued'; run.detail = 'Waiting after your explicit retry.'
    run.lease_token = ''; run.lease_until = None; run.external_ref = None; run.updated_at = utcnow()
    _activity(session, user.id, 'workflow_retry', 'queued', 'You explicitly retried a reviewed workflow.', row.id)
    session.commit()
    notify_workflows(user.id)
    return run_receipt(run)


@router.post('/runs/{run_id}/cancel', dependencies=[Depends(guard)])
def cancel_run(run_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    _owner_lock(session, user)
    run = _owned_run(session, user, run_id)
    if run.status in ACTIVE:
        run.status = 'cancelled'; run.detail = 'You cancelled this workflow run.'
        run.lease_token = ''; run.lease_until = None; run.updated_at = utcnow()
        _activity(session, user.id, 'workflow_cancelled', 'completed', 'Cancelled a pending workflow run.', run.workflow_id)
        session.commit()
        notify_workflows(user.id)
    return run_receipt(run)


def export_workflows_data(session, owner_id):
    return {'workflows': [workflow_receipt(row) for row in session.scalars(select(OsWorkflow).where(OsWorkflow.owner_id == owner_id))],
            'workflow_runs': [run_receipt(row) for row in session.scalars(select(OsWorkflowRun).where(OsWorkflowRun.owner_id == owner_id))]}


def delete_workflows_data(session, owner_id):
    session.execute(delete(OsWorkflowRun).where(OsWorkflowRun.owner_id == owner_id))
    session.execute(delete(OsWorkflow).where(OsWorkflow.owner_id == owner_id))
