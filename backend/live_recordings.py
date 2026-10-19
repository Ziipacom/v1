"""Owned opt-in recording automation. No public publishing or live start authority."""
from datetime import datetime, timedelta, timezone
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StrictBool, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, func, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard
from live_api import LiveStream, no_store, owned
from render_services import Rendition

MAX_BYTES = 100 * 1024 * 1024
MAX_DURATION = 1800
MAX_RECORDINGS = 100
LEASE_SECONDS = 300


class RecordingSettings(BaseSettings):
    live_recordings_enabled: bool = False
    live_webhook_id: str = ''
    live_webhook_secret: SecretStr = SecretStr('')
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')


config = RecordingSettings()
router = APIRouter(prefix='/api/live', dependencies=[Depends(current_user), Depends(no_store)])


def now():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def stamp(value):
    return aware(value).isoformat() if value else None


def notify():
    from media_workflows import notify_workflows
    notify_workflows()


def owner_lock(session, owner_id):
    if session.bind.dialect.name == 'sqlite':
        session.execute(update(User).where(User.id == owner_id).values(id=owner_id))
    return session.scalar(select(User).where(User.id == owner_id).with_for_update())


def webhook_configured():
    try:
        uuid.UUID(config.live_webhook_id)
    except (TypeError, ValueError):
        return False
    return len(config.live_webhook_secret.get_secret_value()) >= 32


