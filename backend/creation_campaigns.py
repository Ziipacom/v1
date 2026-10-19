"""Owner-reviewed creation-to-distribution campaigns; no agent publishing authority.

One campaign reviews one current Studio render. Transcripts and suggested copy are
review material, never silent edits to the original. Provider delivery always goes
through the existing publishing adapter and its consent/readiness checks.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, cache, current_user, db, guard
from creator import Caption, CreatorItem, SocialProvider
from personal_media import OSAssetMetadata, record_activity, rights_json
from render_services import (RenderJob, Rendition, RENDITIONS, input_fingerprint, resolve_rendered_media,
                             snapshot_rendition, rendition_descriptor)

router = APIRouter(prefix='/api/os/campaigns', dependencies=[Depends(current_user)])
ACTIVE = ('queued', 'preparing', 'scheduled', 'delivering')
DELIVERY_FINAL = ('delivered', 'failed', 'blocked', 'uncertain', 'needs_handoff', 'cancelled')
MAX_CAMPAIGNS = 30
LEASE_SECONDS = 240


class CampaignSettings(BaseSettings):
    enabled: bool = False
    model_config = SettingsConfigDict(env_prefix='CREATION_CAMPAIGN_', env_file='.env', extra='ignore')


config = CampaignSettings()


def now():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def stamp(value):
    return aware(value).isoformat() if value else None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def heartbeat_key():
    from media_workflows import coordination_scope
    return 'ziipa:os:campaign-worker:' + coordination_scope()


def notify():
    from media_workflows import notify_workflows
    notify_workflows()


class CreationCampaign(Base):
    __tablename__ = 'creation_campaigns'
    __table_args__ = (UniqueConstraint('owner_id', 'request_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    request_id: Mapped[str] = mapped_column(String(36))
    request_hash: Mapped[str] = mapped_column(String(64))
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(120))
    title: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(3000), default='')
    destinations: Mapped[list] = mapped_column(JSON, default=list)
    renditions: Mapped[list] = mapped_column(JSON, default=lambda: ['original'])
    ziipa_rendition: Mapped[str] = mapped_column(String(16), default='original')
    render_jobs: Mapped[dict] = mapped_column(JSON, default=dict)
    artifacts: Mapped[dict] = mapped_column(JSON, default=dict)
    published_items: Mapped[dict] = mapped_column(JSON, default=dict)
    schedule_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    transcript: Mapped[dict] = mapped_column(JSON, default=dict)
    generated_copy: Mapped[dict] = mapped_column(JSON, default=dict)
    source_fingerprint: Mapped[str] = mapped_column(String(64), default='')
    source_visibility: Mapped[str] = mapped_column(String(12), default='draft')
    render_job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    artifact: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    review_hash: Mapped[str] = mapped_column(String(64), default='')
    approved_hash: Mapped[str] = mapped_column(String(64), default='')
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ziipa_published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_item_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    revision: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(String(24), default='draft', index=True)
    paused_status: Mapped[str] = mapped_column(String(24), default='')
    detail: Mapped[str] = mapped_column(String(400), default='Prepare this saved Studio edit, then review its exact export and destinations.')
    next_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    lease_token: Mapped[str] = mapped_column(String(36), default='')
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CampaignDelivery(Base):
    __tablename__ = 'campaign_deliveries'
    __table_args__ = (UniqueConstraint('campaign_id', 'campaign_revision', 'provider'),
                     UniqueConstraint('owner_id', 'request_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    campaign_id: Mapped[str] = mapped_column(ForeignKey('creation_campaigns.id', ondelete='CASCADE'), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    campaign_revision: Mapped[int]
    request_id: Mapped[str] = mapped_column(String(36), default=lambda: str(uuid.uuid4()))
    provider: Mapped[str] = mapped_column(String(20))
    rendition: Mapped[str] = mapped_column(String(16), default='original')
    published_item_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    target_id: Mapped[str] = mapped_column(String(100))
    privacy: Mapped[str] = mapped_column(String(12))
    made_for_kids: Mapped[bool] = mapped_column(default=False)
    approval_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24), default='pending')
    detail: Mapped[str] = mapped_column(String(400), default='Waiting for the approved schedule.')
    publishing_job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    external_id: Mapped[str] = mapped_column(String(128), default='')
    external_url: Mapped[str] = mapped_column(String(500), default='')
    attempts: Mapped[int] = mapped_column(default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Destination(Input):
    provider: SocialProvider
    target_id: str = Field(min_length=1, max_length=100, pattern=r'.*\S.*')
    privacy: Literal['private', 'unlisted', 'public']
    made_for_kids: bool = False
    rendition: Rendition = 'original'


class CampaignInput(Input):
    request_id: uuid.UUID
    item_id: uuid.UUID
    name: str = Field(min_length=1, max_length=120, pattern=r'.*\S.*')
    title: str = Field(min_length=1, max_length=100, pattern=r'^[^<>]+$')
    description: str = Field(default='', max_length=3000)
    destinations: list[Destination] = Field(default_factory=list, max_length=6)
    renditions: list[Rendition] = Field(default_factory=lambda: ['original'], min_length=1, max_length=4)
    ziipa_rendition: Rendition = 'original'
    schedule_at: datetime | None = None
    rights_confirmed: bool = False
    soundtrack_rights_confirmed: bool = False
    request_transcription: bool = False
    transcription_consent: bool = False
    generate_copy: bool = False
    manual_transcript: str = Field(default='', max_length=12000)
    manual_segments: list[Caption] = Field(default_factory=list, max_length=100)

    @field_validator('schedule_at')
    @classmethod
    def scheduled(cls, value):
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError('Use a schedule with an explicit timezone.')
        return value.astimezone(timezone.utc) if value else None

    @model_validator(mode='after')
    def unique(self):
        if len({d.provider for d in self.destinations}) != len(self.destinations):
            raise ValueError('Choose each provider once.')
        if len(set(self.renditions)) != len(self.renditions):
            raise ValueError('Choose each rendition once.')
        if self.ziipa_rendition not in self.renditions or any(d.rendition not in self.renditions for d in self.destinations):
            raise ValueError('Every destination and Ziipa must use a selected rendition.')
        return self


class CampaignPatch(Input):
    revision: int = Field(ge=1)
    name: str | None = None
    title: str | None = None
    description: str | None = None
    destinations: list[Destination] | None = None
    renditions: list[Rendition] | None = None
    ziipa_rendition: Rendition | None = None
    schedule_at: datetime | None = None
    rights_confirmed: bool | None = None
    soundtrack_rights_confirmed: bool | None = None
    request_transcription: bool | None = None
    transcription_consent: bool | None = None
    generate_copy: bool | None = None
    manual_transcript: str | None = None
    manual_segments: list[Caption] | None = None


class RevisionInput(Input):
    revision: int = Field(ge=1)


class ApprovalInput(RevisionInput):
    review_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    consent: bool = False
    publish_to_ziipa: bool = False


class CaptionApproval(RevisionInput):
    transcript_hash: str = Field(pattern=r'^[a-f0-9]{64}$')


def owner_lock(session, owner_id):
    return session.scalar(select(User).where(User.id == owner_id).with_for_update().execution_options(populate_existing=True))


def owned(session, owner_id, campaign_id, lock=False):
    query = select(CreationCampaign).where(CreationCampaign.id == str(campaign_id), CreationCampaign.owner_id == owner_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    row = session.scalar(query)
    if not row:
        raise HTTPException(404, 'Your creation campaign was not found.')
    return row


def source(session, row):
    item = session.scalar(select(CreatorItem).where(CreatorItem.id == row.item_id, CreatorItem.owner_id == row.owner_id).execution_options(populate_existing=True))
    if not item:
        raise HTTPException(404, 'Your saved video was removed.')
    if item.visibility not in ('draft', 'published') or item.data.get('category', 'video') not in ('video', 'music', 'games'):
        raise HTTPException(409, 'Campaigns accept saved video, music and gaming posts, never hidden posts, broadcasts, products or minting requests.')
    fingerprint = input_fingerprint(session, item)
    metadata = session.scalar(select(OSAssetMetadata).where(OSAssetMetadata.owner_id == row.owner_id, OSAssetMetadata.item_id == item.id).execution_options(populate_existing=True))
    rights = rights_json(metadata.rights if metadata else {})
    if rights.get('expired'):
        raise HTTPException(409, 'The saved rights declaration expired. Review it in your library.')
    return item, digest({'editor': fingerprint, 'category': item.data.get('category', 'video'),
                        'remix_of': item.data.get('remix_of'), 'rights': rights, 'rights_revision': metadata.revision if metadata else 0})


def selected_renditions(row):
    return list(row.renditions or ['original'])


def render_job_map(row):
    result = dict(row.render_jobs or {})
    if not result and row.render_job_id:
        result[row.ziipa_rendition or 'original'] = row.render_job_id
    return result


def published_item_map(row):
    result = dict(row.published_items or {})
    if not result and row.published_item_id:
        result[row.ziipa_rendition or 'original'] = row.published_item_id
    return result


def current_artifacts(session, row):
    item, fingerprint = source(session, row)
    if fingerprint != row.source_fingerprint:
        raise HTTPException(409, 'The source, Studio edit or rights changed. Prepare and review the current version.')
    jobs = render_job_map(row)
    result = {}
    for name in selected_renditions(row):
        if not jobs.get(name):
            raise HTTPException(409, 'Prepare every selected rendition before reviewing this campaign.')
        media = resolve_rendered_media(session, row.owner_id, item, jobs[name])
        job = session.get(RenderJob, jobs[name])
        if snapshot_rendition(job.snapshot)['name'] != name:
            raise HTTPException(409, 'The render job does not match its selected rendition.')
        if not job.output_sha256 or len(job.output_sha256) != 64:
            raise HTTPException(409, 'The render has no verified output digest. Prepare it again.')
        if name != 'original' and (job.output_width, job.output_height) != RENDITIONS[name]:
            raise HTTPException(409, 'The rendition has no verified matching output dimensions. Render it again.')
        result[name] = {'media_id': media.id, 'render_id': job.id, 'output_sha256': job.output_sha256,
            'input_fingerprint': job.input_fingerprint, 'content_type': media.content_type, 'size': media.size,
            **({'rendition': name, 'fit': 'contain', 'output_width': job.output_width, 'output_height': job.output_height} if name != 'original' else {})}
    return result


def current_artifact(session, row):
    row.artifacts = current_artifacts(session, row)
    return row.artifacts[row.ziipa_rendition or 'original']


def review_manifest(row, artifact):
    result = {'schema': 1, 'campaign_id': row.id, 'owner_id': row.owner_id, 'revision': row.revision,
            'item_id': row.item_id, 'source_fingerprint': row.source_fingerprint, 'artifact': artifact,
            'source_visibility': row.source_visibility,
            'title': row.title, 'description': row.description, 'destinations': row.destinations,
            'schedule_at': stamp(row.schedule_at), 'options': row.options, 'transcript': row.transcript}
    if selected_renditions(row) != ['original'] or (row.ziipa_rendition or 'original') != 'original':
        result.update(schema=2, renditions=selected_renditions(row), ziipa_rendition=row.ziipa_rendition,
                      artifacts=row.artifacts)
    return result


def invalidate(row, status='draft', detail='Changes require fresh preparation and review.'):
    row.review_hash = ''; row.approved_hash = ''; row.approved_at = None
    row.artifact = None; row.artifacts = {}; row.status = status; row.detail = detail
    row.lease_token = ''; row.lease_until = None; row.next_run = None; row.attempts = 0
    row.updated_at = now()


def delivery_rows(session, row):
    return list(session.scalars(select(CampaignDelivery).where(CampaignDelivery.owner_id == row.owner_id,
                CampaignDelivery.campaign_id == row.id).order_by(CampaignDelivery.campaign_revision, CampaignDelivery.provider)))


def delivery_receipt(row):
    return {key: getattr(row, key) for key in ('id', 'provider', 'target_id', 'privacy', 'status', 'detail', 'rendition', 'published_item_id',
            'publishing_job_id', 'external_id', 'external_url', 'attempts')} | {'revision': row.campaign_revision, 'updated_at': stamp(row.updated_at)}


def receipt(row, session):
    return {key: getattr(row, key) for key in ('id', 'item_id', 'name', 'title', 'description', 'destinations', 'revision',
            'status', 'detail', 'render_job_id', 'artifact', 'review_hash', 'transcript', 'generated_copy')} | {
            **(row.options or {}), 'schedule_at': stamp(row.schedule_at), 'approved_at': stamp(row.approved_at),
            'ziipa_published_at': stamp(row.ziipa_published_at), 'transcript_hash': digest(row.transcript or {}),
            'published_item_id': row.published_item_id,
            'renditions': selected_renditions(row), 'ziipa_rendition': row.ziipa_rendition or 'original',
            'render_jobs': render_job_map(row), 'artifacts': row.artifacts or ({'original': row.artifact} if row.artifact else {}),
            'published_items': published_item_map(row),
            'created_at': stamp(row.created_at), 'updated_at': stamp(row.updated_at),
            'deliveries': [delivery_receipt(d) for d in delivery_rows(session, row)]}


def require_revision(row, revision):
    if row.revision != revision:
        raise HTTPException(409, 'This campaign changed. Reload it before continuing.')


def require_mutable(row):
    if row.status in ('cancelled', 'completed', 'partial') or row.published_item_id or row.ziipa_published_at or row.published_items:
        raise HTTPException(409, 'Preserve this finished campaign and its receipts. Create a new campaign for another version.')


def validate_publishing_authority(session, owner_id, data):
    """Recheck immediately at the publisher's durable pre-write checkpoint."""
    if data.campaign_id is None:
        return
    owner_lock(session, owner_id)
    row = owned(session, owner_id, data.campaign_id, True)
    artifact = current_artifact(session, row)
    if (row.status not in ('scheduled', 'delivering') or row.revision != data.campaign_revision
            or row.approved_hash != data.campaign_approval_hash or not row.approved_hash
            or digest(review_manifest(row, artifact)) != row.approved_hash
            or not row.ziipa_published_at or not row.schedule_at or aware(row.schedule_at) > now()):
        raise HTTPException(409, 'Campaign authority was paused, changed or revoked before provider handoff.')
    item, _ = source(session, row)
    delivery = session.scalar(select(CampaignDelivery).where(CampaignDelivery.owner_id == owner_id,
                CampaignDelivery.campaign_id == row.id, CampaignDelivery.campaign_revision == row.revision,
                CampaignDelivery.request_id == str(data.idempotency_key)))
    name = (delivery.rendition or 'original') if delivery else 'original'
    artifact = row.artifacts.get(name) if row.artifacts else artifact if name == 'original' else None
    post_id = published_item_map(row).get(name)
    published = session.get(CreatorItem, post_id) if post_id else None
    visibility = 'published' if name == (row.ziipa_rendition or 'original') else 'draft'
    if (not delivery or delivery.approval_hash != row.approved_hash or delivery.status not in ('sending', 'processing')
            or item.visibility != row.source_visibility or not artifact or not published or published.owner_id != owner_id
            or published.visibility != visibility or published.data.get('media_id') != artifact['media_id']
            or str(data.item_id) != post_id or delivery.published_item_id not in (None, post_id) or data.render_id is not None
            or str(data.expected_media_id) != artifact['media_id']
            or data.expected_source_sha256 != artifact['output_sha256']
            or (data.provider, data.expected_target_id, data.privacy, data.made_for_kids) !=
               (delivery.provider, delivery.target_id, delivery.privacy, delivery.made_for_kids)
            or data.title != row.title or data.description != row.description):
        raise HTTPException(409, 'The provider handoff no longer matches its exact campaign approval.')


