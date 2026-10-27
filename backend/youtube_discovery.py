"""Bounded public-channel YouTube metadata, never downloaded audiovisual media.

Three one-unit Data API list calls at most; no search, user OAuth, private feed,
subscription list, pagination, HTML scraping or embedded player. The caller owns
opt-in, account/revision checks, cooldown/quota and expiring/deleting snapshots.
Official references: developers.google.com/youtube/data/reference/rest/v3/
and developers.google.com/youtube/terms/developer-policies (III.E.4).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import re
from urllib.parse import urlsplit

import httpx

API_ORIGIN = 'https://www.googleapis.com/youtube/v3/'
POST_LIMIT = 30
MAX_RESPONSE_BYTES = 512 * 1024
TOTAL_TIMEOUT_SECONDS = 20
VIDEO_ID = re.compile(r'[A-Za-z0-9_-]{11}', re.ASCII)
CHANNEL_ID = re.compile(r'UC[A-Za-z0-9_-]{22}', re.ASCII)
HANDLE = re.compile(r'[A-Za-z0-9_.-]{3,30}', re.ASCII)
PLAYLIST_ID = re.compile(r'[A-Za-z0-9_-]{10,100}', re.ASCII)
THUMBNAIL_FILES = frozenset(('default.jpg', 'mqdefault.jpg', 'hqdefault.jpg', 'sddefault.jpg', 'maxresdefault.jpg'))


class YouTubeSyncFailure(Exception):
    """Only fixed safe messages escape the adapter, never keys/upstream bodies."""

    def __init__(self, message: str, *, discard_snapshot: bool = False):
        super().__init__(message)
        self.discard_snapshot = discard_snapshot


def channel_filter(identity: str) -> dict[str, str]:
    if not isinstance(identity, str):
        raise YouTubeSyncFailure('Re-link a valid YouTube channel ID or @handle before syncing.')
    value = identity.strip()
    if CHANNEL_ID.fullmatch(value):
        return {'id': value}
    value = value.removeprefix('@')
    if not HANDLE.fullmatch(value):
        raise YouTubeSyncFailure('Re-link a valid YouTube channel ID or @handle before syncing.')
    return {'forHandle': value}


def thumbnail_url(value, video_id: str) -> str | None:
    if not isinstance(value, str) or len(value) > 400 or not VIDEO_ID.fullmatch(video_id):
        return None
    try:
        parsed = urlsplit(value)
        prefix = '/vi/' + video_id + '/'
        if (parsed.scheme == 'https' and parsed.netloc == 'i.ytimg.com'
                and not parsed.query and not parsed.fragment and parsed.path.startswith(prefix)
                and parsed.path.removeprefix(prefix) in THUMBNAIL_FILES):
            return value
    except ValueError:
        pass
    return None


def video_thumbnail(thumbnails, video_id):
    if not isinstance(thumbnails, dict):
        return None
    for name in ('high', 'medium', 'standard', 'default', 'maxres'):
        item = thumbnails.get(name)
        candidate = thumbnail_url(item.get('url'), video_id) if isinstance(item, dict) else None
        if candidate:
            return candidate
    return None


def published_at(value):
    if not isinstance(value, str) or not 10 <= len(value) <= 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is not None:
            return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, OverflowError):
        pass
    return None


async def youtube_get(client: httpx.AsyncClient, method: str, params: dict, api_key: str) -> dict:
    if method not in ('channels', 'playlistItems', 'videos'):
        raise ValueError('Unsupported YouTube list method')
    # A fresh request avoids inherited cookies, user bearer tokens or a client
    # base URL. Google documents X-Goog-Api-Key as its key system parameter.
    request = httpx.Request('GET', API_ORIGIN + method, params=params,
                            headers={'Accept': 'application/json', 'X-Goog-Api-Key': api_key})
    response = None
    try:
        response = await client.send(request, stream=True, auth=None, follow_redirects=False)
        if response.status_code in (400, 404):
            raise YouTubeSyncFailure('The YouTube channel or public uploads are unavailable.',
                                     discard_snapshot=method in ('channels', 'playlistItems'))
        if response.status_code in (401, 403, 429):
            raise YouTubeSyncFailure('YouTube public imports are unavailable because of server configuration or quota. Try again later.')
        if response.status_code != 200:
            raise YouTubeSyncFailure('YouTube did not complete the public sync. Try again later.')
        if response.headers.get('content-type', '').split(';')[0].lower() != 'application/json':
            raise ValueError('Expected JSON metadata')
        raw = bytearray()
        async for chunk in response.aiter_bytes():
            if len(raw) + len(chunk) > MAX_RESPONSE_BYTES:
                raise YouTubeSyncFailure('YouTube returned more metadata than this sync can safely import.')
            raw.extend(chunk)
        result = json.loads(raw)
        if not isinstance(result, dict) or not isinstance(result.get('items'), list):
            raise ValueError('Expected a resource list')
        return result
    except (httpx.HTTPError, ValueError, UnicodeError):
        raise YouTubeSyncFailure('YouTube could not be reached or returned invalid metadata. Try again later.') from None
    finally:
        if response is not None:
            try:
                await response.aclose()
            except httpx.HTTPError:
                raise YouTubeSyncFailure('YouTube could not complete its metadata response. Try again later.') from None


def channel_data(response, selected):
    items = response['items']
    if not items:
        raise YouTubeSyncFailure('The YouTube channel or public uploads are unavailable.', discard_snapshot=True)
    if len(items) != 1 or not isinstance(items[0], dict):
        raise YouTubeSyncFailure('YouTube returned an incomplete channel identity. Re-link the channel.')
    item = items[0]
    identifier = item.get('id')
    if not isinstance(identifier, str) or not CHANNEL_ID.fullmatch(identifier) or selected.get('id', identifier) != identifier:
        raise YouTubeSyncFailure('YouTube returned a different channel identity. Re-link the channel.')
    details = item.get('contentDetails') if isinstance(item.get('contentDetails'), dict) else {}
    playlists = details.get('relatedPlaylists') if isinstance(details.get('relatedPlaylists'), dict) else {}
    uploads = playlists.get('uploads')
    if not isinstance(uploads, str) or not PLAYLIST_ID.fullmatch(uploads):
        raise YouTubeSyncFailure('YouTube returned no readable public uploads playlist.', discard_snapshot=True)
    snippet = item.get('snippet') if isinstance(item.get('snippet'), dict) else {}
    title = snippet.get('title')
    return identifier, uploads, title[:100] if isinstance(title, str) else 'YouTube channel'


def playlist_video_ids(response):
    if len(response['items']) > POST_LIMIT:
        raise YouTubeSyncFailure('YouTube returned too many public playlist entries.')
    result = []
    for item in response['items']:
        if not isinstance(item, dict):
            continue
        details = item.get('contentDetails') if isinstance(item.get('contentDetails'), dict) else {}
        snippet = item.get('snippet') if isinstance(item.get('snippet'), dict) else {}
        resource = snippet.get('resourceId') if isinstance(snippet.get('resourceId'), dict) else {}
        identifier = details.get('videoId')
        if (isinstance(identifier, str) and VIDEO_ID.fullmatch(identifier)
                and resource.get('videoId', identifier) == identifier
                and resource.get('kind', 'youtube#video') == 'youtube#video' and identifier not in result):
            result.append(identifier)
    return result


def public_videos(response, identifiers, channel_id, display_name):
    if len(response['items']) > POST_LIMIT:
        raise YouTubeSyncFailure('YouTube returned too many video records.')
    result = {}
    for item in response['items']:
        if not isinstance(item, dict):
            continue
        identifier = item.get('id')
        if not isinstance(identifier, str) or identifier not in identifiers or identifier in result:
            continue
        snippet = item.get('snippet') if isinstance(item.get('snippet'), dict) else {}
        status = item.get('status') if isinstance(item.get('status'), dict) else {}
        # Playlist records alone are never proof of public playback. This fresh
        # status check removes private/unlisted/deleted/rejected/missing videos.
        if (snippet.get('channelId') != channel_id or status.get('privacyStatus') != 'public'
                or status.get('uploadStatus') != 'processed'):
            continue
        title, description = snippet.get('title'), snippet.get('description')
        moment = published_at(snippet.get('publishedAt'))
        if not isinstance(title, str) or not title.strip() or not moment:
            continue
        result[identifier] = {'id': identifier, 'provider': 'youtube', 'title': title[:100],
                              'text': description[:3000] if isinstance(description, str) else '',
                              'url': 'https://www.youtube.com/watch?v=' + identifier,
                              'thumbnail_url': video_thumbnail(snippet.get('thumbnails'), identifier),
                              'author': display_name, 'handle': channel_id, 'published_at': moment, 'kind': 'video'}
    return [result[identifier] for identifier in identifiers if identifier in result]


async def fetch_youtube_snapshot(client: httpx.AsyncClient, identity: str, api_key: str) -> dict:
    """Read at most30 public uploaded video records, with an explicit server key.

    No setting/environment is read here. Returned data never contains the key,
    OAuth tokens, source media files, arbitrary upstream URLs or subscriptions.
    A successful return replaces the entire old snapshot, including with [].
    """
    selected = channel_filter(identity)
    if not isinstance(api_key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,200}', api_key, re.ASCII):
        raise YouTubeSyncFailure('YouTube public imports need a configured server API key.')
    try:
        async with asyncio.timeout(TOTAL_TIMEOUT_SECONDS):
            channel = await youtube_get(client, 'channels', {'part': 'snippet,contentDetails',
                'fields': 'items(id,snippet(title),contentDetails(relatedPlaylists(uploads)))', **selected}, api_key)
            channel_id, uploads, name = channel_data(channel, selected)
            playlist = await youtube_get(client, 'playlistItems', {'part': 'contentDetails,snippet',
                'playlistId': uploads, 'maxResults': POST_LIMIT,
                'fields': 'items(contentDetails(videoId),snippet(resourceId(kind,videoId)))'}, api_key)
            identifiers = playlist_video_ids(playlist)
            videos = await youtube_get(client, 'videos', {'part': 'snippet,status', 'id': ','.join(identifiers),
                'fields': 'items(id,snippet(channelId,title,description,publishedAt,thumbnails),status(privacyStatus,uploadStatus))'}, api_key) if identifiers else {'items': []}
            return {'channel_id': channel_id, 'display_name': name,
                    'profile_url': 'https://www.youtube.com/channel/' + channel_id,
                    'snapshot': {'media': public_videos(videos, identifiers, channel_id, name), 'people': []}}
    except TimeoutError:
        raise YouTubeSyncFailure('YouTube public sync exceeded its time limit. Try again later.') from None
