"""Per-account social links and bounded, opt-in public Bluesky imports.

A saved public profile is not proof of ownership or an OAuth grant. No endpoint
in this module sends posts, follows accounts, or invites anyone automatically.
"""
import asyncio
from datetime import datetime, timezone
import json
import re
from urllib.parse import parse_qs, quote, urlsplit
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import User, cache, current_user, db, guard, settings
from creator import CreatorConnection, CreatorDistribution, CreatorMedia, PROVIDERS, SocialProvider, provider_connection
from storage_services import LocalStorage, storage

router = APIRouter(prefix='/api/social', dependencies=[Depends(current_user)])
BLUESKY_ORIGIN = 'https://public.api.bsky.app'
BLUESKY_METHODS = frozenset({'app.bsky.actor.getProfile', 'app.bsky.feed.getAuthorFeed', 'app.bsky.graph.getFollows'})
MAX_RESPONSE_BYTES = 1024 * 1024
POST_LIMIT = 30
PEOPLE_LIMIT = 50
SYNC_COOLDOWN_SECONDS = 60
TOTAL_SYNC_TIMEOUT_SECONDS = 20
HOSTS = {
    'bluesky': ('bsky.app',), 'facebook': ('facebook.com', 'www.facebook.com', 'm.facebook.com'),
    'instagram': ('instagram.com', 'www.instagram.com'), 'tiktok': ('tiktok.com', 'www.tiktok.com'),
    'twitch': ('twitch.tv', 'www.twitch.tv'), 'youtube': ('youtube.com', 'www.youtube.com'),
}
BASES = {provider: 'https://' + hosts[0] for provider, hosts in HOSTS.items()}
NOTICE = ('Links do not verify account ownership or authorize posting. Bluesky sync reads a limited public profile, '
          'author feed and following list, not private messages or a personalized home feed. Other networks require '
          'supported provider integrations and account authorization. Ziipa never sends invitations automatically.')


class LinkInput(BaseModel):
    handle: str = Field(default='', max_length=253)
    profile_url: str = Field(default='', max_length=500)