def validate_job_campaign_authority(session, job):
    """Staged adapter polls can publish; never advance revoked campaign work."""
    if job is None:
        raise HTTPException(404, 'The provider delivery receipt was removed.')
    delivery = session.scalar(select(CampaignDelivery).where(CampaignDelivery.owner_id == job.owner_id,
                CampaignDelivery.request_id == job.idempotency_key))
    if not delivery:
        return  # Ordinary explicitly reviewed Publishing jobs keep their behavior.
    from social_publishing import PublishInput
    row = owned(session, job.owner_id, delivery.campaign_id)
    current_artifact(session, row)
    name = delivery.rendition or 'original'
    artifact = row.artifacts[name]
    validate_publishing_authority(session, job.owner_id, PublishInput(item_id=published_item_map(row)[name],
        expected_media_id=artifact['media_id'], expected_source_sha256=artifact['output_sha256'],
        expected_target_id=delivery.target_id, render_id=None, provider=delivery.provider,
        idempotency_key=delivery.request_id, privacy=delivery.privacy, made_for_kids=delivery.made_for_kids,
        consent=True, title=row.title, description=row.description, campaign_id=row.id,
        campaign_revision=delivery.campaign_revision, campaign_approval_hash=delivery.approval_hash))


def require_worker():
    if not config.enabled:
        raise HTTPException(503, 'Creation campaigns are disabled until their worker is configured and accepted.')
    try:
        ready = bool(cache.get(heartbeat_key()))
    except Exception:
        ready = False
    if not ready:
        raise HTTPException(503, 'The campaign workflow worker is not ready. Your private draft remains saved.')


