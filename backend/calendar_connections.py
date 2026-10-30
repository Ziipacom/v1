"""Private, explicitly selected calendar connections. No publishing or AI calls.

Google/Microsoft use delegated OAuth and a bounded, user-initiated sync. Device
calendars are handled locally by the native client; passwords never enter Ziipa.
"""
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
import asyncio
import hashlib
import json
import re
import time
from typing import Literal
from urllib.parse import quote, urlencode, urlsplit
import uuid

import httpx
from fastapi import HTTPException
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app import Base

Provider = Literal['google', 'microsoft']
UTC = timezone.utc
GOOGLE = 'https://www.googleapis.com/calendar/v3'
MICROSOFT = 'https://graph.microsoft.com/v1.0'
SCOPES = {
    'google': {'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
               'https://www.googleapis.com/auth/calendar.events'},
    'microsoft': {'Calendars.ReadWrite'},
}


class Settings(BaseSettings):
    enabled: bool = False
    google_client_id: str = ''
    google_client_secret: str = Field(default='', repr=False)
    google_public_approved: bool = False
    microsoft_client_id: str = ''
    microsoft_client_secret: str = Field(default='', repr=False)
    microsoft_public_approved: bool = False
    model_config = SettingsConfigDict(env_prefix='CALENDAR_CONNECT_', env_file='.env', extra='ignore')


config = Settings()


def now():
    return datetime.now(UTC)


