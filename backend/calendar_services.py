"""Private wall-clock calendar and read-only streaming preparation.

Calendar occurrences deliver in-app reminders only. They never authorize a
campaign, create provider resources, enable ingest, or capture camera/audio.
"""
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from typing import Literal
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint, delete, func, select, update
from sqlalchemy.orm import Mapped, mapped_column

from app import Base, User


class CalendarSettings(BaseSettings):
    enabled: bool = False
    model_config = SettingsConfigDict(env_prefix='OS_CALENDAR_', env_file='.env', extra='ignore')


config = CalendarSettings()
MAX_EVENTS = 100
MAX_HISTORY = 500
MAX_ICS_OCCURRENCES = 1000


def now():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def stamp(value):
    return aware(value).isoformat() if value else None


class CalendarEvent(Base):
    __tablename__ = 'calendar_events'
    __table_args__ = (UniqueConstraint('owner_id', 'request_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    request_id: Mapped[str] = mapped_column(String(36))
    request_hash: Mapped[str] = mapped_column(String(64))
    data: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(String(16), default='active', index=True)
    preflight: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CalendarOccurrence(Base):
    __tablename__ = 'calendar_occurrences'
    __table_args__ = (UniqueConstraint('event_id', 'event_revision', 'starts_at'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    event_id: Mapped[str] = mapped_column(ForeignKey('calendar_events.id', ondelete='CASCADE'), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    event_revision: Mapped[int]
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    remind_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(24), default='scheduled', index=True)
    revision: Mapped[int] = mapped_column(default=1)
    detail: Mapped[str] = mapped_column(String(400), default='Planned in-app reminder; no publishing or broadcast is scheduled.')
    checklist: Mapped[dict] = mapped_column(JSON, default=dict)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Recurrence(Input):
    frequency: Literal['none', 'daily', 'weekly'] = 'none'
    interval: int = Field(default=1, ge=1, le=12, strict=True)
    count: int = Field(default=1, ge=1, le=52, strict=True)
    weekdays: list[StrictInt] = Field(default_factory=list, max_length=7)
    until: date | None = None

    @model_validator(mode='after')
    def shape(self):
        if any(type(day) is not int or not 0 <= day <= 6 for day in self.weekdays) or len(set(self.weekdays)) != len(self.weekdays):
            raise ValueError('Weekdays must be distinct integers, Monday 0 through Sunday 6.')
        self.weekdays = sorted(self.weekdays)
        if self.frequency != 'weekly' and self.weekdays:
            raise ValueError('Only weekly recurrence selects weekdays.')
        if self.frequency == 'none' and (self.count != 1 or self.interval != 1 or self.until):
            raise ValueError('One-time events do not have a repeat count, interval or end date.')
        return self


class EventFields(Input):
    title: str = Field(min_length=1, max_length=140, pattern=r'.*\S.*')
    notes: str = Field(default='', max_length=2000)
    kind: Literal['reminder', 'stream', 'campaign'] = 'reminder'
    timezone: str = Field(min_length=1, max_length=80)
    starts_local: datetime
    fold: Literal['earlier', 'later'] = 'earlier'
    duration_minutes: int = Field(default=60, ge=1, le=720, strict=True)
    reminder_minutes: int = Field(default=15, ge=0, le=10080, strict=True)
    recurrence: Recurrence = Field(default_factory=Recurrence)
    stream_id: uuid.UUID | None = None
    campaign_id: uuid.UUID | None = None

    @field_validator('title', 'notes')
    @classmethod
    def clean(cls, value):
        return ''.join(c for c in value if c.isprintable() or c in '\n\t').strip()

    @model_validator(mode='after')
    def shape(self):
        if not self.title:
            raise ValueError('Give the event a title.')
        if self.starts_local.tzinfo is not None:
            raise ValueError('Use a local wall time without an offset, together with its IANA timezone.')
        if self.starts_local.microsecond:
            raise ValueError('Use whole seconds for the event start.')
        if not 1970 <= self.starts_local.year <= 2100:
            raise ValueError('Choose a calendar year between 1970 and 2100.')
        if self.stream_id and self.kind != 'stream' or self.campaign_id and self.kind != 'campaign':
            raise ValueError('Link only the existing record matching this event kind.')
        try:
            ZoneInfo(self.timezone)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError('Choose an installed IANA timezone, for example America/New_York or UTC.') from None
        if self.recurrence.until and self.recurrence.until < self.starts_local.date():
            raise ValueError('The recurrence end date precedes the first event.')
        if local_to_utc(self.starts_local, self.timezone, self.fold) is None:
            raise ValueError('That local time does not exist during a daylight-saving transition. Choose another time.')
        return self


class CreateEvent(EventFields):
    request_id: uuid.UUID


class UpdateEvent(EventFields):
    revision: int = Field(ge=1, strict=True)


class Revision(Input):
    revision: int = Field(ge=1, strict=True)


def local_to_utc(local, zone_name, fold='earlier'):
    zone = ZoneInfo(zone_name)
    candidates = set()
    for selection in (0, 1):
        converted = local.replace(tzinfo=zone, fold=selection).astimezone(timezone.utc)
        if converted.astimezone(zone).replace(tzinfo=None) == local:
            candidates.add(converted)
    if not candidates:
        return None
    return min(candidates) if fold == 'earlier' else max(candidates)


def schedule(fields):
    """Materialize <=52 UTC instants. Preserve wall time, skip future DST gaps.

    Count means actual scheduled occurrences; skipped nonexistent times do not
    consume it. A supplied local end date is inclusive and may reduce count.
    """
    recurrence, first = fields.recurrence, fields.starts_local
    dates, anchor = [], first.date() - timedelta(days=first.weekday())
    weekdays = recurrence.weekdays or [first.weekday()]
    for offset in range(1096):
        candidate = first + timedelta(days=offset)
        if recurrence.until and candidate.date() > recurrence.until:
            break
        if recurrence.frequency == 'none' and offset:
            break
        if recurrence.frequency == 'daily' and offset % recurrence.interval:
            continue
        if recurrence.frequency == 'weekly' and (candidate.weekday() not in weekdays
                or ((candidate.date() - anchor).days // 7) % recurrence.interval):
            continue
        instant = local_to_utc(candidate, fields.timezone, fields.fold)
        if instant is None:
            continue
        dates.append(instant)
        if len(dates) >= recurrence.count:
            break
    if not dates or (not recurrence.until and len(dates) < recurrence.count):
        raise HTTPException(422, 'Choose a recurrence with at most 52 occurrences within three years.')
    return dates


def lock_owner(session, owner_id, *, skip=False):
    if session.bind.dialect.name == 'sqlite':
        session.execute(update(User).where(User.id == owner_id).values(name=User.name))
    owner = session.scalar(select(User).where(User.id == owner_id).with_for_update(skip_locked=skip))
    if owner is None and not skip:
        raise HTTPException(401, 'The Ziipa account no longer exists.')
    return owner


def owned_event(session, owner_id, event_id, *, lock=False):
    query = select(CalendarEvent).where(CalendarEvent.id == str(event_id), CalendarEvent.owner_id == owner_id)
    if lock:
        query = query.with_for_update()
    row = session.scalar(query.execution_options(populate_existing=True))
    if row is None:
        raise HTTPException(404, 'Calendar event not found.')
    return row


def check_revision(row, revision):
    if row.revision != revision:
        raise HTTPException(409, 'Calendar data changed. Refresh before applying this action.')


def validate_links(session, owner_id, fields):
    if fields.stream_id:
        from live_api import LiveStream
        if not session.scalar(select(LiveStream.id).where(LiveStream.id == str(fields.stream_id), LiveStream.owner_id == owner_id)):
            raise HTTPException(404, 'Owned broadcast not found.')
    if fields.campaign_id:
        from creation_campaigns import CreationCampaign
        if not session.scalar(select(CreationCampaign.id).where(CreationCampaign.id == str(fields.campaign_id), CreationCampaign.owner_id == owner_id)):
            raise HTTPException(404, 'Owned campaign not found.')


def add_occurrences(session, row, fields, instants):
    remaining = session.scalar(select(func.count()).select_from(CalendarOccurrence).where(CalendarOccurrence.event_id == row.id))
    if remaining + len(instants) > MAX_HISTORY:
        raise HTTPException(409, 'This event reached its history limit. Export it and create a new event.')
    for instant in instants:
        session.add(CalendarOccurrence(event_id=row.id, owner_id=row.owner_id, event_revision=row.revision,
            starts_at=instant, ends_at=instant + timedelta(minutes=fields.duration_minutes),
            remind_at=instant - timedelta(minutes=fields.reminder_minutes)))


def occurrence_json(row):
    return {'id': row.id, 'event_id': row.event_id, 'event_revision': row.event_revision,
        'revision': row.revision, 'starts_at': stamp(row.starts_at), 'ends_at': stamp(row.ends_at),
        'remind_at': stamp(row.remind_at), 'status': row.status, 'detail': row.detail,
        'checklist': row.checklist, 'delivered_at': stamp(row.delivered_at), 'updated_at': stamp(row.updated_at)}


def safe_preflight(value):
    value = dict(value or {})
    if value.get('expires_at') or value.get('provider_verified') or value.get('provider_active'):
        try:
            fresh = datetime.fromisoformat(value.get('expires_at')) > now()
        except (TypeError, ValueError):
            fresh = False
        if not fresh:
            value.update(status='unknown', provider_verified=False, provider_active=False,
                         detail='Previous provider verification expired. Check readiness again before explicitly starting.')
            value['checks'] = [dict(check, status='unknown') if check['id'] == 'provider' else check
                               for check in value.get('checks', [])]
    return value


def event_json(session, row, occurrences=None):
    if occurrences is None:
        occurrences = list(session.scalars(select(CalendarOccurrence).where(CalendarOccurrence.event_id == row.id,
            CalendarOccurrence.owner_id == row.owner_id).order_by(CalendarOccurrence.starts_at).limit(MAX_HISTORY)))
    next_due = min((aware(value.remind_at) for value in occurrences if value.status == 'scheduled'), default=None)
    return {**row.data, 'id': row.id, 'request_id': row.request_id, 'revision': row.revision, 'status': row.status,
        'next_reminder_at': stamp(next_due) if row.status == 'active' else None,
        'occurrences': [occurrence_json(value) for value in occurrences], 'preflight': safe_preflight(row.preflight),
        'created_at': stamp(row.created_at), 'updated_at': stamp(row.updated_at),
        'automatic_broadcast': False, 'automatic_campaign_delivery': False}


def checklist(session, row):
    """Only owner-local reads. Safe to run at reminder time without provider calls."""
    from account_services import AccountState, PrivacyInput
    checks = []
    def add(identifier, label, ready, detail):
        checks.append({'id': identifier, 'label': label, 'status': 'ready' if ready else 'needs_action', 'detail': detail})
    if row.data['kind'] == 'stream':
        from live_api import LiveStream, TwitchDestination, configured
        stream = session.scalar(select(LiveStream).where(LiveStream.id == row.data.get('stream_id'), LiveStream.owner_id == row.owner_id))
        account = session.get(AccountState, row.owner_id)
        try:
            public = PrivacyInput(**(account.privacy or {})).profile_visibility == 'public' if account else True
        except ValueError:
            public = False
        add('profile', 'Review public profile privacy', public, 'Public streaming requires a deliberately public profile; the calendar does not change privacy.')
        add('configuration', 'Streaming provider configured', configured(), 'Provider configuration alone is not a verified broadcast.')
        add('broadcast', 'Select a prepared broadcast', bool(stream and stream.provider_id and stream.status not in ('creating', 'provisioning_unknown', 'ending', 'ended')),
            'Prepare or resolve your own broadcast in Live Studio. No provider resources are created by the calendar.')
        destination = session.scalar(select(TwitchDestination).where(TwitchDestination.stream_id == stream.id,
            TwitchDestination.owner_id == row.owner_id)) if stream else None
        relay_ready = not destination or destination.status == 'detached'
        if destination and destination.status == 'configured':
            from social_publishing import PublishingGrant
            relay_ready = bool(session.scalar(select(PublishingGrant.id).where(PublishingGrant.owner_id == row.owner_id,
                PublishingGrant.provider == 'twitch', PublishingGrant.status == 'authorized',
                PublishingGrant.selected_target_id == destination.channel_id)))
        add('destinations', 'Review Twitch relay and authorization', relay_ready,
            'Saved relay settings need fresh verification in Live Studio before starting; no Twitch live state is inferred.')
        add('capture', 'Test camera, microphone or encoder', False, 'Open Live Studio yourself; device permission and capture are never started by a reminder.')
        add('consent', 'Confirm public broadcast and media rights', False, 'Starting always requires your explicit confirmation in Live Studio.')
    elif row.data['kind'] == 'campaign':
        from creation_campaigns import CreationCampaign
        campaign = session.scalar(select(CreationCampaign).where(CreationCampaign.id == row.data.get('campaign_id'), CreationCampaign.owner_id == row.owner_id))
        add('campaign', 'Review linked campaign', bool(campaign), 'Open the campaign to review its current export, destinations and permissions.')
        reviewed = bool(campaign and campaign.approved_hash and campaign.approved_hash == campaign.review_hash)
        add('approval', 'Review exact campaign approval', reviewed, 'A calendar date does not approve, schedule, or publish a campaign. Campaign scheduling remains separate.')
    else:
        add('review', 'Review this private reminder', False, 'Acknowledge the reminder when you have reviewed it. This does not claim the task was performed.')
    return {'status': 'needs_review', 'checked_at': None, 'expires_at': None, 'provider_verified': False,
        'provider_active': False, 'requires_explicit_start': True, 'automatic_broadcast': False,
        'checks': checks, 'detail': 'Private preparation only. Check current settings and explicitly perform the action yourself.'}


async def preflight(session, row):
    value = checklist(session, row)
    if row.data['kind'] != 'stream':
        return value
    from live_api import LiveStream, configured, read_provider_stream, playback_policy, VERIFIED_SECONDS
    stream = session.scalar(select(LiveStream).where(LiveStream.id == row.data.get('stream_id'),
        LiveStream.owner_id == row.owner_id).with_for_update())
    if not stream or not stream.provider_id or not configured() or stream.status in ('creating', 'provisioning_unknown', 'ending', 'ended'):
        value['status'] = 'needs_setup'
        return value
    # Read provider state only. Never call start/ingest/create, persist raw
    # responses or return stream keys, WHIP/RTMP credentials or playback URLs.
    try:
        raw = await read_provider_stream(stream)
        if raw is None:
            value.update(status='unknown', detail='Provider no longer has this broadcast. Review it in Live Studio.')
        else:
            public_policy = playback_policy(raw).get('type') == 'public'
            verified_at = now()
            value.update(status='verified' if public_policy else 'needs_review', checked_at=stamp(verified_at),
                expires_at=stamp(verified_at + timedelta(seconds=VERIFIED_SECONDS)), provider_verified=True,
                provider_active=bool(raw['isActive'] and not raw['suspended'] and public_policy and stream.publish_enabled
                    and next(check['status'] for check in value['checks'] if check['id'] == 'profile') == 'ready'),
                detail='Provider state was read now. This checklist is not permission to start and does not keep a stream live.')
            value['checks'].append({'id': 'provider', 'label': 'Fresh provider configuration',
                'status': 'ready' if public_policy else 'needs_action',
                'detail': 'Open Live Studio and confirm the broadcast before starting. A prepared stream is not live.'})
    except HTTPException:
        value.update(status='unknown', detail='Provider verification was unavailable. No live state or start permission was confirmed.')
    return value


def export_calendar_data(session, owner_id):
    rows = list(session.scalars(select(CalendarEvent).where(CalendarEvent.owner_id == owner_id).order_by(CalendarEvent.created_at)))
    return {'events': [event_json(session, row) for row in rows]}


def delete_calendar_data(session, owner_id):
    # Caller owns its account transaction; no hidden commits or external calls.
    session.execute(delete(CalendarOccurrence).where(CalendarOccurrence.owner_id == owner_id))
    session.execute(delete(CalendarEvent).where(CalendarEvent.owner_id == owner_id))


def ics_text(value):
    return str(value).replace('\\', '\\\\').replace('\r', '').replace('\n', '\\n').replace(';', '\\;').replace(',', '\\,')


def fold_ics(line):
    # RFC5545 limit is octets, not Unicode characters. Never split UTF-8 bytes.
    parts, current = [], ''
    for char in line:
        if len((current + char).encode('utf-8')) > 75:
            parts.append(current); current = ' '
        current += char
    return '\r\n'.join(parts + [current])


def export_ics(session, owner_id, *, event_id=None, starts_after=None, starts_before=None):
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ziipa//Private Creator Calendar//EN', 'CALSCALE:GREGORIAN']
    query = select(CalendarEvent, CalendarOccurrence).join(CalendarOccurrence,
        CalendarOccurrence.event_id == CalendarEvent.id).where(CalendarEvent.owner_id == owner_id,
        CalendarOccurrence.owner_id == owner_id, CalendarEvent.status != 'cancelled',
        CalendarOccurrence.status != 'cancelled')
    if event_id:
        query = query.where(CalendarEvent.id == str(event_id))
    if starts_after:
        query = query.where(CalendarOccurrence.starts_at >= starts_after)
    if starts_before:
        query = query.where(CalendarOccurrence.starts_at < starts_before)
    # Bound rows before repeating notes or folding UTF-8. Never silently truncate
    # the calendar, or let retained history exhaust a small free API instance.
    rows = list(session.execute(query.order_by(CalendarOccurrence.starts_at, CalendarOccurrence.id)
                                .limit(MAX_ICS_OCCURRENCES + 1)))
    if len(rows) > MAX_ICS_OCCURRENCES:
        raise HTTPException(413, 'This calendar export exceeds 1,000 occurrences. Filter by event_id, starts_after or starts_before and export a smaller range.')
    for event, occurrence in rows:
        when = lambda value: aware(value).astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        lines += ['BEGIN:VEVENT', 'UID:' + occurrence.id + '@calendar.ziipa.com',
            'DTSTAMP:' + when(event.updated_at), 'DTSTART:' + when(occurrence.starts_at),
            'DTEND:' + when(occurrence.ends_at), 'SEQUENCE:' + str(event.revision), 'CLASS:PRIVATE',
            'STATUS:' + ('TENTATIVE' if event.status == 'paused' else 'CONFIRMED'),
            'SUMMARY:' + ics_text(event.data['title']),
            'DESCRIPTION:' + ics_text(event.data.get('notes', '') + '\nZiipa planning event only; no automatic publishing or broadcast.'),
            'END:VEVENT']
    return '\r\n'.join(fold_ics(line) for line in lines + ['END:VCALENDAR']) + '\r\n'