@router.get('/config')
def configuration():
    import social_publishing as publishing
    try:
        value = cache.get(heartbeat_key())
        capabilities = json.loads(value) if value else {}
    except Exception:
        capabilities = {}
    ready = bool(capabilities)
    return {'enabled': config.enabled, 'worker_ready': ready, 'can_prepare': config.enabled and ready,
            'background_publishing_ready': bool(config.enabled and ready and capabilities.get('publish_providers')),
            'providers': [publishing.readiness(p) for p in ('youtube', 'bluesky', 'facebook', 'instagram', 'tiktok', 'twitch')],
            'worker_publish_providers': capabilities.get('publish_providers', []),
            'scope': 'one_saved_edit_multiple_contain_renditions',
            'renditions': [rendition_descriptor(name) for name in RENDITIONS], 'rendition_fit': 'contain',
            'notice': 'One reviewed Studio MP4; transcript text does not silently edit captions. TikTok requires its current creator review in Publishing; Twitch uses Live controls. No posting runs before exact export, account, privacy and schedule approval.'}


@router.get('')
@router.get('/')
def list_campaigns(user: User = Depends(current_user), session: Session = Depends(db)):
    return [receipt(row, session) for row in session.scalars(select(CreationCampaign).where(CreationCampaign.owner_id == user.id).order_by(CreationCampaign.created_at.desc()).limit(MAX_CAMPAIGNS))]


