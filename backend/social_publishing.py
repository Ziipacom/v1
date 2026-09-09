"""Consent-based provider authorization and delivery; never simulates success.

YouTube, TikTok and Meta adapters enforce real receipts and explicit consent.
Unsupported providers report missing adapters. Credentials stay encrypted on the server.
"""
import asyncio
from contextlib import asynccontextmanager
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from typing import Literal
from urllib.parse import urlencode, urlsplit
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.exceptions import RedisError
from sqlalchemy import ForeignKey, String, Text, JSON, DateTime, UniqueConstraint, select, delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column, Session

from app import Base, User, cache, current_user, db, guard, settings
import creator
from creator import CreatorItem, CreatorMedia, PROVIDERS, SocialProvider
from storage_services import LocalStorage, R2Storage, object_key, storage
import tiktok_publishing_adapter as tiktok_adapter
import twitch_publishing_adapter as twitch_adapter
import bluesky_publishing_adapter as bluesky_adapter

router = APIRouter(prefix='/api/publishing')


class PublishingSettings(BaseSettings):
    encryption_key: str = Field(default='', repr=False)
    api_origin: str = ''
    approved_origins: str = ''
    allow_insecure_localhost: bool = False
    portal_url: str = 'https://ziipa.com/portal'
    youtube_client_id: str = ''
    youtube_client_secret: str = Field(default='', repr=False)
    youtube_public_approved: bool = False
    tiktok_client_key: str = ''
    tiktok_client_secret: str = Field(default='', repr=False)
    tiktok_public_approved: bool = False
    tiktok_verified_media_origins: str = ''
    twitch_client_id: str = ''
    twitch_client_secret: str = Field(default='', repr=False)
    bluesky_enabled: bool = False
    bluesky_private_jwk: str = Field(default='', repr=False)
    bluesky_node_binary: str = 'node'
    bluesky_extra_origins: str = ''
    meta_client_id: str = ''
    meta_client_secret: str = Field(default='', repr=False)
    meta_graph_version: str = ''
    meta_media_origins: str = ''
    meta_public_approved: bool = False
    model_config = SettingsConfigDict(env_prefix='PUBLISHING_', env_file='.env', extra='ignore')


config = PublishingSettings()
STATE_TTL = 600
MAX_MEDIA_BYTES = 25 * 1024 * 1024
MAX_JSON_BYTES = 1024 * 1024
TOKEN_URL = 'https://oauth2.googleapis.com/token'
REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'
VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos'
UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos'
HTTP_URLS = frozenset((TOKEN_URL, REVOKE_URL, CHANNELS_URL, VIDEOS_URL, UPLOAD_URL))
YOUTUBE_SCOPES = frozenset(('https://www.googleapis.com/auth/youtube.upload',
                            'https://www.googleapis.com/auth/youtube.readonly'))


class PublishingGrant(Base):
    __tablename__ = 'publishing_grants'
    __table_args__ = (UniqueConstraint('owner_id', 'provider'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    token_cipher: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default='authorized')
    targets: Mapped[list] = mapped_column(JSON, default=list)
    selected_target_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class PublishingJob(Base):
    __tablename__ = 'publishing_jobs'
    __table_args__ = (UniqueConstraint('owner_id', 'idempotency_key'),
                     UniqueConstraint('owner_id', 'provider', 'source_hash'))
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    idempotency_key: Mapped[str] = mapped_column(String(36))
    source_hash: Mapped[str] = mapped_column(String(64))
    target_id: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(24), default='sending')
    detail: Mapped[str] = mapped_column(String(500), default='')
    privacy: Mapped[str] = mapped_column(String(12))
    external_id: Mapped[str] = mapped_column(String(128), default='')
    external_url: Mapped[str] = mapped_column(String(500), default='')
    provider_data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def encryption_key() -> bytes:
    try:
        key = base64.b64decode(config.encryption_key, altchars=b'-_', validate=True)
    except (ValueError, TypeError):
        key = b''
    if len(key) != 32:
        raise HTTPException(503, 'Provider token encryption is not configured. Ask the Ziipa operator.')
    return key


def encrypt_tokens(owner_id: int, provider: str, tokens: dict) -> str:
    from Crypto.Cipher import AES
    cipher = AES.new(encryption_key(), AES.MODE_GCM, nonce=secrets.token_bytes(12))
    cipher.update(f'ziipa-publishing-v1:{owner_id}:{provider}'.encode())
    payload = json.dumps(tokens, separators=(',', ':')).encode()
    encrypted, tag = cipher.encrypt_and_digest(payload)
    return 'v1.' + base64.urlsafe_b64encode(cipher.nonce + tag + encrypted).decode()


def decrypt_tokens(grant: PublishingGrant) -> dict:
    from Crypto.Cipher import AES
    try:
        if not grant.token_cipher.startswith('v1.'):
            raise ValueError('Unsupported ciphertext')
        raw = base64.b64decode(grant.token_cipher[3:], altchars=b'-_', validate=True)
        cipher = AES.new(encryption_key(), AES.MODE_GCM, nonce=raw[:12])
        cipher.update(f'ziipa-publishing-v1:{grant.owner_id}:{grant.provider}'.encode())
        data = json.loads(cipher.decrypt_and_verify(raw[28:], raw[12:28]))
        if not isinstance(data, dict):
            raise ValueError('Invalid token record')
        return data
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(503, 'Stored authorization could not be decrypted. Ask the Ziipa operator to restore its encryption key.') from exc


