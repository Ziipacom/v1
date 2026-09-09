"""Owner-scoped Livepeer control plane. This module never captures a camera.

Only the ingest endpoint returns a stream credential. A successful create/start
is NOT evidence of a public broadcast; live status comes from Livepeer reads.
"""
import asyncio
from datetime import datetime, timedelta, timezone
import json
import re
from urllib.parse import urlsplit
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, SecretStr, StrictBool
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard


class LiveSettings(BaseSettings):
    livepeer_api_key: SecretStr = SecretStr('')
    live_max_streams_per_owner: int = Field(default=3, ge=1, le=10)
    live_daily_create_limit: int = Field(default=10, ge=1, le=50)
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')


config = LiveSettings()
API_ORIGIN = 'https://livepeer.studio/api'
WHIP_ORIGIN = 'https://playback.livepeer.studio/webrtc'
RTMP_SERVER = 'rtmp://rtmp.livepeer.studio/live'
MAX_RESPONSE_BYTES = 256 * 1024
VERIFIED_SECONDS = 20
PROVIDER_TIMEOUT_SECONDS = 12
CDN_HOSTS = frozenset({'playback.livepeer.studio', 'livepeercdn.studio', 'livepeercdn.com', 'lp-playback.studio'})


def now():
    return datetime.now(timezone.utc)


