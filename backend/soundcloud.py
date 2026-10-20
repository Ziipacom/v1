"""Isolated, opt-in SoundCloud catalog access. Never downloads or mixes audio.

API terms prohibit persistent user-content storage/file-save functionality. Only
encrypted authorization and minimal linked-profile metadata are retained here.
"""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import json
import re
import secrets
import time
from types import SimpleNamespace
from typing import Literal
from urllib.parse import quote, urlencode, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.exceptions import RedisError
from sqlalchemy import DateTime, ForeignKey, String, Text, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, cache, current_user, db, guard
import social_publishing as publishing


class SoundCloudSettings(BaseSettings):
    enabled: bool = False
    client_id: str = ''
    client_secret: str = Field(default='', repr=False)
    public_search_enabled: bool = False
    owner_widget_enabled: bool = False
    model_config = SettingsConfigDict(env_prefix='SOUNDCLOUD_', env_file='.env', extra='ignore', hide_input_in_errors=True)


config = SoundCloudSettings()
TOKEN_URL = 'https://secure.soundcloud.com/oauth/token'
REVOKE_URL = 'https://secure.soundcloud.com/sign-out'
ME_URL = 'https://api.soundcloud.com/me'
MINE_URL = 'https://api.soundcloud.com/me/tracks'
SEARCH_URL = 'https://api.soundcloud.com/tracks'
STATE_TTL = 600
MAX_JSON = 256 * 1024
LIMIT = 20
OAUTH_PATH = '/api/music/soundcloud/oauth'
TRACK = re.compile(r'^soundcloud:tracks:[1-9][0-9]{0,19}$')
USER = re.compile(r'^soundcloud:users:[1-9][0-9]{0,19}$')
COOKIE = 'ziipa_oauth_soundcloud'
RELEASE_LOCK = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end"
RATE = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n"


class SoundCloudConnection(Base):
    __tablename__ = 'soundcloud_connections'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    revision: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(String(32), default='pending')
    token_cipher: Mapped[str] = mapped_column(Text, default='')
    account_urn: Mapped[str] = mapped_column(String(64), default='')
    username: Mapped[str] = mapped_column(String(100), default='')
    profile_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    oauth_epoch: Mapped[str] = mapped_column(String(80), default='')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def private_response(response: Response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'


router = APIRouter(prefix='/api/music/soundcloud', dependencies=[Depends(private_response)])


class Consent(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, hide_input_in_errors=True)
    consent: Literal[True]

    @field_validator('consent', mode='before')
    @classmethod
    def explicit(cls, value):
        if value is not True:
            raise ValueError('Explicit consent is required')
        return value


def callback_url():
    return publishing.approved_api_origin() + OAUTH_PATH + '/callback'


def connection(session, owner_id, *, lock=False):
    query = select(SoundCloudConnection).where(SoundCloudConnection.owner_id == owner_id).execution_options(populate_existing=True)
    return session.scalar(query.with_for_update() if lock else query)


def receipt(row):
    return {'status': row.status if row.status in {'authorized', 'reauthorization_required'} else 'disconnected',
            'revision': row.revision, 'username': row.username, 'profile_url': row.profile_url} if row else None


def readiness(row=None):
    missing = []
    if not config.enabled:
        missing.append('SoundCloud integration is disabled by the operator')
    if not config.client_id or not config.client_secret:
        missing.append('Existing eligible registered SoundCloud application client ID and secret')
    try:
        publishing.encryption_key()
    except HTTPException:
        missing.append('Stable publishing encryption key')
    try:
        callback_url()
    except HTTPException:
        missing.append('Approved fixed public browser OAuth origin and registered SoundCloud callback')
    ready = not missing
    linked = bool(row and row.status == 'authorized' and row.token_cipher)
    return {'implemented': True, 'enabled': config.enabled, 'configured': ready, 'can_connect': ready,
            'connected': linked, 'can_search': ready and linked,
            'can_play_owned': ready and linked and config.owner_widget_enabled, 'can_import': False,
            'public_search_enabled': config.public_search_enabled,
            'native_oauth_supported': False, 'connect_via_portal': publishing.portal_url(),
            'requirements': missing, 'connection': receipt(row),
            'detail': 'Isolated SoundCloud metadata and creator-owned official playback only. New API credentials currently require Artist Pro; no purchase is made. No audio import, offline cache, synchronization into edits, or AI input is permitted by this integration.'}


def require_ready():
    state = readiness()
    if not state['configured']:
        raise HTTPException(409, 'SoundCloud is not ready: ' + '; '.join(state['requirements']))


def state_key(kind, raw):
    return 'soundcloud_oauth:' + kind + ':' + hashlib.sha256(raw.encode()).hexdigest()


def store_state(kind, raw, data):
    try:
        if not cache.set(state_key(kind, raw), json.dumps(data, separators=(',', ':')), ex=STATE_TTL, nx=True):
            raise HTTPException(503, 'Authorization coordination is busy. Start again.')
    except RedisError:
        raise HTTPException(503, 'Authorization state storage is unavailable.') from None


def consume_state(kind, raw):
    try:
        value = cache.getdel(state_key(kind, raw))
    except RedisError:
        raise HTTPException(503, 'Authorization state storage is unavailable.') from None
    try:
        result = json.loads(value or '')
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, TypeError):
        raise HTTPException(400, 'Authorization expired or was already used. Start again.') from None