def approved_api_origin() -> str:
    origin = config.api_origin.rstrip('/')
    approved = {entry.strip().rstrip('/') for entry in config.approved_origins.split(',') if entry.strip()}
    try:
        parsed = urlsplit(origin)
        local = (config.allow_insecure_localhost and settings.environment == 'development' and
                 parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost'))
        valid = (origin in approved and parsed.hostname and (parsed.scheme == 'https' or local) and
                 not parsed.username and not parsed.password and not parsed.path and not parsed.query and not parsed.fragment)
        parsed.port  # Reject malformed ports rather than passing them to a redirect.
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(503, 'A fixed approved OAuth API origin must be configured by the Ziipa operator.')
    return origin


def callback_url(provider: str) -> str:
    return f'{approved_api_origin()}/api/publishing/oauth/{provider}/callback'


def portal_url() -> str | None:
    """A configured approved web entry, never a caller-controlled redirect."""
    try:
        parsed = urlsplit(config.portal_url)
        origin = f'{parsed.scheme}://{parsed.netloc}'
        approved = {entry.strip().rstrip('/') for entry in config.approved_origins.split(',') if entry.strip()}
        local = config.allow_insecure_localhost and settings.environment == 'development' and parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost')
        if ((parsed.scheme == 'https' or local) and origin in approved and parsed.hostname and
                not parsed.username and not parsed.password and not parsed.query and not parsed.fragment):
            return config.portal_url
    except ValueError:
        pass
    return None


def meta_adapter():
    try:
        import meta_publishing_adapter
        return meta_publishing_adapter
    except ImportError:
        return None


def readiness(provider: str) -> dict:
    implemented = provider in ('youtube', 'tiktok', 'twitch', 'bluesky') or provider in ('facebook', 'instagram') and meta_adapter() is not None
    requirements = []
    if not implemented:
        requirements = ['An implemented and reviewed provider OAuth and publishing adapter',
                        'Required platform developer approval and user-granted permissions']
    else:
        if provider == 'youtube' and (not config.youtube_client_id or not config.youtube_client_secret):
            requirements.append('YouTube OAuth web client ID and secret')
        if provider == 'tiktok' and (not config.tiktok_client_key or not config.tiktok_client_secret):
            requirements.append('TikTok developer client key and secret with approved Direct Post scopes')
        if provider == 'twitch' and (not config.twitch_client_id or not config.twitch_client_secret):
            requirements.append('Twitch registered web client ID, secret and broadcaster scopes')
        if provider == 'bluesky':
            try:
                bluesky_adapter.validate_settings(config)
            except bluesky_adapter.BlueskyError as exc:
                requirements.append(str(exc))
        if provider in ('facebook', 'instagram'):
            try:
                meta_adapter().validate_settings(config)
            except Exception:
                requirements.append('Meta developer client ID, secret and an explicitly supported Graph API version')
        try:
            encryption_key()
        except HTTPException:
            requirements.append('A stable 32-byte publishing encryption key')
        try:
            approved_api_origin()
        except HTTPException:
            requirements.append('An explicitly approved fixed API origin and registered OAuth callback')
    detail = ('Authorize a YouTube account, explicitly choose its channel, and approve each original video upload. '
              'Private uploads only until the operator confirms Google project approval. The OAuth start and callback must use the same public browser origin.' if implemented else
              'This provider adapter is not implemented. Public profile links and manual sharing are available separately.')
    if provider == 'twitch':
        detail = 'Authorize your Twitch broadcaster, select the verified channel, update its title/category, check live status and retrieve protected encoder credentials. Twitch does not support arbitrary video uploads through this API.'
    elif provider == 'bluesky':
        detail = 'Authorize your handle with the official AT Protocol OAuth SDK. Public MP4 video posts use create-only permissions and DPoP-protected credentials. PLC identities on Bluesky-hosted or explicitly approved PDS origins are supported; arbitrary servers are not fetched.'
    elif provider == 'tiktok':
        detail = 'Authorize TikTok, review its current creator settings and approve a Direct Post upload. Unaudited apps permit SELF_ONLY on private creator accounts. Complete music and commercial-content disclosures; media-domain verification is required.'
    elif provider in ('facebook', 'instagram') and implemented:
        detail = 'Authorize managed Facebook Pages and linked professional Instagram accounts, then explicitly select the destination. Public publishing requires operator-confirmed provider approval. Instagram requires an approved HTTPS media origin.'
    delivery_requirements = []
    if provider == 'tiktok':
        try:
            tiktok_adapter.media_origin(config)
        except tiktok_adapter.TikTokError as exc:
            delivery_requirements.append(str(exc))
    if provider in ('facebook', 'instagram') and not config.meta_public_approved:
        delivery_requirements.append('Operator-confirmed Meta approval for public publication')
    if provider == 'instagram':
        if settings.media_storage_backend != 'r2' or not all((settings.r2_endpoint_url,
                settings.r2_access_key_id, settings.r2_secret_access_key, settings.r2_bucket_name)):
            delivery_requirements.append('Configured private R2 storage for Instagram source videos')
        try:
            parsed = urlsplit(settings.r2_endpoint_url)
            source_origin = f'{parsed.scheme}://{parsed.netloc}'
            allowed = {value.strip().rstrip('/') for value in config.meta_media_origins.split(',') if value.strip()}
            valid_source = (parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
                            and not parsed.query and not parsed.fragment and parsed.port in (None, 443)
                            and source_origin in allowed)
        except ValueError:
            valid_source = False
        if not valid_source:
            delivery_requirements.append('The exact HTTPS R2 source origin in the approved Meta media-origin list')
    public_approved = config.youtube_public_approved if provider == 'youtube' else config.tiktok_public_approved if provider == 'tiktok' else config.meta_public_approved
    return {'provider': provider, 'name': PROVIDERS[provider][0], 'oauth_implemented': implemented,
            'publish_implemented': implemented and provider != 'twitch', 'configured': implemented and not requirements,
            'live_implemented': provider == 'twitch', 'live_ready': provider == 'twitch' and not requirements,
            'can_start': implemented and not requirements, 'requirements': requirements, 'detail': detail,
            'allowed_privacy': (['private', 'unlisted', 'public'] if public_approved else ['private']) if provider == 'youtube' else ['creator_options'] if provider == 'tiktok' else ['public'] if implemented and provider != 'twitch' else [],
            'publish_ready': implemented and provider != 'twitch' and not requirements and not delivery_requirements,
            'delivery_requirements': delivery_requirements,
            'max_media_bytes': MAX_MEDIA_BYTES if implemented else 0,
            'native_oauth_supported': False, 'connect_via_portal': portal_url()}


def require_ready(provider: str):
    state = readiness(provider)
    if not state['can_start']:
        raise HTTPException(409, state['detail'] + ' Required: ' + '; '.join(state['requirements']))


def grant_for(session: Session, user_id: int, provider: str, lock=False):
    query = select(PublishingGrant).where(PublishingGrant.owner_id == user_id, PublishingGrant.provider == provider)
    return session.scalar(query.with_for_update() if lock else query)


def grant_json(grant: PublishingGrant) -> dict:
    return {'provider': grant.provider, 'status': grant.status, 'targets': grant.targets,
            'selected_target_id': grant.selected_target_id,
            'can_publish': grant.status == 'authorized' and bool(grant.selected_target_id) and readiness(grant.provider)['publish_ready']}


def receipt(job: PublishingJob) -> dict:
    result = {name: getattr(job, name) for name in ('id', 'item_id', 'provider', 'status', 'detail', 'external_id', 'external_url', 'privacy')} | {
        'created_at': job.created_at.isoformat(), 'updated_at': job.updated_at.isoformat()}
    started = job.created_at if job.created_at.tzinfo else job.created_at.replace(tzinfo=timezone.utc)
    if job.status == 'sending' and (datetime.now(timezone.utc) - started).total_seconds() > 180:
        result.update(status='uncertain', detail='This attempt has no verified delivery receipt. Check the selected provider directly; Ziipa will not automatically repost.')
    return result


@router.get('/config', dependencies=[Depends(current_user)])
def publishing_configuration():
    return {'providers': [readiness(provider) for provider in PROVIDERS],
            'notice': 'No automatic posting occurs when an account is connected. Each upload needs explicit approval. Never enter social passwords or wallet secrets in Ziipa.'}


@router.get('/connections')
def publishing_connections(user: User = Depends(current_user), session: Session = Depends(db)):
    grants = session.scalars(select(PublishingGrant).where(PublishingGrant.owner_id == user.id)).all()
    jobs = session.scalars(select(PublishingJob).where(PublishingJob.owner_id == user.id).order_by(PublishingJob.created_at.desc()).limit(100)).all()
    return {'connections': [grant_json(grant) for grant in grants], 'jobs': [receipt(job) for job in jobs]}


def state_key(kind: str, value: str) -> str:
    return 'publishing_oauth:' + kind + ':' + hashlib.sha256(value.encode()).hexdigest()


def store_state(kind: str, value: str, record: dict):
    try:
        cache.set(state_key(kind, value), json.dumps(record), ex=STATE_TTL, nx=True)
    except RedisError as exc:
        raise HTTPException(503, 'Authorization state storage is unavailable.') from exc


def consume_state(kind: str, value: str) -> dict:
    try:
        raw = cache.getdel(state_key(kind, value))
    except RedisError as exc:
        raise HTTPException(503, 'Authorization state storage is unavailable.') from exc
    if not raw:
        raise HTTPException(400, 'Authorization expired or was already used. Start again in Ziipa.')
    try:
        record = json.loads(raw)
        if not isinstance(record, dict):
            raise ValueError('Invalid state')
        return record
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, 'Authorization state is invalid. Start again in Ziipa.') from exc


class OAuthStartInput(BaseModel):
    handle: str = Field(default='', max_length=253)


@router.get('/oauth/bluesky/client-metadata.json')
def bluesky_client_metadata(response: Response):
    require_ready('bluesky')
    origin = approved_api_origin()
    response.headers['Cache-Control'] = 'public, max-age=300'
    return {'client_id': origin + '/api/publishing/oauth/bluesky/client-metadata.json', 'client_name': 'Ziipa Studio', 'client_uri': origin,
            'redirect_uris': [callback_url('bluesky')], 'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code'],
            'application_type': 'web', 'scope': bluesky_adapter.SCOPE, 'token_endpoint_auth_method': 'private_key_jwt',
            'token_endpoint_auth_signing_alg': 'ES256', 'dpop_bound_access_tokens': True, 'jwks_uri': origin + '/api/publishing/oauth/bluesky/jwks.json'}


@router.get('/oauth/bluesky/jwks.json')
def bluesky_jwks(response: Response):
    require_ready('bluesky')
    key = json.loads(config.bluesky_private_jwk)
    response.headers['Cache-Control'] = 'public, max-age=300'
    return {'keys': [{name: key[name] for name in ('kty', 'crv', 'x', 'y', 'kid')} ]}


@router.post('/oauth/{provider}/start', dependencies=[Depends(guard)])
def start_oauth(provider: SocialProvider, request: Request, response: Response, data: OAuthStartInput | None = None, user: User = Depends(current_user)):
    require_ready(provider)
    if request.headers.get('authorization') or not request.cookies.get('ziipa_session'):
        return {'status': 'browser_sign_in_required', 'auth_url': None, 'connect_via_portal': portal_url(),
                'detail': 'Sign in to your Ziipa account in the web portal and authorize the provider there. Return to the app and refresh publishing accounts. Direct native OAuth handoff is not implemented.'}
    ticket, binding = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
    try:
        handle = bluesky_adapter.normalize_handle(data.handle if data else '') if provider == 'bluesky' else ''
    except bluesky_adapter.BlueskyError as exc:
        raise HTTPException(422, str(exc)) from exc
    store_state('ticket', ticket, {'owner_id': user.id, 'provider': provider,
                                  'handle': handle,
                                  'binding_hash': hashlib.sha256(binding.encode()).hexdigest(),
                                  'session_hash': hashlib.sha256(request.cookies['ziipa_session'].encode()).hexdigest()})
    response.set_cookie(f'ziipa_oauth_{provider}', binding, max_age=STATE_TTL, httponly=True,
                        secure=approved_api_origin().startswith('https://'), samesite='lax',
                        path=f'/api/publishing/oauth/{provider}')
    return {'status': 'authorization_required', 'auth_url': f'{approved_api_origin()}/api/publishing/oauth/{provider}/authorize?{urlencode({"ticket": ticket})}'}


def verify_initiating_browser(request: Request, record: dict, session: Session):
    token = request.cookies.get('ziipa_session', '')
    if (request.headers.get('authorization') or not token or
            not secrets.compare_digest(record.get('session_hash', ''), hashlib.sha256(token.encode()).hexdigest())):
        raise HTTPException(401, 'The Ziipa sign-in changed during authorization. Start again from your current account.')
    if current_user(request, session).id != record.get('owner_id'):
        raise HTTPException(401, 'This authorization belongs to a different Ziipa account.')