def no_store(response: Response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'


router = APIRouter(prefix='/api/live', dependencies=[Depends(no_store)])


class LiveStream(Base):
    __tablename__ = 'live_streams'
    __table_args__ = (UniqueConstraint('owner_id', 'request_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    request_id: Mapped[str] = mapped_column(String(36))
    title: Mapped[str] = mapped_column(String(140))
    description: Mapped[str] = mapped_column(String(1000), default='')
    provider_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    playback_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    playback_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default='creating')
    record: Mapped[bool] = mapped_column(Boolean, default=False)
    publish_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CreateLive(BaseModel):
    request_id: uuid.UUID
    title: str = Field(min_length=1, max_length=140, pattern=r'.*\S.*')
    description: str = Field(default='', max_length=1000)
    record: StrictBool = False


class StartLive(BaseModel):
    confirm_public: StrictBool


class TwitchDestination(Base):
    __tablename__ = 'live_twitch_destinations'
    stream_id: Mapped[str] = mapped_column(ForeignKey('live_streams.id'), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    channel_id: Mapped[str] = mapped_column(String(128), default='')
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default='creating')


class TwitchDestinationInput(BaseModel):
    enabled: StrictBool
    consent: StrictBool = False
    expected_target_id: str | None = Field(default=None, pattern=r'^[0-9]{1,30}$')


def configured():
    return bool(config.livepeer_api_key.get_secret_value().strip())


def require_provider():
    if not configured():
        raise HTTPException(409, 'Livepeer is not configured on the Ziipa API. An administrator must set LIVEPEER_API_KEY before public broadcasting is available.')


def checked_uuid(value):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(502, 'Livepeer returned an invalid stream identifier.') from None


def checked_token(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', value):
        raise HTTPException(502, 'Livepeer returned invalid stream configuration.')
    return value


def playback_policy(raw):
    policy = raw.get('playbackPolicy')
    if not isinstance(policy, dict):
        raise HTTPException(502, 'Livepeer returned invalid playback policy.')
    return policy


def safe_playback_url(value):
    if not isinstance(value, str) or len(value) > 1000 or any(c in value for c in ('\\', '\r', '\n', '\t', '%')):
        return None
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        allowed = host in CDN_HOSTS or (host.endswith(('.livepeercdn.studio', '.lp-playback.studio')) and re.fullmatch(r'[a-z0-9.-]+', host))
        if (parsed.scheme != 'https' or not allowed or parsed.port or parsed.username or parsed.password
                or parsed.query or parsed.fragment or not parsed.path.endswith('.m3u8') or '..' in parsed.path):
            return None
        return value
    except ValueError:
        return None


async def provider_request(method, path, payload=None, allow_missing=False):
    """Fixed host + closed path grammar; no user URL, redirects or proxy env.

    Safe GETs retry once. Mutations never retry automatically because a timeout
    after provider creation has an ambiguous outcome and could create duplicates.
    """
    require_provider()
    allowed = ((method == 'POST' and path == '/stream') or
               (method == 'POST' and path == '/multistream/target') or
               (method in ('GET', 'DELETE') and re.fullmatch(r'/multistream/target/[0-9a-f-]{36}', path)) or
               (method in ('GET', 'PATCH') and re.fullmatch(r'/stream/[0-9a-f-]{36}', path)) or
               (method == 'DELETE' and re.fullmatch(r'/stream/[0-9a-f-]{36}/terminate', path)) or
               (method == 'GET' and re.fullmatch(r'/playback/[A-Za-z0-9_-]{8,128}', path)))
    if not allowed:
        raise HTTPException(500, 'Invalid live provider operation.')
    try:
        async with asyncio.timeout(PROVIDER_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4, pool=2),
                                         follow_redirects=False, trust_env=False) as client:
                for attempt in range(2 if method == 'GET' else 1):
                    try:
                        async with client.stream(method, API_ORIGIN + path,
                                                 headers={'Authorization': 'Bearer ' + config.livepeer_api_key.get_secret_value(),
                                                          'Accept': 'application/json'}, json=payload) as response:
                            if method == 'GET' and attempt == 0 and response.status_code in (429, 502, 503, 504):
                                await asyncio.sleep(0.2)
                                continue
                            if response.status_code == 404 and allow_missing:
                                return None
                            if not 200 <= response.status_code < 300:
                                raise HTTPException(502, 'Livepeer could not complete this request. Check provider configuration or retry later.')
                            chunks = bytearray()
                            async for chunk in response.aiter_bytes():
                                chunks.extend(chunk)
                                if len(chunks) > MAX_RESPONSE_BYTES:
                                    raise HTTPException(502, 'Livepeer returned an oversized response.')
                            if not chunks:
                                return {}
                            try:
                                value = json.loads(chunks)
                            except (ValueError, UnicodeDecodeError):
                                raise HTTPException(502, 'Livepeer returned an invalid response.') from None
                            if not isinstance(value, dict):
                                raise HTTPException(502, 'Livepeer returned an invalid response.')
                            return value
                    except httpx.TransportError:
                        if method == 'GET' and attempt == 0:
                            await asyncio.sleep(0.2)
                            continue
                        raise HTTPException(502, 'Livepeer is temporarily unreachable. No new live status has been confirmed.') from None
    except TimeoutError:
        raise HTTPException(504, 'Livepeer did not respond in time. Check the saved broadcast status before retrying.') from None
    raise HTTPException(502, 'Livepeer did not return a usable response.')


def owned(session, stream_id, user):
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    row = session.scalar(select(LiveStream).where(LiveStream.id == str(stream_id), LiveStream.owner_id == user.id).with_for_update())
    if row is None:
        raise HTTPException(404, 'Broadcast not found.')
    return row


def is_fresh(row):
    if not row.checked_at:
        return False
    checked = row.checked_at.replace(tzinfo=timezone.utc) if row.checked_at.tzinfo is None else row.checked_at
    return now() - timedelta(seconds=VERIFIED_SECONDS) <= checked <= now()


DETAILS = {
    'creating': 'Broadcast provisioning has not finished. Reuse the same request ID; do not create a duplicate.',
    'provisioning_unknown': 'Provisioning could not be confirmed. An administrator should reconcile this request in Livepeer before another attempt.',
    'prepared': 'Broadcast prepared. Public intake is disabled until you explicitly start.',
    'awaiting_media': 'Public intake is enabled, but Livepeer has not confirmed incoming media. Start your WHIP broadcaster or OBS encoder.',
    'live': 'Livepeer confirmed incoming media. Playback can take a few moments to become available.',
    'unknown': 'Current provider status has not been verified. This broadcast is not listed as live.',
    'ending': 'Ending has not been confirmed. Stop your encoder and retry End broadcast.',
    'ended': 'Broadcast ended. Ingest is disabled; this broadcast cannot restart.',
}


def serialize(row, owner=True):
    status = row.status
    live = status == 'live' and row.publish_enabled and is_fresh(row)
    if status == 'live' and not live:
        status = 'unknown'
    value = {'id': row.id, 'title': row.title, 'description': row.description,
             'provider': 'livepeer', 'status': status, 'live': live,
             'playback_url': row.playback_url if live else None,
             'created_at': row.created_at.isoformat(),
             'checked_at': row.checked_at.isoformat() if row.checked_at else None,
             'detail': DETAILS.get(status, DETAILS['unknown'])}
    if owner:
        value.update(record=row.record, request_id=row.request_id, ended_at=row.ended_at.isoformat() if row.ended_at else None)
    return value


async def read_provider_stream(row):
    raw = await provider_request('GET', '/stream/' + checked_uuid(row.provider_id), allow_missing=True)
    if raw is None:
        return None
    if checked_uuid(raw.get('id')) != row.provider_id or type(raw.get('isActive')) is not bool or type(raw.get('suspended')) is not bool:
        raise HTTPException(502, 'Livepeer returned invalid broadcast status.')
    return raw


async def refresh_stream(row):
    if row.status == 'ended' or not row.provider_id:
        return
    try:
        raw = await read_provider_stream(row)
        row.playback_url = None
        row.checked_at = now()
        if raw is None:
            row.status, row.publish_enabled, row.ended_at = 'ended', False, now()
            return
        if row.status == 'ending':
            if raw['suspended'] is True and raw['isActive'] is False:
                row.status, row.ended_at = 'ended', now()
            return
        policy = playback_policy(raw)
        if not row.publish_enabled:
            row.status = 'prepared' if raw['suspended'] else 'unknown'
        elif raw['suspended'] or policy.get('type') != 'public':
            row.status = 'unknown'
        elif raw['isActive'] is True:
            row.status = 'live'
            playback_id = checked_token(raw.get('playbackId'))
            if playback_id != row.playback_id:
                raise HTTPException(502, 'Livepeer returned inconsistent playback configuration.')
            playback = await provider_request('GET', '/playback/' + playback_id, allow_missing=True)
            meta = (playback or {}).get('meta', {})
            if not isinstance(meta, dict):
                raise HTTPException(502, 'Livepeer returned invalid playback information.')
            sources = meta.get('source') or []
            if not isinstance(sources, list):
                raise HTTPException(502, 'Livepeer returned invalid playback information.')
            for source in sources[:20]:
                url = safe_playback_url(source.get('url')) if isinstance(source, dict) else None
                if url:
                    row.playback_url = url
                    break
        else:
            row.status = 'awaiting_media'
    except HTTPException:
        row.playback_url = None
        row.checked_at = None
        if row.status != 'ending':
            row.status = 'unknown'
        raise


@router.get('/config')
def live_config():
    return {'configured': configured(), 'provider': 'livepeer', 'browser_ingest': 'whip',
            'native_ingest': 'whip', 'external_encoder_supported': True, 'twitch_simulcast': True, 'poll_interval_seconds': 10,
            'detail': ('Livepeer is configured. Starting enables public ingest; camera preview alone is not a broadcast.' if configured()
                       else 'Public broadcasting requires LIVEPEER_API_KEY on the Ziipa API. Camera recording remains private.')}


@router.get('/streams')
def list_streams(user: User = Depends(current_user), session: Session = Depends(db)):
    rows = session.scalars(select(LiveStream).where(LiveStream.owner_id == user.id).order_by(LiveStream.created_at.desc()).limit(50)).all()
    return [serialize(row) for row in rows]


@router.post('/streams', status_code=201, dependencies=[Depends(guard)])
async def create_stream(data: CreateLive, user: User = Depends(current_user), session: Session = Depends(db)):
    require_provider()
    # Serialize owner provisioning attempts, including the duplicate-ID check.
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    row = session.scalar(select(LiveStream).where(LiveStream.owner_id == user.id, LiveStream.request_id == str(data.request_id)))
    if row:
        if (row.title, row.description, row.record) != (data.title.strip(), data.description.strip(), data.record):
            raise HTTPException(409, 'This request ID was already used for different broadcast settings.')
        return serialize(row)
    open_count = session.scalar(select(func.count()).select_from(LiveStream).where(LiveStream.owner_id == user.id, LiveStream.status != 'ended'))
    daily = session.scalar(select(func.count()).select_from(LiveStream).where(LiveStream.owner_id == user.id, LiveStream.created_at >= now() - timedelta(days=1)))
    if open_count >= config.live_max_streams_per_owner or daily >= config.live_daily_create_limit:
        raise HTTPException(429, 'Broadcast creation limit reached. End unused broadcasts or wait for the daily limit to reset.')
    row = LiveStream(owner_id=user.id, request_id=str(data.request_id), title=data.title.strip(), description=data.description.strip(), record=data.record, status='creating')
    session.add(row)
    session.commit()  # Persist an idempotency reservation before a billable call.
    try:
        raw = await provider_request('POST', '/stream', {'name': row.title, 'creatorId': {'type': 'unverified', 'value': row.id},
            'playbackPolicy': {'type': 'public'}, 'record': data.record,
            'profiles': [{'name': '720p', 'width': 1280, 'height': 720, 'bitrate': 2000000, 'fps': 30},
                         {'name': '360p', 'width': 640, 'height': 360, 'bitrate': 700000, 'fps': 30}]})
        row.provider_id = checked_uuid(raw.get('id'))
        row.playback_id = checked_token(raw.get('playbackId'))
        session.commit()  # Keep provider ID if the following suspension fails.
        await provider_request('PATCH', '/stream/' + row.provider_id, {'suspended': True})
        row.status = 'prepared'
        row.checked_at = None
        session.commit()
        return serialize(row)
    except HTTPException:
        row.status = 'provisioning_unknown'
        session.commit()
        raise HTTPException(502, 'Broadcast provisioning could not be confirmed. Reuse the same request ID to inspect its saved status; do not create another broadcast.') from None


@router.get('/streams/{stream_id}', dependencies=[Depends(guard)])
async def get_stream(stream_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, stream_id, user)
    try:
        await refresh_stream(row)
    except HTTPException:
        session.commit()
        raise
    session.commit()
    return serialize(row)


@router.post('/streams/{stream_id}/start', dependencies=[Depends(guard)])
async def start_stream(stream_id: uuid.UUID, data: StartLive, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, stream_id, user)
    owner_id = user.id
    require_provider()
    if data.confirm_public is not True:
        raise HTTPException(422, 'Confirm that this broadcast will be publicly viewable before enabling ingest.')
    from account_services import AccountState, PrivacyInput
    account = session.get(AccountState, user.id)
    privacy = PrivacyInput(**(account.privacy or {})) if account else PrivacyInput()
    if privacy.profile_visibility != 'public':
        raise HTTPException(409, 'Public broadcasting requires a public profile. Change your privacy setting deliberately before starting; private or members-only streaming is not available.')
    if row.status in ('creating', 'provisioning_unknown', 'ending', 'ended') or not row.provider_id:
        raise HTTPException(409, 'This broadcast cannot start. Prepare a new broadcast or resolve its pending state.')
    destination = session.get(TwitchDestination, row.id)
    if destination and destination.status not in ('configured', 'detached'):
        raise HTTPException(409, 'Resolve or remove the pending Twitch destination before starting.')
    if destination and destination.status == 'configured':
        from social_publishing import twitch_ingest_for_live
        grant = await twitch_ingest_for_live(user, session)
        # The publishing helper commits while refreshing OAuth credentials.
        # Reacquire all lifecycle locks before enabling public ingest.
        row, destination = reload_twitch_state(session, owner_id, stream_id)
        require_current_twitch_grant(session, owner_id, grant['target_id'])
        account = session.get(AccountState, owner_id)
        privacy = PrivacyInput(**(account.privacy or {})) if account else PrivacyInput()
        if privacy.profile_visibility != 'public' or row.status != 'prepared' or row.publish_enabled:
            raise HTTPException(409, 'Broadcast or privacy settings changed. Review them before starting again.')
        if not destination or destination.status != 'configured':
            raise HTTPException(409, 'The Twitch destination changed before the broadcast could start.')
        if grant['target_id'] != destination.channel_id:
            raise HTTPException(409, 'The Twitch channel changed. Remove this destination and authorize it again.')
    await provider_request('PATCH', '/stream/' + checked_uuid(row.provider_id), {'suspended': False})
    row.publish_enabled = True
    row.status, row.playback_url, row.checked_at = 'awaiting_media', None, None
    session.commit()
    return serialize(row)


def destination_receipt(destination):
    return {'provider': 'twitch', 'status': destination.status if destination else 'detached',
            'channel_id': destination.channel_id if destination else '',
            'detail': ('Twitch relay configured. This is not confirmation that Twitch is receiving live video.'
                       if destination and destination.status == 'configured' else
                       'No Twitch relay is active.' if not destination or destination.status == 'detached' else
                       'Destination setup or removal is unresolved. Remove it before starting; an administrator may need to reconcile Livepeer targets.')}


def reload_twitch_state(session, owner_id, stream_id):
    session.expire_all()
    owner = session.scalar(select(User).where(User.id == owner_id).with_for_update())
    if not owner:
        raise HTTPException(401, 'The Ziipa account no longer exists.')
    row = owned(session, stream_id, owner)
    destination = session.get(TwitchDestination, row.id)
    return row, destination


def require_current_twitch_grant(session, owner_id, target_id):
    from social_publishing import grant_for
    grant = grant_for(session, owner_id, 'twitch', lock=True)
    if not grant or grant.status != 'authorized' or grant.selected_target_id != target_id:
        raise HTTPException(409, 'The Twitch authorization or selected channel changed. Reconnect before configuring a relay.')


async def remove_twitch_destination(row, destination, session):
    # A user/operator may have added other relays directly at Livepeer. Remove
    # only this saved target, never erase the entire provider destination list.
    if destination.target_id:
        if row.provider_id:
            raw = await read_provider_stream(row)
            if raw:
                kept = [target for target in multistream_targets(raw) if target['id'] != destination.target_id]
                await provider_request('PATCH', '/stream/' + checked_uuid(row.provider_id), {'multistream': {'targets': kept}})
                verified = await read_provider_stream(row)
                if verified and any(target['id'] == destination.target_id for target in multistream_targets(verified)):
                    raise HTTPException(502, 'Twitch relay removal is not confirmed. Stop the broadcast and retry.')
        await provider_request('DELETE', '/multistream/target/' + checked_uuid(destination.target_id), allow_missing=True)
        destination.target_id = None
        destination.status = 'detached'
    elif destination.status not in ('detached',):
        # Creation may have reached Livepeer before a timeout. No target was ever
        # attached without its saved ID, but do not hide possible secret cleanup.
        raise HTTPException(503, 'The unconfirmed Livepeer target must be reconciled by an administrator before removing this connection. No new target was created by this retry.')


def multistream_targets(raw):
    multistream = raw.get('multistream')
    if multistream is None:
        return []
    if not isinstance(multistream, dict) or not isinstance(multistream.get('targets', []), list):
        raise HTTPException(502, 'Livepeer returned an invalid destination list.')
    targets = multistream.get('targets', [])
    if len(targets) > 100 or any(not isinstance(target, dict) or not isinstance(target.get('id'), str) for target in targets):
        raise HTTPException(502, 'Livepeer returned an invalid destination list.')
    return targets


async def detach_twitch_destinations(owner_id: int, session: Session):
    session.scalar(select(User).where(User.id == owner_id).with_for_update())
    for destination in session.scalars(select(TwitchDestination).where(TwitchDestination.owner_id == owner_id,
                                            TwitchDestination.status != 'detached').with_for_update()).all():
        row = session.get(LiveStream, destination.stream_id)
        if row:
            await remove_twitch_destination(row, destination, session)


@router.get('/streams/{stream_id}/destinations/twitch')
def twitch_destination(stream_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, stream_id, user)
    return destination_receipt(session.get(TwitchDestination, row.id))


@router.post('/streams/{stream_id}/destinations/twitch', dependencies=[Depends(guard)])
async def set_twitch_destination(stream_id: uuid.UUID, data: TwitchDestinationInput,
                                user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, stream_id, user)
    owner_id = user.id
    destination = session.get(TwitchDestination, row.id)
    if not data.enabled:
        if destination and destination.status != 'detached':
            await remove_twitch_destination(row, destination, session)
            session.commit()
        return destination_receipt(destination)
    if data.consent is not True:
        raise HTTPException(422, 'Approve transmitting this public broadcast to your selected Twitch channel via Livepeer.')
    if not data.expected_target_id:
        raise HTTPException(422, 'Refresh your connected accounts and approve the displayed Twitch channel.')
    require_current_twitch_grant(session, owner_id, data.expected_target_id)
    if row.publish_enabled or row.status != 'prepared' or not row.provider_id:
        raise HTTPException(409, 'Add destinations to a prepared broadcast before enabling public ingest.')
    if destination and destination.status == 'configured':
        if destination.channel_id != data.expected_target_id:
            raise HTTPException(409, 'The configured Twitch channel differs from the channel you approved. Remove it and approve again.')
        return destination_receipt(destination)
    if destination and destination.status != 'detached':
        raise HTTPException(409, 'This destination request is already pending. Remove or reconcile it; do not create a duplicate target.')
    from social_publishing import twitch_ingest_for_live
    grant = await twitch_ingest_for_live(user, session)
    if grant['target_id'] != data.expected_target_id:
        raise HTTPException(409, 'The Twitch channel changed during authorization. Refresh and approve the displayed channel again.')
    if grant['server_url'] != 'rtmps://ingest.global-contribute.live-video.net/app/' or not re.fullmatch(r'[A-Za-z0-9_-]{8,250}', grant['stream_key']):
        raise HTTPException(502, 'Twitch returned an invalid secure ingest destination.')
    row, destination = reload_twitch_state(session, owner_id, stream_id)
    require_current_twitch_grant(session, owner_id, data.expected_target_id)
    if row.publish_enabled or row.status != 'prepared' or not row.provider_id:
        raise HTTPException(409, 'Broadcast state changed before the Twitch destination could be reserved.')
    if destination and destination.status == 'configured':
        if destination.channel_id != data.expected_target_id:
            raise HTTPException(409, 'The configured Twitch channel changed. Refresh before approving this destination.')
        return destination_receipt(destination)
    if destination and destination.status != 'detached':
        raise HTTPException(409, 'A Twitch destination is already pending. Reconcile it before trying another.')
    if not destination:
        destination = TwitchDestination(stream_id=row.id, owner_id=user.id)
        session.add(destination)
    destination.channel_id, destination.status = grant['target_id'], 'creating'
    session.commit()  # Durable reservation; never automatically repeat creation.
    row, destination = reload_twitch_state(session, owner_id, stream_id)
    require_current_twitch_grant(session, owner_id, grant['target_id'])
    if row.status != 'prepared' or row.publish_enabled:
        raise HTTPException(409, 'Broadcast state changed. Reconcile the reserved destination before continuing.')
    try:
        result = await provider_request('POST', '/multistream/target', {
            'name': 'ziipa-twitch-' + row.id, 'url': grant['server_url'] + grant['stream_key']})
        destination.target_id = checked_uuid(result.get('id'))
        # Keep the ID even if attachment fails so explicit removal can clean it.
        session.commit()
        row, destination = reload_twitch_state(session, owner_id, stream_id)
        require_current_twitch_grant(session, owner_id, grant['target_id'])
        if row.status != 'prepared' or row.publish_enabled or session.get(TwitchDestination, row.id).status != 'creating':
            raise HTTPException(409, 'Broadcast changed during destination setup. Remove the saved destination.')
        raw = await read_provider_stream(row)
        if not raw or not raw['suspended']:
            raise HTTPException(409, 'The broadcast must remain suspended while configuring a destination.')
        targets = [target for target in multistream_targets(raw) if target['id'] != destination.target_id]
        if len(targets) >= 100:
            raise HTTPException(409, 'The broadcast already has too many destinations. Remove a destination before retrying.')
        targets.append({'id': destination.target_id, 'profile': '720p', 'videoOnly': False})
        await provider_request('PATCH', '/stream/' + checked_uuid(row.provider_id),
                               {'multistream': {'targets': targets}})
        raw = await read_provider_stream(row)
        if not raw or not raw['suspended'] or not any(t['id'] == destination.target_id for t in multistream_targets(raw)):
            raise HTTPException(502, 'Twitch relay configuration is not confirmed.')
        destination.status = 'configured'
        session.commit()
        return destination_receipt(destination)
    except HTTPException:
        # Do not resurrect a concurrently detached/deleted destination after a
        # checkpoint released the transaction. Its cleanup has already won.
        current = session.get(TwitchDestination, str(stream_id))
        if current and current.status != 'detached':
            current.status = 'unknown'
            session.commit()
        raise HTTPException(502, 'Twitch relay setup is unresolved. Remove this destination before trying another; do not assume a broadcast was sent.') from None


@router.post('/streams/{stream_id}/ingest', dependencies=[Depends(guard)])
async def ingest(stream_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, stream_id, user)
    if not row.publish_enabled or row.status not in ('awaiting_media', 'live', 'unknown'):
        raise HTTPException(409, 'Enable public ingest before requesting encoder credentials.')
    raw = await read_provider_stream(row)
    if raw is None or raw['suspended'] or playback_policy(raw).get('type') != 'public':
        raise HTTPException(409, 'Livepeer ingest is not available for this broadcast.')
    key = checked_token(raw.get('streamKey'))
    return {'stream_id': row.id, 'whip_url': WHIP_ORIGIN + '/' + key, 'rtmp_server': RTMP_SERVER, 'stream_key': key,
            'detail': 'Secret encoder credentials. Keep in memory only; never place in a public post, analytics, logs or persistent browser storage.'}


@router.post('/streams/{stream_id}/end', dependencies=[Depends(guard)])
async def end_stream(stream_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, stream_id, user)
    if row.status == 'ended':
        return serialize(row)
    if not row.provider_id:
        raise HTTPException(409, 'Provider creation is unresolved. An administrator must reconcile the request in Livepeer; no safe end operation is available yet.')
    row.publish_enabled, row.playback_url, row.status, row.checked_at = False, None, 'ending', None
    session.commit()  # Unlist immediately even if the provider is unreachable.
    try:
        await provider_request('PATCH', '/stream/' + checked_uuid(row.provider_id), {'suspended': True})
        await provider_request('DELETE', '/stream/' + row.provider_id + '/terminate', allow_missing=True)
        await refresh_stream(row)
        destination = session.get(TwitchDestination, row.id)
        if destination and destination.status != 'detached':
            await remove_twitch_destination(row, destination, session)
    except HTTPException:
        session.commit()
        raise HTTPException(502, 'End broadcast has not been confirmed. Stop your encoder now and retry End broadcast.') from None
    session.commit()
    return serialize(row)


def optional_viewer(request: Request, session: Session = Depends(db)):
    if request.headers.get('authorization') is None and not request.cookies.get('ziipa_session'):
        return None
    return current_user(request, session)


def public_visible(session, row, viewer, discovery=False):
    from account_services import AccountState, PrivacyInput
    from creator import prefs_for
    owner = session.get(User, row.owner_id)
    if not owner:
        return False
    account = session.get(AccountState, owner.id)
    privacy = PrivacyInput(**(account.privacy or {})) if account else PrivacyInput()
    if privacy.profile_visibility != 'public' or (discovery and not privacy.discoverable):
        return False
    if viewer:
        preferences = prefs_for(session, viewer)
        owner_preferences = prefs_for(session, owner)
        if (owner.id in preferences['blocked_user_ids'] or owner.name in preferences['blocked_creators']
                or viewer.id in owner_preferences['blocked_user_ids'] or viewer.name in owner_preferences['blocked_creators']):
            return False
        if any(word.strip() and word.lower() in (row.title + ' ' + row.description).lower() for word in preferences['muted_words']):
            return False
    return True


@router.get('/public', dependencies=[Depends(guard)])
def public_streams(viewer: User | None = Depends(optional_viewer), session: Session = Depends(db)):
    # Bounded cache of owner-verified states. Stale entries disappear; no
    # unauthenticated fan-out to all provider streams on every feed request.
    rows = session.scalars(select(LiveStream).where(LiveStream.publish_enabled.is_(True), LiveStream.status == 'live',
        LiveStream.checked_at >= now() - timedelta(seconds=VERIFIED_SECONDS)).order_by(LiveStream.checked_at.desc()).limit(20)).all()
    return [serialize(row, owner=False) for row in rows if is_fresh(row) and row.playback_url and public_visible(session, row, viewer, discovery=True)]


@router.get('/public/{stream_id}', dependencies=[Depends(guard)])
async def public_stream(stream_id: uuid.UUID, viewer: User | None = Depends(optional_viewer), session: Session = Depends(db)):
    row = session.scalar(select(LiveStream).where(LiveStream.id == str(stream_id), LiveStream.publish_enabled.is_(True)).with_for_update())
    if not row or not public_visible(session, row, viewer):
        raise HTTPException(404, 'Public broadcast is unavailable.')
    try:
        await refresh_stream(row)
    except HTTPException:
        session.commit()
        raise HTTPException(503, 'Public broadcast status is temporarily unavailable.') from None
    session.commit()
    result = serialize(row, owner=False)
    if not result['live'] or not result['playback_url']:
        raise HTTPException(404, 'This broadcast is not currently confirmed live with available playback.')
    return result


async def end_live_for_privacy(user_id: int, session: Session):
    """Caller holds its account transaction. Fail closed, preserving owner data.

    Call before making a public profile private/members-only or deleting it.
    This does not commit or delete rows. It also does not remove recordings.
    """
    session.scalar(select(User).where(User.id == user_id).with_for_update())
    rows = session.scalars(select(LiveStream).where(LiveStream.owner_id == user_id).with_for_update()).all()
    for row in rows:
        if row.status == 'ended':
            continue
        if not row.provider_id:
            raise HTTPException(503, 'Broadcast provisioning must be reconciled by an administrator before changing privacy or deleting this account.')
        try:
            await provider_request('PATCH', '/stream/' + checked_uuid(row.provider_id), {'suspended': True})
            await provider_request('DELETE', '/stream/' + row.provider_id + '/terminate', allow_missing=True)
            row.publish_enabled, row.playback_url, row.status, row.checked_at = False, None, 'ending', None
            await refresh_stream(row)
            if row.status != 'ended':
                raise HTTPException(503, 'Broadcast ending is not confirmed.')
        except HTTPException:
            raise HTTPException(503, 'Live broadcast shutdown is not confirmed. Stop your encoder and retry. Account deletion or privacy change has not been completed.') from None
    await detach_twitch_destinations(user_id, session)


async def delete_live_account(user_id: int, session: Session):
    """Call before deleting User; raises 503 rather than orphaning active ingest."""
    await end_live_for_privacy(user_id, session)
    for destination in session.scalars(select(TwitchDestination).where(TwitchDestination.owner_id == user_id)).all():
        session.delete(destination)
    session.flush()
    rows = session.scalars(select(LiveStream).where(LiveStream.owner_id == user_id)).all()
    for row in rows:
        session.delete(row)
    session.flush()
