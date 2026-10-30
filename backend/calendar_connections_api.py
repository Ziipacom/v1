"""Delegated calendar consent and explicit, owner-scoped two-way event actions."""
import hashlib
import secrets
from datetime import datetime, timezone
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import User, current_user, db, guard
from calendar_api import private_response
import calendar_connections as service
from calendar_connections import CalendarConnection, CalendarExport, ConnectedCalendarEvent, DeviceCalendarSnapshot, Provider
from calendar_services import CalendarEvent, CalendarOccurrence, aware, stamp

PREFIX = '/api/os/calendar/connections'
router = APIRouter(prefix=PREFIX, dependencies=[Depends(current_user), Depends(private_response)])


def connection_for(session, owner_id, connection_id):
    # One owner lock serializes refresh, sync, export, disconnect and account
    # deletion; no callback can restore a connection after deletion.
    from social_publishing import _enforce_actor
    user = session.scalar(select(User).where(User.id == owner_id).with_for_update())
    if not user:
        raise HTTPException(401, 'Sign in again.')
    _enforce_actor(session, owner_id, mutation=True)
    connection = session.scalar(select(CalendarConnection).where(CalendarConnection.id == connection_id,
        CalendarConnection.owner_id == owner_id).with_for_update())
    if not connection:
        raise HTTPException(404, 'Calendar connection not found.')
    service.require_ready(connection.provider)
    return connection


def connection_json(row):
    return {'id': row.id, 'provider': row.provider, 'calendar_name': row.calendar_name,
            'selected': bool(row.calendar_id), 'last_sync_at': stamp(row.last_sync_at), 'revision': row.revision}


@router.get('')
def list_connections(user: User = Depends(current_user), session: Session = Depends(db)):
    rows = session.scalars(select(CalendarConnection).where(CalendarConnection.owner_id == user.id)).all()
    events = session.scalars(select(ConnectedCalendarEvent).where(ConnectedCalendarEvent.owner_id == user.id)
                            .order_by(ConnectedCalendarEvent.id).limit(1000)).all()
    devices = session.scalars(select(DeviceCalendarSnapshot).where(DeviceCalendarSnapshot.owner_id == user.id)).all()
    return {'providers': [service.readiness(provider) for provider in ('google', 'microsoft')],
            'connections': [connection_json(row) for row in rows],
            'events': [{'id': row.id, 'connection_id': row.connection_id, 'revision': row.revision, **row.data} for row in events],
            'device_snapshots': [{'id': row.id, 'calendar_name': row.calendar_name, 'synced_at': stamp(row.synced_at), 'events': row.events} for row in devices],
            'automatic_sync': False, 'range_days': {'past': 30, 'future': 90}}


@router.post('/oauth/{provider}/start', dependencies=[Depends(guard)])
def start(provider: Provider, request: Request, response: Response, user: User = Depends(current_user)):
    from social_publishing import approved_api_origin, store_state, STATE_TTL
    service.require_ready(provider)
    origin = approved_api_origin()
    if request.headers.get('authorization') or not request.cookies.get('ziipa_session'):
        return {'status': 'browser_sign_in_required', 'auth_url': None,
                'portal_url': origin + '/studio/?view=calendar',
                'detail': 'Sign into Ziipa in your browser, open Calendar → Connect, then authorize the calendar there. Return and refresh this app.'}
    ticket, binding = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
    record = {'owner_id': user.id, 'provider': provider,
              'binding_hash': hashlib.sha256(binding.encode()).hexdigest(),
              'session_hash': hashlib.sha256(request.cookies['ziipa_session'].encode()).hexdigest()}
    store_state('calendar-ticket', ticket, record)
    response.set_cookie('ziipa_calendar_' + provider, binding, max_age=STATE_TTL, httponly=True,
                        secure=origin.startswith('https://'), samesite='lax', path=PREFIX + '/oauth/' + provider)
    return {'status': 'authorization_required', 'auth_url': origin + PREFIX + '/oauth/' + provider + '/authorize?' + urlencode({'ticket': ticket})}


def verify(request, record, provider, session):
    from social_publishing import verify_initiating_browser, _enforce_actor
    verify_initiating_browser(request, record, session)
    _enforce_actor(session, record['owner_id'], mutation=True)
    binding = request.cookies.get('ziipa_calendar_' + provider, '')
    if record.get('provider') != provider or not binding or not secrets.compare_digest(
            record.get('binding_hash', ''), hashlib.sha256(binding.encode()).hexdigest()):
        raise HTTPException(400, 'Finish calendar authorization in the same Ziipa account and browser that started it.')


