"""Owner-controlled library, explicit memory, goals and creator accounting.

These records are private workspace data. Rights and revenue are user statements,
not legal verification or evidence of a payment. No endpoint fetches a URL or
infers personal facts, and no external analytics are manufactured.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import re
from typing import Literal
from urllib.parse import urlsplit
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, func, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard
from creator import CreatorComment, CreatorDistribution, CreatorItem, CreatorMedia, CreatorPreferences, serialize_item

router = APIRouter(prefix='/api/os', dependencies=[Depends(current_user)])
Status = Literal['active', 'paused', 'completed']


def now():
    return datetime.now(timezone.utc)


class OSProject(Base):
    __tablename__ = 'os_projects'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    name: Mapped[str] = mapped_column(String(140))
    description: Mapped[str] = mapped_column(String(3000), default='')
    status: Mapped[str] = mapped_column(String(16), default='active')
    asset_ids: Mapped[list] = mapped_column(JSON, default=list)
    goal_ids: Mapped[list] = mapped_column(JSON, default=list)
    revision: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OSAssetMetadata(Base):
    __tablename__ = 'os_asset_metadata'
    __table_args__ = (UniqueConstraint('owner_id', 'item_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    notes: Mapped[str] = mapped_column(String(3000), default='')
    tags: Mapped[list] = mapped_column(JSON, default=list)
    rights: Mapped[dict] = mapped_column(JSON, default=dict)
    revision: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OSMemory(Base):
    __tablename__ = 'os_memories'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    body: Mapped[str] = mapped_column(String(2000))
    source: Mapped[str] = mapped_column(String(16), default='user')
    revision: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OSGoal(Base):
    __tablename__ = 'os_goals'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    title: Mapped[str] = mapped_column(String(140))
    description: Mapped[str] = mapped_column(String(3000), default='')
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default='active')
    steps: Mapped[list] = mapped_column(JSON, default=list)
    revision: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OSRevenueEntry(Base):
    __tablename__ = 'os_revenue_entries'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    amount_minor: Mapped[int]
    currency: Mapped[str] = mapped_column(String(3))
    type: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(12))
    category: Mapped[str] = mapped_column(String(80), default='other')
    note: Mapped[str] = mapped_column(String(1000), default='')
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    item_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    provenance: Mapped[str] = mapped_column(String(20), default='user_reported')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OSActivity(Base):
    __tablename__ = 'os_activity'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    kind: Mapped[str] = mapped_column(String(60))
    summary: Mapped[str] = mapped_column(String(280))
    status: Mapped[str] = mapped_column(String(24), default='completed')
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


def clean_text(value: str) -> str:
    # Preserve paragraphs, remove control characters and trim whitespace.
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', value).strip()


def aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def iso(value):
    return aware(value).isoformat() if value is not None else None


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

    @field_validator('*', mode='before')
    @classmethod
    def strip_controls(cls, value):
        return clean_text(value) if isinstance(value, str) else value


class RightsInput(Input):
    basis: Literal['original', 'licensed', 'permission', 'unknown'] = 'unknown'
    license_note: str = Field(default='', max_length=1000)
    source_url: str = Field(default='', max_length=500)
    expires_at: datetime | None = None
    allow_ai: bool = False

    @field_validator('source_url')
    @classmethod
    def safe_url(cls, value):
        if not value:
            return value
        try:
            parsed = urlsplit(value)
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                    or parsed.port not in (None, 443) or any(ch in value for ch in ('\\', '\r', '\n', '\t'))):
                raise ValueError('Use a direct HTTPS source URL without credentials')
        except ValueError:
            raise ValueError('Use a direct HTTPS source URL without credentials') from None
        return value

    @field_validator('expires_at')
    @classmethod
    def expires_aware(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError('Use an expiry date with a timezone')
        return aware(value)

    @model_validator(mode='after')
    def ai_requires_rights(self):
        if self.basis == 'unknown' and self.allow_ai:
            raise ValueError('AI use requires an explicit rights basis')
        return self


class ProjectInput(Input):
    name: str = Field(min_length=1, max_length=140)
    description: str = Field(default='', max_length=3000)
    status: Status = 'active'
    asset_ids: list[str] = Field(default_factory=list, max_length=500)
    goal_ids: list[str] = Field(default_factory=list, max_length=200)

    @field_validator('asset_ids', 'goal_ids')
    @classmethod
    def identifiers(cls, values):
        if len(set(values)) != len(values):
            raise ValueError('Choose each record once')
        return [str(uuid.UUID(value)) for value in values]


class ProjectPatch(Input):
    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=140)
    description: str | None = Field(default=None, max_length=3000)
    status: Status | None = None
    asset_ids: list[str] | None = Field(default=None, max_length=500)
    goal_ids: list[str] | None = Field(default=None, max_length=200)


class AssetInput(Input):
    revision: int = Field(ge=0)
    notes: str = Field(default='', max_length=3000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    project_id: str | None = None
    rights: RightsInput = Field(default_factory=RightsInput)

    @field_validator('tags')
    @classmethod
    def tags_clean(cls, values):
        values = [clean_text(value) for value in values]
        if any(not value or len(value) > 40 for value in values):
            raise ValueError('Tags need 1 to 40 characters')
        return list(dict.fromkeys(values))


class MemoryInput(Input):
    kind: Literal['preference', 'style', 'context']
    body: str = Field(min_length=1, max_length=2000)
    source: Literal['user'] = 'user'


class MemoryPatch(Input):
    revision: int = Field(ge=1)
    kind: Literal['preference', 'style', 'context'] | None = None
    body: str | None = Field(default=None, min_length=1, max_length=2000)


class GoalStep(Input):
    id: str = Field(min_length=1, max_length=36, pattern=r'^[A-Za-z0-9_-]+$')
    title: str = Field(min_length=1, max_length=140)
    completed: bool = False


class GoalInput(Input):
    title: str = Field(min_length=1, max_length=140)
    description: str = Field(default='', max_length=3000)
    project_id: str | None = None
    due_at: datetime | None = None
    status: Status = 'active'
    steps: list[GoalStep] = Field(default_factory=list, max_length=50)

    @field_validator('due_at')
    @classmethod
    def due_aware(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError('Use a due date with a timezone')
        return aware(value)

    @model_validator(mode='after')
    def unique_steps(self):
        if len(set(step.id for step in self.steps)) != len(self.steps):
            raise ValueError('Goal step identifiers must be unique')
        return self


class GoalPatch(Input):
    revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=140)
    description: str | None = Field(default=None, max_length=3000)
    project_id: str | None = None
    due_at: datetime | None = None
    status: Status | None = None
    steps: list[GoalStep] | None = Field(default=None, max_length=50)


class RevenueInput(Input):
    amount_minor: int = Field(ge=0, le=1_000_000_000, strict=True)
    currency: str = Field(pattern=r'^[A-Z]{3}$')
    type: Literal['income', 'expense']
    status: Literal['received', 'expected'] = 'received'
    category: str = Field(default='other', min_length=1, max_length=80)
    note: str = Field(default='', max_length=1000)
    occurred_at: datetime
    item_id: str | None = None

    @field_validator('occurred_at')
    @classmethod
    def occurred_aware(cls, value):
        if value.tzinfo is None:
            raise ValueError('Use a revenue date with a timezone')
        return aware(value)


def owned(session, model, identifier, owner_id):
    try:
        identifier = str(uuid.UUID(identifier))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(404, 'Record not found') from None
    row = session.scalar(select(model).where(model.id == identifier, model.owner_id == owner_id))
    if row is None:
        raise HTTPException(404, 'Record not found')
    return row


def optional_project(session, identifier, owner_id):
    return owned(session, OSProject, identifier, owner_id).id if identifier else None


def enforce_count(session, model, owner_id, maximum):
    count = session.scalar(select(func.count()).select_from(model).where(model.owner_id == owner_id))
    if count >= maximum:
        raise HTTPException(409, 'Workspace record limit reached. Remove an old record before adding another.')


def project_json(row):
    return {'id': row.id, 'name': row.name, 'description': row.description, 'status': row.status,
            'asset_ids': row.asset_ids, 'goal_ids': row.goal_ids, 'revision': row.revision,
            'created_at': iso(row.created_at), 'updated_at': iso(row.updated_at)}


def memory_json(row):
    return {'id': row.id, 'kind': row.kind, 'body': row.body, 'source': row.source,
            'revision': row.revision, 'created_at': iso(row.created_at), 'updated_at': iso(row.updated_at)}


def goal_json(row):
    completed = sum(bool(step.get('completed')) for step in row.steps)
    return {'id': row.id, 'title': row.title, 'description': row.description, 'project_id': row.project_id,
            'due_at': iso(row.due_at), 'status': row.status, 'steps': row.steps, 'revision': row.revision,
            'progress': {'completed': completed, 'total': len(row.steps),
                         'percent': round(100 * completed / len(row.steps)) if row.steps else 0},
            'created_at': iso(row.created_at), 'updated_at': iso(row.updated_at)}


def rights_json(value):
    rights = RightsInput.model_validate(value or {}).model_dump(mode='json')
    expiry = RightsInput.model_validate(value or {}).expires_at
    expired = bool(expiry and expiry <= now())
    rights.update(provenance='user_reported', expired=expired,
                  effective_allow_ai=bool(rights['allow_ai'] and rights['basis'] != 'unknown' and not expired))
    return rights


def metadata_json(row):
    return {'item_id': row.item_id, 'notes': row.notes, 'tags': row.tags, 'project_id': row.project_id,
            'rights': rights_json(row.rights), 'revision': row.revision,
            'created_at': iso(row.created_at), 'updated_at': iso(row.updated_at)}


def default_metadata(item_id):
    return {'item_id': item_id, 'notes': '', 'tags': [], 'project_id': None,
            'rights': rights_json({}), 'revision': 0, 'created_at': None, 'updated_at': None}


def revenue_json(row):
    return {'id': row.id, 'amount_minor': row.amount_minor, 'currency': row.currency, 'type': row.type,
            'status': row.status, 'category': row.category, 'note': row.note, 'occurred_at': iso(row.occurred_at),
            'item_id': row.item_id, 'provenance': row.provenance, 'created_at': iso(row.created_at)}


DETAIL_KEYS = frozenset({'item_id', 'project_id', 'goal_id', 'workflow_id', 'run_id', 'action_id', 'proposal_id', 'task_id',
                         'job_id', 'memory_id', 'entry_id', 'provider', 'providers', 'count', 'counts', 'source',
                         'trigger', 'scheduled_at', 'status', 'revision', 'reason', 'permission', 'tool'})


def sanitized_details(details):
    """Allow only operational identifiers and bounded scalar details, never secrets or memory bodies."""
    result = {}
    for key, value in (details or {}).items():
        if key not in DETAIL_KEYS:
            continue
        if isinstance(value, (bool, int, float)) or value is None:
            result[key] = value
        elif isinstance(value, str):
            result[key] = clean_text(value)[:180]
        elif isinstance(value, list):
            result[key] = [clean_text(v)[:60] for v in value[:10] if isinstance(v, str)]
        elif key == 'counts' and isinstance(value, dict):
            result[key] = {clean_text(k)[:40]: v for k, v in list(value.items())[:10]
                           if isinstance(k, str) and isinstance(v, int) and 0 <= v <= 1_000_000_000}
    return result


def record_activity(session, user_id, kind, summary, status='completed', details=None):
    row = OSActivity(owner_id=user_id, kind=clean_text(kind)[:60], summary=clean_text(summary)[:280],
                     status=clean_text(status)[:24], details=sanitized_details(details))
    session.add(row)
    return row


def activity_json(row):
    return {'id': row.id, 'kind': row.kind, 'summary': row.summary, 'status': row.status,
            'details': sanitized_details(row.details), 'created_at': iso(row.created_at)}


def revision_update(session, row, revision, values):
    result = session.execute(update(type(row)).where(type(row).id == row.id,
                            type(row).owner_id == row.owner_id, type(row).revision == revision)
                            .values(**values, revision=revision + 1, updated_at=now()))
    if result.rowcount != 1:
        raise HTTPException(409, 'This record changed. Reload it before saving your edits.')
    session.flush()
    session.refresh(row)


def merged_input(schema, row_data, patch):
    from pydantic import ValidationError
    try:
        return schema.model_validate({**row_data, **patch.model_dump(exclude_unset=True, exclude={'revision'})})
    except ValidationError:
        raise HTTPException(422, 'Invalid workspace changes') from None


def validate_project_refs(session, data, owner_id):
    for identifier in data.asset_ids:
        owned(session, CreatorItem, identifier, owner_id)
    for identifier in data.goal_ids:
        owned(session, OSGoal, identifier, owner_id)


def list_rows(session, model, owner_id):
    timestamp = getattr(model, 'created_at', None)
    if timestamp is None:
        timestamp = getattr(model, 'updated_at', None)
    ordering = (timestamp.desc(), model.id) if timestamp is not None else (model.id,)
    return session.scalars(select(model).where(model.owner_id == owner_id).order_by(*ordering)).all()


@router.get('/projects')
def projects(user: User = Depends(current_user), session: Session = Depends(db)):
    return [project_json(row) for row in list_rows(session, OSProject, user.id)]


@router.post('/projects', status_code=201, dependencies=[Depends(guard)])
def add_project(data: ProjectInput, user: User = Depends(current_user), session: Session = Depends(db)):
    enforce_count(session, OSProject, user.id, 100)
    validate_project_refs(session, data, user.id)
    row = OSProject(owner_id=user.id, **data.model_dump())
    session.add(row); session.flush()
    record_activity(session, user.id, 'project.created', 'Created a project', details={'project_id': row.id})
    session.commit()
    return project_json(row)


@router.patch('/projects/{project_id}', dependencies=[Depends(guard)])
def edit_project(project_id: str, data: ProjectPatch, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, OSProject, project_id, user.id)
    value = merged_input(ProjectInput, {key: getattr(row, key) for key in ProjectInput.model_fields}, data)
    validate_project_refs(session, value, user.id)
    revision_update(session, row, data.revision, value.model_dump())
    record_activity(session, user.id, 'project.updated', 'Updated a project', details={'project_id': row.id, 'revision': row.revision})
    session.commit()
    return project_json(row)


def check_delete_revision(row, revision):
    if revision is not None and row.revision != revision:
        raise HTTPException(409, 'This record changed. Reload it before deleting it.')


@router.delete('/projects/{project_id}', dependencies=[Depends(guard)])
def remove_project(project_id: str, revision: int | None = Query(default=None, ge=1), user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, OSProject, project_id, user.id)
    check_delete_revision(row, revision)
    # Assets and goals survive removal of their grouping, and receive fresh revisions.
    for model in (OSAssetMetadata, OSGoal):
        session.execute(update(model).where(model.owner_id == user.id, model.project_id == row.id)
                        .values(project_id=None, revision=model.revision + 1, updated_at=now()))
    session.delete(row)
    record_activity(session, user.id, 'project.deleted', 'Removed a project grouping', details={'project_id': project_id})
    session.commit()
    return {'deleted': True}


@router.put('/assets/{item_id}/metadata', dependencies=[Depends(guard)])
def set_metadata(item_id: str, data: AssetInput, user: User = Depends(current_user), session: Session = Depends(db)):
    from sqlalchemy.exc import IntegrityError
    item = owned(session, CreatorItem, item_id, user.id)
    project_id = optional_project(session, data.project_id, user.id)
    row = session.scalar(select(OSAssetMetadata).where(OSAssetMetadata.owner_id == user.id, OSAssetMetadata.item_id == item.id))
    values = data.model_dump(exclude={'revision', 'rights', 'project_id'})
    values.update(project_id=project_id, rights=data.rights.model_dump(mode='json'))
    if row is None:
        if data.revision != 0:
            raise HTTPException(409, 'Metadata changed. Reload this asset before saving.')
        row = OSAssetMetadata(owner_id=user.id, item_id=item.id, **values)
        session.add(row)
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, 'Metadata changed. Reload this asset before saving.') from None
    else:
        revision_update(session, row, data.revision, values)
    record_activity(session, user.id, 'asset.metadata_updated', 'Updated asset organization and rights', details={'item_id': item.id, 'revision': row.revision})
    session.commit()
    return metadata_json(row)


@router.get('/library')
def library(q: str = Query(default='', max_length=140), project_id: str | None = None,
            user: User = Depends(current_user), session: Session = Depends(db)):
    selected = owned(session, OSProject, project_id, user.id) if project_id else None
    metadata = {row.item_id: row for row in list_rows(session, OSAssetMetadata, user.id)}
    query = clean_text(q).casefold()
    items = []
    for item in list_rows(session, CreatorItem, user.id):
        meta = metadata_json(metadata[item.id]) if item.id in metadata else default_metadata(item.id)
        if selected and item.id not in selected.asset_ids and meta['project_id'] != selected.id:
            continue
        haystack = ' '.join([item.data.get('title', ''), item.data.get('description', ''), meta['notes'],
                             *item.data.get('tags', []), *meta['tags']]).casefold()
        if query and query not in haystack:
            continue
        items.append({**serialize_item(item, session), 'metadata': meta})
    # Unattached originals remain visible; project filtering shows only attached files.
    all_media = session.scalars(select(CreatorMedia).where(CreatorMedia.owner_id == user.id).order_by(CreatorMedia.id)).all()
    media_ids = {item.get('media_id') for item in items}
    media = [{'id': row.id, 'content_type': row.content_type, 'size': row.size, 'provenance': 'ziipa_upload'}
             for row in all_media if not (selected or query) or row.id in media_ids]
    return {'items': items, 'media': media, 'provenance': 'owned_ziipa_library',
            'notice': 'Rights are your statements. External libraries and saved inspiration are not imported automatically.'}


@router.get('/memories')
def memories(user: User = Depends(current_user), session: Session = Depends(db)):
    return [memory_json(row) for row in list_rows(session, OSMemory, user.id)]


@router.post('/memories', status_code=201, dependencies=[Depends(guard)])
def add_memory(data: MemoryInput, user: User = Depends(current_user), session: Session = Depends(db)):
    enforce_count(session, OSMemory, user.id, 200)
    row = OSMemory(owner_id=user.id, **data.model_dump())
    session.add(row); session.flush()
    record_activity(session, user.id, 'memory.created', 'Saved an explicit personal memory', details={'memory_id': row.id})
    session.commit()
    return memory_json(row)


@router.patch('/memories/{memory_id}', dependencies=[Depends(guard)])
def edit_memory(memory_id: str, data: MemoryPatch, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, OSMemory, memory_id, user.id)
    value = merged_input(MemoryInput, {'kind': row.kind, 'body': row.body, 'source': 'user'}, data)
    revision_update(session, row, data.revision, value.model_dump())
    record_activity(session, user.id, 'memory.updated', 'Corrected a personal memory', details={'memory_id': row.id, 'revision': row.revision})
    session.commit()
    return memory_json(row)


@router.delete('/memories/{memory_id}', dependencies=[Depends(guard)])
def forget_memory(memory_id: str, revision: int | None = Query(default=None, ge=1), user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, OSMemory, memory_id, user.id)
    check_delete_revision(row, revision)
    from assistant_api import forget_memory_context
    forget_memory_context(session, user.id, row.id)
    session.delete(row)
    record_activity(session, user.id, 'memory.deleted', 'Forgot a personal memory', details={'memory_id': memory_id})
    session.commit()
    return {'deleted': True}


@router.get('/goals')
def goals(user: User = Depends(current_user), session: Session = Depends(db)):
    return [goal_json(row) for row in list_rows(session, OSGoal, user.id)]


@router.post('/goals', status_code=201, dependencies=[Depends(guard)])
def add_goal(data: GoalInput, user: User = Depends(current_user), session: Session = Depends(db)):
    enforce_count(session, OSGoal, user.id, 200)
    values = data.model_dump()
    values['project_id'] = optional_project(session, data.project_id, user.id)
    row = OSGoal(owner_id=user.id, **values)
    session.add(row); session.flush()
    record_activity(session, user.id, 'goal.created', 'Created a personal goal', details={'goal_id': row.id})
    session.commit()
    return goal_json(row)


@router.patch('/goals/{goal_id}', dependencies=[Depends(guard)])
def edit_goal(goal_id: str, data: GoalPatch, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, OSGoal, goal_id, user.id)
    value = merged_input(GoalInput, {key: getattr(row, key) for key in GoalInput.model_fields}, data)
    values = value.model_dump()
    values['project_id'] = optional_project(session, value.project_id, user.id)
    revision_update(session, row, data.revision, values)
    record_activity(session, user.id, 'goal.updated', 'Updated a goal and its checked steps', details={'goal_id': row.id, 'revision': row.revision})
    session.commit()
    return goal_json(row)


@router.delete('/goals/{goal_id}', dependencies=[Depends(guard)])
def remove_goal(goal_id: str, revision: int | None = Query(default=None, ge=1), user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, OSGoal, goal_id, user.id)
    check_delete_revision(row, revision)
    for project in list_rows(session, OSProject, user.id):
        if row.id in project.goal_ids:
            project.goal_ids = [identifier for identifier in project.goal_ids if identifier != row.id]
            project.revision += 1; project.updated_at = now()
    session.delete(row)
    record_activity(session, user.id, 'goal.deleted', 'Removed a personal goal', details={'goal_id': goal_id})
    session.commit()
    return {'deleted': True}


@router.get('/revenue')
def revenue(user: User = Depends(current_user), session: Session = Depends(db)):
    return [revenue_json(row) for row in list_rows(session, OSRevenueEntry, user.id)]


@router.post('/revenue', status_code=201, dependencies=[Depends(guard)])
def add_revenue(data: RevenueInput, user: User = Depends(current_user), session: Session = Depends(db)):
    enforce_count(session, OSRevenueEntry, user.id, 10000)
    values = data.model_dump()
    if data.item_id:
        values['item_id'] = owned(session, CreatorItem, data.item_id, user.id).id
    row = OSRevenueEntry(owner_id=user.id, **values)
    session.add(row); session.flush()
    record_activity(session, user.id, 'revenue.created', 'Recorded a user-reported financial entry', details={'entry_id': row.id})
    session.commit()
    return revenue_json(row)


@router.delete('/revenue/{entry_id}', dependencies=[Depends(guard)])
def remove_revenue(entry_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, OSRevenueEntry, entry_id, user.id)
    session.delete(row)
    record_activity(session, user.id, 'revenue.deleted', 'Removed a user-reported financial entry', details={'entry_id': entry_id})
    session.commit()
    return {'deleted': True}


def insights_data(session, user_id):
    items = list_rows(session, CreatorItem, user_id)
    item_ids = {item.id for item in items}
    comments = session.scalar(select(func.count()).select_from(CreatorComment).where(CreatorComment.item_id.in_(item_ids))) if item_ids else 0
    likes = saves = 0
    for pref in session.scalars(select(CreatorPreferences)):
        likes += len(item_ids.intersection(pref.data.get('liked', [])))
        saves += len(item_ids.intersection(pref.data.get('saved', [])))
    distributions = Counter(row.status for row in list_rows(session, CreatorDistribution, user_id))
    from render_services import RenderJob
    render_counts = Counter(row.status for row in list_rows(session, RenderJob, user_id))
    currencies = defaultdict(lambda: {'realized_income_minor': 0, 'realized_cost_minor': 0,
                                     'expected_income_minor': 0, 'expected_cost_minor': 0})
    for entry in list_rows(session, OSRevenueEntry, user_id):
        state = 'realized' if entry.status == 'received' else 'expected'
        direction = 'income' if entry.type == 'income' else 'cost'
        currencies[entry.currency][f'{state}_{direction}_minor'] += entry.amount_minor
    economics = []
    for currency, amounts in sorted(currencies.items()):
        economics.append({'currency': currency, **amounts,
                          'realized_net_minor': amounts['realized_income_minor'] - amounts['realized_cost_minor'],
                          'expected_net_minor': amounts['expected_income_minor'] - amounts['expected_cost_minor'],
                          'provenance': 'user_reported', 'verified_payments': False})
    return {'library': {'items': len(items), 'by_visibility': dict(Counter(item.visibility for item in items)),
                        'by_category': dict(Counter(item.data.get('category', 'video') for item in items))},
            'engagement': {'comments': comments, 'likes': likes, 'saves': saves, 'provenance': 'ziipa_local',
                           'views': None, 'external_analytics_available': False},
            'publishing': {'total': sum(distributions.values()), 'by_status': dict(distributions), 'provenance': 'ziipa_delivery_records'},
            'rendering': {'total': sum(render_counts.values()), 'by_status': dict(render_counts), 'provenance': 'ziipa_render_jobs'},
            'economics': economics,
            'provenance': {'engagement': 'Counts recorded within Ziipa only; no inferred external views or audience reach.',
                           'economics': 'Amounts entered by you, grouped per currency. No exchange conversion or payment verification.'}}


@router.get('/insights')
def insights(user: User = Depends(current_user), session: Session = Depends(db)):
    return insights_data(session, user.id)


@router.get('/overview')
def overview(user: User = Depends(current_user), session: Session = Depends(db)):
    count = lambda model: session.scalar(select(func.count()).select_from(model).where(model.owner_id == user.id))
    return {'library_count': count(CreatorItem), 'media_count': count(CreatorMedia), 'project_count': count(OSProject),
            'memory_count': count(OSMemory), 'goal_count': count(OSGoal),
            'projects': [project_json(row) for row in list_rows(session, OSProject, user.id)],
            'goals': [goal_json(row) for row in list_rows(session, OSGoal, user.id)],
            'insights': insights_data(session, user.id),
            'memory_policy': 'Only memories you explicitly save are retained. Inspect, correct or forget them at any time.'}


@router.get('/activity')
def activity(limit: int = Query(default=100, ge=1, le=500), user: User = Depends(current_user), session: Session = Depends(db)):
    rows = session.scalars(select(OSActivity).where(OSActivity.owner_id == user.id)
                           .order_by(OSActivity.created_at.desc(), OSActivity.id).limit(limit)).all()
    return [activity_json(row) for row in rows]


def export_os_data(session, user_id):
    return {'projects': [project_json(row) for row in list_rows(session, OSProject, user_id)],
            'asset_metadata': [metadata_json(row) for row in list_rows(session, OSAssetMetadata, user_id)],
            'memories': [memory_json(row) for row in list_rows(session, OSMemory, user_id)],
            'goals': [goal_json(row) for row in list_rows(session, OSGoal, user_id)],
            'revenue': [revenue_json(row) for row in list_rows(session, OSRevenueEntry, user_id)],
            'activity': [activity_json(row) for row in list_rows(session, OSActivity, user_id)]}


@router.get('/export')
def export(user: User = Depends(current_user), session: Session = Depends(db)):
    return export_os_data(session, user.id)


def delete_os_data(session, user_id):
    """Caller commits with account deletion, so a failure rolls back the entire operation."""
    for model in (OSActivity, OSRevenueEntry, OSGoal, OSMemory, OSAssetMetadata, OSProject):
        session.execute(delete(model).where(model.owner_id == user_id))