@router.get('/oauth/{provider}/authorize')
async def authorize(provider: SocialProvider, request: Request, ticket: str = Query(min_length=32, max_length=200), session: Session = Depends(db)):
    require_ready(provider)
    record = consume_state('ticket', ticket)
    verify_initiating_browser(request, record, session)
    binding = request.cookies.get(f'ziipa_oauth_{provider}', '')
    if (record.get('provider') != provider or not session.get(User, record.get('owner_id')) or not binding or
            not secrets.compare_digest(record.get('binding_hash', ''), hashlib.sha256(binding.encode()).hexdigest())):
        raise HTTPException(400, 'Authorization does not match this account or provider.')
    state, verifier = (secrets.token_urlsafe(40) for _ in range(2))
    if provider == 'bluesky':
        session.commit()
        try:
            flow = await bluesky_adapter.authorize(record['handle'], approved_api_origin(), state, config)
        except bluesky_adapter.BlueskyError as exc:
            raise HTTPException(503, str(exc)) from exc
        store_state('callback', flow['state'], {**record, 'app_state': state,
            'sdk_cipher': encrypt_tokens(record['owner_id'], 'bluesky', {'states': flow['states']})})
        redirect = RedirectResponse(flow['auth_url'], status_code=302)
        redirect.headers['Cache-Control'] = 'no-store'
        redirect.headers['Referrer-Policy'] = 'no-referrer'
        return redirect
    store_state('callback', state, {**record, 'verifier': verifier})
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    params = {'client_id': config.youtube_client_id, 'redirect_uri': callback_url(provider),
              'response_type': 'code', 'scope': ' '.join(sorted(YOUTUBE_SCOPES)), 'state': state,
              'code_challenge': challenge, 'code_challenge_method': 'S256', 'access_type': 'offline', 'prompt': 'consent'}
    if provider == 'youtube':
        authorization = 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode(params)
    elif provider == 'tiktok':
        authorization = tiktok_adapter.authorization_url(config, callback_url(provider), state, challenge)
    elif provider == 'twitch':
        authorization = twitch_adapter.authorization_url(config, callback_url(provider), state)
    else:
        authorization = meta_adapter().authorization_url(provider, config, callback_url(provider), state)
    response = RedirectResponse(authorization, status_code=302)
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Cache-Control'] = 'no-store'
    return response


class ProviderFailure(Exception):
    pass


async def provider_json(client: httpx.AsyncClient, method: str, url: str, **kwargs) -> tuple[int, dict]:
    if url not in HTTP_URLS:
        raise ValueError('Provider endpoint is not allowlisted')
    try:
        async with client.stream(method, url, **kwargs) as response:
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                if len(raw) + len(chunk) > MAX_JSON_BYTES:
                    raise ProviderFailure('Provider response exceeded the safe limit.')
                raw.extend(chunk)
            try:
                data = json.loads(raw) if raw else {}
            except ValueError as exc:
                raise ProviderFailure('Provider response could not be verified.') from exc
            if not isinstance(data, dict):
                raise ProviderFailure('Provider response could not be verified.')
            return response.status_code, data
    except httpx.HTTPError as exc:
        raise ProviderFailure('Provider request could not be completed safely.') from exc


def api_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False, trust_env=False)


async def channels(client: httpx.AsyncClient, token: str) -> list[dict]:
    status, data = await provider_json(client, 'GET', CHANNELS_URL, params={'part': 'snippet', 'mine': 'true', 'maxResults': 50},
                                       headers={'Authorization': 'Bearer ' + token})
    if status != 200 or not isinstance(data.get('items'), list):
        raise ProviderFailure('YouTube channel access was not granted. Reauthorize this account.')
    result = []
    for item in data['items'][:50]:
        if not isinstance(item, dict) or not re.fullmatch(r'UC[A-Za-z0-9_-]{22}', str(item.get('id', ''))):
            continue
        name = item.get('snippet', {}).get('title', '') if isinstance(item.get('snippet'), dict) else ''
        result.append({'id': item['id'], 'name': str(name)[:150], 'kind': 'youtube_channel', 'url': 'https://youtube.com/channel/' + item['id']})
    if not result:
        raise ProviderFailure('No eligible YouTube channel was returned. Create or choose a channel with this Google account, then reconnect.')
    return result


@router.get('/oauth/{provider}/callback')
async def oauth_callback(provider: SocialProvider, request: Request, state: str = Query(min_length=32, max_length=200),
                         code: str = Query(default='', max_length=4096), error: str = Query(default='', max_length=100),
                         session: Session = Depends(db)):
    require_ready(provider)
    record = consume_state('callback', state)
    verify_initiating_browser(request, record, session)
    binding = request.cookies.get(f'ziipa_oauth_{provider}', '')
    if record.get('provider') != provider or not binding or not secrets.compare_digest(
            record.get('binding_hash', ''), hashlib.sha256(binding.encode()).hexdigest()):
        raise HTTPException(400, 'Authorization must finish in the same browser that started it.')
    owner_id = record.get('owner_id')
    if not session.get(User, owner_id):
        raise HTTPException(400, 'The Ziipa account no longer exists.')
    if error or not code:
        raise HTTPException(400, 'Provider authorization was not approved. No connection was saved.')
    session.commit()
    try:
        async with asyncio.timeout(25), api_client() as client:
            if provider == 'youtube':
                status, tokens = await provider_json(client, 'POST', TOKEN_URL, data={
                    'grant_type': 'authorization_code', 'client_id': config.youtube_client_id,
                    'client_secret': config.youtube_client_secret, 'code': code,
                    'redirect_uri': callback_url(provider), 'code_verifier': record['verifier']})
                scope = set(tokens.get('scope', '').split()) if isinstance(tokens.get('scope'), str) else set()
                if status != 200 or not isinstance(tokens.get('access_token'), str) or not YOUTUBE_SCOPES.issubset(scope):
                    raise ProviderFailure('YouTube did not grant the required channel and upload permissions. Reconnect and approve both permissions.')
                targets = await channels(client, tokens['access_token'])
                tokens = {'provider': provider, 'access_token': tokens['access_token'], 'refresh_token': tokens.get('refresh_token', ''),
                          'expires_at': time.time() + min(max(int(tokens.get('expires_in', 0)), 0), 86400), 'scope': sorted(scope)}
            elif provider == 'bluesky':
                saved = decrypt_tokens(PublishingGrant(owner_id=owner_id, provider='bluesky', token_cipher=record['sdk_cipher']))
                result = await bluesky_adapter.exchange(saved['states'], dict(request.query_params), record['app_state'], approved_api_origin(), config)
                tokens, targets = result['tokens'], result['targets']
            else:
                result = (await tiktok_adapter.exchange(code, callback_url(provider), record['verifier'], client, config) if provider == 'tiktok' else
                          await twitch_adapter.exchange(code, callback_url(provider), client, config) if provider == 'twitch' else
                          await meta_adapter().exchange(code, callback_url(provider), client, provider, config))
                tokens, targets = result['tokens'], result['targets']
    except Exception as exc:
        raise HTTPException(502, 'Provider authorization could not be verified. Start again; no new connection was saved.') from exc
    # Account deletion and simultaneous callbacks serialize here. Never restore
    # a grant after the owning account has been deleted.
    owner = session.scalar(select(User).where(User.id == owner_id).with_for_update())
    if not owner:
        raise HTTPException(400, 'The Ziipa account no longer exists.')
    grant = grant_for(session, owner_id, provider, lock=True)
    if provider == 'twitch' and grant is not None:
        from live_api import detach_twitch_destinations
        await detach_twitch_destinations(owner_id, session)
        if not session.scalar(select(User).where(User.id == owner_id).with_for_update()):
            raise HTTPException(400, 'The Ziipa account no longer exists.')
        grant = grant_for(session, owner_id, provider, lock=True)
    if grant is None:
        grant = PublishingGrant(owner_id=owner_id, provider=provider)
        session.add(grant)
    grant.token_cipher = encrypt_tokens(owner_id, provider, tokens)
    grant.status, grant.targets, grant.selected_target_id = 'authorized', targets, None
    session.commit()
    response = HTMLResponse('<!doctype html><meta name="referrer" content="no-referrer"><title>Ziipa authorization</title>'
                            '<h1>Provider authorization saved</h1><p>Return to Ziipa and refresh your publishing accounts. '
                            'Choose a channel explicitly before approving an upload. Nothing has been posted.</p>')
    response.delete_cookie(f'ziipa_oauth_{provider}', path=f'/api/publishing/oauth/{provider}')
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


class TargetInput(BaseModel):
    target_id: str = Field(min_length=1, max_length=100)


@router.post('/connections/{provider}/target', dependencies=[Depends(guard)])
async def choose_target(provider: SocialProvider, data: TargetInput, user: User = Depends(current_user), session: Session = Depends(db)):
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    grant = grant_for(session, user.id, provider, lock=True)
    if not grant or grant.status != 'authorized':
        raise HTTPException(409, 'Authorize this provider account first.')
    if data.target_id not in {target['id'] for target in grant.targets}:
        raise HTTPException(422, 'Choose one of the channels authorized by this account.')
    if provider == 'twitch' and grant.selected_target_id and grant.selected_target_id != data.target_id:
        from live_api import detach_twitch_destinations
        await detach_twitch_destinations(user.id, session)
    grant.selected_target_id = data.target_id
    session.commit()
    return grant_json(grant)


