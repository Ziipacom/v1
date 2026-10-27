"""Separate opt-in read authorization. Credentials never enter client/export DTOs."""
import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import json
import math
import re
import secrets
import time
from urllib.parse import urlencode, urlsplit
import uuid

import sentry_sdk

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import User, cache, current_user, db, guard, settings
from creator import CreatorConnection, provider_connection
import social_publishing as vault
import social_read_adapters as adapter

router = APIRouter(prefix='/api/social/oauth')
READ_PROVIDERS = frozenset(('facebook', 'instagram', 'tiktok'))
STATE_TTL = 600
SNAPSHOT_TTL = 24 * 3600


def redact_read_telemetry(event, _hint):
    request = event.get('request') if isinstance(event, dict) else None
    if not isinstance(request, dict) or '/api/social/' not in str(request.get('url', '')):
        return event
    request['url'] = str(request.get('url', '')).split('?', 1)[0].split('#', 1)[0]
    for field in ('query_string', 'data', 'cookies'):
        request.pop(field, None)
    request['headers'] = {}
    event.pop('extra', None)
    for value in event.get('exception', {}).get('values', []):
        if isinstance(value, dict):
            value['value'] = 'Read-import request failed; private provider details removed.'
            for frame in value.get('stacktrace', {}).get('frames', []):
                if isinstance(frame, dict):
                    frame.pop('vars', None)
    for crumb in event.get('breadcrumbs', {}).get('values', []):
        if isinstance(crumb, dict):
            data = crumb.get('data')
            if isinstance(data, dict):
                crumb['data'] = {key: value for key, value in data.items() if key in ('method', 'status_code')}
            crumb.pop('message', None)
    return event


sentry_sdk.get_global_scope().add_event_processor(redact_read_telemetry)


def enabled(provider):
    return provider in READ_PROVIDERS and bool(getattr(settings, f'social_{provider}_imports_enabled', False)
        and getattr(settings, f'social_{provider}_imports_approved', False))


def readiness(provider):
    requirements = []
    if provider not in READ_PROVIDERS:
        return {'can_start': False, 'requirements': ['This provider does not use managed-account read authorization.'], 'detail': 'Use a supported public-profile import instead.'}
    if not enabled(provider):
        requirements.append('Operator-enabled read imports after provider product and permission review')
    if provider == 'tiktok':
        if not vault.config.tiktok_client_key or not vault.config.tiktok_client_secret:
            requirements.append('Registered TikTok Login Kit and Display API application')
    else:
        if not vault.config.meta_client_id or not vault.config.meta_client_secret or not re.fullmatch(r'v[1-9][0-9]{0,2}\.0', vault.config.meta_graph_version or ''):
            requirements.append('Registered Meta application and an explicitly supported Graph version')
    try:
        vault.encryption_key()
    except HTTPException:
        requirements.append('Stable server-side read-token encryption')
    try:
        vault.approved_api_origin()
    except HTTPException:
        requirements.append('Approved fixed HTTPS API origin and registered read callback')
    detail = ('Read only your public TikTok videos with basic identity and video.list consent. No posting, private videos or home feed.' if provider == 'tiktok' else
        'Read only public posts from an explicitly selected managed Facebook Page or its linked professional Instagram account. No personal timeline, private feed or posting permission.')
    return {'can_start': not requirements, 'requirements': requirements, 'detail': detail}


def aad(owner_id, provider):
    return f'ziipa-social-read-v1:{owner_id}:{provider}'.encode('ascii')


def encrypt(owner_id, provider, tokens):
    from Crypto.Cipher import AES
    cipher = AES.new(vault.encryption_key(), AES.MODE_GCM, nonce=secrets.token_bytes(12))
    cipher.update(aad(owner_id, provider))
    payload = json.dumps({'purpose': 'public-read-import-v1', 'provider': provider, 'tokens': tokens}, separators=(',', ':')).encode()
    if len(payload) > 512 * 1024:
        raise HTTPException(503, 'Read authorization exceeded the safe storage bound.')
    encrypted, tag = cipher.encrypt_and_digest(payload)
    return 'read1.' + base64.urlsafe_b64encode(cipher.nonce + tag + encrypted).decode()