def valid_bsky_actor(value: str) -> bool:
    if re.fullmatch(r'did:plc:[a-z2-7]{24}', value):
        return True
    if value.startswith('did:web:'):
        value = value.removeprefix('did:web:')
    return bool(len(value) <= 253 and re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?', value))


def normalized_profile(provider: str, data: LinkInput) -> tuple[str, str]:
    """Normalize only known profile URL shapes, never fetch the supplied URL."""
    raw_url = data.profile_url.strip()
    supplied_handle = data.handle.strip().lstrip('@')
    if not raw_url and supplied_handle.startswith(('https://', 'http://')):
        raw_url, supplied_handle = supplied_handle, ''
    value = supplied_handle
    facebook_id = False
    youtube_channel = False
    if raw_url:
        try:
            parsed = urlsplit(raw_url)
            allowed = (parsed.scheme == 'https' and parsed.hostname in HOSTS[provider] and
                       not parsed.username and not parsed.password and not parsed.port and not parsed.fragment)
        except ValueError:
            allowed = False
        if not allowed or any(c in raw_url for c in ('\\', '\r', '\n', '\t', '%')):
            raise HTTPException(422, 'Use a direct HTTPS profile URL on the selected network, without tracking parameters.')
        path = parsed.path.strip('/')
        if provider == 'facebook' and path == 'profile.php':
            query = parse_qs(parsed.query, strict_parsing=False)
            if set(query) != {'id'} or len(query['id']) != 1 or not re.fullmatch(r'[0-9]{1,30}', query['id'][0]):
                raise HTTPException(422, 'Use the Facebook profile URL with only its numeric id parameter.')
            value, facebook_id = query['id'][0], True
        else:
            if parsed.query:
                raise HTTPException(422, 'Remove tracking parameters from the profile URL.')
            if provider == 'bluesky':
                if not path.startswith('profile/'):
                    raise HTTPException(422, 'Use a Bluesky profile URL, not a post URL.')
                value = path.removeprefix('profile/')
            elif provider == 'youtube' and path.startswith('channel/'):
                value, youtube_channel = path.removeprefix('channel/'), True
            else:
                value = path.lstrip('@')
        if supplied_handle and supplied_handle.lower() != value.lower():
            raise HTTPException(422, 'The handle and profile URL must refer to the same profile.')
    if not value or '/' in value or value != value.strip() or '\\' in value:
        raise HTTPException(422, 'Enter a profile handle or direct profile URL.')
    if provider == 'bluesky':
        value = value.lower()
        if not valid_bsky_actor(value):
            raise HTTPException(422, 'Enter the full Bluesky handle, such as creator.bsky.social.')
        return value, f'https://bsky.app/profile/{quote(value, safe=":")}'
    if provider == 'youtube' and (youtube_channel or value.startswith('UC') and len(value) == 24):
        if not re.fullmatch(r'UC[A-Za-z0-9_-]{22}', value):
            raise HTTPException(422, 'Use a YouTube @handle or channel ID.')
        return value, f'https://youtube.com/channel/{value}'
    patterns = {'facebook': r'[A-Za-z0-9.]{1,100}', 'instagram': r'[A-Za-z0-9_.]{1,30}',
                'tiktok': r'[A-Za-z0-9_.]{1,24}', 'twitch': r'[A-Za-z0-9_]{1,25}',
                'youtube': r'[A-Za-z0-9_.-]{3,30}'}
    if not re.fullmatch(patterns[provider], value):
        raise HTTPException(422, 'This is not a supported profile handle for the selected network.')
    reserved = {'facebook': {'login', 'settings', 'watch', 'reel', 'reels', 'groups', 'share', 'dialog', 'sharer.php'},
                'instagram': {'accounts', 'explore', 'direct', 'p', 'reels', 'reel'},
                'tiktok': {'login', 'search', 'upload'}, 'twitch': {'directory', 'settings', 'login', 'videos'},
                'youtube': {'watch', 'feed', 'playlist', 'results', 'shorts', 'upload'}}
    if value.lower() in reserved[provider]:
        raise HTTPException(422, 'Use a profile URL, not a network tool or content URL.')
    value = value.lower()
    if facebook_id:
        return value, f'https://facebook.com/profile.php?id={value}'
    prefix = '@' if provider in ('tiktok', 'youtube') else ''
    return value, f'{BASES[provider]}/{prefix}{value}'


def serialize_provider(provider: str, row: CreatorConnection | None) -> dict:
    data = row.data if row else {}
    linked = bool(row and data.get('profile_url') and data.get('auth_type') == 'public_profile')
    can_sync = linked and provider == 'bluesky' and settings.social_public_sync_enabled
    snapshot = data.get('snapshot', {}) if linked else {}
    message = ('Public profile linked. Sync imports up to 30 public author posts and 50 followed accounts; '
               'ownership is not verified and posting is not authorized.' if provider == 'bluesky' else
               'Public profile link only. Feed, contacts and publishing require an implemented provider adapter '
               'and authorization; saving this link grants no account access.')
    return {
        'provider': provider, 'name': PROVIDERS[provider][0], 'capability': PROVIDERS[provider][1],
        'status': 'linked' if linked else 'disconnected', 'handle': data.get('handle', '') if linked else '',
        'profile_url': data.get('profile_url', '') if linked else '', 'configured': False,
        'auth_type': 'public_profile' if linked else 'none', 'can_sync': can_sync, 'can_publish': False,
        'capabilities': {'profile_link': True, 'public_feed': provider == 'bluesky' and settings.social_public_sync_enabled,
                         'following': provider == 'bluesky' and settings.social_public_sync_enabled,
                         'private_feed': False, 'publish': False},
        'sync_status': data.get('sync_status', 'never') if provider == 'bluesky' else 'not_available',
        'last_synced_at': data.get('last_synced_at'), 'sync_error': data.get('sync_error'),
        'media_count': len(snapshot.get('media', [])), 'people_count': len(snapshot.get('people', [])),
        'connection_notice': message,
    }


def providers_for(user: User, session: Session) -> list[dict]:
    rows = {r.provider: r for r in session.scalars(select(CreatorConnection).where(CreatorConnection.owner_id == user.id))}
    return [serialize_provider(provider, rows.get(provider)) for provider in PROVIDERS]


def build_hub(user: User, session: Session) -> dict:
    rows = list(session.scalars(select(CreatorConnection).where(CreatorConnection.owner_id == user.id)))
    by_provider = {r.provider: r for r in rows}
    snapshots = [r.data.get('snapshot', {}) for r in rows if r.data.get('auth_type') == 'public_profile']
    media = [item for snapshot in snapshots for item in snapshot.get('media', [])]
    media.sort(key=lambda item: item.get('published_at') or '', reverse=True)
    return {'providers': [serialize_provider(p, by_provider.get(p)) for p in PROVIDERS], 'media': media,
            'people': [person for snapshot in snapshots for person in snapshot.get('people', [])],
            'invite_url': settings.social_invite_url.rstrip('/'), 'notice': NOTICE}


@router.get('/hub')
def hub(user: User = Depends(current_user), session: Session = Depends(db)):
    return build_hub(user, session)


@router.post('/media/{media_id}/export', dependencies=[Depends(guard)])
def export_owned_media(media_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    media = session.get(CreatorMedia, media_id)
    if not media or media.owner_id != user.id:
        raise HTTPException(404, 'Your media file was not found.')
    backend = storage()
    if isinstance(backend, LocalStorage):
        url = f'/api/creator/media/{media.id}'
    else:
        url = backend.read_url(user.id, media.id)
        try:
            parsed = urlsplit(url)
            valid = parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(503, 'Secure media export is not configured.')
    return {'url': url, 'content_type': media.content_type, 'size': media.size}


@router.post('/{provider}/link', dependencies=[Depends(guard)])
def link_profile(provider: SocialProvider, data: LinkInput, user: User = Depends(current_user), session: Session = Depends(db)):
    handle, profile_url = normalized_profile(provider, data)
    row = provider_connection(provider, user, session)
    # Linking the same URL is idempotent; editing an identity removes its old import.
    if not row:
        row = CreatorConnection(owner_id=user.id, provider=provider)
        session.add(row)
    if not row.data or row.data.get('profile_url') != profile_url:
        row.data = {'version': 1, 'revision': str(uuid.uuid4()), 'handle': handle, 'profile_url': profile_url,
                    'auth_type': 'public_profile', 'sync_status': 'never', 'snapshot': {}}
    row.status = 'linked'
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(409, 'This connection changed in another request. Refresh and try again.') from exc
    return serialize_provider(provider, row)


@router.post('/{provider}/connect', dependencies=[Depends(guard)])
def connect_account(provider: SocialProvider):
    """Readiness action, not a fake OAuth handshake or a client-ID-only toggle."""
    return {'status': 'setup_required', 'auth_url': None,
            'detail': (f'This {PROVIDERS[provider][0]} profile link does not grant publishing permission. Use Publishing accounts to authorize supported destinations. '
                       'You can save and open its public profile link' +
                       (' and sync public Bluesky posts and following.' if provider == 'bluesky' else '.')),
            'requirements': ['Open Publishing accounts to check destination-specific readiness',
                             'Registered developer application and required provider permissions',
                             'Approved publishing adapter before automatic cross-posting']}


def disconnect_for(provider: str, user: User, session: Session) -> dict:
    row = provider_connection(provider, user, session)
    if row:
        session.delete(row)
    for job in session.scalars(select(CreatorDistribution).where(CreatorDistribution.owner_id == user.id,
                                                                CreatorDistribution.provider == provider)):
        if job.status not in ('published', 'unsupported_media'):
            job.status, job.detail = 'connection_required', 'Network disconnected. No automatic delivery will run.'
            job.updated_at = datetime.now(timezone.utc)
    session.commit()
    return serialize_provider(provider, None)


@router.post('/{provider}/disconnect', dependencies=[Depends(guard)])
def disconnect(provider: SocialProvider, user: User = Depends(current_user), session: Session = Depends(db)):
    return disconnect_for(provider, user, session)


class SyncFailure(Exception):
    """Only a fixed safe message is persisted or returned, never an upstream body."""


async def bsky_get(client: httpx.AsyncClient, method: str, params: dict) -> dict:
    if method not in BLUESKY_METHODS:
        raise ValueError('Unsupported public Bluesky method')
    try:
        # A URL supplied by the user or by a DID document never becomes a request target.
        async with client.stream('GET', f'{BLUESKY_ORIGIN}/xrpc/{method}', params=params) as response:
            if response.status_code == 429:
                raise SyncFailure('Bluesky is rate limiting requests. Please retry later.')
            if response.status_code in (400, 404):
                raise SyncFailure('The Bluesky profile is unavailable or cannot be read publicly.')
            if response.status_code != 200:
                raise SyncFailure('Bluesky did not complete the public sync. Please retry later.')
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                if len(raw) + len(chunk) > MAX_RESPONSE_BYTES:
                    raise SyncFailure('Bluesky returned more data than this sync can safely import.')
                raw.extend(chunk)
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError('Expected a JSON object')
        return result
    except (httpx.HTTPError, ValueError, UnicodeError) as exc:
        raise SyncFailure('Bluesky could not be reached or returned an invalid response. Please retry later.') from exc


def plain(value, maximum=300) -> str:
    return value[:maximum] if isinstance(value, str) else ''


def image_url(value) -> str | None:
    if not isinstance(value, str) or len(value) > 1500:
        return None
    try:
        url = urlsplit(value)
        if (url.scheme == 'https' and url.hostname in ('cdn.bsky.app', 'video.bsky.app') and
                not url.username and not url.password and not url.port and not url.fragment):
            return value
    except ValueError:
        pass
    return None


def safe_actor(value) -> str:
    return value if isinstance(value, str) and valid_bsky_actor(value) else ''


def normalize_snapshot(profile: dict, feed: dict, follows: dict) -> dict:
    if not safe_actor(profile.get('did')) or not isinstance(feed.get('feed'), list) or not isinstance(follows.get('follows'), list):
        raise SyncFailure('Bluesky returned an incomplete public profile. Please retry later.')
    media, people = [], []
    seen_posts, seen_people = set(), set()
    for entry in feed['feed'][:POST_LIMIT]:
        if not isinstance(entry, dict) or not isinstance(entry.get('post'), dict):
            continue
        post = entry['post']
        author = post.get('author') if isinstance(post.get('author'), dict) else {}
        author_actor = safe_actor(author.get('did'))
        uri = plain(post.get('uri'), 500)
        match = re.fullmatch(r'at://([^/]+)/app\.bsky\.feed\.post/([A-Za-z0-9._~:-]{1,128})', uri)
        if not match or not author_actor or match.group(1) != author_actor or uri in seen_posts:
            continue
        seen_posts.add(uri)
        record = post.get('record') if isinstance(post.get('record'), dict) else {}
        embed = post.get('embed') if isinstance(post.get('embed'), dict) else {}
        if isinstance(embed.get('media'), dict):
            embed = embed['media']
        kind, thumbnail = 'post', None
        if embed.get('$type') == 'app.bsky.embed.video#view':
            kind, thumbnail = 'video', image_url(embed.get('thumbnail'))
        elif isinstance(embed.get('images'), list) and embed['images'] and isinstance(embed['images'][0], dict):
            kind, thumbnail = 'image', image_url(embed['images'][0].get('thumb'))
        text = plain(record.get('text'), 3000)
        media.append({'id': uri, 'provider': 'bluesky', 'title': text[:100] or 'Bluesky post', 'text': text,
                      'url': f'https://bsky.app/profile/{author_actor}/post/{match.group(2)}',
                      'thumbnail_url': thumbnail, 'author': plain(author.get('displayName')) or plain(author.get('handle')),
                      'handle': safe_actor(author.get('handle')) or author_actor,
                      'published_at': plain(record.get('createdAt'), 64) or None, 'kind': kind})
    for person in follows['follows'][:PEOPLE_LIMIT]:
        if not isinstance(person, dict):
            continue
        did = safe_actor(person.get('did'))
        if not did or did in seen_people:
            continue
        seen_people.add(did)
        handle = safe_actor(person.get('handle')) or did
        people.append({'id': did, 'provider': 'bluesky', 'name': plain(person.get('displayName')) or handle,
                       'handle': handle, 'profile_url': f'https://bsky.app/profile/{did}',
                       'avatar_url': image_url(person.get('avatar')), 'relationship': 'following'})
    return {'media': media, 'people': people}


def claim_sync(user_id: int, provider: str):
    key = f'social_sync:{user_id}:{provider}'
    try:
        if not cache.set(key, '1', nx=True, ex=SYNC_COOLDOWN_SECONDS):
            raise HTTPException(429, 'Wait a minute before syncing this network again.',
                                headers={'Retry-After': str(SYNC_COOLDOWN_SECONDS)})
    except RedisError as exc:
        raise HTTPException(503, 'Sync rate limiting is unavailable. Please retry later.') from exc


@router.post('/{provider}/sync', dependencies=[Depends(guard)])
async def sync_profile(provider: SocialProvider, user: User = Depends(current_user), session: Session = Depends(db)):
    row = provider_connection(provider, user, session)
    if not row or row.data.get('auth_type') != 'public_profile':
        raise HTTPException(409, 'Save a public profile link before syncing.')
    if provider != 'bluesky':
        raise HTTPException(409, 'This network is linked for opening only. Its authorized feed integration is not implemented yet.')
    if not settings.social_public_sync_enabled:
        raise HTTPException(503, 'Public network sync is disabled on this Ziipa environment.')
    claim_sync(user.id, provider)
    row_id, revision, user_id = row.id, row.data.get('revision'), user.id
    actor = row.data.get('did') or row.data.get('handle')
    if not safe_actor(actor):
        raise HTTPException(409, 'Re-link this Bluesky profile before syncing.')
    # Do not retain a pooled database connection while waiting on a provider.
    # Identity and revision are rechecked in a fresh transaction before saving.
    session.commit()
    updated, error = {}, None
    try:
        # HTTPX read timeouts limit idle time, not a slow response's total time.
        # This bounds the whole operation, including continuously trickled bytes.
        async with asyncio.timeout(TOTAL_SYNC_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4), follow_redirects=False, trust_env=False,
                                         headers={'Accept': 'application/json', 'User-Agent': 'ZiipaPublicSync/1.0'}) as client:
                profile = await bsky_get(client, 'app.bsky.actor.getProfile', {'actor': actor})
                did = safe_actor(profile.get('did'))
                if not did or not did.startswith('did:'):
                    raise SyncFailure('Bluesky returned an invalid profile identity. Please retry later.')
                feed, follows = await asyncio.gather(
                    bsky_get(client, 'app.bsky.feed.getAuthorFeed', {'actor': did, 'limit': POST_LIMIT, 'filter': 'posts_no_replies'}),
                    bsky_get(client, 'app.bsky.graph.getFollows', {'actor': did, 'limit': PEOPLE_LIMIT}))
                updated = {'did': did, 'display_name': plain(profile.get('displayName')),
                           'snapshot': normalize_snapshot(profile, feed, follows), 'sync_status': 'synced',
                           'last_synced_at': datetime.now(timezone.utc).isoformat(), 'sync_error': None}
    except SyncFailure as exc:
        error = str(exc)
    except TimeoutError:
        error = 'Bluesky sync exceeded its time limit. Please retry later.'
    # Re-read after network I/O: a disconnect, relink, or deletion must not resurrect old data.
    session.expire_all()
    latest = session.scalar(select(CreatorConnection).where(CreatorConnection.id == row_id,
                            CreatorConnection.owner_id == user_id).with_for_update())
    if not latest or latest.data.get('revision') != revision:
        raise HTTPException(409, 'The profile link changed during sync. Refresh your networks.')
    latest.data = {**latest.data, **({'sync_status': 'error', 'sync_error': error} if error else updated)}
    session.commit()
    # Preserve the last successful snapshot on upstream failure and make the stale state explicit.
    return build_hub(user, session)