async def access_token(session: Session, grant: PublishingGrant, client: httpx.AsyncClient) -> str:
    tokens = decrypt_tokens(grant)
    if grant.provider == 'bluesky':
        return tokens['access_token']  # Official SDK handles DPoP refresh under the bridge lease.
    if tokens.get('expires_at', 0) > time.time() + 60:
        return tokens['access_token']
    if grant.provider in ('facebook', 'instagram'):
        grant.status = 'reconnect_required'
        session.commit()
        raise HTTPException(409, 'This Meta authorization needs to be renewed through the provider login flow.')
    if not tokens.get('refresh_token'):
        grant.status = 'reconnect_required'
        session.commit()
        raise HTTPException(409, 'Authorization expired. Reconnect this provider account.')
    grant_id, owner_id, provider, original_cipher = grant.id, grant.owner_id, grant.provider, grant.token_cipher
    key, lease = f'publishing_refresh:{grant.id}', secrets.token_urlsafe(24)
    try:
        if not cache.set(key, lease, nx=True, ex=45):
            raise HTTPException(409, 'Provider authorization is already refreshing. Retry shortly.')
    except RedisError as exc:
        raise HTTPException(503, 'Provider authorization coordination is unavailable.') from exc
    try:
        session.commit()
        if provider in ('tiktok', 'twitch'):
            refreshed = await (tiktok_adapter if provider == 'tiktok' else twitch_adapter).refresh(tokens, client, config)
            status = 200
        else:
            status, refreshed = await provider_json(client, 'POST', TOKEN_URL, data={
                'grant_type': 'refresh_token', 'client_id': config.youtube_client_id,
                'client_secret': config.youtube_client_secret, 'refresh_token': tokens['refresh_token']})
        session.expire_all()
        latest = session.scalar(select(PublishingGrant).where(PublishingGrant.id == grant_id,
                                PublishingGrant.owner_id == owner_id).with_for_update())
        if not latest or latest.status != 'authorized' or latest.token_cipher != original_cipher:
            raise HTTPException(409, 'Provider authorization changed while refreshing. Refresh your connections before retrying.')
        if status != 200 or not isinstance(refreshed.get('access_token'), str):
            if status in (400, 401):
                latest.status = 'reconnect_required'
                session.commit()
            raise HTTPException(409 if status in (400, 401) else 503, 'Provider authorization could not be refreshed. Reconnect or retry later.')
        tokens.update(access_token=refreshed['access_token'], expires_at=refreshed['expires_at'] if provider in ('tiktok', 'twitch') else time.time() + min(max(int(refreshed.get('expires_in', 0)), 0), 86400))
        if refreshed.get('refresh_token'):
            tokens['refresh_token'] = refreshed['refresh_token']
        latest.token_cipher = encrypt_tokens(owner_id, provider, tokens)
        session.commit()
        return tokens['access_token']
    finally:
        try:
            cache.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, key, lease)
        except RedisError:
            pass


class TikTokOptions(BaseModel):
    privacy_level: Literal['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']
    disable_comment: bool
    disable_duet: bool
    disable_stitch: bool
    brand_content_toggle: bool
    brand_organic_toggle: bool
    is_aigc: bool
    music_usage_confirmed: bool
    source_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    content_disclosure_enabled: bool
    branded_content_policy_confirmed: bool
    # Compatibility only: the server always probes the actual selected bytes.
    duration_seconds: float | None = Field(default=None, gt=0, le=86400)


class PublishInput(BaseModel):
    item_id: uuid.UUID
    expected_media_id: uuid.UUID
    expected_target_id: str = Field(min_length=1, max_length=100)
    render_id: uuid.UUID | None = None
    provider: SocialProvider
    idempotency_key: uuid.UUID
    privacy: Literal['private', 'unlisted', 'public']
    made_for_kids: bool
    consent: bool = False
    original_media_acknowledged: bool = False
    retry_failed: bool = False
    title: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=5000)
    tiktok: TikTokOptions | None = None


class TikTokReviewInput(BaseModel):
    item_id: uuid.UUID
    expected_media_id: uuid.UUID
    expected_target_id: str = Field(min_length=1, max_length=100)
    render_id: uuid.UUID | None = None


def reviewed_tiktok_source(data, owner_id, session):
    item = session.get(CreatorItem, str(data.item_id))
    if not item or item.owner_id != owner_id or item.visibility != 'published':
        raise HTTPException(404, 'Your published source creation was not found.')
    if item.data.get('media_id') != str(data.expected_media_id):
        raise HTTPException(409, 'The source changed. Review the current file before publishing.')
    if data.render_id:
        from render_services import resolve_rendered_media
        media = resolve_rendered_media(session, owner_id, item, str(data.render_id))
    else:
        media = session.get(CreatorMedia, str(data.expected_media_id))
    if (not media or media.owner_id != owner_id or media.size > MAX_MEDIA_BYTES
            or media.content_type not in ('video/mp4', 'video/quicktime', 'video/webm')):
        raise HTTPException(404, 'Your supported source video was not found.')
    return item, media


@router.post('/tiktok/review', dependencies=[Depends(guard)])
async def review_tiktok_source(data: TikTokReviewInput, user: User = Depends(current_user), session: Session = Depends(db)):
    grant = grant_for(session, user.id, 'tiktok')
    if not grant or grant.status != 'authorized' or grant.selected_target_id != data.expected_target_id:
        raise HTTPException(409, 'Authorize and select the TikTok account you want to review.')
    _, media = reviewed_tiktok_source(data, user.id, session)
    media_id, grant_id = media.id, grant.id
    lease = secrets.token_urlsafe(24)
    try:
        if not cache.set('publishing_probe_lock', lease, nx=True, ex=90):
            raise HTTPException(429, 'Another source review is running. Retry shortly.')
    except RedisError as exc:
        raise HTTPException(503, 'TikTok source-review coordination is unavailable.') from exc
    try:
        body = await asyncio.to_thread(original_bytes, media, user.id)
        duration = await asyncio.to_thread(tiktok_adapter.probe_video, body, media.content_type)
        async with asyncio.timeout(25), api_client() as client:
            await access_token(session, grant, client)
            options = await tiktok_adapter.creator_options(decrypt_tokens(grant), client)
        if not config.tiktok_public_approved:
            options['privacy_level_options'] = [p for p in options['privacy_level_options'] if p == 'SELF_ONLY']
        if duration > options['max_video_post_duration_sec']:
            raise HTTPException(422, 'The actual selected video exceeds this creator’s current TikTok duration limit.')
        session.expire_all()
        grant = grant_for(session, user.id, 'tiktok')
        _, current_media = reviewed_tiktok_source(data, user.id, session)
        if not grant or grant.id != grant_id or grant.status != 'authorized' or grant.selected_target_id != data.expected_target_id or current_media.id != media_id:
            raise HTTPException(409, 'The source or destination changed during review. Review it again.')
        return {'item_id': str(data.item_id), 'media_id': media_id, 'render_id': str(data.render_id) if data.render_id else None,
                'expected_media_id': str(data.expected_media_id), 'target_id': data.expected_target_id,
                'source_sha256': hashlib.sha256(body).hexdigest(), 'duration_seconds': duration, 'creator': options}
    except (tiktok_adapter.TikTokError, TimeoutError) as exc:
        raise HTTPException(422, str(exc) if isinstance(exc, tiktok_adapter.TikTokError) else 'TikTok review timed out. Please retry.') from exc
    finally:
        try:
            cache.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, 'publishing_probe_lock', lease)
        except RedisError:
            pass


TIKTOK_PULL_TTL = 7200


def tiktok_pull_key(nonce):
    return 'publishing_tiktok_pull:' + hashlib.sha256(nonce.encode()).hexdigest()


def create_tiktok_pull_url(job, media, grant, data, digest):
    origin = tiktok_adapter.media_origin(config)
    nonce = secrets.token_urlsafe(32)
    signature = base64.urlsafe_b64encode(hmac.digest(encryption_key(), b'ziipa-tiktok-pull-v1:' + nonce.encode(), 'sha256')).decode().rstrip('=')
    record = {'owner_id': job.owner_id, 'job_id': job.id, 'grant_id': grant.id,
              'item_id': job.item_id, 'media_id': media.id, 'expected_media_id': str(data.expected_media_id),
              'target_id': job.target_id, 'expected_target_id': job.target_id,
              'render_id': str(data.render_id) if data.render_id else None,
              'source_sha256': digest, 'expires': time.time() + TIKTOK_PULL_TTL}
    try:
        cache.set(tiktok_pull_key(nonce), json.dumps(record), ex=TIKTOK_PULL_TTL)
    except RedisError as exc:
        raise HTTPException(503, 'Private TikTok media handoff is unavailable. No post was initialized.') from exc
    return origin + tiktok_adapter.PULL_PATH + nonce + '.' + signature