OPTION_KEYS = ('rights_confirmed', 'soundtrack_rights_confirmed', 'request_transcription', 'transcription_consent',
               'generate_copy', 'manual_transcript', 'manual_segments')


@router.post('', dependencies=[Depends(guard)])
@router.post('/', dependencies=[Depends(guard)])
def create_campaign(data: CampaignInput, user: User = Depends(current_user), session: Session = Depends(db)):
    owner_lock(session, user.id)
    value = data.model_dump(mode='json')
    fingerprint = digest(value)
    existing = session.scalar(select(CreationCampaign).where(CreationCampaign.owner_id == user.id, CreationCampaign.request_id == str(data.request_id)))
    if existing:
        if existing.request_hash != fingerprint:
            raise HTTPException(409, 'This request identifier already belongs to a different campaign.')
        return receipt(existing, session)
    if session.scalar(select(func.count()).select_from(CreationCampaign).where(CreationCampaign.owner_id == user.id)) >= MAX_CAMPAIGNS:
        raise HTTPException(429, 'You can keep up to 30 campaigns.')
    row = CreationCampaign(owner_id=user.id, request_id=str(data.request_id), request_hash=fingerprint,
                item_id=str(data.item_id), name=data.name, title=data.title, description=data.description,
                destinations=value['destinations'], schedule_at=data.schedule_at, options={key: value[key] for key in OPTION_KEYS})
    row.renditions = list(data.renditions); row.ziipa_rendition = data.ziipa_rendition
    source(session, row)
    session.add(row); session.flush()
    record_activity(session, user.id, 'campaign.created', 'Saved a private creation campaign.', details={'item_id': row.item_id})
    session.commit()
    return receipt(row, session)