class CalendarConnection(Base):
    __tablename__ = 'calendar_connections'
    __table_args__ = (UniqueConstraint('owner_id', 'provider'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    token_cipher: Mapped[str] = mapped_column(String)
    calendar_id: Mapped[str] = mapped_column(String(1024), default='')
    calendar_name: Mapped[str] = mapped_column(String(150), default='')
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revision: Mapped[int] = mapped_column(default=1)


class ConnectedCalendarEvent(Base):
    __tablename__ = 'connected_calendar_events'
    __table_args__ = (UniqueConstraint('connection_id', 'remote_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    connection_id: Mapped[str] = mapped_column(ForeignKey('calendar_connections.id', ondelete='CASCADE'), index=True)
    remote_id: Mapped[str] = mapped_column(String(1024))
    data: Mapped[dict] = mapped_column(JSON)
    etag: Mapped[str] = mapped_column(String(300), default='')
    revision: Mapped[int] = mapped_column(default=1)


class CalendarExport(Base):
    __tablename__ = 'calendar_exports'
    __table_args__ = (UniqueConstraint('connection_id', 'occurrence_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    connection_id: Mapped[str] = mapped_column(ForeignKey('calendar_connections.id', ondelete='CASCADE'), index=True)
    occurrence_id: Mapped[str] = mapped_column(ForeignKey('calendar_occurrences.id', ondelete='CASCADE'))
    remote_id: Mapped[str] = mapped_column(String(1024))
    etag: Mapped[str] = mapped_column(String(300), default='')
    event_revision: Mapped[int] = mapped_column()


class DeviceCalendarSnapshot(Base):
    __tablename__ = 'device_calendar_snapshots'
    __table_args__ = (UniqueConstraint('owner_id', 'device_key'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    device_key: Mapped[str] = mapped_column(String(36))
    calendar_name: Mapped[str] = mapped_column(String(150))
    events: Mapped[list] = mapped_column(JSON, default=list)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


def credentials(provider):
    if provider not in SCOPES:
        raise HTTPException(404, 'Unknown calendar provider.')
    return getattr(config, provider + '_client_id'), getattr(config, provider + '_client_secret')


def readiness(provider):
    from social_publishing import approved_api_origin, encrypt_tokens
    client_id, secret = credentials(provider)
    requirements = []
    if not config.enabled:
        requirements.append('Calendar connections enabled by the Ziipa operator')
    if not client_id or not secret:
        requirements.append('Registered calendar OAuth application and server credentials')
    try:
        approved_api_origin()
        encrypt_tokens(0, 'calendar:' + provider, {})
    except HTTPException:
        requirements.append('Approved callback origin and stable encrypted token storage')
    return {'provider': provider, 'ready': not requirements, 'requirements': requirements,
            'callback': callback(provider) if not requirements else None,
            'automatic_sync': False,
            'testing_only': not getattr(config, provider + '_public_approved')}


def require_ready(provider):
    if not readiness(provider)['ready']:
        raise HTTPException(503, 'Calendar connection setup is required. No account has been connected.')


def callback(provider):
    from social_publishing import approved_api_origin
    credentials(provider)
    return approved_api_origin() + '/api/os/calendar/connections/oauth/' + provider + '/callback'


def token_url(provider):
    return ('https://oauth2.googleapis.com/token' if provider == 'google' else
            'https://login.microsoftonline.com/common/oauth2/v2.0/token')


def authorization_url(provider, state, verifier):
    import base64
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    params = {'client_id': credentials(provider)[0], 'redirect_uri': callback(provider),
              'response_type': 'code', 'state': state, 'code_challenge': challenge,
              'code_challenge_method': 'S256', 'scope': ' '.join(sorted(SCOPES[provider]))}
    if provider == 'google':
        params.update(access_type='offline', prompt='consent')
        return 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode(params)
    params['scope'] += ' offline_access'
    params['response_mode'] = 'query'
    return 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + urlencode(params)


def client():
    return httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False, trust_env=False)


@asynccontextmanager
async def operation():
    try:
        async with asyncio.timeout(25), client() as http:
            yield http
    except TimeoutError as exc:
        raise HTTPException(504, 'Calendar request timed out. Refresh before retrying a write.') from exc


async def fetch(http, method, url, **kwargs):
    """Fixed service origins, no redirects and a bounded response; never echo bodies."""
    parsed = urlsplit(url)
    allowed = ((parsed.scheme, parsed.netloc) in {
        ('https', 'www.googleapis.com'), ('https', 'graph.microsoft.com')}
        or url in (token_url('google'), token_url('microsoft')))
    if not allowed or parsed.username or parsed.password or parsed.fragment:
        raise HTTPException(502, 'Calendar endpoint could not be verified.')
    try:
        async with http.stream(method, url, **kwargs) as response:
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                if len(raw) + len(chunk) > 2_000_000:
                    raise HTTPException(502, 'Calendar response exceeded the safe limit.')
                raw.extend(chunk)
            data = json.loads(raw) if raw else {}
            if not isinstance(data, dict):
                raise ValueError()
            if response.status_code in (401, 403):
                raise HTTPException(409, 'Calendar access expired or was denied. Reconnect this account.')
            if response.status_code in (409, 412):
                raise HTTPException(409, 'This event changed in another calendar. Sync again before editing.')
            if response.status_code >= 400:
                raise HTTPException(502, 'The calendar provider could not complete this request. No success was recorded.')
            return data
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, 'The calendar provider could not be reached or verified. Retry later.') from exc


def encrypted(owner_id, provider, tokens, old=None):
    from social_publishing import encrypt_tokens
    scopes = set(str(tokens.get('scope', '')).split()) if 'scope' in tokens else set((old or {}).get('scope', []))
    if not SCOPES[provider].issubset(scopes):
        raise HTTPException(400, 'Required read/write calendar permissions were not granted.')
    if not isinstance(tokens.get('access_token'), str) or not tokens['access_token']:
        raise HTTPException(502, 'The calendar token response could not be verified.')
    refresh = tokens.get('refresh_token') or (old or {}).get('refresh_token', '')
    if not refresh:
        raise HTTPException(400, 'Offline calendar access was not granted. Reconnect and approve access.')
    return encrypt_tokens(owner_id, 'calendar:' + provider, {
        'access_token': tokens['access_token'], 'refresh_token': refresh,
        'scope': sorted(scopes), 'expires_at': time.time() + min(max(int(tokens.get('expires_in', 0)), 0), 86400)})


async def access(http, connection, session):
    from social_publishing import decrypt_tokens
    from types import SimpleNamespace
    tokens = decrypt_tokens(SimpleNamespace(owner_id=connection.owner_id, provider='calendar:' + connection.provider,
                                            token_cipher=connection.token_cipher))
    if tokens.get('expires_at', 0) < time.time() + 90:
        client_id, secret = credentials(connection.provider)
        fresh = await fetch(http, 'POST', token_url(connection.provider), data={
            'client_id': client_id, 'client_secret': secret, 'grant_type': 'refresh_token',
            'refresh_token': tokens['refresh_token'], 'scope': ' '.join(tokens['scope'])})
        connection.token_cipher = encrypted(connection.owner_id, connection.provider, fresh, tokens)
        session.flush()
        tokens['access_token'] = fresh['access_token']
    return {'Authorization': 'Bearer ' + tokens['access_token']}


def segment(value):
    if not isinstance(value, str) or not value or len(value) > 1024 or any(ord(c) < 32 for c in value):
        raise HTTPException(422, 'Invalid calendar identifier.')
    return quote(value, safe='')


async def calendars(http, connection, session):
    headers = await access(http, connection, session)
    google = connection.provider == 'google'
    url = GOOGLE + '/users/me/calendarList' if google else MICROSOFT + '/me/calendars'
    params = {'maxResults': 250, 'minAccessRole': 'writer'} if google else {'$top': 100}
    data = await fetch(http, 'GET', url, headers=headers, params=params)
    if data.get('nextPageToken') or data.get('@odata.nextLink'):
        raise HTTPException(409, 'Too many calendars for this connection. Use an account with fewer than 100 calendars.')
    result = []
    for row in data.get('items' if google else 'value', []):
        writable = row.get('accessRole') in ('owner', 'writer') if google else row.get('canEdit') is True
        if writable and row.get('id'):
            result.append({'id': row['id'], 'name': str(row.get('summary' if google else 'name', 'Calendar'))[:150]})
    return result


def event_path(connection):
    root = GOOGLE if connection.provider == 'google' else MICROSOFT + '/me'
    return root + '/calendars/' + segment(connection.calendar_id)


def iso(value):
    date = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return (date.replace(tzinfo=UTC) if date.tzinfo is None else date).astimezone(UTC).isoformat()


def normalized(provider, row):
    google = provider == 'google'
    start, end = row.get('start', {}), row.get('end', {})
    starts, ends = start.get('dateTime') or start.get('date'), end.get('dateTime') or end.get('date')
    # Graph is requested in UTC; Google date-only events are represented as UTC
    # dates for display, never rewritten as timed events automatically.
    if not row.get('id') or not starts or not ends:
        return None
    try:
        starts, ends = iso(starts), iso(ends)
    except ValueError:
        return None
    description = row.get('description', '') if google else row.get('body', {}).get('content', row.get('bodyPreview', ''))
    return {'title': str(row.get('summary' if google else 'subject', 'Untitled event'))[:140],
            'notes': re.sub('<[^>]+>', '', str(description))[:2000], 'starts_at': starts, 'ends_at': ends,
            'all_day': bool(row.get('isAllDay') or 'date' in start),
            'editable': len(str(description)) <= 2000 and not bool(row.get('attendees')) and not bool(row.get('isCancelled')) and
                        not bool(row.get('recurringEventId') or row.get('seriesMasterId') or row.get('recurrence'))}


async def read_events(http, connection, session):
    headers = await access(http, connection, session)
    headers['Prefer'] = 'outlook.timezone="UTC", outlook.body-content-type="text"'
    google = connection.provider == 'google'
    lower, upper = now() - timedelta(days=30), now() + timedelta(days=90)
    url = event_path(connection) + ('/events' if google else '/calendarView')
    params = ({'timeMin': lower.isoformat(), 'timeMax': upper.isoformat(), 'maxResults': 100,
               'singleEvents': 'true', 'orderBy': 'startTime'} if google else
              {'startDateTime': lower.isoformat(), 'endDateTime': upper.isoformat(), '$top': 100,
               '$select': 'id,subject,body,start,end,isAllDay,isCancelled,attendees,seriesMasterId,type'})
    result = []
    # Rebuild fixed URLs with extracted opaque page tokens. Never follow an
    # arbitrary provider nextLink with a bearer token.
    for _ in range(5):
        data = await fetch(http, 'GET', url, headers=headers, params=params)
        for row in data.get('items' if google else 'value', []):
            if row.get('status') == 'cancelled' or row.get('isCancelled'):
                continue
            event = normalized(connection.provider, row)
            if event:
                result.append((str(row['id']), row.get('etag') or row.get('@odata.etag', ''), event))
        next_page = data.get('nextPageToken') if google else data.get('@odata.nextLink')
        if not next_page:
            return result
        if google:
            params['pageToken'] = next_page
        else:
            from urllib.parse import parse_qs
            parsed = urlsplit(next_page)
            if parsed.scheme != 'https' or parsed.netloc != 'graph.microsoft.com' or parsed.path != urlsplit(url).path:
                raise HTTPException(502, 'Calendar pagination could not be verified.')
            params = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
    raise HTTPException(409, 'More than 500 calendar events were returned. Nothing was replaced; choose a smaller calendar.')


def write_body(provider, title, notes, starts, ends):
    if provider == 'google':
        return {'summary': title, 'description': notes, 'start': {'dateTime': starts}, 'end': {'dateTime': ends}}
    return {'subject': title, 'body': {'contentType': 'text', 'content': notes},
            'start': {'dateTime': iso(starts).replace('+00:00', ''), 'timeZone': 'UTC'},
            'end': {'dateTime': iso(ends).replace('+00:00', ''), 'timeZone': 'UTC'}}