class RedactTikTokPullAccess(logging.Filter):
    def filter(self, record):
        if isinstance(record.args, tuple):
            record.args = tuple(re.sub(r'(/api/publishing/tiktok/media/)[^ ?]+', r'\1[redacted]', value)
                                if isinstance(value, str) else value for value in record.args)
        return True


logging.getLogger('uvicorn.access').addFilter(RedactTikTokPullAccess())


def redact_tiktok_telemetry(event, _hint):
    """Keep private pull capabilities out of errors, traces and breadcrumbs."""
    private = [False]
    def clean(value, depth=0):
        if depth > 20:
            return '[telemetry depth omitted]'
        if isinstance(value, str):
            value = value[:20000]
            if tiktok_adapter.PULL_PATH in value:
                private[0] = True
                return re.sub(r'(/api/publishing/tiktok/media/)[^\s?"\'<>]+', r'\1[redacted]', value)
            return value
        if isinstance(value, dict):
            return {str(key): clean(item, depth + 1) for key, item in list(value.items())[:1000]
                    if str(key).lower().replace('_', '-') not in ('authorization', 'cookie', 'set-cookie')}
        if isinstance(value, (tuple, list)):
            return [clean(item, depth + 1) for item in value[:1000]]
        return value
    result = clean(event)
    if private[0]:
        # Sentry may collect Python locals separately from a redacted request
        # URL. Never send this route's token, signature, byte buffer or records.
        for exception in result.get('exception', {}).get('values', []):
            for frame in exception.get('stacktrace', {}).get('frames', []):
                frame.pop('vars', None)
        result.pop('extra', None)
        if isinstance(result.get('request'), dict):
            result['request'].pop('data', None)
            result['request'].pop('headers', None)
    return result


import sentry_sdk
sentry_sdk.get_global_scope().add_event_processor(redact_tiktok_telemetry)


@router.api_route('/tiktok/media/{token}', methods=['GET', 'HEAD'])
def tiktok_pull_media(token: str, request: Request, session: Session = Depends(db)):
    """A scoped two-hour capability for TikTok. No cookie or arbitrary URL access."""
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}', token):
        raise HTTPException(404, 'Media handoff unavailable.')
    try:
        tiktok_adapter.media_origin(config)
    except tiktok_adapter.TikTokError as exc:
        raise HTTPException(404, 'Media handoff unavailable.') from exc
    nonce, signature = token.split('.')
    expected = base64.urlsafe_b64encode(hmac.digest(encryption_key(), b'ziipa-tiktok-pull-v1:' + nonce.encode(), 'sha256')).decode().rstrip('=')
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(404, 'Media handoff unavailable.')
    try:
        raw = cache.get(tiktok_pull_key(nonce))
        record = json.loads(raw) if raw else {}
        if record.get('expires', 0) <= time.time():
            raise HTTPException(404, 'Media handoff expired.')
        job = session.get(PublishingJob, record['job_id'])
        grant = grant_for(session, record['owner_id'], 'tiktok')
        if (not session.get(User, record['owner_id']) or not job or job.owner_id != record['owner_id']
                or job.provider != 'tiktok' or job.status not in ('sending', 'processing', 'uncertain')
                or job.provider_data.get('stage') not in ('init_started', 'processing')
                or not grant or grant.id != record['grant_id'] or grant.status != 'authorized'
                or grant.selected_target_id != record['target_id'] or job.target_id != record['target_id']):
            raise HTTPException(404, 'Media handoff unavailable.')
        _, media = reviewed_tiktok_source(TikTokReviewInput(**record), record['owner_id'], session)
        if media.id != record['media_id']:
            raise HTTPException(404, 'Media handoff unavailable.')
    except RedisError as exc:
        raise HTTPException(503, 'Media handoff is temporarily unavailable.', headers={'Retry-After': '5'}) from exc
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(404, 'Media handoff unavailable.') from exc
    headers = {'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
               'Accept-Ranges': 'bytes', 'Content-Disposition': 'attachment; filename="video.mp4"'}
    start, end, status = 0, media.size - 1, 200
    requested = request.headers.get('range')
    if requested:
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested) if len(requested) <= 100 else None
        if not match or not any(match.groups()):
            raise HTTPException(416, 'Invalid media range.', headers={'Content-Range': f'bytes */{media.size}'})
        left, right = match.groups()
        start = int(left) if left else max(0, media.size - int(right))
        end = min(int(right), end) if left and right else end
        if start > end or start >= media.size:
            raise HTTPException(416, 'Invalid media range.', headers={'Content-Range': f'bytes */{media.size}'})
        status = 206
        headers['Content-Range'] = f'bytes {start}-{end}/{media.size}'
    headers['Content-Length'] = str(end - start + 1)
    if request.method == 'HEAD':
        return Response(status_code=status, media_type=media.content_type, headers=headers)
    lease = secrets.token_urlsafe(24)
    try:
        if not cache.set('publishing_tiktok_pull_lock', lease, nx=True, ex=90):
            raise HTTPException(503, 'Media handoff busy. Retry shortly.', headers={'Retry-After': '2'})
    except RedisError as exc:
        raise HTTPException(503, 'Media handoff is temporarily unavailable.', headers={'Retry-After': '5'}) from exc
    def release():
        try:
            cache.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, 'publishing_tiktok_pull_lock', lease)
        except RedisError:
            pass
    try:
        body = original_bytes(media, record['owner_id'])
        if hashlib.sha256(body).hexdigest() != record['source_sha256']:
            raise HTTPException(404, 'Media handoff changed.')
    except Exception:
        release()
        raise

    async def chunks():
        renewed = time.monotonic()
        try:
            for offset in range(start, end + 1, 256 * 1024):
                if time.monotonic() - renewed >= 15:
                    if not cache.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],90) else return 0 end", 1, 'publishing_tiktok_pull_lock', lease):
                        raise RuntimeError('Private media transfer lease expired.')
                    renewed = time.monotonic()
                yield body[offset:min(offset + 256 * 1024, end + 1)]
        finally:
            release()
    # Keep the memory/transfer lease until the response ends, not merely until
    # storage has been read. A slow recipient cannot accumulate 25 MB responses.
    return StreamingResponse(chunks(), status_code=status, media_type=media.content_type, headers=headers)


class TwitchChannelInput(BaseModel):
    expected_target_id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=140)
    game_id: str | None = Field(default=None, pattern=r'^[0-9]{0,30}$')
    language: str | None = Field(default=None, pattern=r'^(?:[a-z]{2}|other)$')
    consent: bool = False


class TwitchIngestInput(BaseModel):
    consent: bool = False


async def twitch_action(operation, user, session, values=None):
    require_ready('twitch')
    grant = grant_for(session, user.id, 'twitch')
    if not grant or grant.status != 'authorized' or not grant.selected_target_id:
        raise HTTPException(409, 'Authorize Twitch and select its verified broadcaster channel first.')
    if operation == 'update' and values.get('expected_target_id') != grant.selected_target_id:
        raise HTTPException(409, 'The Twitch destination changed after your approval. Refresh it and approve again.')
    original_grant_id, original_cipher = grant.id, grant.token_cipher
    try:
        async with asyncio.timeout(35), api_client() as client:
            token = await access_token(session, grant, client)
            selected, grant_id = grant.selected_target_id, grant.id
            session.expire_all()
            current = grant_for(session, user.id, 'twitch')
            if not current or current.id != grant_id or current.status != 'authorized' or current.selected_target_id != selected or decrypt_tokens(current).get('access_token') != token:
                raise HTTPException(409, 'The Twitch authorization changed. Refresh your connected accounts.')
            tokens = decrypt_tokens(current)
            if operation == 'update' and values.get('expected_target_id') != selected:
                raise HTTPException(409, 'The Twitch destination changed after your approval. Refresh it and approve again.')
            original_grant_id, original_cipher = current.id, current.token_cipher
            session.commit()
            if operation == 'channel':
                return await twitch_adapter.channel_status(tokens, selected, client, config)
            if operation == 'update':
                return await twitch_adapter.update_channel(tokens, selected, values, client, config)
            if operation == 'ingest':
                return await twitch_adapter.ingest(tokens, selected, client, config)
            return await twitch_adapter.follows(tokens, selected, client, config)
    except (twitch_adapter.TwitchError, TimeoutError) as exc:
        if getattr(exc, 'reconnect', False):
            session.expire_all()
            current = grant_for(session, user.id, 'twitch')
            if current and current.id == original_grant_id and current.token_cipher == original_cipher:
                current.status = 'reconnect_required'
                session.commit()
        raise HTTPException(409 if getattr(exc, 'reconnect', False) else 503,
            'Twitch could not verify this operation. Reconnect if required, or check the channel before repeating an update.') from exc


@router.get('/connections/twitch/channel')
async def twitch_channel(user: User = Depends(current_user), session: Session = Depends(db)):
    return await twitch_action('channel', user, session)


@router.post('/connections/twitch/channel-settings', dependencies=[Depends(guard)])
async def twitch_channel_settings(data: TwitchChannelInput, user: User = Depends(current_user), session: Session = Depends(db)):
    if not data.consent:
        raise HTTPException(422, 'Approve updating your Twitch channel title and category.')
    return await twitch_action('update', user, session, data.model_dump())


