"""Authenticated private calendar endpoints; streaming actions stay in Live Studio."""
from datetime import datetime, timedelta
import hashlib
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app import User, current_user, db, guard
import calendar_services as service
from calendar_services import CalendarEvent, CalendarOccurrence, CreateEvent, UpdateEvent, Revision


def private_response(response: Response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'


router = APIRouter(prefix='/api/os/calendar', dependencies=[Depends(current_user), Depends(private_response)])


def notify():
    from media_workflows import notify_workflows
    notify_workflows()


def activity(session, owner_id, kind, summary):
    from personal_media import record_activity
    record_activity(session, owner_id, kind, summary, status='completed')


def future_plan(data):
    dates = service.schedule(data)
    current = service.now()
    if dates[0] < current - timedelta(days=1) or dates[0] > current + timedelta(days=366):
        raise HTTPException(422, 'Choose a first event between yesterday and one year from now.')
    return dates


def fields_json(data):
    return data.model_dump(mode='json', exclude={'revision', 'request_id'})


@router.get('/config')
def calendar_config():
    from media_workflows import cache, config as workflow_config, heartbeat_key
    ready = False
    if service.config.enabled and workflow_config.enabled:
        try:
            ready = bool(cache.get(heartbeat_key()))
        except Exception:
            pass
    return {'enabled': service.config.enabled, 'worker_ready': ready,
        'reminders_enabled': bool(service.config.enabled and workflow_config.enabled),
        'automatic_broadcast': False, 'automatic_campaign_delivery': False,
        'recurrence': ['none', 'daily', 'weekly'], 'max_occurrences': 52,
        'dst_policy': 'Reject an initial gap, skip recurring gaps, and use the selected earlier/later fold.',
        'detail': 'Private in-app reminders only; no email, external calendar sync, automatic camera capture or broadcast.'}


@router.get('/events')
def list_events(user: User = Depends(current_user), session: Session = Depends(db)):
    rows = list(session.scalars(select(CalendarEvent).where(CalendarEvent.owner_id == user.id)
        .order_by(CalendarEvent.created_at.desc()).limit(service.MAX_EVENTS)))
    grouped = {row.id: [] for row in rows}
    if grouped:
        for occurrence in session.scalars(select(CalendarOccurrence).where(CalendarOccurrence.owner_id == user.id,
            CalendarOccurrence.event_id.in_(grouped)).order_by(CalendarOccurrence.starts_at)):
            grouped[occurrence.event_id].append(occurrence)
    from creation_campaigns import CreationCampaign
    campaigns = session.scalars(select(CreationCampaign).where(CreationCampaign.owner_id == user.id)
        .order_by(CreationCampaign.created_at.desc()).limit(100))
    return {'events': [service.event_json(session, row, grouped[row.id]) for row in rows],
        'campaigns': [{'id': row.id, 'name': row.name, 'status': row.status, 'revision': row.revision,
            'schedule_at': service.stamp(row.schedule_at), 'read_only': True} for row in campaigns],
        'automation': {'reminders_only': True, 'automatic_broadcast': False, 'automatic_campaign_delivery': False}}


@router.get('/events/{event_id}')
def get_event(event_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    return service.event_json(session, service.owned_event(session, user.id, event_id))


@router.post('/events', status_code=201, dependencies=[Depends(guard)])
def create_event(data: CreateEvent, user: User = Depends(current_user), session: Session = Depends(db)):
    service.lock_owner(session, user.id)
    fields = fields_json(data)
    fingerprint = hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    previous = session.scalar(select(CalendarEvent).where(CalendarEvent.owner_id == user.id,
        CalendarEvent.request_id == str(data.request_id)))
    if previous:
        if previous.request_hash != fingerprint:
            raise HTTPException(409, 'This request ID already belongs to different calendar settings.')
        return service.event_json(session, previous)
    if session.scalar(select(func.count()).select_from(CalendarEvent).where(CalendarEvent.owner_id == user.id)) >= service.MAX_EVENTS:
        raise HTTPException(409, 'Calendar event limit reached. Export and delete an old event first.')
    service.validate_links(session, user.id, data)
    instants = future_plan(data)
    row = CalendarEvent(owner_id=user.id, request_id=str(data.request_id), request_hash=fingerprint, data=fields)
    session.add(row); session.flush()
    service.add_occurrences(session, row, data, instants)
    activity(session, user.id, 'calendar_created', 'Created a private calendar plan; no broadcast or publishing action was scheduled.')
    session.commit(); notify()
    return service.event_json(session, row)


@router.put('/events/{event_id}', dependencies=[Depends(guard)])
def update_event(event_id: uuid.UUID, data: UpdateEvent, user: User = Depends(current_user), session: Session = Depends(db)):
    service.lock_owner(session, user.id)
    row = service.owned_event(session, user.id, event_id, lock=True)
    service.check_revision(row, data.revision)
    if row.status == 'cancelled':
        raise HTTPException(409, 'A cancelled event cannot be rescheduled. Create a new event.')
    service.validate_links(session, user.id, data)
    instants = future_plan(data)
    # Undelivered plans are replaceable; retain delivered/missed/acknowledged history.
    session.execute(delete(CalendarOccurrence).where(CalendarOccurrence.event_id == row.id,
        CalendarOccurrence.owner_id == user.id, CalendarOccurrence.status == 'scheduled'))
    row.data, row.revision, row.updated_at, row.preflight = fields_json(data), row.revision + 1, service.now(), {}
    service.add_occurrences(session, row, data, instants)
    activity(session, user.id, 'calendar_updated', 'Updated the private calendar plan; previously delivered reminder history was retained.')
    session.commit(); notify()
    return service.event_json(session, row)


def change_state(event_id, data, target, user, session):
    service.lock_owner(session, user.id)
    row = service.owned_event(session, user.id, event_id, lock=True)
    service.check_revision(row, data.revision)
    if row.status == 'cancelled' and target != 'cancelled':
        raise HTTPException(409, 'Cancelled events cannot be resumed. Create a new event.')
    if row.status != target:
        row.status, row.revision, row.updated_at, row.preflight = target, row.revision + 1, service.now(), {}
        if target == 'cancelled':
            session.execute(update(CalendarOccurrence).where(CalendarOccurrence.event_id == row.id,
                CalendarOccurrence.owner_id == user.id, CalendarOccurrence.status.in_(('scheduled', 'reminder_ready')))
                .values(status='cancelled', revision=CalendarOccurrence.revision + 1, updated_at=service.now(),
                    detail='Calendar reminder cancelled. This does not stop any separately started broadcast or campaign.'))
        activity(session, user.id, 'calendar_' + target, 'Calendar plan ' + target + '; no external broadcast or campaign was changed.')
        session.commit(); notify()
    return service.event_json(session, row)


@router.post('/events/{event_id}/pause', dependencies=[Depends(guard)])
def pause(event_id: uuid.UUID, data: Revision, user: User = Depends(current_user), session: Session = Depends(db)):
    return change_state(event_id, data, 'paused', user, session)


@router.post('/events/{event_id}/resume', dependencies=[Depends(guard)])
def resume(event_id: uuid.UUID, data: Revision, user: User = Depends(current_user), session: Session = Depends(db)):
    return change_state(event_id, data, 'active', user, session)


@router.post('/events/{event_id}/cancel', dependencies=[Depends(guard)])
def cancel(event_id: uuid.UUID, data: Revision, user: User = Depends(current_user), session: Session = Depends(db)):
    return change_state(event_id, data, 'cancelled', user, session)


@router.delete('/events/{event_id}', dependencies=[Depends(guard)])
def delete_event(event_id: uuid.UUID, revision: int = Query(ge=1), user: User = Depends(current_user), session: Session = Depends(db)):
    service.lock_owner(session, user.id)
    row = service.owned_event(session, user.id, event_id, lock=True)
    service.check_revision(row, revision)
    session.execute(delete(CalendarOccurrence).where(CalendarOccurrence.event_id == row.id, CalendarOccurrence.owner_id == user.id))
    session.delete(row); session.commit(); notify()
    return {'deleted': True, 'external_actions_changed': False}


@router.post('/occurrences/{occurrence_id}/acknowledge', dependencies=[Depends(guard)])
def acknowledge(occurrence_id: uuid.UUID, data: Revision, user: User = Depends(current_user), session: Session = Depends(db)):
    service.lock_owner(session, user.id)
    identity = session.scalar(select(CalendarOccurrence.event_id).where(CalendarOccurrence.id == str(occurrence_id),
        CalendarOccurrence.owner_id == user.id))
    if not identity:
        raise HTTPException(404, 'Calendar occurrence not found.')
    event = service.owned_event(session, user.id, identity, lock=True)
    row = session.scalar(select(CalendarOccurrence).where(CalendarOccurrence.id == str(occurrence_id),
        CalendarOccurrence.owner_id == user.id).with_for_update())
    service.check_revision(row, data.revision)
    if row.status not in ('reminder_ready', 'acknowledged'):
        raise HTTPException(409, 'Only a delivered reminder can be acknowledged.')
    if row.status != 'acknowledged':
        row.status, row.revision, row.updated_at = 'acknowledged', row.revision + 1, service.now()
        row.detail = 'Reminder acknowledged by its owner; task completion or broadcast status is not inferred.'
        session.commit()
    return service.event_json(session, event)


@router.post('/events/{event_id}/preflight', dependencies=[Depends(guard)])
async def preflight(event_id: uuid.UUID, data: Revision, user: User = Depends(current_user), session: Session = Depends(db)):
    service.lock_owner(session, user.id)
    row = service.owned_event(session, user.id, event_id, lock=True)
    service.check_revision(row, data.revision)
    if row.status != 'active':
        raise HTTPException(409, 'Resume the calendar event before checking streaming preparation.')
    # Bound owner-triggered provider reads across every event, not just one ID.
    cutoff = service.now() - timedelta(seconds=20)
    for saved in session.scalars(select(CalendarEvent).where(CalendarEvent.owner_id == user.id)):
        attempted = (saved.preflight or {}).get('attempted_at')
        try:
            recent = attempted and datetime.fromisoformat(attempted) > cutoff
        except (ValueError, TypeError):
            recent = False
        if recent:
            if saved.id == row.id:
                return service.event_json(session, row)
            raise HTTPException(429, 'Wait twenty seconds between streaming readiness checks.')
    value = await service.preflight(session, row)
    row.preflight = {**value, 'attempted_at': service.stamp(service.now())}
    session.commit()
    return service.event_json(session, row)


@router.get('/export.ics')
def export_calendar(event_id: uuid.UUID | None = None, starts_after: datetime | None = None,
                    starts_before: datetime | None = None,
                    user: User = Depends(current_user), session: Session = Depends(db)):
    if any(value is not None and (value.tzinfo is None or value.utcoffset() is None)
           for value in (starts_after, starts_before)):
        raise HTTPException(422, 'Calendar export ranges require explicit timezone offsets.')
    if starts_after and starts_before and starts_after >= starts_before:
        raise HTTPException(422, 'The calendar export end must follow its start.')
    if event_id:
        service.owned_event(session, user.id, event_id)
    return Response(service.export_ics(session, user.id, event_id=event_id,
                    starts_after=starts_after, starts_before=starts_before), media_type='text/calendar; charset=utf-8',
        headers={'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
                 'Content-Disposition': 'attachment; filename="ziipa-private-calendar.ics"'})