def decrypt(row):
    from Crypto.Cipher import AES
    try:
        value = row.data.get('read_cipher')
        if not isinstance(value, str) or not value.startswith('read1.') or len(value) > 750000:
            raise ValueError()
        raw = base64.b64decode(value[6:], altchars=b'-_', validate=True)
        cipher = AES.new(vault.encryption_key(), AES.MODE_GCM, nonce=raw[:12])
        cipher.update(aad(row.owner_id, row.provider))
        record = json.loads(cipher.decrypt_and_verify(raw[28:], raw[12:28]))
        if record.get('purpose') != 'public-read-import-v1' or record.get('provider') != row.provider or not isinstance(record.get('tokens'), dict):
            raise ValueError()
        return record['tokens']
    except (ValueError, TypeError, KeyError):
        raise HTTPException(503, 'Stored read authorization could not be verified. Reconnect this account.') from None


def timestamp(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > time.time()


def authorized(row):
    return bool(row and row.data.get('auth_type') == 'oauth' and row.data.get('read_purpose') == 'public-read-import-v1'
        and row.data.get('read_status') == 'authorized' and isinstance(row.data.get('read_cipher'), str))


def can_sync(row):
    return bool(authorized(row) and readiness(row.provider)['can_start'] and row.data.get('selected_import_target_id')
        and (timestamp(row.data.get('read_expires_at')) or row.provider == 'tiktok' and timestamp(row.data.get('read_refresh_expires_at'))))


def public_targets(row):
    if not authorized(row):
        return []
    values = read_metadata(row).get('targets', [])
    if not isinstance(values, list):
        values = []
    result = [{key: value.get(key, '') for key in ('id', 'name', 'kind', 'url')}
              for value in values[:adapter.MAX_TARGETS] if isinstance(value, dict)]
    if result:
        return result
    # Consent identifiers are retained with the encrypted grant. API-derived
    # names/URLs expire; generic labels allow explicit selection without keeping
    # personal account-profile metadata indefinitely in PostgreSQL.
    return [{'id': value['id'], 'name': 'Authorized account ' + value['id'], 'kind': value['kind'], 'url': ''}
        for value in row.data.get('read_targets', []) if isinstance(value, dict) and isinstance(value.get('id'), str)
        and isinstance(value.get('kind'), str)][:adapter.MAX_TARGETS]


def visible_snapshot(row):
    # Read grants are different from linked public profiles: withdrawal, expiry
    # or operator disabling imports must stop rendering their cached metadata.
    if not can_sync(row):
        return {}
    value = read_metadata(row).get('snapshot')
    return value if isinstance(value, dict) else {}


def metadata_key(row):
    revision = row.data.get('revision') if row and isinstance(row.data, dict) else None
    try:
        if row.provider not in READ_PROVIDERS | {'youtube'} or str(uuid.UUID(revision)) != revision:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(409, 'The public import identity is unavailable. Reconnect.') from None
    return f'social_import_metadata:{row.owner_id}:{row.provider}:{revision}'


def metadata_ttl(provider):
    return 6 * 3600 if provider == 'tiktok' else SNAPSHOT_TTL


def read_metadata(row):
    try:
        raw = cache.get(metadata_key(row))
        if not raw or len(raw) > 512 * 1024:
            return {}
        value = json.loads(raw)
        if not isinstance(value, dict) or not timestamp(value.get('expires_at')):
            return {}
        return value
    except (RedisError, HTTPException, ValueError, TypeError):
        return {}


def write_metadata(row, *, snapshot=None, targets=None, expires_at=None):
    expiry = min(time.time() + metadata_ttl(row.provider), expires_at) if timestamp(expires_at) else time.time() + metadata_ttl(row.provider)
    ttl = max(1, min(metadata_ttl(row.provider), math.ceil(expiry - time.time())))
    payload = {'expires_at': expiry, 'snapshot': snapshot or {}, 'targets': targets or []}
    raw = json.dumps(payload, separators=(',', ':'))
    if len(raw.encode()) > 512 * 1024:
        raise HTTPException(503, 'Public import metadata exceeded its safe cache bound.')
    try:
        if not cache.set(metadata_key(row), raw, ex=ttl):
            raise HTTPException(503, 'Public import metadata could not be saved.')
    except RedisError:
        raise HTTPException(503, 'Public import metadata storage is unavailable.') from None
    return payload['expires_at']


def clear_metadata(row):
    try:
        cache.delete(metadata_key(row))
    except (RedisError, HTTPException):
        pass  # Revision rotation/unlink makes old data inaccessible; TTL bounds retention.


def delete_account_metadata(session, owner_id):
    for row in session.scalars(select(CreatorConnection).where(CreatorConnection.owner_id == owner_id,
            CreatorConnection.provider.in_(tuple(READ_PROVIDERS | {'youtube'})))):
        clear_metadata(row)


def enforce_owner(session, owner_id):
    from admin_services import account_is_active, require_mutations_open
    owner = session.get(User, owner_id, populate_existing=True)
    if not owner or not account_is_active(session, owner_id):
        raise HTTPException(403, 'The Ziipa account is unavailable. No import was started.')
    require_mutations_open(session, owner)
    return owner


def state_key(kind, value):
    return 'social_read_oauth:' + kind + ':' + hashlib.sha256(value.encode()).hexdigest()


def store_state(kind, value, record):
    try:
        if not cache.set(state_key(kind, value), json.dumps(record), nx=True, ex=STATE_TTL):
            raise HTTPException(503, 'Read authorization state was not saved. Start again.')
    except RedisError:
        raise HTTPException(503, 'Read authorization state storage is unavailable.') from None


def consume_state(kind, value):
    try:
        raw = cache.getdel(state_key(kind, value))
        if not raw or len(raw) > 16384:
            raise ValueError()
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except RedisError:
        raise HTTPException(503, 'Read authorization state storage is unavailable.') from None
    except (ValueError, TypeError):
        raise HTTPException(400, 'Read authorization expired or was already used. Start again.') from None


def profile_identity(row):
    return [row.id, row.data.get('revision')] if row else None


def verify_browser(provider, request, record, session):
    token = request.cookies.get('ziipa_session', '')
    binding = request.cookies.get('ziipa_read_oauth_' + provider, '')
    if (record.get('provider') != provider or request.headers.get('authorization') or not token or not binding
            or not secrets.compare_digest(record.get('session_hash', ''), hashlib.sha256(token.encode()).hexdigest())
            or not secrets.compare_digest(record.get('binding_hash', ''), hashlib.sha256(binding.encode()).hexdigest())):
        raise HTTPException(401, 'Finish read authorization in the same Ziipa browser and account that started it.')
    owner = current_user(request, session)
    if owner.id != record.get('owner_id'):
        raise HTTPException(401, 'Read authorization belongs to a different Ziipa account.')
    enforce_owner(session, owner.id)
    row = provider_connection(provider, owner, session)
    if profile_identity(row) != record.get('link_identity'):
        raise HTTPException(409, 'This network link changed during authorization. Start again.')
    return owner


def callback_url(provider):
    return vault.approved_api_origin() + f'/api/social/oauth/{provider}/callback'


def portal_url():
    value = settings.public_app_url.rstrip('/')
    url = urlsplit(value)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
        raise HTTPException(503, 'The fixed Ziipa portal origin is unavailable.')
    return value + '/portal'


def begin(provider, request, response, user, session):
    state = readiness(provider)
    if not state['can_start']:
        return {'status': 'setup_required', 'auth_url': None, 'connect_via_portal': None,
                'detail': state['detail'], 'requirements': state['requirements']}
    if request.headers.get('authorization') or not request.cookies.get('ziipa_session'):
        return {'status': 'browser_sign_in_required', 'auth_url': None, 'connect_via_portal': portal_url(),
            'detail': 'Sign into this same Ziipa account in the portal and explicitly authorize read imports there. Return to the app and refresh networks.', 'requirements': []}
    # A proxied browser POST retains its trusted Origin header. Host is never
    # used to construct a callback or to move a host-only sign-in cookie.
    browser_origin = request.headers.get('origin') or str(request.base_url).rstrip('/')
    if browser_origin.rstrip('/') != vault.approved_api_origin():
        raise HTTPException(409, 'Open Ziipa on the configured read-authorization browser origin before connecting. Its sign-in cookie must reach the callback.')
    ticket, binding = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
    row = provider_connection(provider, user, session)
    store_state('ticket', ticket, {'owner_id': user.id, 'provider': provider, 'link_identity': profile_identity(row),
        'session_hash': hashlib.sha256(request.cookies['ziipa_session'].encode()).hexdigest(),
        'binding_hash': hashlib.sha256(binding.encode()).hexdigest()})
    response.set_cookie('ziipa_read_oauth_' + provider, binding, max_age=STATE_TTL, httponly=True, secure=True,
                        samesite='lax', path='/api/social/oauth/' + provider)
    return {'status': 'authorization_required', 'auth_url': vault.approved_api_origin() + f'/api/social/oauth/{provider}/authorize?' + urlencode({'ticket': ticket}),
            'connect_via_portal': None, 'detail': state['detail'], 'requirements': []}


@router.get('/{provider}/authorize')
async def authorize(provider: str, request: Request, ticket: str = Query(min_length=54, max_length=54, pattern='^[A-Za-z0-9_-]+$'), session: Session = Depends(db)):
    if provider not in READ_PROVIDERS or not readiness(provider)['can_start']:
        raise HTTPException(409, 'Read imports are not configured for this provider.')
    record = consume_state('ticket', ticket)
    verify_browser(provider, request, record, session)
    state, verifier = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
    store_state('callback', state, {**record, 'verifier': verifier})
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    response = RedirectResponse(adapter.authorization_url(provider, vault.config, callback_url(provider), state, challenge), status_code=302)
    response.headers.update({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
    return response


@router.get('/{provider}/callback')
async def callback(provider: str, request: Request, state: str = Query(min_length=54, max_length=54, pattern='^[A-Za-z0-9_-]+$'),
                   code: str = Query(default='', max_length=4096), error: str = Query(default='', max_length=100), session: Session = Depends(db)):
    if provider not in READ_PROVIDERS or not readiness(provider)['can_start']:
        raise HTTPException(409, 'Read imports are not configured for this provider.')
    record = consume_state('callback', state)
    owner = verify_browser(provider, request, record, session)
    if error or not code:
        raise HTTPException(400, 'Read authorization was not approved. No connection was saved.')
    owner_id = owner.id
    session.commit()
    try:
        async with asyncio.timeout(25), vault.api_client() as client:
            result = await adapter.exchange(provider, code, callback_url(provider), record['verifier'], client, vault.config)
    except Exception:
        raise HTTPException(502, 'Read authorization could not be verified. No connection was saved.') from None
    session.expire_all()
    owner = session.scalar(select(User).where(User.id == owner_id).with_for_update())
    if not owner:
        raise HTTPException(409, 'The Ziipa account no longer exists.')
    verify_browser(provider, request, record, session)
    row = provider_connection(provider, owner, session)
    if row is None:
        row = CreatorConnection(owner_id=owner_id, provider=provider)
        session.add(row)
    row.status = 'connected'
    tokens = result['tokens']
    previous = row.data or {}
    if previous:
        clear_metadata(row)
    row.data = {'version': 2, 'revision': str(uuid.uuid4()), 'auth_type': 'oauth', 'read_purpose': 'public-read-import-v1',
        'read_status': 'authorized', 'read_cipher': encrypt(owner_id, provider, tokens), 'read_expires_at': tokens['expires_at'],
        'read_refresh_expires_at': tokens.get('refresh_expires_at'),
        'read_targets': [{'id': target['id'], 'kind': target['kind']} for target in result['targets']],
        'selected_import_target_id': None, 'sync_status': 'never',
        **{key: previous[key] for key in ('handle', 'profile_url') if key in previous}}
    session.flush()
    write_metadata(row, targets=result['targets'])
    session.commit()
    response = HTMLResponse('<!doctype html><meta name="referrer" content="no-referrer"><title>Ziipa read authorization</title>'
        '<h1>Read authorization saved</h1><p>Return to Ziipa, refresh networks, explicitly select an authorized account and choose Sync public posts. Nothing has been posted.</p>')
    response.delete_cookie('ziipa_read_oauth_' + provider, path='/api/social/oauth/' + provider)
    response.headers.update({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
    return response


class TargetInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    target_id: str = Field(min_length=1, max_length=100)
    revision: uuid.UUID


def select_target(provider, data, user, session):
    session.scalar(select(User).where(User.id == user.id).with_for_update())
    row = provider_connection(provider, user, session)
    if not authorized(row) or str(data.revision) != row.data.get('revision'):
        raise HTTPException(409, 'Read authorization changed. Refresh your networks.')
    selected = next((target for target in public_targets(row) if target['id'] == data.target_id), None)
    if selected is None:
        raise HTTPException(422, 'Choose one of this account\'s verified import destinations.')
    if not readiness(provider)['can_start']:
        raise HTTPException(409, 'Read imports are not configured for this provider.')
    targets, old_metadata = public_targets(row), read_metadata(row)
    clear_metadata(row)
    row.data = {**row.data, 'selected_import_target_id': selected['id'],
        'revision': str(uuid.uuid4()), 'sync_status': 'never'}
    write_metadata(row, targets=targets, expires_at=old_metadata.get('expires_at'))
    session.commit()
    return row


async def sync(provider, user, session):
    from social_api import claim_sync, build_hub
    row = provider_connection(provider, user, session)
    if not can_sync(row):
        raise HTTPException(409, 'Authorize public read imports and select a current eligible account first.')
    target = next((value for value in public_targets(row) if value['id'] == row.data.get('selected_import_target_id')), None)
    if target is None:
        raise HTTPException(409, 'Select an authorized import account first.')
    claim_sync(user.id, provider)
    owner_id, row_id, revision = user.id, row.id, row.data.get('revision')
    tokens = decrypt(row)
    session.commit()
    result, error = None, None
    try:
        async with asyncio.timeout(25), vault.api_client() as client:
            result = await adapter.fetch_snapshot(provider, tokens, target, client, vault.config)
    except adapter.ReadFailure as exc:
        error = exc
    except Exception:
        error = adapter.ReadFailure('The public import could not complete. Retry later.')
    session.expire_all()
    owner = session.scalar(select(User).where(User.id == owner_id).with_for_update())
    enforce_owner(session, owner_id)
    latest = session.scalar(select(CreatorConnection).where(CreatorConnection.id == row_id,
        CreatorConnection.owner_id == owner_id).with_for_update())
    if not owner or not authorized(latest) or latest.data.get('revision') != revision:
        raise HTTPException(409, 'Read authorization changed during import. Refresh your networks.')
    if error:
        patch = {'sync_status': 'error', 'sync_error': str(error)}
        # A read failure never certifies continuing public visibility. Clear the
        # former snapshot rather than preserving potentially withdrawn posts.
        if error.reconnect:
            patch.update(read_status='reconnect_required', read_cipher=None, read_targets=[],
                         selected_import_target_id=None, read_expires_at=None, read_refresh_expires_at=None)
    else:
        patch = {'read_cipher': encrypt(owner_id, provider, result['tokens']), 'read_expires_at': result['tokens']['expires_at'],
            'read_refresh_expires_at': result['tokens'].get('refresh_expires_at'), 'last_synced_at': datetime.now(timezone.utc).isoformat(),
            'sync_status': 'synced', 'sync_error': None}
    old_targets = public_targets(latest)
    clear_metadata(latest)
    latest.data = {**latest.data, **patch, 'revision': str(uuid.uuid4())}
    if not error:
        try:
            write_metadata(latest, snapshot=result['snapshot'], targets=result.get('targets', old_targets))
        except HTTPException:
            latest.data = {**latest.data, 'sync_status': 'error', 'sync_error': 'Public import metadata could not be saved. Retry later.'}
            session.commit()  # Persist rotated revision even when Redis is down.
            raise
    session.commit()
    return build_hub(user, session)