@router.post('/connections/twitch/ingest', dependencies=[Depends(guard)])
async def twitch_ingest(data: TwitchIngestInput, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    if not data.consent:
        raise HTTPException(422, 'Approve revealing your secret Twitch encoder key. Never share it publicly.')
    result = await twitch_action('ingest', user, session)
    response.headers['Cache-Control'] = 'no-store, private'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return result


@router.post('/connections/twitch/follows', dependencies=[Depends(guard)])
async def twitch_followed_channels(user: User = Depends(current_user), session: Session = Depends(db)):
    return await twitch_action('follows', user, session)


async def twitch_ingest_for_live(user: User, session: Session) -> dict:
    """Caller verifies owned stream and explicit simulcast consent.

    Returned keys belong only in protected live-provider configuration, never
    public stream responses, account exports or logs.
    """
    return await twitch_action('ingest', user, session)


@router.post('/connections/tiktok/creator-options', dependencies=[Depends(guard)])
async def tiktok_creator_options(user: User = Depends(current_user), session: Session = Depends(db)):
    grant = grant_for(session, user.id, 'tiktok')
    if not grant or grant.status != 'authorized':
        raise HTTPException(409, 'Authorize TikTok first.')
    try:
        async with asyncio.timeout(25), api_client() as client:
            await access_token(session, grant, client)
            options = await tiktok_adapter.creator_options(decrypt_tokens(grant), client)
            if not config.tiktok_public_approved:
                options['privacy_level_options'] = [p for p in options['privacy_level_options'] if p == 'SELF_ONLY']
            return options
    except (tiktok_adapter.TikTokError, TimeoutError) as exc:
        raise HTTPException(503, 'TikTok creator options could not be verified. Retry or reconnect the account.') from exc


def original_bytes(media: CreatorMedia, owner_id: int) -> bytes:
    backend = storage()
    if isinstance(backend, LocalStorage):
        path = (creator.MEDIA_ROOT / str(uuid.UUID(media.id))).resolve()
        if path.parent != creator.MEDIA_ROOT.resolve() or not path.is_file():
            raise HTTPException(404, 'The owned source video is unavailable.')
        with path.open('rb') as source:
            value = source.read(MAX_MEDIA_BYTES + 1)
    elif isinstance(backend, R2Storage):
        # Bound private R2 reads by this publishing limit and a short deadline.
        # No presigned/caller URL is ever fetched by the API.
        from render_services import _r2_client
        try:
            stream = _r2_client().get_object(Bucket=backend.bucket, Key=object_key(owner_id, str(uuid.UUID(media.id))),
                                            Range=f'bytes=0-{MAX_MEDIA_BYTES}')['Body']
            chunks = bytearray()
            deadline = time.monotonic() + 25
            try:
                while len(chunks) <= MAX_MEDIA_BYTES:
                    if time.monotonic() > deadline:
                        raise HTTPException(503, 'Private media read exceeded its deadline.')
                    block = stream.read(min(1024 * 1024, MAX_MEDIA_BYTES + 1 - len(chunks)))
                    if not block:
                        break
                    chunks.extend(block)
            finally:
                stream.close()
            value = bytes(chunks)
        except Exception as exc:
            raise HTTPException(503, 'Private media storage is temporarily unavailable.') from exc
    else:
        # Fetch an owned storage key, never a user-supplied URL. The R2 adapter's
        # own read cap is 100 MB; this first provider adapter accepts at most 25 MB.
        value = backend.read_bytes(owner_id, media.id)
    if len(value) != media.size or len(value) > MAX_MEDIA_BYTES or not creator.valid_signature(media.content_type, value[:32]):
        raise HTTPException(422, 'The source video no longer matches its verified media record.')
    return value


def external_errors():
    errors = (ProviderFailure, TimeoutError, HTTPException, ValueError, TypeError, OSError, tiktok_adapter.TikTokError, twitch_adapter.TwitchError, bluesky_adapter.BlueskyError)
    adapter = meta_adapter()
    return errors + ((adapter.MetaError,) if adapter else ())


def apply_outcome(job: PublishingJob, outcome: dict):
    if outcome.get('status') not in ('processing', 'delivered', 'rejected', 'uncertain', 'failed'):
        raise ProviderFailure('Provider outcome status could not be verified.')
    job.status = outcome['status']
    job.detail = str(outcome.get('detail', 'Provider status updated.'))[:500]
    for field in ('external_id', 'external_url', 'provider_data'):
        if field in outcome:
            setattr(job, field, outcome[field])
    if outcome.get('privacy') in ('private', 'unlisted', 'public', 'restricted'):
        job.privacy = outcome['privacy']


@asynccontextmanager
async def provider_bridge_lease(grant):
    if grant.provider != 'bluesky':
        yield
        return
    key, lease = f'publishing_bridge:{grant.id}', secrets.token_urlsafe(24)
    try:
        if not cache.set(key, lease, nx=True, ex=90):
            raise HTTPException(409, 'This Bluesky session is already in use. Retry after its current operation finishes.')
    except RedisError as exc:
        raise HTTPException(503, 'Bluesky session coordination is unavailable.') from exc
    try:
        yield
    finally:
        try:
            cache.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, key, lease)
        except RedisError:
            pass


def sdk_credential_saver(session, grant, target_id):
    grant_id, owner_id, cipher = grant.id, grant.owner_id, grant.token_cipher
    async def save(updated):
        nonlocal cipher
        session.expire_all()
        latest = grant_for(session, owner_id, 'bluesky', lock=True)
        if (not latest or latest.id != grant_id or latest.status != 'authorized' or latest.token_cipher != cipher
                or updated.get('provider') != 'bluesky' or updated.get('subject') != target_id):
            raise HTTPException(409, 'Bluesky authorization changed during the operation. Refresh the connected account before continuing.')
        latest.token_cipher = encrypt_tokens(owner_id, 'bluesky', updated)
        cipher = latest.token_cipher
        session.commit()
        return updated['access_token']
    return save