@router.get('/oauth/{provider}/authorize')
def authorize(provider: Provider, request: Request, ticket: str = Query(min_length=32, max_length=200), session: Session = Depends(db)):
    from social_publishing import consume_state, store_state
    service.require_ready(provider)
    record = consume_state('calendar-ticket', ticket)
    verify(request, record, provider, session)
    state, verifier = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
    store_state('calendar-callback', state, {**record, 'verifier': verifier})
    response = RedirectResponse(service.authorization_url(provider, state, verifier), status_code=302)
    private_response(response)
    return response


@router.get('/oauth/{provider}/callback')
async def callback(provider: Provider, request: Request, state: str = Query(min_length=32, max_length=200),
                   code: str = Query(default='', max_length=4096), error: str = Query(default='', max_length=100),
                   session: Session = Depends(db)):
    from social_publishing import consume_state, _enforce_actor
    service.require_ready(provider)
    record = consume_state('calendar-callback', state)
    verify(request, record, provider, session)
    if error or not code:
        raise HTTPException(400, 'Calendar access was not approved. No new connection was saved.')
    client_id, secret = service.credentials(provider)
    try:
        async with service.operation() as http:
            tokens = await service.fetch(http, 'POST', service.token_url(provider), data={
                'client_id': client_id, 'client_secret': secret, 'code': code, 'grant_type': 'authorization_code',
                'redirect_uri': service.callback(provider), 'code_verifier': record['verifier']})
        cipher = service.encrypted(record['owner_id'], provider, tokens)
    except TimeoutError as exc:
        raise HTTPException(504, 'Calendar authorization timed out. Start again.') from exc
    user = session.scalar(select(User).where(User.id == record['owner_id']).with_for_update())
    if not user:
        raise HTTPException(401, 'This account is no longer available.')
    _enforce_actor(session, user.id, mutation=True)
    row = session.scalar(select(CalendarConnection).where(CalendarConnection.owner_id == user.id, CalendarConnection.provider == provider))
    if row is None:
        row = CalendarConnection(owner_id=user.id, provider=provider, token_cipher=cipher)
        session.add(row)
    else:
        # Reauthorization may use a different provider account. Never retain a
        # previous account's selection, event mirrors or export mappings.
        session.execute(delete(ConnectedCalendarEvent).where(ConnectedCalendarEvent.connection_id == row.id))
        session.execute(delete(CalendarExport).where(CalendarExport.connection_id == row.id))
        row.token_cipher, row.calendar_id, row.calendar_name, row.last_sync_at = cipher, '', '', None
        row.revision += 1
    session.commit()
    response = HTMLResponse('<!doctype html><meta name="referrer" content="no-referrer"><title>Ziipa Calendar</title>'
        '<h1>Calendar authorization saved</h1><p>Return to Ziipa Calendar, open Connect, and choose a calendar. '
        'No events were read or written yet. Choose Sync now to import events and review each export separately.</p>'
        '<p><a href="/studio/?view=calendar">Return to Calendar</a></p>')
    response.delete_cookie('ziipa_calendar_' + provider, path=PREFIX + '/oauth/' + provider)
    private_response(response)
    return response


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Selection(Input):
    calendar_id: str = Field(min_length=1, max_length=1024)


class DeviceEvent(Input):
    id: str = Field(pattern=r'^[a-f0-9]{64}$')
    title: str = Field(min_length=1, max_length=140)
    notes: str = Field(default='', max_length=2000)
    starts_at: datetime
    ends_at: datetime
    all_day: bool = False

    @model_validator(mode='after')
    def valid_time(self):
        if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None or self.ends_at < self.starts_at:
            raise ValueError('Invalid event time.')
        return self


class DeviceSnapshot(Input):
    device_key: str = Field(pattern=r'^[a-f0-9-]{36}$')
    calendar_name: str = Field(min_length=1, max_length=150)
    events: list[DeviceEvent] = Field(max_length=500)


@router.post('/device/snapshot', dependencies=[Depends(guard)])
def device_snapshot(data: DeviceSnapshot, user: User = Depends(current_user), session: Session = Depends(db)):
    from calendar_services import lock_owner
    lock_owner(session, user.id)
    rows = list(session.scalars(select(DeviceCalendarSnapshot).where(DeviceCalendarSnapshot.owner_id == user.id)))
    row = next((value for value in rows if value.device_key == data.device_key), None)
    if row is None:
        if len(rows) >= 5:
            raise HTTPException(409, 'Disconnect an old device calendar before adding another.')
        row = DeviceCalendarSnapshot(owner_id=user.id, device_key=data.device_key)
        session.add(row)
    row.calendar_name, row.events, row.synced_at = data.calendar_name, [event.model_dump(mode='json') for event in data.events], service.now()
    session.commit()
    return {'saved': True, 'count': len(row.events)}


