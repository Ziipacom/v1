"""Permission-bound Remix projects. Source identities are server-owned, not client attribution."""
from datetime import datetime, timezone
import math
import uuid

from fastapi import HTTPException
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, event, inspect, select
from sqlalchemy.orm import Mapped, mapped_column

from app import Base, User
from creator import CreatorItem, CreatorMedia, CreatorPreferences, ItemInput, account_allows_view
from render_services import MAX_INPUT_BYTES, RenderJob, snapshot_hash

MODES = ('stitch', 'split_screen', 'use_sound')
VIDEO_TYPES = ('video/mp4', 'video/quicktime', 'video/webm')
AUDIO_TYPES = ('audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg')
MAX_LINEAGE_DEPTH = 16


def now():
    return datetime.now(timezone.utc)


class RemixPolicy(Base):
    __tablename__ = 'remix_policies'
    item_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    revision: Mapped[int] = mapped_column(default=1)
    audience: Mapped[str] = mapped_column(String(12), default='disabled')
    modes: Mapped[list] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class RemixProject(Base):
    __tablename__ = 'remix_projects'
    __table_args__ = (UniqueConstraint('owner_id', 'request_id'),)
    item_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    request_id: Mapped[str] = mapped_column(String(36))
    request_hash: Mapped[str] = mapped_column(String(64))
    # These IDs deliberately have no FK to posts: deletion must not rewrite an
    # existing child's ancestry or silently turn it into an original.
    parent_id: Mapped[str] = mapped_column(String(36), index=True)
    root_id: Mapped[str] = mapped_column(String(36), index=True)
    source_owner_id: Mapped[int] = mapped_column()
    policy_revision: Mapped[int] = mapped_column()
    source_spec: Mapped[dict] = mapped_column(JSON)
    response_spec: Mapped[dict] = mapped_column(JSON)
    mode: Mapped[str] = mapped_column(String(16))
    source_start_ms: Mapped[int] = mapped_column()
    source_seconds_ms: Mapped[int] = mapped_column()
    job_id: Mapped[str] = mapped_column(String(36), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_media_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    result_sha256: Mapped[str] = mapped_column(String(64), default='')
    source_sha256: Mapped[str] = mapped_column(String(64), default='')
    response_sha256: Mapped[str] = mapped_column(String(64), default='')


IMMUTABLE_FIELDS = ('item_id', 'owner_id', 'request_id', 'request_hash', 'parent_id', 'root_id',
                    'source_owner_id', 'policy_revision', 'source_spec', 'response_spec', 'mode',
                    'source_start_ms', 'source_seconds_ms', 'job_id', 'created_at')


@event.listens_for(RemixProject, 'before_update')
def immutable_lineage(mapper, connection, target):
    if any(inspect(target).attrs[name].history.has_changes() for name in IMMUTABLE_FIELDS):
        raise ValueError('Remix source identity is immutable; create a new project.')
    for name in ('result_media_id', 'result_sha256', 'source_sha256', 'response_sha256', 'applied_at'):
        history = inspect(target).attrs[name].history
        if history.has_changes() and history.deleted and history.deleted[0] not in ('', None):
            raise ValueError('Remix output provenance cannot be replaced.')


def _fresh(session, model, identifier, lock=False):
    if lock:
        return session.scalar(select(model).where(model.__table__.primary_key.columns.values()[0] == identifier)
                              .with_for_update().execution_options(populate_existing=True))
    return session.get(model, identifier, populate_existing=True)


def _visible(session, item, viewer_id):
    from account_services import AccountState
    from admin_services import account_is_active, enforce_content_visible
    if not item or not account_is_active(session, viewer_id) or not account_is_active(session, item.owner_id):
        return False
    for uid in {viewer_id, item.owner_id}:
        session.get(CreatorPreferences, uid, populate_existing=True)
        session.get(AccountState, uid, populate_existing=True)
    try:
        enforce_content_visible(session, item)  # Moderation applies even to the source owner.
    except HTTPException:
        return False
    return (item.owner_id == viewer_id or item.visibility == 'published') and account_allows_view(session, item.owner_id, viewer_id)


def visible_item(session, item_id, viewer_id, *, lock=False):
    item = _fresh(session, CreatorItem, item_id, lock)
    if not _visible(session, item, viewer_id):
        raise HTTPException(404, 'This source is unavailable.')
    return item


def _rights(session, item):
    from personal_media import OSAssetMetadata, rights_json
    metadata = session.scalar(select(OSAssetMetadata).where(OSAssetMetadata.owner_id == item.owner_id,
                              OSAssetMetadata.item_id == item.id).execution_options(populate_existing=True))
    if metadata:
        try:
            rights = rights_json(metadata.rights)
        except Exception:
            raise HTTPException(409, 'Review the source rights before remixing.') from None
        if rights['expired']:
            raise HTTPException(409, 'The recorded source permission has expired.')


def source_spec(session, item):
    """Only the visible simple-trim region may be sampled, never hidden timeline cuts."""
    _rights(session, item)
    try:
        data = ItemInput.model_validate(item.data)
    except Exception:
        raise HTTPException(409, 'Save a valid source before enabling Remix.') from None
    if (data.photo_ids or data.timeline is not None or data.visual_effect != 'none' or data.captions
            or data.overlays or data.soundtrack):
        raise HTTPException(409, 'Export the edited source into a video before enabling Remix.')
    media = session.get(CreatorMedia, data.media_id, populate_existing=True) if data.media_id else None
    if not media or media.owner_id != item.owner_id or media.content_type not in VIDEO_TYPES + AUDIO_TYPES:
        raise HTTPException(409, 'Remix needs a saved video or audio source.')
    if not 0 < media.size <= MAX_INPUT_BYTES:
        raise HTTPException(409, 'The source exceeds the Remix media limit.')
    if not math.isfinite(data.trim_start) or not math.isfinite(data.trim_end or 0):
        raise HTTPException(409, 'The source trim is invalid.')
    return {'media': {'id': media.id, 'content_type': media.content_type, 'size': media.size},
            'trim_start': data.trim_start, 'trim_end': data.trim_end}


def policy_json(policy):
    return {'revision': policy.revision if policy else 0, 'audience': policy.audience if policy else 'disabled',
            'modes': list(policy.modes) if policy else []}


def permitted_modes(session, item, viewer_id):
    if item.visibility != 'published':
        return []
    policy = session.get(RemixPolicy, item.id, populate_existing=True)
    if item.owner_id == viewer_id:
        modes = list(MODES)
    elif not policy or policy.owner_id != item.owner_id or policy.audience == 'disabled':
        modes = []
    elif policy.audience == 'followers':
        from profile_follows import follows
        modes = list(policy.modes) if follows(session, viewer_id, item.owner_id) else []
    elif policy.audience == 'everyone':
        modes = list(policy.modes)
    else:
        modes = []
    spec = source_spec(session, item)
    return [mode for mode in MODES if mode in modes and (spec['media']['content_type'] in VIDEO_TYPES or mode == 'use_sound')]


def _authority(session, project, *, lock=False, seen=None, mutation=True, viewer_id=None):
    from admin_services import require_mutations_open
    seen = set() if seen is None else seen
    if project.item_id in seen or len(seen) >= MAX_LINEAGE_DEPTH:
        raise HTTPException(409, 'The source attribution chain is unavailable.')
    seen.add(project.item_id)
    owner = session.get(User, project.owner_id, populate_existing=True)
    if owner is None:
        raise HTTPException(409, 'The project owner is unavailable.')
    if mutation:
        require_mutations_open(session, owner)
    source = visible_item(session, project.parent_id, project.owner_id, lock=lock)
    if viewer_id is not None and not _visible(session, source, viewer_id):
        raise HTTPException(404, 'This source is unavailable to the viewer.')
    policy = _fresh(session, RemixPolicy, source.id, lock)
    if (source.owner_id != project.source_owner_id or (policy.revision if policy else 0) != project.policy_revision
            or project.mode not in permitted_modes(session, source, project.owner_id)
            or source_spec(session, source) != project.source_spec):
        raise HTTPException(409, 'The source or its Remix permission changed. Create a new project.')
    ancestor = session.get(RemixProject, source.id, populate_existing=True)
    if ancestor:
        if not ancestor.applied_at or source.data.get('media_id') != ancestor.result_media_id:
            raise HTTPException(409, 'The source Remix must be applied before reuse.')
        _authority(session, ancestor, lock=lock, seen=seen, mutation=mutation, viewer_id=viewer_id)
    return source


def expected_snapshot(project):
    return {'schema': 4, 'source': dict(project.response_spec), 'audio': None,
            'edit': {'trim_start': 0, 'trim_end': None, 'captions': [], 'overlays': [], 'soundtrack': None},
            'remix': {'mode': project.mode, 'source_start': project.source_start_ms / 1000,
                      'source_seconds': project.source_seconds_ms / 1000,
                      'source_owner_id': project.source_owner_id, 'source': dict(project.source_spec['media']),
                      'policy_revision': project.policy_revision}}


def validate_remix_job(session, job, *, lock=False):
    project = _fresh(session, RemixProject, job.item_id, lock)
    if not project or project.job_id != job.id or project.owner_id != job.owner_id:
        raise HTTPException(409, 'The Remix project is unavailable.')
    if job.snapshot != expected_snapshot(project) or snapshot_hash(job.snapshot) != job.input_fingerprint:
        raise HTTPException(409, 'The Remix render receipt changed.')
    _authority(session, project, lock=lock, viewer_id=project.owner_id)
    response = session.get(CreatorMedia, project.response_spec['id'], populate_existing=True)
    if (not response or response.owner_id != project.owner_id or
            {'id': response.id, 'content_type': response.content_type, 'size': response.size} != project.response_spec):
        raise HTTPException(409, 'The response source is unavailable.')
    item = _fresh(session, CreatorItem, project.item_id, lock)
    if not item or item.owner_id != project.owner_id:
        raise HTTPException(409, 'The Remix draft is unavailable.')
    if not project.applied_at:
        parsed = ItemInput.model_validate(item.data)
        if (item.visibility != 'draft' or parsed.media_id != response.id or parsed.remix_of != project.parent_id
                or parsed.trim_start or parsed.trim_end or parsed.timeline or parsed.captions or parsed.overlays
                or parsed.soundtrack or parsed.visual_effect != 'none' or parsed.photo_ids):
            raise HTTPException(409, 'The response draft changed. Create a new Remix.')
    else:
        _applied_output(session, project, item)


def current_source_fingerprint(session, job):
    try:
        validate_remix_job(session, job)
        return job.input_fingerprint
    except (HTTPException, ValueError, TypeError, KeyError):
        return None


def record_remix_provenance(session, job, *, source_sha256, response_sha256):
    for value in (source_sha256, response_sha256):
        if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
            raise ValueError('Invalid Remix source digest.')
    project = session.get(RemixProject, job.item_id)
    if not project or project.job_id != job.id:
        raise ValueError('Missing Remix provenance.')
    if project.source_sha256 not in ('', source_sha256) or project.response_sha256 not in ('', response_sha256):
        raise ValueError('Remix source bytes changed.')
    project.source_sha256, project.response_sha256 = source_sha256, response_sha256


def _applied_output(session, project, item):
    job = session.get(RenderJob, project.job_id, populate_existing=True)
    output = session.get(CreatorMedia, project.result_media_id, populate_existing=True) if project.result_media_id else None
    if (not project.applied_at or item.data.get('media_id') != project.result_media_id or not output
            or output.owner_id != project.owner_id or output.content_type != 'video/mp4'
            or not job or job.status != 'ready' or job.output_media_id != output.id
            or job.output_sha256 != project.result_sha256):
        raise HTTPException(409, 'Apply the verified completed Remix before publishing.')
    if item.data.get('remix_of') != project.parent_id:
        raise HTTPException(409, 'Remix attribution cannot be replaced.')


def enforce_remix_publication(session, item):
    project = session.get(RemixProject, item.id, populate_existing=True)
    if project:
        _authority(session, project, viewer_id=project.owner_id)
        _applied_output(session, project, item)


def remix_is_visible(session, item, viewer_id=None):
    if item.owner_id == viewer_id:
        return True
    try:
        project = session.get(RemixProject, item.id, populate_existing=True)
        if project:
            # Anonymous publication is deliberately unsupported for licensed
            # derivatives. Authenticated viewers must see every ancestor.
            if viewer_id is None:
                return False
            _authority(session, project, mutation=False, viewer_id=viewer_id)
            _applied_output(session, project, item)
        return True
    except HTTPException:
        return False


def guard_item_update(session, user, row, data):
    project = session.get(RemixProject, row.id, populate_existing=True) if row else None
    if project:
        if data.remix_of != project.parent_id:
            raise HTTPException(409, 'This project keeps its original Remix attribution.')
        if project.applied_at and data.media_id != project.result_media_id:
            raise HTTPException(409, 'A Remix keeps its applied media. Create another project to replace it.')
        if data.visibility == 'published':
            enforce_remix_publication(session, row)
    elif data.remix_of and (row is None or data.remix_of != row.data.get('remix_of')):
        raise HTTPException(409, 'Use Remix to create verified attribution. Existing saved attribution stays editable.')
    if data.media_id and is_derived_media(session, data.media_id) and not (
            project and project.applied_at and data.media_id == project.result_media_id):
        raise HTTPException(409, 'Open the original Remix project to keep its source attribution and permissions.')


def is_derived_media(session, media_id):
    return bool(session.scalar(select(RenderJob.id).where(RenderJob.output_media_id == str(media_id),
                    RenderJob.snapshot['schema'].as_integer() == 4).limit(1)))


def is_remix_item(session, item_id):
    if session.get(RemixProject, str(item_id)):
        return True
    item = session.get(CreatorItem, str(item_id))
    return bool(item and item.data.get('media_id') and is_derived_media(session, item.data['media_id']))


def assert_external_export_allowed(session, item_id):
    if is_remix_item(session, item_id):
        raise HTTPException(409, 'Remix permission covers Ziipa posts only. External export needs separate source permission.')


def project_receipt(session, project):
    job = session.get(RenderJob, project.job_id, populate_existing=True)
    status, detail = ('failed', 'The render receipt is unavailable.') if job is None else (job.status, job.detail)
    if job:
        if current_source_fingerprint(session, job) != job.input_fingerprint:
            status, detail = 'stale', 'The source, permission or draft changed. Create a new Remix.'
        elif project.applied_at:
            status, detail = 'applied', 'The Remix is saved as your editable draft. Review it before publishing.'
    return {'item_id': project.item_id, 'job_id': project.job_id, 'status': status, 'detail': detail}


def attribution_item(session, identifier, viewer_id):
    item = session.get(CreatorItem, identifier, populate_existing=True)
    if not _visible(session, item, viewer_id) or not remix_is_visible(session, item, viewer_id):
        return None
    owner = session.get(User, item.owner_id)
    return {'id': item.id, 'title': str(item.data.get('title', ''))[:140], 'creator': owner.name}


def item_info(session, item, viewer_id):
    from render_services import readiness
    project = session.get(RemixProject, item.id, populate_existing=True)
    policy = session.get(RemixPolicy, item.id, populate_existing=True)
    try:
        if project:
            enforce_remix_publication(session, item)
        modes = permitted_modes(session, item, viewer_id)
    except HTTPException:
        modes = []
    children = []
    ids = session.scalars(select(RemixProject.item_id).where(RemixProject.parent_id == item.id)
                          .order_by(RemixProject.created_at.desc()).limit(60))
    for identifier in ids:
        child = attribution_item(session, identifier, viewer_id)
        if child:
            children.append(child)
        if len(children) == 20:
            break
    return {'available': bool(modes) and bool(readiness().get('can_remix')),
            'allowed_modes': modes, 'policy': policy_json(policy) if item.owner_id == viewer_id else None,
            'attribution': {'parent': attribution_item(session, project.parent_id, viewer_id),
                            'root': attribution_item(session, project.root_id, viewer_id)} if project else None,
            'children': children}


def delete_remix_data(session, owner_id):
    session.execute(delete(RemixPolicy).where(RemixPolicy.owner_id == owner_id))
    session.execute(delete(RemixProject).where(RemixProject.owner_id == owner_id))


def export_remix_data(session, owner_id):
    projects = session.scalars(select(RemixProject).where(RemixProject.owner_id == owner_id).limit(500)).all()
    return {'policies': [{'item_id': row.item_id, **policy_json(row)} for row in
                        session.scalars(select(RemixPolicy).where(RemixPolicy.owner_id == owner_id).limit(500))],
            'projects': [{'item_id': row.item_id, 'parent_id': row.parent_id, 'root_id': row.root_id,
                          'mode': row.mode, 'source_media_id': row.source_spec['media']['id'],
                          'policy_revision': row.policy_revision, 'source_start_ms': row.source_start_ms,
                          'source_seconds_ms': row.source_seconds_ms, 'result_media_id': row.result_media_id,
                          'result_sha256': row.result_sha256, 'source_sha256': row.source_sha256,
                          'response_sha256': row.response_sha256} for row in projects]}