@router.post('/publish', dependencies=[Depends(guard)])
async def publish(data: PublishInput, user: User = Depends(current_user), session: Session = Depends(db)):
    require_ready(data.provider)
    if data.provider == 'twitch':
        raise HTTPException(409, 'Twitch is an authorized live/channel destination. Use its live controls; arbitrary video uploads are not supported.')
    if data.provider == 'bluesky' and data.privacy != 'public':
        raise HTTPException(422, 'Bluesky posts are public. Explicitly choose public visibility before publishing.')
    if not data.consent:
        raise HTTPException(422, 'Approve sending the selected video to this external destination.')
    if not data.render_id and not data.original_media_acknowledged:
        raise HTTPException(422, 'Acknowledge that an original-file upload does not include Ziipa editing overlays or soundtrack rendering.')
    if data.provider == 'youtube' and data.privacy != 'private' and not config.youtube_public_approved:
        raise HTTPException(422, 'This Google project is configured for private uploads only until its production audit is approved.')
    if data.provider in ('facebook', 'instagram') and (data.privacy != 'public' or not config.meta_public_approved):
        raise HTTPException(422, 'Meta publication is public. Explicitly approve public visibility and complete the operator’s Meta approval setup first.')
    if data.provider == 'tiktok' and data.tiktok is None:
        raise HTTPException(422, 'Choose TikTok creator privacy, interaction and disclosure settings before publishing.')
    if data.provider == 'tiktok' and not readiness('tiktok')['publish_ready']:
        raise HTTPException(409, 'TikTok media-domain verification is not configured. Review the provider setup requirements before posting.')
    item = session.scalar(select(CreatorItem).where(CreatorItem.id == str(data.item_id), CreatorItem.owner_id == user.id))
    if not item:
        raise HTTPException(404, 'Your creation was not found.')
    if item.visibility != 'published':
        raise HTTPException(409, 'Publish this source creation in Ziipa first.')
    if item.data.get('media_id') != str(data.expected_media_id):
        raise HTTPException(409, 'The source file changed after your approval. Refresh the creation and approve the current file.')
    media = session.get(CreatorMedia, item.data.get('media_id')) if item.data.get('media_id') else None
    render_fingerprint = None
    if data.render_id:
        from render_services import resolve_rendered_media, input_fingerprint
        media = resolve_rendered_media(session, user.id, item, str(data.render_id))
        render_fingerprint = input_fingerprint(session, item)
    if not media or media.owner_id != user.id:
        raise HTTPException(404, 'Your source media was not found.')
    if media.content_type not in ('video/mp4', 'video/quicktime', 'video/webm') or media.size > MAX_MEDIA_BYTES:
        raise HTTPException(422, 'This adapter accepts original MP4, MOV or WebM videos up to 25 MB.')
    grant = grant_for(session, user.id, data.provider)
    if not grant or grant.status != 'authorized' or not grant.selected_target_id:
        raise HTTPException(409, 'Authorize this provider and explicitly choose its destination first.')
    if grant.selected_target_id != data.expected_target_id:
        raise HTTPException(409, 'The publishing destination changed after your approval. Refresh it and approve again.')
    title = (data.title if data.title is not None else item.data['title']).strip()
    if not title or len(title) > 100 or '<' in title or '>' in title:
        raise HTTPException(422, 'Choose a title of 1–100 characters without angle brackets.')
    description = data.description if data.description is not None else item.data.get('description', '')
    metadata = {'snippet': {'title': title, 'description': description},
                'status': {'privacyStatus': data.privacy, 'selfDeclaredMadeForKids': data.made_for_kids}}
    fingerprint = hashlib.sha256(json.dumps({'item': item.id, 'media': media.id, 'render_id': str(data.render_id) if data.render_id else None,
                                  'render_fingerprint': render_fingerprint, 'target': grant.selected_target_id,
                                  'metadata': metadata, 'tiktok': data.tiktok.model_dump() if data.tiktok else None}, sort_keys=True).encode()).hexdigest()
    existing = session.scalar(select(PublishingJob).where(PublishingJob.owner_id == user.id,
                                                         PublishingJob.idempotency_key == str(data.idempotency_key)))
    retry_job = None
    if existing:
        if existing.source_hash != fingerprint or existing.provider != data.provider:
            raise HTTPException(409, 'This request key already belongs to a different upload.')
        if existing.status == 'failed' and data.retry_failed:
            retry_job = existing
        else:
            return receipt(existing)
    duplicate = session.scalar(select(PublishingJob).where(PublishingJob.owner_id == user.id,
                              PublishingJob.provider == data.provider, PublishingJob.source_hash == fingerprint))
    if duplicate:
        if duplicate.status == 'failed' and data.retry_failed:
            retry_job = duplicate
        else:
            return receipt(duplicate)
    # Serialize source handoffs across the small demo API; no unbounded 25 MB
    # buffers or concurrent duplicate uploads while a provider is slow.
    lock = 'publishing_upload_lock'
    lock_token = secrets.token_urlsafe(24)
    try:
        if not cache.set(lock, lock_token, nx=True, ex=180):
            raise HTTPException(429, 'Another upload is being sent. Please retry shortly.')
    except RedisError as exc:
        raise HTTPException(503, 'Publishing coordination is unavailable.') from exc
    job_id, owner_id = retry_job.id if retry_job else str(uuid.uuid4()), user.id
    job = retry_job or PublishingJob(id=job_id, owner_id=owner_id, item_id=item.id, provider=data.provider,
                        idempotency_key=str(data.idempotency_key), source_hash=fingerprint,
                        target_id=grant.selected_target_id, privacy=data.privacy, status='sending',
                        detail=f'Preparing the approved {"rendered" if data.render_id else "original"} video upload. Do not start another upload.')
    session.add(job)
    attempted = False
    try:
        if retry_job:
            session.refresh(job, with_for_update=True)
            if job.status != 'failed':
                return receipt(job)
            job.status = 'sending'
            job.detail = 'Retrying preparation after your renewed upload approval. No prior delivery was attempted.'
        session.commit()
        body = await asyncio.to_thread(original_bytes, media, owner_id)
        tiktok_duration = None
        if data.provider == 'tiktok':
            if hashlib.sha256(body).hexdigest() != data.tiktok.source_sha256:
                raise HTTPException(409, 'The selected video changed since TikTok review. Review the exact current source again.')
            tiktok_duration = await asyncio.to_thread(tiktok_adapter.probe_video, body, media.content_type)
        source_media_id, source_item_id = media.id, item.id
        def revalidate_render():
            current_item = session.scalar(select(CreatorItem).where(CreatorItem.id == source_item_id, CreatorItem.owner_id == owner_id))
            if not current_item or current_item.visibility != 'published':
                raise HTTPException(409, 'The published source creation was removed or made private before delivery.')
            if current_item.data.get('media_id') != str(data.expected_media_id):
                raise HTTPException(409, 'The source file changed after your approval. Refresh and approve the current file.')
            if not data.render_id:
                return
            from render_services import resolve_rendered_media, input_fingerprint
            current_media = resolve_rendered_media(session, owner_id, current_item, str(data.render_id))
            if current_media.id != source_media_id or input_fingerprint(session, current_item) != render_fingerprint:
                raise HTTPException(409, 'This rendered export no longer matches the saved edit. Render and approve the current version.')
        async with asyncio.timeout(60), api_client() as client, provider_bridge_lease(grant):
            token = await access_token(session, grant, client)
            grant_id = grant.id
            save_sdk = sdk_credential_saver(session, grant, job.target_id)
            async def save_tokens(updated):
                nonlocal token
                token = await save_sdk(updated)
            async def checkpoint(provider_data):
                nonlocal attempted, job
                session.expire_all()
                revalidate_render()
                latest = grant_for(session, owner_id, data.provider, lock=True)
                current = session.get(PublishingJob, job_id)
                if (not current or not latest or latest.id != grant_id or latest.status != 'authorized' or
                        latest.selected_target_id != current.target_id or decrypt_tokens(latest).get('access_token') != token):
                    raise HTTPException(409, 'Provider authorization changed before the next delivery step.')
                current.provider_data = dict(provider_data)
                current.updated_at = datetime.now(timezone.utc)
                current.detail = 'An approved provider delivery step has started. Do not create a duplicate upload.'
                session.commit()
                attempted, job = True, current

            if data.provider == 'youtube':
                targets = await channels(client, token)
                # A credential grants the authenticated channel, not arbitrary
                # channel IDs. Never pick the first channel implicitly.
                if len(targets) != 1 or targets[0]['id'] != job.target_id:
                    raise HTTPException(409, 'The authorized YouTube channel no longer matches the selected destination. Reconnect and choose it again.')
                boundary = 'ziipa' + secrets.token_hex(16)
                preamble = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
                            json.dumps(metadata) + f'\r\n--{boundary}\r\nContent-Type: {media.content_type}\r\n\r\n').encode()
                content = preamble + body + f'\r\n--{boundary}--\r\n'.encode()
                session.expire_all()
                revalidate_render()
                latest_grant = grant_for(session, owner_id, data.provider, lock=True)
                if (not latest_grant or latest_grant.id != grant_id or latest_grant.status != 'authorized' or
                        latest_grant.selected_target_id != job.target_id or decrypt_tokens(latest_grant).get('access_token') != token):
                    raise HTTPException(409, 'The destination authorization changed before delivery. Refresh your connections and approve again.')
                # Persist uncertainty BEFORE contacting the write endpoint. A crash
                # or lost response never leads to an automatic duplicate post.
                job.detail = 'An upload attempt has started. Check its receipt before trying again.'
                session.commit()
                attempted = True
                status, result = await provider_json(client, 'POST', UPLOAD_URL,
                    params={'uploadType': 'multipart', 'part': 'snippet,status', 'notifySubscribers': 'false'},
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': f'multipart/related; boundary={boundary}'}, content=content)
                session.expire_all()
                job = session.get(PublishingJob, job_id)
                if not job:
                    raise HTTPException(409, 'This Ziipa account or upload record was removed. Check YouTube directly for the upload outcome.')
                if status in (200, 201) and re.fullmatch(r'[A-Za-z0-9_-]{11}', str(result.get('id', ''))):
                    job.external_id = result['id']
                    job.external_url = 'https://www.youtube.com/watch?v=' + result['id']
                    job.status, job.detail = 'processing', 'YouTube accepted the video. Processing and visibility still require verification.'
                elif 400 <= status < 500:
                    job.status, job.detail = 'rejected', 'YouTube rejected the upload. Review channel permissions, media and project limits; no automatic retry will run.'
                else:
                    job.status, job.detail = 'uncertain', 'The upload outcome could not be verified. Check YouTube Studio before attempting a new upload.'
            else:
                backend = storage()
                source_url = (create_tiktok_pull_url(job, media, grant, data, hashlib.sha256(body).hexdigest()) if data.provider == 'tiktok'
                              else None if isinstance(backend, LocalStorage) else backend.read_url(owner_id, media.id))
                source = {'bytes': body, 'size': media.size, 'content_type': media.content_type,
                          'title': title, 'description': description, 'url': source_url,
                          'tiktok': data.tiktok.model_dump() if data.tiktok else None,
                          'duration_seconds': tiktok_duration,
                          'origin': approved_api_origin(), 'save_tokens': save_tokens, 'job_id': job_id,
                          'created_at': job.created_at.isoformat().replace('+00:00', 'Z')}
                adapter = tiktok_adapter if data.provider == 'tiktok' else bluesky_adapter if data.provider == 'bluesky' else meta_adapter()
                outcome = await adapter.publish_prepare(decrypt_tokens(grant), job.target_id, source, client, config, checkpoint)
                session.expire_all()
                job = session.get(PublishingJob, job_id)
                if not job:
                    raise HTTPException(409, 'The account or upload record was removed. Check the provider directly.')
                apply_outcome(job, outcome)

    except external_errors() as exc:
        session.rollback()
        job = session.get(PublishingJob, job_id)
        if not job:
            raise HTTPException(409, 'The upload record was removed. Check the destination before retrying.') from exc
        job.status = 'uncertain' if attempted else 'failed'
        job.detail = ('The upload outcome is uncertain. Check the destination and refresh this receipt; Ziipa will not automatically repost.' if attempted else
                      'Upload preparation or authorization failed before media delivery. Reconnect the account or check the source file.')
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(409, 'An identical upload request is already registered. Refresh your outbox.') from exc
    finally:
        try:
            cache.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, lock, lock_token)
        except RedisError:
            pass  # Bounded TTL releases the lock; never risk retrying the upload.
    job.updated_at = datetime.now(timezone.utc)
    session.commit()
    return receipt(job)


