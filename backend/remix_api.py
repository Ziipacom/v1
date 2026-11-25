"""Owned permission settings and explicit, private Remix creation/apply operations."""
import math
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import User, current_user, db, guard
from creator import CreatorItem, CreatorMedia, ItemInput, serialize_item
from media_quota import lock_admission, require_capacity
from render_services import MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, RenderJob, notify_worker, readiness, snapshot_hash
import remix_services as remix

router = APIRouter(prefix='/api/remix', dependencies=[Depends(current_user)])
Mode = Literal['stitch', 'split_screen', 'use_sound']


class PolicyInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=0)
    audience: Literal['disabled', 'everyone', 'followers']
    modes: list[Mode] = Field(max_length=3)

    @model_validator(mode='after')
    def valid(self):
        if len(self.modes) != len(set(self.modes)):
            raise ValueError('Select each Remix mode once.')
        if self.audience != 'disabled' and not self.modes:
            raise ValueError('Select an allowed mode or disable Remix.')
        return self


class ProjectInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: uuid.UUID
    mode: Mode
    source_start: float = Field(default=0, ge=0, le=89.8)
    source_seconds: float = Field(ge=0.2, le=30)
    response_media_id: uuid.UUID
    title: str = Field(min_length=1, max_length=140, pattern=r'.*\S.*')
    rights_confirmed: Literal[True]

    @model_validator(mode='after')
    def valid(self):
        if not all(math.isfinite(v) for v in (self.source_start, self.source_seconds)):
            raise ValueError('Clip times must be finite.')
        if self.source_start + self.source_seconds > 90:
            raise ValueError('The selected source region must fit within 90 seconds.')
        if self.mode == 'stitch' and not 1 <= self.source_seconds <= 5:
            raise ValueError('A Stitch uses one to five seconds of the source.')
        if any(abs(v * 1000 - round(v * 1000)) > 0.000001 for v in (self.source_start, self.source_seconds)):
            raise ValueError('Clip precision is limited to milliseconds.')
        return self