@router.get('/{campaign_id}')
def get_campaign(campaign_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    return receipt(owned(session, user.id, campaign_id), session)


@router.patch('/{campaign_id}', dependencies=[Depends(guard)])
def edit_campaign(campaign_id: uuid.UUID, data: CampaignPatch, user: User = Depends(current_user), session: Session = Depends(db)):
    owner_lock(session, user.id)
    row = owned(session, user.id, campaign_id, True); require_revision(row, data.revision)
    require_mutable(row)
    if any(d.publishing_job_id or d.status in ('sending', 'processing', 'delivered', 'uncertain') for d in delivery_rows(session, row)):
        raise HTTPException(409, 'A delivery has started. Preserve its receipts and create a new campaign for different content.')
    previous = {key: getattr(row, key) for key in ('name', 'title', 'description', 'destinations', 'schedule_at')}
    previous.update(renditions=selected_renditions(row), ziipa_rendition=row.ziipa_rendition or 'original')
    previous['schedule_at'] = aware(row.schedule_at)
    previous.update(row.options or {}, request_id=row.request_id, item_id=row.item_id)
    try:
        value = CampaignInput.model_validate({**previous, **data.model_dump(exclude={'revision'}, exclude_unset=True)})
    except ValidationError:
        raise HTTPException(422, 'Choose valid bounded campaign copy, destinations and an offset-aware schedule.') from None
    serialized = value.model_dump(mode='json')
    for key in ('name', 'title', 'description', 'schedule_at'):
        setattr(row, key, getattr(value, key))
    row.destinations = serialized['destinations']; row.options = {key: serialized[key] for key in OPTION_KEYS}
    row.renditions = list(value.renditions); row.ziipa_rendition = value.ziipa_rendition
    row.render_jobs = {}; row.render_job_id = None
    for delivery in delivery_rows(session, row):
        if delivery.status not in DELIVERY_FINAL:
            delivery.status = 'cancelled'; delivery.detail = 'The reviewed campaign changed before handoff.'
    row.revision += 1; invalidate(row)
    session.commit(); notify()
    return receipt(row, session)


@router.post('/{campaign_id}/prepare', dependencies=[Depends(guard)])
def prepare_campaign(campaign_id: uuid.UUID, data: RevisionInput, user: User = Depends(current_user), session: Session = Depends(db)):
    require_worker(); owner_lock(session, user.id)
    row = owned(session, user.id, campaign_id, True); require_revision(row, data.revision)
    require_mutable(row)
    if row.status in ('queued', 'preparing'):
        return receipt(row, session)
    if row.status in ('scheduled', 'delivering', 'completed', 'partial') or any(d.publishing_job_id for d in delivery_rows(session, row)):
        raise HTTPException(409, 'Preserve this approved campaign and its delivery receipts. Create a new campaign to prepare another version.')
    if not row.options.get('rights_confirmed'):
        raise HTTPException(422, 'Confirm your right to use and distribute this video before preparation.')
    item, fingerprint = source(session, row)
    if session.bind.dialect.name == 'postgresql':
        from sqlalchemy import text
        session.execute(text('SELECT pg_advisory_xact_lock(25413261051740167)'))
    if session.scalar(select(func.count()).select_from(CreationCampaign).where(CreationCampaign.status.in_(ACTIVE))) >= 30:
        raise HTTPException(429, 'The campaign queue is full. Wait for an existing campaign.')
    invalidate(row, 'queued', 'Queued private render preparation. Nothing is published.')
    row.source_fingerprint = fingerprint; row.source_visibility = item.visibility
    row.render_job_id = None; row.render_jobs = {}; row.next_run = now()
    session.commit(); notify()
    return receipt(row, session)


@router.post('/{campaign_id}/review', dependencies=[Depends(guard)])
def review_campaign(campaign_id: uuid.UUID, data: RevisionInput, user: User = Depends(current_user), session: Session = Depends(db)):
    owner_lock(session, user.id)
    row = owned(session, user.id, campaign_id, True); require_revision(row, data.revision)
    require_mutable(row)
    if row.approved_hash:
        raise HTTPException(409, 'This campaign is already approved. Preserve its existing approval and receipts.')
    artifact = current_artifact(session, row)
    row.artifact = artifact; row.review_hash = digest(review_manifest(row, artifact))
    row.status = 'review'; row.detail = 'Review this exact export, copy, transcript, destinations, privacy and schedule before approval.'
    row.next_run = None; row.lease_token = ''; row.lease_until = None; row.updated_at = now()
    session.commit()
    return receipt(row, session)


@router.get('/{campaign_id}/preview')
def preview_campaign(campaign_id: uuid.UUID, rendition: Rendition | None = None, user: User = Depends(current_user), session: Session = Depends(db)):
    from fastapi import Response
    from render_api import export_render
    row = owned(session, user.id, campaign_id)
    artifacts = current_artifacts(session, row)
    name = rendition or row.ziipa_rendition or 'original'
    if name not in artifacts:
        raise HTTPException(404, 'This rendition is not part of your campaign.')
    return export_render(uuid.UUID(artifacts[name]['render_id']), Response(), user, session)


@router.post('/{campaign_id}/apply-captions', dependencies=[Depends(guard)])
def apply_captions(campaign_id: uuid.UUID, data: CaptionApproval, user: User = Depends(current_user), session: Session = Depends(db)):
    require_worker(); owner_lock(session, user.id)
    row = owned(session, user.id, campaign_id, True); require_revision(row, data.revision)
    require_mutable(row)
    if not row.options.get('rights_confirmed'):
        raise HTTPException(422, 'Confirm your rights before applying captions and rendering this video.')
    if row.approved_hash or any(d.publishing_job_id for d in delivery_rows(session, row)):
        raise HTTPException(409, 'Do not change an approved export. Create a new campaign for another caption version.')
    item, fingerprint = source(session, row)
    if fingerprint != row.source_fingerprint or digest(row.transcript or {}) != data.transcript_hash:
        raise HTTPException(409, 'The source or transcript changed. Prepare and review the current cues again.')
    from creator import ItemInput
    cues = [Caption.model_validate(c).model_dump() for c in (row.transcript or {}).get('segments', [])]
    if not cues or len(cues) > 100:
        raise HTTPException(422, 'Review between one and 100 timed caption cues before applying them.')
    try:
        parsed = ItemInput.model_validate({**item.data, 'captions': cues})
    except ValidationError:
        raise HTTPException(422, 'The current Studio edit and reviewed captions are invalid. Correct them in Studio first.') from None
    item.data = {**item.data, 'captions': parsed.model_dump(mode='json')['captions']}
    row.options = {**row.options, 'manual_transcript': row.transcript.get('text', ''),
                   'manual_segments': cues, 'request_transcription': False}
    row.revision += 1
    invalidate(row, 'queued', 'Applied your reviewed captions to Studio and queued a fresh private export.')
    _, row.source_fingerprint = source(session, row)
    row.render_job_id = None; row.render_jobs = {}; row.next_run = now()
    record_activity(session, user.id, 'campaign.captions_applied', 'Applied explicitly reviewed timed captions to Studio.', details={'item_id': row.item_id})
    session.commit(); notify()
    return receipt(row, session)


@router.post('/{campaign_id}/approve', dependencies=[Depends(guard)])
def approve_campaign(campaign_id: uuid.UUID, data: ApprovalInput, user: User = Depends(current_user), session: Session = Depends(db)):
    require_worker(); owner_lock(session, user.id)
    row = owned(session, user.id, campaign_id, True); require_revision(row, data.revision)
    if row.approved_hash == data.review_hash and row.status not in ('cancelled', 'needs_review'):
        return receipt(row, session)
    if row.status != 'review' or not data.consent or not data.publish_to_ziipa:
        raise HTTPException(422, 'Explicitly approve the reviewed export and Ziipa publication before scheduling destinations.')
    if not row.schedule_at:
        raise HTTPException(422, 'Choose an explicit schedule with a timezone before approval.')
    artifact = current_artifact(session, row)
    expected = digest(review_manifest(row, artifact))
    if data.review_hash != row.review_hash or expected != row.review_hash:
        raise HTTPException(409, 'The reviewed artifact or campaign changed. Review the exact current version again.')
    if not row.options.get('rights_confirmed'):
        raise HTTPException(422, 'Confirm your distribution rights before approval.')
    item, _ = source(session, row)
    if item.visibility != row.source_visibility:
        raise HTTPException(409, 'The source visibility changed. Prepare and review it again.')
    # Approval authorizes Ziipa publication at the due time, never immediately.
    row.approved_hash = expected; row.approved_at = now(); row.artifact = artifact
    row.status = 'scheduled'; row.detail = 'Approved for the selected schedule and exact destinations.'
    row.next_run = max(now(), aware(row.schedule_at)); row.updated_at = now()
    for target in row.destinations:
        session.add(CampaignDelivery(campaign_id=row.id, owner_id=user.id, campaign_revision=row.revision,
                    provider=target['provider'], target_id=target['target_id'], privacy=target['privacy'],
                    made_for_kids=target['made_for_kids'], rendition=target.get('rendition', 'original'), approval_hash=expected))
    record_activity(session, user.id, 'campaign.approved', 'Approved exact campaign artifact, destinations and schedule.', details={'item_id': row.item_id})
    session.commit(); notify()
    return receipt(row, session)


@router.post('/{campaign_id}/{operation}', dependencies=[Depends(guard)])
def control_campaign(campaign_id: uuid.UUID, operation: Literal['pause', 'resume', 'cancel', 'retry'], data: RevisionInput,
                     user: User = Depends(current_user), session: Session = Depends(db)):
    owner_lock(session, user.id)
    row = owned(session, user.id, campaign_id, True); require_revision(row, data.revision)
    if operation in ('resume', 'retry'):
        require_worker()
        if row.status == 'paused' and not row.approved_hash and row.paused_status in ('draft', 'review'):
            row.status = row.paused_status; row.detail = 'Returned to private campaign review. Nothing is scheduled.'
            row.updated_at = now(); session.commit()
            return receipt(row, session)
        if row.status == 'paused' and not row.approved_hash and row.paused_status in ('queued', 'preparing'):
            _, fingerprint = source(session, row)
            if fingerprint != row.source_fingerprint:
                raise HTTPException(409, 'The source changed while paused. Prepare the current version again.')
            row.status = 'queued'; row.next_run = now(); row.lease_token = ''; row.lease_until = None
            row.detail = 'Resumed private preparation. No publication is approved.'; row.updated_at = now()
            session.commit(); notify()
            return receipt(row, session)
        if row.status == 'cancelled' or not row.approved_hash:
            raise HTTPException(409, 'Prepare and approve the campaign before starting its deliveries.')
        artifact = current_artifact(session, row)
        if digest(review_manifest(row, artifact)) != row.approved_hash:
            raise HTTPException(409, 'This approved campaign changed. Prepare a fresh review.')
        from social_publishing import PublishingJob
        for delivery in delivery_rows(session, row):
            if delivery.status in ('uncertain', 'delivered', 'processing', 'needs_handoff'):
                continue
            job = session.get(PublishingJob, delivery.publishing_job_id) if delivery.publishing_job_id else None
            if job and job.status != 'failed':
                continue
            if delivery.attempts < 3:
                delivery.status = 'pending'; delivery.detail = 'Explicitly resumed before any verified provider handoff.'
        row.status = 'scheduled'; row.next_run = max(now(), aware(row.schedule_at)); row.detail = 'Resumed the same exact approved version; completed and uncertain receipts are never reposted.'
    else:
        if row.status in ('completed', 'cancelled'):
            return receipt(row, session)
        row.paused_status = row.status
        row.status = 'paused' if operation == 'pause' else 'cancelled'
        row.next_run = None; row.detail = 'No further deliveries will start. An already handed-off provider request cannot be recalled.'
        for delivery in delivery_rows(session, row):
            if delivery.status == 'pending':
                delivery.status = 'cancelled' if operation == 'cancel' else 'pending'
    row.lease_token = ''; row.lease_until = None; row.updated_at = now()
    session.commit(); notify()
    return receipt(row, session)


def export_campaigns_data(session, owner_id):
    return [receipt(row, session) for row in session.scalars(select(CreationCampaign).where(CreationCampaign.owner_id == owner_id))]


def delete_campaigns_data(session, owner_id):
    session.execute(delete(CampaignDelivery).where(CampaignDelivery.owner_id == owner_id))
    session.execute(delete(CreationCampaign).where(CreationCampaign.owner_id == owner_id))