@router.get('/jobs')
def jobs(user: User = Depends(current_user), session: Session = Depends(db)):
    return [receipt(row) for row in session.scalars(select(PublishingJob).where(PublishingJob.owner_id == user.id)
                                                   .order_by(PublishingJob.created_at.desc()).limit(100))]


async def refresh_adapter_job(job, grant, user, session):
    job_id, owner_id, provider, grant_id = job.id, user.id, job.provider, grant.id
    key, lease = f'publishing_poll:{job_id}', secrets.token_urlsafe(24)
    try:
        if not cache.set(key, lease, nx=True, ex=45):
            raise HTTPException(429, 'This receipt is already being checked. Retry shortly.')
    except RedisError as exc:
        raise HTTPException(503, 'Provider status coordination is unavailable.') from exc
    checkpointed = False
    try:
        session.refresh(job)
        if job.status in ('delivered', 'rejected', 'failed'):
            return receipt(job)
        if not job.provider_data:
            return receipt(job)
        async with asyncio.timeout(30), api_client() as client, provider_bridge_lease(grant):
            token = await access_token(session, grant, client)
            save_sdk = sdk_credential_saver(session, grant, job.target_id)
            async def save_tokens(updated):
                nonlocal token
                token = await save_sdk(updated)
            async def checkpoint(provider_data):
                nonlocal checkpointed, job
                session.expire_all()
                latest = grant_for(session, owner_id, provider, lock=True)
                current = session.get(PublishingJob, job_id)
                if (not current or not latest or latest.id != grant_id or latest.status != 'authorized' or
                        decrypt_tokens(latest).get('access_token') != token or
                        provider in ('facebook', 'instagram') and not config.meta_public_approved):
                    raise HTTPException(409, 'Provider authorization or publication approval changed before this delivery step.')
                current.provider_data = dict(provider_data)
                current.updated_at = datetime.now(timezone.utc)
                session.commit()
                checkpointed, job = True, current
            adapter = tiktok_adapter if provider == 'tiktok' else bluesky_adapter if provider == 'bluesky' else meta_adapter()
            result = await adapter.poll(decrypt_tokens(grant), job.target_id,
                {'external_id': job.external_id, 'provider_data': job.provider_data or {}, 'status': job.status,
                 'origin': approved_api_origin(), 'save_tokens': save_tokens},
                client, config, checkpoint)
        session.expire_all()
        job = session.get(PublishingJob, job_id)
        if not job:
            raise HTTPException(409, 'This account or delivery receipt was removed.')
        apply_outcome(job, result)
        job.updated_at = datetime.now(timezone.utc)
        session.commit()
        return receipt(job)
    except external_errors() as exc:
        session.rollback()
        job = session.get(PublishingJob, job_id)
        confirmed = job.provider_data if job and job.provider == 'instagram' and isinstance(job.provider_data, dict) else {}
        if (confirmed.get('phase') == 'delivered' and confirmed.get('provider') == 'instagram'
                and confirmed.get('target_id') == job.target_id and re.fullmatch(r'[1-9][0-9]{0,49}', str(confirmed.get('media_id', '')))):
            job.status, job.external_id, job.detail = 'delivered', confirmed['media_id'], 'Instagram confirmed publication. Its optional public link lookup is unavailable.'
            session.commit()
            return receipt(job)
        if job and (checkpointed or getattr(exc, 'uncertain', False)):
            job.status, job.detail = 'uncertain', 'The provider delivery outcome is uncertain. Check the destination; no new upload will be created.'
            session.commit()
            return receipt(job)
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(503, 'Provider delivery status is unavailable. No new upload was created.') from exc
    finally:
        try:
            cache.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, key, lease)
        except RedisError:
            pass


@router.post('/jobs/{job_id}/refresh', dependencies=[Depends(guard)])
async def refresh_job(job_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    job = session.scalar(select(PublishingJob).where(PublishingJob.id == str(job_id), PublishingJob.owner_id == user.id))
    if not job:
        raise HTTPException(404, 'Upload receipt not found.')
    if not job.external_id and not job.provider_data:
        return receipt(job)  # Unknown uploads must be inspected manually, not reposted.
    grant = grant_for(session, user.id, job.provider)
    if not grant or grant.status != 'authorized':
        raise HTTPException(409, 'Reconnect the provider account to check this upload.')
    if job.provider != 'youtube':
        return await refresh_adapter_job(job, grant, user, session)
    try:
        async with asyncio.timeout(25), api_client() as client:
            token = await access_token(session, grant, client)
            status, result = await provider_json(client, 'GET', VIDEOS_URL,
                params={'part': 'snippet,status,processingDetails', 'id': job.external_id}, headers={'Authorization': 'Bearer ' + token})
    except (ProviderFailure, TimeoutError) as exc:
        raise HTTPException(503, 'YouTube upload status is temporarily unavailable. No media was reposted.') from exc
    items = result.get('items', [])
    if status != 200 or not isinstance(items, list) or not items:
        raise HTTPException(409, 'YouTube did not return this upload. Check YouTube Studio; no media was reposted.')
    video = items[0]
    if not isinstance(video, dict) or video.get('id') != job.external_id or video.get('snippet', {}).get('channelId') != job.target_id:
        raise HTTPException(409, 'The provider receipt does not match the selected channel.')
    state = video.get('status', {})
    processing = video.get('processingDetails', {}).get('processingStatus')
    if state.get('uploadStatus') in ('failed', 'rejected', 'deleted') or processing in ('failed', 'terminated'):
        job.status, job.detail = 'rejected', 'YouTube reported that this upload failed, was rejected, or was removed.'
    elif processing == 'succeeded' or state.get('uploadStatus') == 'processed':
        actual_privacy = state.get('privacyStatus')
        if actual_privacy not in ('private', 'unlisted', 'public'):
            raise HTTPException(409, 'YouTube did not return a verifiable visibility status.')
        job.privacy = actual_privacy
        job.status, job.detail = 'delivered', f'YouTube processing completed. Current visibility: {actual_privacy}.'
    else:
        job.status, job.detail = 'processing', 'YouTube is still processing this video. No repeat upload was started.'
    job.updated_at = datetime.now(timezone.utc)
    session.commit()
    return receipt(job)


async def revoke_grant(grant: PublishingGrant) -> bool:
    """Returns false on provider failure; local deletion must still remove tokens."""
    try:
        tokens = decrypt_tokens(grant)
        async with asyncio.timeout(15), api_client() as client:
            if grant.provider == 'tiktok':
                return await tiktok_adapter.revoke(tokens, client, config)
            if grant.provider == 'twitch':
                return await twitch_adapter.revoke(tokens, client, config)
            if grant.provider == 'bluesky':
                return await bluesky_adapter.revoke(tokens, config, approved_api_origin())
            if grant.provider in ('facebook', 'instagram'):
                return await meta_adapter().revoke(tokens, client, config)
            status, result = await provider_json(client, 'POST', REVOKE_URL, data={'token': tokens.get('refresh_token') or tokens['access_token']})
        return status == 200 or status == 400 and result.get('error') == 'invalid_token'
    except external_errors() + (KeyError,):
        return False


@router.post('/connections/{provider}/disconnect', dependencies=[Depends(guard)])
async def disconnect_publishing(provider: SocialProvider, user: User = Depends(current_user), session: Session = Depends(db)):
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    grant = grant_for(session, user.id, provider)
    revoked = True
    if grant:
        if provider == 'twitch':
            from live_api import detach_twitch_destinations
            await detach_twitch_destinations(user.id, session)
        revoked = await revoke_grant(grant)
        session.delete(grant)
        if provider in ('facebook', 'instagram'):
            for sibling in session.scalars(select(PublishingGrant).where(PublishingGrant.owner_id == user.id,
                    PublishingGrant.provider.in_(['facebook', 'instagram']), PublishingGrant.provider != provider)):
                sibling.status = 'reconnect_required'
    session.commit()
    return {'provider': provider, 'status': 'disconnected', 'provider_revoked': revoked,
            'detail': 'Local authorization was deleted. Published videos remain on the provider.' +
                      (' Meta app revocation can also affect the linked Facebook/Instagram authorization; reconnect it if needed.' if provider in ('facebook', 'instagram') else '') +
                      ('' if revoked else ' Provider revocation could not be confirmed; remove Ziipa in the provider’s account permissions too.')}


async def delete_publishing_account(user_id: int, session: Session) -> dict:
    """Root account-deletion hook: call before deleting User, then commit once."""
    grants = list(session.scalars(select(PublishingGrant).where(PublishingGrant.owner_id == user_id)))
    results = []
    for grant in grants:
        results.append(await revoke_grant(grant))
    session.execute(delete(PublishingGrant).where(PublishingGrant.owner_id == user_id))
    session.execute(delete(PublishingJob).where(PublishingJob.owner_id == user_id))
    return {'provider_revocation_confirmed': all(results)}