class RecordingAutomation(Base):
    __tablename__ = 'live_recording_automation'
    stream_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    enabled: Mapped[bool] = mapped_column(default=False)
    consent: Mapped[bool] = mapped_column(default=False)
    clip_count: Mapped[int] = mapped_column(default=1)
    clip_seconds: Mapped[int] = mapped_column(default=30)
    rendition: Mapped[str] = mapped_column(String(16), default='portrait')
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class LiveRecording(Base):
    __tablename__ = 'live_recordings'
    __table_args__ = (UniqueConstraint('provider_asset_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    stream_id: Mapped[str] = mapped_column(String(36), index=True)
    provider_asset_id: Mapped[str] = mapped_column(String(36))
    provider_session_id: Mapped[str] = mapped_column(String(36))
    provider_stream_id: Mapped[str] = mapped_column(String(36))
    policy: Mapped[dict] = mapped_column(JSON)
    title: Mapped[str] = mapped_column(String(140))
    status: Mapped[str] = mapped_column(String(20), default='queued', index=True)
    revision: Mapped[int] = mapped_column(default=1)
    detail: Mapped[str] = mapped_column(String(400), default='Waiting to verify and import an owned recording into private Ziipa storage.')
    reserved_media_id: Mapped[str] = mapped_column(String(36), default=lambda: str(uuid.uuid4()))
    media_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    item_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    duration: Mapped[float | None] = mapped_column(nullable=True)
    size: Mapped[int | None] = mapped_column(nullable=True)
    sha256: Mapped[str] = mapped_column(String(64), default='')
    clips: Mapped[list] = mapped_column(JSON, default=list)
    attempts: Mapped[int] = mapped_column(default=0)
    next_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=lambda: now(), index=True)
    lease_token: Mapped[str] = mapped_column(String(36), default='')
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class LiveWebhookReceipt(Base):
    __tablename__ = 'live_webhook_receipts'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    stream_id: Mapped[str] = mapped_column(String(36), index=True)
    event: Mapped[str] = mapped_column(String(32))
    binding_hash: Mapped[str] = mapped_column(String(64))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AutomationInput(BaseModel):
    revision: int = Field(ge=0, strict=True)
    enabled: StrictBool
    consent: StrictBool = False
    clip_count: int = Field(default=1, ge=1, le=3, strict=True)
    clip_seconds: int = Field(default=30, ge=15, le=90, strict=True)
    rendition: Rendition = 'portrait'
    model_config = ConfigDict(extra='forbid')

    @model_validator(mode='after')
    def consent_required(self):
        if self.enabled and not self.consent:
            raise ValueError('Confirm rights and consent to private recording imports and deterministic clip drafts.')
        return self


class Revision(BaseModel):
    revision: int = Field(ge=1, strict=True)
    model_config = ConfigDict(extra='forbid')


def policy_receipt(stream_id, row):
    return {'stream_id': stream_id, 'revision': row.revision if row else 0,
        'enabled': row.enabled if row else False, 'consent': row.consent if row else False,
        'clip_count': row.clip_count if row else 1, 'clip_seconds': row.clip_seconds if row else 30,
        'rendition': row.rendition if row else 'portrait', 'automatic_publication': False,
        'detail': 'Opt-in creates private Ziipa recording and sequential excerpt drafts, not AI-selected highlights. Provider recording privacy and retention are separate; nothing is automatically published.'}


def valid_authority(session, row):
    stream = session.get(LiveStream, row.stream_id)
    policy = session.get(RecordingAutomation, row.stream_id)
    return bool(stream and stream.owner_id == row.owner_id and stream.record
        and stream.provider_id == row.provider_stream_id and policy and policy.owner_id == row.owner_id
        and policy.enabled and policy.consent and policy.revision == row.policy.get('revision'))


def receipt(row, session):
    from creator import CreatorItem
    from render_services import RenderJob, receipt as render_receipt
    source = session.get(CreatorItem, row.item_id) if row.item_id else None
    clips = []
    for value in row.clips or []:
        clip = dict(value)
        item = session.get(CreatorItem, clip.get('item_id'))
        job = session.get(RenderJob, clip.get('render_id')) if clip.get('render_id') else None
        if not item or item.owner_id != row.owner_id:
            clip.update(status='unavailable', detail='Private clip draft was removed.', render_id=None)
        elif job and job.owner_id == row.owner_id and job.item_id == item.id:
            checked = render_receipt(job, session)
            clip.update(status=checked['status'], detail=checked['detail'])
        else:
            clip.update(status='draft', detail='Private editable excerpt; rendering has not been queued.')
        clips.append(clip)
    return {'id': row.id, 'stream_id': row.stream_id, 'status': row.status, 'revision': row.revision,
        'title': row.title, 'detail': row.detail, 'media_id': row.media_id if source and source.owner_id == row.owner_id else None,
        'item_id': row.item_id if source and source.owner_id == row.owner_id else None,
        'duration': row.duration, 'size': row.size, 'sha256': row.sha256, 'clips': clips,
        'automatic_publication': False, 'created_at': stamp(row.created_at), 'updated_at': stamp(row.updated_at)}


@router.get('/recordings/config')
def configuration():
    from live_recordings_worker import worker_ready
    return {'enabled': config.live_recordings_enabled, 'webhook_configured': webhook_configured(),
        'worker_ready': worker_ready(), 'max_bytes': MAX_BYTES, 'max_duration_seconds': MAX_DURATION, 'max_clips': 3,
        'automatic_publication': False, 'detail': 'Signed Livepeer asset.ready callbacks and an enabled local workflow/render worker are required. Long or oversized recordings need manual trimming outside this bounded importer.'}


@router.get('/streams/{stream_id}/recording-automation')
def get_automation(stream_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    owned(session, stream_id, user)
    return policy_receipt(str(stream_id), session.get(RecordingAutomation, str(stream_id)))


def cancel_jobs(session, row):
    from render_services import RenderJob
    for clip in row.clips or []:
        if clip.get('render_id'):
            session.execute(update(RenderJob).where(RenderJob.id == clip['render_id'], RenderJob.owner_id == row.owner_id,
                RenderJob.item_id == clip['item_id'], RenderJob.status.in_(('queued', 'processing'))).values(
                status='cancelled', claim_token='', detail='Recording automation was cancelled. Private drafts remain editable.', updated_at=now()))


@router.put('/streams/{stream_id}/recording-automation', dependencies=[Depends(guard)])
def set_automation(stream_id: uuid.UUID, data: AutomationInput, user: User = Depends(current_user), session: Session = Depends(db)):
    owner_lock(session, user.id)
    stream = owned(session, stream_id, user)
    if data.enabled and not stream.record:
        raise HTTPException(409, 'Create a broadcast with recording enabled first. This setting does not enable provider recording.')
    row = session.get(RecordingAutomation, str(stream_id))
    if data.revision != (row.revision if row else 0):
        raise HTTPException(409, 'Recording automation changed. Reload before saving.')
    if row is None:
        row = RecordingAutomation(stream_id=stream.id, owner_id=user.id, revision=0)
        session.add(row)
    for key in ('enabled', 'consent', 'clip_count', 'clip_seconds', 'rendition'):
        setattr(row, key, getattr(data, key))
    row.revision += 1; row.updated_at = now()
    for recording in session.scalars(select(LiveRecording).where(LiveRecording.stream_id == stream.id,
            LiveRecording.owner_id == user.id, LiveRecording.status.in_(('queued', 'processing'))).with_for_update()):
        recording.status = 'cancelled'; recording.next_run = None; recording.lease_token = ''
        recording.detail = 'Automation settings changed. Existing private media remains saved; new imports require a new verified event.'
        recording.revision += 1; recording.updated_at = now()
        cancel_jobs(session, recording)
    session.commit(); notify()
    return policy_receipt(stream.id, row)


@router.get('/recordings')
def list_recordings(stream_id: uuid.UUID | None = None, user: User = Depends(current_user), session: Session = Depends(db)):
    query = select(LiveRecording).where(LiveRecording.owner_id == user.id)
    if stream_id:
        query = query.where(LiveRecording.stream_id == str(stream_id))
    return [receipt(row, session) for row in session.scalars(query.order_by(LiveRecording.created_at.desc()).limit(MAX_RECORDINGS))]


def owned_recording(session, user, recording_id, lock=False):
    query = select(LiveRecording).where(LiveRecording.id == str(recording_id), LiveRecording.owner_id == user.id)
    row = session.scalar(query.with_for_update() if lock else query)
    if not row:
        raise HTTPException(404, 'Owned recording not found.')
    return row


@router.get('/recordings/{recording_id}')
def get_recording(recording_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    return receipt(owned_recording(session, user, recording_id), session)


@router.post('/recordings/{recording_id}/{operation}', dependencies=[Depends(guard)])
def control(recording_id: uuid.UUID, operation: Literal['retry', 'cancel'], data: Revision,
            user: User = Depends(current_user), session: Session = Depends(db)):
    owner_lock(session, user.id)
    row = owned_recording(session, user, recording_id, True)
    if data.revision != row.revision:
        raise HTTPException(409, 'Recording changed. Reload before continuing.')
    if operation == 'cancel':
        from creator import CreatorMedia
        from storage_services import storage
        if not session.get(CreatorMedia, row.reserved_media_id):
            try:
                storage().delete(row.owner_id, row.reserved_media_id)
            except Exception:
                raise HTTPException(503, 'Unfinished private recording cleanup is pending. Retry cancellation.') from None
        row.status = 'cancelled'; row.next_run = None; row.lease_token = ''; cancel_jobs(session, row)
        row.detail = 'Automation cancelled; existing private recording and drafts were not deleted. No provider broadcast was changed.'
    else:
        if row.status not in ('blocked', 'failed') or not valid_authority(session, row):
            raise HTTPException(409, 'Only failed imports with unchanged active consent can be retried.')
        if row.attempts >= 5:
            raise HTTPException(409, 'Import retry limit reached. Review the provider recording and import it manually.')
        row.status = 'queued'; row.next_run = now(); row.lease_token = ''; row.detail = 'Explicitly retried private import; no public action is scheduled.'
    row.revision += 1; row.updated_at = now(); session.commit(); notify()
    return receipt(row, session)


def export_live_recordings(session, owner_id):
    return {'automation': [policy_receipt(row.stream_id, row) for row in session.scalars(select(RecordingAutomation).where(RecordingAutomation.owner_id == owner_id))],
        'recordings': [receipt(row, session) for row in session.scalars(select(LiveRecording).where(LiveRecording.owner_id == owner_id))]}


async def delete_provider_recordings(session, owner_id):
    """Explicit account deletion only; fresh binding, no hidden DB commit.

    Call after live ingest has ended, before deleting LiveStream rows. A successful
    provider DELETE is logical removal; provider backups/physical retention are not
    controlled by Ziipa. Never run this from normal import/cancel operations.
    """
    import live_api as live
    from live_webhooks import id_value
    if not owner_lock(session, owner_id):
        raise HTTPException(404, 'Account not found.')
    rows = list(session.scalars(select(LiveRecording).where(LiveRecording.owner_id == owner_id).with_for_update()))
    for row in rows:
        try:
            asset = await live.provider_request('GET', '/asset/' + id_value(row.provider_asset_id), allow_missing=True)
            if asset is None or (isinstance(asset, dict) and asset.get('deleted') is True
                    and id_value(asset.get('id')) == row.provider_asset_id):
                continue  # Safe idempotent retry after an earlier successful DELETE.
            stream = session.get(LiveStream, row.stream_id)
            source = asset.get('source') if isinstance(asset, dict) else None
            if (not stream or stream.owner_id != owner_id or stream.provider_id != row.provider_stream_id
                    or stream.publish_enabled or stream.status != 'ended'
                    or id_value(asset.get('id')) != row.provider_asset_id or not isinstance(source, dict)
                    or source.get('type') != 'recording' or id_value(source.get('sessionId')) != row.provider_session_id):
                raise ValueError('Unverified recording binding')
            provider_session = await live.provider_request('GET', '/session/' + id_value(row.provider_session_id), allow_missing=True)
            if (not isinstance(provider_session, dict) or id_value(provider_session.get('id')) != row.provider_session_id
                    or id_value(provider_session.get('parentId')) != stream.provider_id or provider_session.get('record') is not True):
                raise ValueError('Unverified parent stream')
            await live.provider_request('DELETE', '/asset/' + row.provider_asset_id, allow_missing=True)
            remaining = await live.provider_request('GET', '/asset/' + row.provider_asset_id, allow_missing=True)
            if remaining is not None and (not isinstance(remaining, dict) or remaining.get('deleted') is not True):
                raise ValueError('Provider deletion not confirmed')
        except (HTTPException, ValueError, TypeError, AttributeError):
            raise HTTPException(503, 'Owned provider recording removal is not confirmed. Account deletion was paused; retry or ask an administrator to reconcile this recording in Livepeer.') from None


def delete_live_recordings(session, owner_id):
    from creator import CreatorMedia
    from storage_services import storage
    # Clean only our random reserved, uncatalogued keys. Catalogued media is
    # handled by the existing account deletion path. Fail closed on cleanup errors.
    for row in session.scalars(select(LiveRecording).where(LiveRecording.owner_id == owner_id)):
        if not session.get(CreatorMedia, row.reserved_media_id):
            try:
                storage().delete(owner_id, row.reserved_media_id)
            except Exception:
                raise HTTPException(503, 'Private recording cleanup is pending. Retry account deletion.') from None
    session.execute(delete(LiveWebhookReceipt).where(LiveWebhookReceipt.owner_id == owner_id))
    session.execute(delete(LiveRecording).where(LiveRecording.owner_id == owner_id))
    session.execute(delete(RecordingAutomation).where(RecordingAutomation.owner_id == owner_id))
