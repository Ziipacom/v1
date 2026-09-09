"""Owned render-job submission and export. Never executes FFmpeg in the API."""
from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import User, current_user, db, guard
from creator import CreatorItem
from render_services import (RenderJob, input_snapshot, snapshot_hash, readiness, receipt,
                             resolve_rendered_media, notify_worker)
from storage_services import LocalStorage, storage

router = APIRouter(prefix='/api/render')


class RenderInput(BaseModel):
    item_id: uuid.UUID
    soundtrack_rights_confirmed: bool = False
    retry_failed: bool = False


@router.get('/config', dependencies=[Depends(current_user)])
def render_configuration():
    return readiness()


@router.post('/jobs', dependencies=[Depends(guard)])
def queue_render(data: RenderInput, user: User = Depends(current_user), session: Session = Depends(db)):
    if not readiness()['can_render']:
        raise HTTPException(503, 'The render worker is offline or not configured. Your editable original remains saved.')
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    item = session.get(CreatorItem, str(data.item_id))
    if not item or item.owner_id != user.id:
        raise HTTPException(404, 'Your saved creation was not found.')
    snapshot = input_snapshot(session, item)
    if snapshot['audio'] and not data.soundtrack_rights_confirmed:
        raise HTTPException(422, 'Confirm that you own or have a license to use the selected soundtrack.')
    fingerprint = snapshot_hash(snapshot)
    job = session.scalar(select(RenderJob).where(RenderJob.owner_id == user.id, RenderJob.item_id == item.id,
                                                 RenderJob.input_fingerprint == fingerprint))
    if job and not (data.retry_failed and job.status in ('failed', 'cancelled', 'stale')):
        if job.status == 'queued':
            notify_worker()
        return receipt(job, session)
    active = session.scalar(select(func.count()).select_from(RenderJob).where(RenderJob.owner_id == user.id,
                                    RenderJob.status.in_(('queued', 'processing'))))
    total = session.scalar(select(func.count()).select_from(RenderJob).where(RenderJob.status.in_(('queued', 'processing'))))
    if active >= 2 or total >= 20:
        raise HTTPException(429, 'The render queue is full. Wait for an existing job before requesting another.')
    if job:
        job.status, job.detail = 'queued', 'Waiting for the render worker after your explicit retry.'
        job.attempts, job.claim_token, job.lease_until = 0, '', None
        job.updated_at = datetime.now(timezone.utc)
    else:
        snapshot = {**snapshot, 'rights_attestation': {'soundtrack_confirmed': bool(data.soundtrack_rights_confirmed),
                    'at': datetime.now(timezone.utc).isoformat(), 'owner_id': user.id}}
        job = RenderJob(owner_id=user.id, item_id=item.id, input_fingerprint=fingerprint, snapshot=snapshot,
                        status='queued', detail='Waiting for the render worker.')
        session.add(job)
    session.commit()
    notify_worker()
    return receipt(job, session)


@router.get('/jobs')
def list_render_jobs(item_id: uuid.UUID | None = None, user: User = Depends(current_user), session: Session = Depends(db)):
    query = select(RenderJob).where(RenderJob.owner_id == user.id)
    if item_id:
        query = query.where(RenderJob.item_id == str(item_id))
    return [receipt(job, session) for job in session.scalars(query.order_by(RenderJob.created_at.desc()).limit(50))]


def _job(session, user, job_id):
    job = session.get(RenderJob, str(job_id))
    if not job or job.owner_id != user.id:
        raise HTTPException(404, 'Your render job was not found.')
    return job


@router.get('/jobs/{job_id}')
def get_render_job(job_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    return receipt(_job(session, user, job_id), session)


@router.post('/jobs/{job_id}/cancel', dependencies=[Depends(guard)])
def cancel_render_job(job_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    job = _job(session, user, job_id)
    if job.status in ('queued', 'processing'):
        job.status, job.detail, job.claim_token = 'cancelled', 'Rendering was cancelled. The editable original is unchanged.', ''
        job.updated_at = datetime.now(timezone.utc)
        session.commit()
    return receipt(job, session)


@router.post('/jobs/{job_id}/export', dependencies=[Depends(guard)])
def export_render(job_id: uuid.UUID, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    job = _job(session, user, job_id)
    item = session.get(CreatorItem, job.item_id)
    if not item or item.owner_id != user.id:
        raise HTTPException(404, 'Your saved creation was not found.')
    media = resolve_rendered_media(session, user.id, item, str(job_id))
    backend = storage()
    response.headers['Cache-Control'] = 'no-store'
    return {'url': f'/api/creator/media/{media.id}' if isinstance(backend, LocalStorage) else backend.read_url(user.id, media.id),
            'media_id': media.id, 'render_id': job.id, 'rendered': True, 'content_type': media.content_type, 'size': media.size,
            'input_fingerprint': job.input_fingerprint, 'output_sha256': job.output_sha256}