@router.get('/items/{item_id}')
def get_item(item_id: uuid.UUID, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers['Cache-Control'] = 'private, no-store'
    item = remix.visible_item(session, str(item_id), user.id)
    if not remix.remix_is_visible(session, item, user.id):
        raise HTTPException(404, 'This source is unavailable.')
    return remix.item_info(session, item, user.id)


@router.post('/items/{item_id}/policy', dependencies=[Depends(guard)])
def set_policy(item_id: uuid.UUID, data: PolicyInput, user: User = Depends(current_user), session: Session = Depends(db)):
    from admin_services import require_mutations_open
    lock_admission(session, user.id)
    require_mutations_open(session, user)
    item = remix.visible_item(session, str(item_id), user.id, lock=True)
    if item.owner_id != user.id:
        raise HTTPException(404, 'Your creation was not found.')
    policy = session.get(remix.RemixPolicy, item.id, populate_existing=True)
    if (policy.revision if policy else 0) != data.revision:
        raise HTTPException(409, 'Remix permission changed. Refresh before saving.')
    if data.audience != 'disabled':
        remix.source_spec(session, item)
        remix.enforce_remix_publication(session, item)
    if policy is None:
        policy = remix.RemixPolicy(item_id=item.id, owner_id=user.id, revision=0)
        session.add(policy)
    policy.revision += 1
    policy.audience, policy.modes, policy.updated_at = data.audience, list(data.modes), remix.now()
    session.commit()
    return remix.item_info(session, item, user.id)


@router.post('/items/{item_id}/projects', dependencies=[Depends(guard)])
def create_project(item_id: uuid.UUID, data: ProjectInput, user: User = Depends(current_user), session: Session = Depends(db)):
    from admin_services import require_mutations_open
    lock_admission(session, user.id)
    require_mutations_open(session, user)
    request_hash = snapshot_hash({'parent_id': str(item_id), **data.model_dump(mode='json')})
    existing = session.scalar(select(remix.RemixProject).where(remix.RemixProject.owner_id == user.id,
                               remix.RemixProject.request_id == str(data.request_id)))
    if existing:
        if existing.request_hash != request_hash:
            raise HTTPException(409, 'This request already belongs to a different Remix. Use a new request ID.')
        return remix.project_receipt(session, existing)
    if not readiness().get('can_remix'):
        raise HTTPException(503, 'The compatible Remix worker is unavailable. Your original is unchanged.')
    source = remix.visible_item(session, str(item_id), user.id, lock=True)
    if data.mode not in remix.permitted_modes(session, source, user.id):
        raise HTTPException(403, 'This creator has not allowed this Remix mode for your account.')
    ancestor = session.get(remix.RemixProject, source.id, populate_existing=True)
    if ancestor:
        remix.enforce_remix_publication(session, source)
    spec = remix.source_spec(session, source)
    absolute_start = math.ceil((spec['trim_start'] + data.source_start) * 1000) / 1000
    absolute_end = absolute_start + data.source_seconds
    if absolute_end > 90 or (spec['trim_end'] is not None and absolute_end > spec['trim_end'] + 0.000001):
        raise HTTPException(422, 'Choose a region within the source post’s published trim.')
    media = session.get(CreatorMedia, str(data.response_media_id), populate_existing=True)
    if not media or media.owner_id != user.id:
        raise HTTPException(404, 'Your response media was not found.')
    if media.content_type not in remix.VIDEO_TYPES or not 0 < media.size <= MAX_INPUT_BYTES:
        raise HTTPException(422, 'Choose an owned MP4, MOV or WebM response video up to 100 MiB.')
    if remix.is_derived_media(session, media.id):
        raise HTTPException(409, 'Use an original response video. Existing Remix outputs retain their source permissions.')
    active = session.scalar(select(func.count()).select_from(RenderJob).where(RenderJob.owner_id == user.id,
                            RenderJob.status.in_(('queued', 'processing'))))
    total = session.scalar(select(func.count()).select_from(RenderJob).where(RenderJob.status.in_(('queued', 'processing'))))
    if active >= 2 or total >= 20:
        raise HTTPException(429, 'The render queue is full. Wait for an existing job.')
    require_capacity(session, user.id, MAX_OUTPUT_BYTES)
    policy = session.get(remix.RemixPolicy, source.id, populate_existing=True)
    item = CreatorItem(id=str(uuid.uuid4()), owner_id=user.id, visibility='draft',
                       data=ItemInput(title=data.title, media_id=media.id, remix_of=source.id).model_dump(mode='json'))
    project = remix.RemixProject(item_id=item.id, owner_id=user.id, request_id=str(data.request_id),
        request_hash=request_hash, parent_id=source.id, root_id=ancestor.root_id if ancestor else source.id,
        source_owner_id=source.owner_id, policy_revision=policy.revision if policy else 0,
        source_spec=spec, response_spec={'id': media.id, 'content_type': media.content_type, 'size': media.size},
        mode=data.mode, source_start_ms=round(absolute_start * 1000), source_seconds_ms=round(data.source_seconds * 1000),
        job_id=str(uuid.uuid4()))
    snapshot = remix.expected_snapshot(project)
    job = RenderJob(id=project.job_id, owner_id=user.id, item_id=item.id, snapshot=snapshot,
                    input_fingerprint=snapshot_hash(snapshot), status='queued',
                    detail='Waiting for a compatible worker to render your private Remix.')
    session.add_all([item, project, job])
    session.flush()
    remix.validate_remix_job(session, job)
    session.commit()
    notify_worker()
    return remix.project_receipt(session, project)


def owned_project(session, user, item_id):
    project = session.get(remix.RemixProject, str(item_id), populate_existing=True)
    if not project or project.owner_id != user.id:
        raise HTTPException(404, 'Your Remix project was not found.')
    return project


@router.get('/projects/{item_id}')
def get_project(item_id: uuid.UUID, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers['Cache-Control'] = 'private, no-store'
    return remix.project_receipt(session, owned_project(session, user, item_id))


@router.post('/projects/{item_id}/apply', dependencies=[Depends(guard)])
def apply_project(item_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    lock_admission(session, user.id)
    project = owned_project(session, user, item_id)
    job = session.scalar(select(RenderJob).where(RenderJob.id == project.job_id).with_for_update()
                         .execution_options(populate_existing=True))
    if not job:
        raise HTTPException(409, 'The Remix render is unavailable.')
    remix.validate_remix_job(session, job, lock=True)
    item = session.get(CreatorItem, project.item_id)
    if project.applied_at:
        return serialize_item(item, session, viewer_id=user.id)
    if job.status != 'ready':
        raise HTTPException(409, 'Wait for the Remix to finish before applying it.')
    output = session.get(CreatorMedia, job.output_media_id, populate_existing=True)
    if (not output or output.owner_id != user.id or output.content_type != 'video/mp4'
            or not 0 < output.size <= MAX_OUTPUT_BYTES or len(job.output_sha256) != 64):
        raise HTTPException(409, 'The verified Remix output is unavailable.')
    item.data = {**item.data, 'media_id': output.id, 'visibility': 'draft', 'trim_start': 0,
                 'trim_end': None, 'captions': [], 'caption_source_cues': None, 'overlays': [],
                 'timeline': None, 'visual_effect': 'none', 'soundtrack': None, 'photo_ids': []}
    item.visibility = 'draft'
    project.applied_at, project.result_media_id, project.result_sha256 = remix.now(), output.id, job.output_sha256
    session.commit()
    return serialize_item(item, session, viewer_id=user.id)