@router.post('/device/{snapshot_id}/disconnect', dependencies=[Depends(guard)])
def disconnect_device(snapshot_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    from calendar_services import lock_owner
    lock_owner(session, user.id)
    row = session.scalar(select(DeviceCalendarSnapshot).where(DeviceCalendarSnapshot.id == snapshot_id, DeviceCalendarSnapshot.owner_id == user.id))
    if not row:
        raise HTTPException(404, 'Device calendar snapshot not found.')
    session.delete(row)
    session.commit()
    return {'disconnected': True}


@router.get('/{connection_id}/calendars')
async def calendars(connection_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    connection = connection_for(session, user.id, connection_id)
    async with service.operation() as http:
        result = await service.calendars(http, connection, session)
    session.commit()
    return {'calendars': result}


@router.post('/{connection_id}/select', dependencies=[Depends(guard)])
async def select_calendar(connection_id: str, data: Selection, user: User = Depends(current_user), session: Session = Depends(db)):
    row = connection_for(session, user.id, connection_id)
    async with service.operation() as http:
        options = await service.calendars(http, row, session)
    chosen = next((value for value in options if value['id'] == data.calendar_id), None)
    if not chosen:
        raise HTTPException(422, 'Choose a writable calendar returned by this account.')
    if row.calendar_id != chosen['id']:
        session.execute(delete(ConnectedCalendarEvent).where(ConnectedCalendarEvent.connection_id == row.id))
        session.execute(delete(CalendarExport).where(CalendarExport.connection_id == row.id))
        row.calendar_id, row.calendar_name, row.last_sync_at = chosen['id'], chosen['name'], None
        row.revision += 1
    session.commit()
    return connection_json(row)


@router.post('/{connection_id}/sync', dependencies=[Depends(guard)])
async def sync(connection_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    row = connection_for(session, user.id, connection_id)
    if not row.calendar_id:
        raise HTTPException(409, 'Choose a calendar first.')
    async with service.operation() as http:
        incoming = await service.read_events(http, row, session)
    existing = {event.remote_id: event for event in session.scalars(select(ConnectedCalendarEvent).where(
        ConnectedCalendarEvent.owner_id == user.id, ConnectedCalendarEvent.connection_id == row.id))}
    seen = set()
    for remote_id, etag, fields in incoming:
        seen.add(remote_id)
        event = existing.get(remote_id)
        if event is None:
            session.add(ConnectedCalendarEvent(owner_id=user.id, connection_id=row.id, remote_id=remote_id, data=fields, etag=etag))
        elif event.data != fields or event.etag != etag:
            event.data, event.etag = fields, etag
            event.revision += 1
    for remote_id, event in existing.items():
        if remote_id not in seen:
            session.delete(event)
    row.last_sync_at = service.now()
    session.commit()
    return {'imported': len(seen), 'last_sync_at': stamp(row.last_sync_at), 'detail': 'Calendar events synced. No invitations, creations or releases were sent.'}


class Edit(Input):
    revision: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=140)
    notes: str = Field(default='', max_length=2000)
    starts_at: datetime
    ends_at: datetime

    @model_validator(mode='after')
    def valid_time(self):
        if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None or self.ends_at <= self.starts_at:
            raise ValueError('Use timezone-aware start and end times, with the end after the start.')
        return self


@router.post('/{connection_id}/events/{event_id}/edit', dependencies=[Depends(guard)])
async def edit(connection_id: str, event_id: str, data: Edit, user: User = Depends(current_user), session: Session = Depends(db)):
    row = connection_for(session, user.id, connection_id)
    event = session.scalar(select(ConnectedCalendarEvent).where(ConnectedCalendarEvent.id == event_id,
        ConnectedCalendarEvent.connection_id == row.id, ConnectedCalendarEvent.owner_id == user.id))
    if not event:
        raise HTTPException(404, 'Calendar event not found.')
    if event.revision != data.revision or not event.etag:
        raise HTTPException(409, 'Sync this calendar again before editing this event.')
    if not event.data.get('editable') or event.data.get('all_day'):
        raise HTTPException(409, 'Meetings with guests, recurring and all-day events must be edited in their original calendar.')
    async with service.operation() as http:
        headers = await service.access(http, row, session)
        headers['If-Match'] = event.etag
        url = service.event_path(row) + '/events/' + service.segment(event.remote_id)
        # Recheck server data, since guests may have been added since the sync.
        current = await service.fetch(http, 'GET', url, headers=headers)
        normalized = service.normalized(row.provider, current)
        if not normalized or not normalized['editable'] or normalized['all_day']:
            raise HTTPException(409, 'This event now requires editing in its original calendar.')
        etag = current.get('etag') or current.get('@odata.etag', '')
        if etag != event.etag:
            raise HTTPException(409, 'This event changed. Sync before editing it.')
        result = await service.fetch(http, 'PATCH', url, headers=headers,
            params={'sendUpdates': 'none'} if row.provider == 'google' else {},
            json=service.write_body(row.provider, data.title, data.notes, data.starts_at.isoformat(), data.ends_at.isoformat()))
    event.data = {**event.data, 'title': data.title, 'notes': data.notes,
                  'starts_at': data.starts_at.isoformat(), 'ends_at': data.ends_at.isoformat()}
    event.etag = result.get('etag') or result.get('@odata.etag', '')
    event.revision += 1
    session.commit()
    return {'saved': True}


class Export(Input):
    occurrence_id: str = Field(min_length=36, max_length=36)


@router.post('/{connection_id}/export', dependencies=[Depends(guard)])
async def export(connection_id: str, data: Export, user: User = Depends(current_user), session: Session = Depends(db)):
    from social_publishing import approved_api_origin
    row = connection_for(session, user.id, connection_id)
    if not row.calendar_id:
        raise HTTPException(409, 'Choose a calendar first.')
    occurrence = session.scalar(select(CalendarOccurrence).where(CalendarOccurrence.id == data.occurrence_id,
        CalendarOccurrence.owner_id == user.id))
    event = session.get(CalendarEvent, occurrence.event_id) if occurrence else None
    if not event or event.owner_id != user.id or event.status != 'active' or occurrence.event_revision != event.revision or occurrence.status == 'cancelled':
        raise HTTPException(404, 'Active calendar occurrence not found.')
    previous = session.scalar(select(CalendarExport).where(CalendarExport.connection_id == row.id,
        CalendarExport.occurrence_id == occurrence.id, CalendarExport.owner_id == user.id))
    if previous:
        return {'saved': True, 'already_exported': True, 'detail': 'This occurrence already has a calendar copy. No duplicate was created.'}
    identity = hashlib.sha256((row.id + ':' + occurrence.id).encode()).hexdigest()
    notes = event.data.get('notes', '')[:1700] + '\n\nOpen in Ziipa: ' + approved_api_origin() + '/studio/?view=calendar&eventId=' + event.id
    body = service.write_body(row.provider, event.data['title'], notes, stamp(occurrence.starts_at), stamp(occurrence.ends_at))
    body['id' if row.provider == 'google' else 'transactionId'] = identity
    async with service.operation() as http:
        headers = await service.access(http, row, session)
        url = service.event_path(row) + '/events'
        try:
            result = await service.fetch(http, 'POST', url, headers=headers, json=body,
                params={'sendUpdates': 'none'} if row.provider == 'google' else {})
        except HTTPException as exc:
            # Google's deterministic resource ID makes retry after a dropped
            # response safe. Verify the existing event rather than making a copy.
            if exc.status_code != 409 or row.provider != 'google':
                raise
            result = await service.fetch(http, 'GET', url + '/' + identity, headers=headers)
    if not result.get('id'):
        raise HTTPException(502, 'The provider did not confirm an event. Refresh before retrying.')
    session.add(CalendarExport(owner_id=user.id, connection_id=row.id, occurrence_id=occurrence.id,
        remote_id=result['id'], etag=result.get('etag') or result.get('@odata.etag', ''), event_revision=event.revision))
    session.commit()
    return {'saved': True, 'already_exported': False, 'detail': 'Calendar copy saved with its Ziipa link. No guests were invited or media published.'}


@router.post('/{connection_id}/disconnect', dependencies=[Depends(guard)])
def disconnect(connection_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    # Disconnection must still work when an operator disables provider setup.
    from calendar_services import lock_owner
    lock_owner(session, user.id)
    row = session.scalar(select(CalendarConnection).where(CalendarConnection.id == connection_id,
        CalendarConnection.owner_id == user.id).with_for_update())
    if not row:
        raise HTTPException(404, 'Calendar connection not found.')
    session.execute(delete(ConnectedCalendarEvent).where(ConnectedCalendarEvent.connection_id == row.id))
    session.execute(delete(CalendarExport).where(CalendarExport.connection_id == row.id))
    session.delete(row)
    session.commit()
    return {'disconnected': True, 'detail': 'Ziipa access and imported calendar copies removed. External events remain in your calendar. You can also revoke the app in the provider account settings.'}