def verify_browser(request, record, session):
    publishing.verify_initiating_browser(request, record, session)
    publishing._enforce_actor(session, record['owner_id'], mutation=True)
    binding = request.cookies.get(COOKIE, '')
    if not binding or not secrets.compare_digest(record.get('binding_hash', ''), hashlib.sha256(binding.encode()).hexdigest()):
        raise HTTPException(400, 'Finish authorization in the same browser that started it.')
    row = connection(session, record['owner_id'])
    if not row or not row.oauth_epoch or not secrets.compare_digest(row.oauth_epoch, record.get('epoch', '')):
        raise HTTPException(409, 'The SoundCloud connection changed. Start authorization again.')
    return row


@router.get('/config')
def get_config(user: User = Depends(current_user), session: Session = Depends(db)):
    return readiness(connection(session, user.id))


@router.post('/oauth/start', dependencies=[Depends(guard)])
def start_oauth(data: Consent, request: Request, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    require_ready()
    if request.headers.get('authorization') or not request.cookies.get('ziipa_session'):
        return {'status': 'browser_sign_in_required', 'auth_url': None, 'connect_via_portal': publishing.portal_url(),
                'detail': 'Sign in to the same Ziipa account in the portal and connect SoundCloud there. Return to the app and refresh. No native token handoff is implemented.'}
    publishing._enforce_actor(session, user.id, mutation=True)
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    row = connection(session, user.id, lock=True)
    if row is None:
        row = SoundCloudConnection(owner_id=user.id, revision=1)
        session.add(row)
    else:
        row.revision += 1
    row.oauth_epoch = secrets.token_urlsafe(40)
    ticket, binding = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
    store_state('ticket', ticket, {'owner_id': user.id, 'epoch': row.oauth_epoch,
        'binding_hash': hashlib.sha256(binding.encode()).hexdigest(),
        'session_hash': hashlib.sha256(request.cookies['ziipa_session'].encode()).hexdigest()})
    session.commit()
    response.set_cookie(COOKIE, binding, max_age=STATE_TTL, httponly=True, secure=publishing.approved_api_origin().startswith('https://'), samesite='lax', path=OAUTH_PATH)
    return {'status': 'authorization_required', 'auth_url': publishing.approved_api_origin() + OAUTH_PATH + '/authorize?' + urlencode({'ticket': ticket}),
            'connect_via_portal': publishing.portal_url(), 'detail': 'Authorize profile and track metadata access. Ziipa does not upload, download, modify, train on or publish SoundCloud audio.'}


@router.get('/oauth/authorize')
def authorize(request: Request, ticket: str = Query(min_length=32, max_length=200), session: Session = Depends(db)):
    require_ready()
    record = consume_state('ticket', ticket)
    verify_browser(request, record, session)
    state, verifier = secrets.token_urlsafe(40), secrets.token_urlsafe(48)
    cipher = publishing.encrypt_tokens(record['owner_id'], 'soundcloud', {'verifier': verifier})
    store_state('callback', state, {**record, 'verifier_cipher': cipher})
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    result = RedirectResponse('https://secure.soundcloud.com/authorize?' + urlencode({
        'client_id': config.client_id, 'redirect_uri': callback_url(), 'response_type': 'code',
        'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'}), status_code=302)
    private_response(result)
    return result


def api_client():
    return httpx.AsyncClient(timeout=httpx.Timeout(12, connect=5), follow_redirects=False, trust_env=False)


@asynccontextmanager
async def bounded_client():
    try:
        async with asyncio.timeout(25), api_client() as client:
            yield client
    except TimeoutError:
        raise HTTPException(502, 'SoundCloud request timed out. Retry through the explicit connection or search controls.') from None


async def provider_json(client, method, url, **kwargs):
    allowed = url in {TOKEN_URL, REVOKE_URL, ME_URL, MINE_URL, SEARCH_URL} or bool(re.fullmatch(r'https://api\.soundcloud\.com/tracks/soundcloud%3Atracks%3A[1-9][0-9]{0,19}', url))
    if not allowed or method not in {'GET', 'POST'}:
        raise ValueError('SoundCloud endpoint is not allowlisted')
    try:
        async with client.stream(method, url, **kwargs) as response:
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                if len(raw) + len(chunk) > MAX_JSON:
                    raise HTTPException(502, 'SoundCloud response exceeded the bounded metadata limit.')
                raw.extend(chunk)
            if response.status_code == 429:
                raise HTTPException(429, 'SoundCloud rate limit reached. Try again later.', headers={'Retry-After': '60'})
            try:
                body = json.loads(raw) if raw else {}
            except ValueError:
                raise HTTPException(502, 'SoundCloud returned unverifiable metadata.') from None
            if not isinstance(body, (dict, list)):
                raise HTTPException(502, 'SoundCloud returned unverifiable metadata.')
            return response.status_code, body
    except httpx.HTTPError:
        raise HTTPException(502, 'SoundCloud could not be reached safely. Try again later.') from None


def identifier(value, kind):
    if isinstance(value, bool):
        return None
    value = str(value)
    if re.fullmatch(r'[1-9][0-9]{0,19}', value):
        value = 'soundcloud:' + kind + ':' + value
    return value if (TRACK if kind == 'tracks' else USER).fullmatch(value) else None


def plain(value, maximum):
    return ''.join(char for char in str(value or '') if ord(char) >= 32 and ord(char) != 127)[:maximum]


def soundcloud_url(value, *, profile=False):
    if not isinstance(value, str) or len(value) > 500:
        return None
    try:
        parsed = urlsplit(value)
        pattern = r'/[A-Za-z0-9_-]{1,200}/?' if profile else r'/[A-Za-z0-9_-]{1,200}/[A-Za-z0-9_-]{1,200}/?'
        if (parsed.scheme == 'https' and parsed.netloc == 'soundcloud.com' and not parsed.query and not parsed.fragment
                and re.fullmatch(pattern, parsed.path)):
            return 'https://soundcloud.com' + parsed.path.rstrip('/')
    except ValueError:
        pass
    return None


def valid_tokens(data):
    if not isinstance(data, dict):
        raise HTTPException(502, 'SoundCloud authorization was not verified.')
    access, refresh, expiry = data.get('access_token'), data.get('refresh_token'), data.get('expires_in')
    valid = lambda value: isinstance(value, str) and bool(re.fullmatch(r'[\x21-\x7e]{1,8192}', value))
    if not valid(access) or not valid(refresh) or type(expiry) is not int or not 60 <= expiry <= 86400:
        raise HTTPException(502, 'SoundCloud returned incomplete authorization. Reconnect through the portal.')
    return {'access_token': access, 'refresh_token': refresh, 'expires_at': time.time() + expiry}


def decrypted(row):
    return publishing.decrypt_tokens(SimpleNamespace(owner_id=row.owner_id, provider='soundcloud', token_cipher=row.token_cipher))


@router.get('/oauth/callback')
async def callback(request: Request, state: str = Query(min_length=32, max_length=200), code: str = Query(default='', max_length=4096), error: str = Query(default='', max_length=100), session: Session = Depends(db)):
    require_ready()
    record = consume_state('callback', state)
    verify_browser(request, record, session)
    if error or not code:
        raise HTTPException(400, 'SoundCloud authorization was not approved. No credentials were saved.')
    verifier = publishing.decrypt_tokens(SimpleNamespace(owner_id=record['owner_id'], provider='soundcloud', token_cipher=record['verifier_cipher']))['verifier']
    session.commit()
    async with bounded_client() as client:
        status, data = await provider_json(client, 'POST', TOKEN_URL, data={
            'grant_type': 'authorization_code', 'client_id': config.client_id, 'client_secret': config.client_secret,
            'redirect_uri': callback_url(), 'code': code, 'code_verifier': verifier})
        if status != 200:
            raise HTTPException(502, 'SoundCloud did not approve this authorization. Start again.')
        tokens = valid_tokens(data)
        status, profile = await provider_json(client, 'GET', ME_URL, headers={'Authorization': 'OAuth ' + tokens['access_token']})
    if status != 200 or not isinstance(profile, dict):
        raise HTTPException(502, 'SoundCloud account ownership could not be verified.')
    account = identifier(profile.get('urn') or profile.get('id'), 'users')
    profile_url = soundcloud_url(profile.get('permalink_url'), profile=True)
    if not account or not profile_url:
        raise HTTPException(502, 'SoundCloud returned an invalid linked profile.')
    session.expire_all()
    session.scalar(select(User).where(User.id == record['owner_id']).with_for_update())
    row = verify_browser(request, record, session)
    row = connection(session, row.owner_id, lock=True)
    row.token_cipher = publishing.encrypt_tokens(row.owner_id, 'soundcloud', tokens)
    row.account_urn, row.username, row.profile_url = account, plain(profile.get('username'), 100), profile_url
    row.status, row.oauth_epoch = 'authorized', ''
    row.revision += 1
    session.commit()
    result = HTMLResponse('<!doctype html><meta name="referrer" content="no-referrer"><title>Ziipa SoundCloud connection</title><h1>SoundCloud connected</h1><p>Return to Ziipa and refresh the SoundCloud library. No audio has been downloaded, imported, trained on, or published.</p>')
    result.delete_cookie(COOKIE, path=OAUTH_PATH)
    private_response(result)
    return result


async def access_token(session, row, client):
    tokens = decrypted(row)
    if tokens.get('expires_at', 0) > time.time() + 60:
        return tokens['access_token']
    key, lease = f'soundcloud_refresh:{row.owner_id}', secrets.token_urlsafe(24)
    try:
        if not cache.set(key, lease, ex=40, nx=True):
            raise HTTPException(409, 'SoundCloud authorization is refreshing. Try again shortly.')
    except RedisError:
        raise HTTPException(503, 'Authorization coordination is unavailable.') from None
    owner, original = row.owner_id, row.token_cipher
    try:
        session.commit()
        publishing._enforce_actor(session, owner, mutation=True)
        try:
            status, result = await provider_json(client, 'POST', TOKEN_URL, data={
                'grant_type': 'refresh_token', 'client_id': config.client_id, 'client_secret': config.client_secret,
                'refresh_token': tokens.get('refresh_token', '')})
        except (HTTPException, asyncio.CancelledError):
            # Single-use refresh may have reached the provider despite a lost reply.
            session.expire_all()
            latest = connection(session, owner, lock=True)
            if latest and latest.token_cipher == original:
                latest.status = 'reauthorization_required'
                latest.revision += 1
                session.commit()
            raise
        session.expire_all()
        latest = connection(session, owner, lock=True)
        if not latest or latest.status != 'authorized' or latest.token_cipher != original:
            raise HTTPException(409, 'SoundCloud authorization changed during refresh. Refresh connections.')
        if status != 200:
            latest.status = 'reauthorization_required'
            latest.revision += 1
            session.commit()
            raise HTTPException(409, 'Reconnect SoundCloud to renew authorization.')
        try:
            renewed = valid_tokens(result)
        except HTTPException:
            latest.status = 'reauthorization_required'
            latest.revision += 1
            session.commit()
            raise
        latest.token_cipher = publishing.encrypt_tokens(owner, 'soundcloud', renewed)
        session.commit()
        return renewed['access_token']
    finally:
        try:
            cache.eval(RELEASE_LOCK, 1, key, lease)
        except RedisError:
            pass


def require_connection(session, owner):
    require_ready()
    row = connection(session, owner)
    if not row or row.status != 'authorized' or not row.token_cipher:
        raise HTTPException(409, 'Connect SoundCloud through the Ziipa portal first.')
    return row


def catalog_rate(owner):
    try:
        if cache.eval(RATE, 1, f'soundcloud_rate:user:{owner}') > 20 or cache.eval(RATE, 1, 'soundcloud_rate:app') > 60:
            raise HTTPException(429, 'SoundCloud catalog allowance reached. Try again in a minute.', headers={'Retry-After': '60'})
    except RedisError:
        raise HTTPException(503, 'Catalog request coordination is unavailable.') from None


def track_metadata(track, account):
    if not isinstance(track, dict) or not isinstance(track.get('user'), dict):
        return None
    item_id = identifier(track.get('urn') or track.get('id'), 'tracks')
    actor = identifier(track['user'].get('urn') or track['user'].get('id') or track.get('user_id'), 'users')
    permalink, profile = soundcloud_url(track.get('permalink_url')), soundcloud_url(track['user'].get('permalink_url'), profile=True)
    if not item_id or not actor or not permalink or not profile:
        return None
    owned = actor == account
    sharing = track.get('sharing')
    if sharing not in {'public', 'private'}:
        return None
    if sharing == 'private' and not owned:
        return None
    access = track.get('access') if track.get('access') in {'playable', 'preview', 'blocked'} else 'unknown'
    can_embed = bool(config.owner_widget_enabled and owned and sharing == 'public' and access == 'playable'
                     and track.get('streamable') is True and track.get('embeddable_by') == 'all')
    duration = track.get('duration')
    return {'id': item_id, 'title': plain(track.get('title'), 180), 'uploader': plain(track['user'].get('username'), 100),
            'permalink_url': permalink, 'profile_url': profile, 'duration_ms': duration if type(duration) is int and 0 <= duration <= 86400000 else None,
            'sharing': sharing, 'access': access, 'owned': owned, 'can_embed': can_embed,
            'can_import': False, 'license': plain(track.get('license'), 80), 'attribution': 'SoundCloud'}


def recheck(request, session, owner, expected_cipher):
    session.expire_all()
    if current_user(request, session).id != owner:
        raise HTTPException(401, 'The Ziipa sign-in changed.')
    latest = connection(session, owner)
    if not latest or latest.status != 'authorized' or latest.token_cipher != expected_cipher:
        raise HTTPException(409, 'SoundCloud was disconnected or changed while the request was running.')
    return latest


async def authorized_get(request, session, owner, url, params=None):
    row = require_connection(session, owner)
    publishing._enforce_actor(session, owner)
    catalog_rate(owner)
    async with bounded_client() as client:
        token = await access_token(session, row, client)
        latest = connection(session, owner)
        if not latest or latest.status != 'authorized':
            raise HTTPException(409, 'SoundCloud connection changed. Refresh before searching.')
        expected, account = latest.token_cipher, latest.account_urn
        session.commit()
        status, data = await provider_json(client, 'GET', url, params=params, headers={'Authorization': 'OAuth ' + token})
    latest = recheck(request, session, owner, expected)
    if status == 401:
        latest.status = 'reauthorization_required'
        latest.revision += 1
        session.commit()
        raise HTTPException(409, 'SoundCloud authorization expired. Reconnect through the portal.')
    if status != 200:
        raise HTTPException(502 if status >= 500 else 409, 'SoundCloud did not make this metadata available. Open the official SoundCloud page or retry later.')
    return data, account


@router.get('/tracks', dependencies=[Depends(guard)])
async def tracks(request: Request, q: str = Query(default='', max_length=140), scope: Literal['mine', 'public'] = 'mine', user: User = Depends(current_user), session: Session = Depends(db)):
    if scope == 'public' and not config.public_search_enabled:
        raise HTTPException(409, 'Public catalog search is disabled until the operator reviews the registered SoundCloud app use. Your connected library is available separately.')
    params = {'limit': LIMIT, 'linked_partitioning': 'true'}
    if scope == 'public':
        if not q.strip():
            raise HTTPException(422, 'Enter a search term for public discovery.')
        params['q'] = q.strip()
    data, account = await authorized_get(request, session, user.id, MINE_URL if scope == 'mine' else SEARCH_URL, params)
    collection = data.get('collection') if isinstance(data, dict) else data
    if not isinstance(collection, list):
        raise HTTPException(502, 'SoundCloud returned an invalid catalog page.')
    results = [value for track in collection[:LIMIT] if (value := track_metadata(track, account))
               and ((scope == 'mine' and value['owned']) or (scope == 'public' and value['sharing'] == 'public'))
               and (scope == 'public' or not q.strip() or q.casefold().strip() in (value['title'] + ' ' + value['uploader']).casefold())]
    return {'scope': scope, 'tracks': results, 'has_more': bool(isinstance(data, dict) and data.get('next_href')),
            'notice': 'First bounded catalog page only. Content remains on SoundCloud. Listening does not grant reuse, synchronization or AI rights. No audio is cached or imported.'}


@router.post('/tracks/{track_id}/playback', dependencies=[Depends(guard)])
async def playback(track_id: str, data: Consent, request: Request, user: User = Depends(current_user), session: Session = Depends(db)):
    item_id = identifier(track_id, 'tracks')
    if not item_id:
        raise HTTPException(422, 'Choose a valid SoundCloud track identifier.')
    value, account = await authorized_get(request, session, user.id, SEARCH_URL + '/' + quote(item_id, safe=''))
    track = track_metadata(value, account)
    if not track or track['id'] != item_id:
        raise HTTPException(502, 'SoundCloud track metadata could not be verified.')
    widget = ('https://w.soundcloud.com/player/?' + urlencode({'url': track['permalink_url'], 'auto_play': 'false',
              'show_comments': 'false', 'show_reposts': 'false', 'visual': 'false'})) if track['can_embed'] else None
    return {'mode': 'widget' if widget else 'external', 'widget_url': widget, 'permalink_url': track['permalink_url'],
            'attribution': 'SoundCloud', 'detail': 'Official SoundCloud player for your public track. No download, attachment, AI input or edit synchronization.' if widget else 'Open SoundCloud for playback. This track is private, restricted, not owned by this connected account, or embedding is disabled; Ziipa does not bypass those limits.'}


async def revoke(row):
    try:
        token = decrypted(row).get('access_token')
        if not token:
            return False
        async with asyncio.timeout(10), api_client() as client:
            status, _ = await provider_json(client, 'POST', REVOKE_URL, json={'access_token': token})
        return status in {200, 204, 401}
    except (HTTPException, TimeoutError, ValueError, KeyError):
        return False


@router.delete('/connection', dependencies=[Depends(guard)])
async def disconnect(revision: int = Query(ge=1), user: User = Depends(current_user), session: Session = Depends(db)):
    row = connection(session, user.id, lock=True)
    if not row or row.revision != revision:
        raise HTTPException(409, 'SoundCloud connection changed. Refresh before disconnecting.')
    saved = SimpleNamespace(owner_id=row.owner_id, token_cipher=row.token_cipher)
    session.delete(row)
    session.commit()
    revoked = await revoke(saved)
    return {'disconnected': True, 'provider_revoked': revoked,
            'detail': 'Local authorization and profile data deleted. SoundCloud authorization revoked.' if revoked else 'Local authorization and profile data deleted. SoundCloud revocation could not be confirmed; revoke Ziipa in SoundCloud account settings as well.'}


def export_soundcloud_data(session, owner):
    return {'connection': receipt(connection(session, owner)), 'stored_audio': False}


async def delete_soundcloud_account(owner, session):
    row = connection(session, owner, lock=True)
    if row:
        await revoke(SimpleNamespace(owner_id=row.owner_id, token_cipher=row.token_cipher))
        session.execute(delete(SoundCloudConnection).where(SoundCloudConnection.owner_id == owner))
