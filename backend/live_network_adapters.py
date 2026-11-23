"""Direct YouTube Live and Facebook Page adapters for an approved Go Live.

The caller owns confirmation, grant checks, quotas, relay attachment and durable
reconciliation. Provider IDs must be checkpointed before subsequent writes.
The ingest URL is a secret intended only for the relay. Never log or return it
to the client. Status confirms the provider lifecycle, not audiovisual quality.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re

import httpx


YOUTUBE_LIVE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'
YOUTUBE_LIVE_SCOPES = frozenset({YOUTUBE_LIVE_SCOPE, 'https://www.googleapis.com/auth/youtube'})
GOOGLE_API = 'https://www.googleapis.com/youtube/v3/'
META_API = 'https://graph.facebook.com/'
MAX_JSON_BYTES = 256 * 1024
YOUTUBE_PARTS = 'id,snippet,status,contentDetails'
META_FIELDS = 'id,from,status,broadcast_start_time'
YOUTUBE_END_STATES = frozenset({'complete', 'revoked'})
META_END_STATES = frozenset({'LIVE_STOPPED', 'PROCESSING', 'VOD', 'SCHEDULED_CANCELED', 'SCHEDULED_EXPIRED'})
Checkpoint = Callable[[str | None, str | None], Awaitable[None]]


class LiveNetworkError(RuntimeError):
    """Sanitized provider failure. Uncertain writes require reconciliation."""

    def __init__(self, detail: str, *, uncertain: bool = False):
        super().__init__(detail)
        self.uncertain = uncertain


def _object(value) -> dict:
    return value if isinstance(value, dict) else {}


def youtube_live_granted(tokens: dict) -> bool:
    scope = tokens.get('scope')
    return isinstance(scope, (list, tuple)) and any(
        isinstance(value, str) and value in YOUTUBE_LIVE_SCOPES for value in scope
    )


def _identity(value, pattern: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise LiveNetworkError('The live destination identity could not be verified.')
    return value


def _bearer(value) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'[!-~]{1,16384}', value):
        raise LiveNetworkError('Reconnect this account before starting a live destination.')
    return value


def _google_token(tokens: dict, target_id: str) -> str:
    _identity(target_id, r'UC[A-Za-z0-9_-]{22}')
    if tokens.get('provider') != 'youtube' or not youtube_live_granted(tokens):
        raise LiveNetworkError('Reconnect YouTube and authorize live broadcasting on the selected channel.')
    return _bearer(tokens.get('access_token'))


def _meta_credentials(tokens: dict, target_id: str, settings) -> tuple[str, str, str]:
    from meta_publishing_adapter import required_scopes

    _identity(target_id, r'[1-9][0-9]{0,49}')
    scope = tokens.get('scope')
    scopes = {item for item in scope if isinstance(item, str)} if isinstance(scope, (tuple, list)) else set()
    page = _object(_object(tokens.get('page_tokens')).get(target_id))
    if tokens.get('provider') != 'facebook' or not required_scopes('facebook').issubset(scopes) or page.get('page_id') != target_id:
        raise LiveNetworkError('Reconnect Facebook and select the Page you can manage.')
    version = getattr(settings, 'meta_graph_version', '')
    secret = getattr(settings, 'meta_client_secret', '')
    if not isinstance(secret, str) or not secret or not re.fullmatch(r'v[1-9][0-9]{0,2}\.0', version or ''):
        raise LiveNetworkError('Facebook live has not been configured for this Ziipa server.')
    token = _bearer(page.get('access_token'))
    proof = hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()
    return f'{META_API}{version}/', token, proof


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4), follow_redirects=False, trust_env=False)


async def _json(client, method: str, url: str, token: str, params: dict, *, payload=None, missing_ok=False):
    """Only internally constructed Google/Meta endpoints enter this method."""
    write = method != 'GET'
    body_arg = {'data': payload} if url.startswith(META_API) else {'json': payload}
    try:
        async with asyncio.timeout(10):
            async with client.stream(method, url, params=params,
                                     headers={'Authorization': f'Bearer {token}'}, **body_arg) as response:
                if response.status_code == 404 and missing_ok:
                    return None
                if not 200 <= response.status_code < 300:
                    if response.status_code in (401, 403):
                        raise LiveNetworkError('The network did not authorize this live operation. Check account eligibility and permissions.')
                    if response.status_code == 429:
                        raise LiveNetworkError('The network’s usage limit was reached. Wait before trying again.', uncertain=write)
                    raise LiveNetworkError('The network did not confirm the live operation.',
                                           uncertain=write and (response.status_code >= 500 or response.status_code in (408, 409)))
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > MAX_JSON_BYTES:
                        raise LiveNetworkError('The network returned an unverifiable live response.', uncertain=write)
        value = json.loads(raw) if raw else {}
        if not isinstance(value, dict) or 'error' in value:
            raise LiveNetworkError('The network returned an unverifiable live response.', uncertain=write)
        return value
    except (httpx.HTTPError, TimeoutError, ValueError) as exc:
        raise LiveNetworkError('The network did not confirm the live operation.', uncertain=write) from None


def _youtube_ingest(body: dict) -> str:
    info = _object(_object(body.get('cdn')).get('ingestionInfo'))
    address = info.get('rtmpsIngestionAddress')
    key = info.get('streamName')
    if (not isinstance(address, str) or not re.fullmatch(r'rtmps://a\.rtmps\.youtube\.com(?::443)?/live2/?', address)
            or not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{6,240}', key)):
        raise LiveNetworkError('YouTube did not return an approved secure ingest endpoint.')
    return f'{address.rstrip("/")}/{key}'


def _facebook_ingest(body: dict) -> str:
    value = body.get('secure_stream_url')
    if (not isinstance(value, str) or len(value) > 2048
            or not re.fullmatch(r'rtmps://live-api-s\.facebook\.com(?::443)?/rtmp/[A-Za-z0-9_.~=-]+/?(?:\?[A-Za-z0-9_%.~=&-]+)?', value)):
        raise LiveNetworkError('Facebook did not return an approved secure ingest endpoint.')
    return value


def _owned_youtube_resource(body: dict, target: str, resource_id: str | None = None) -> bool:
    return isinstance(body, dict) and _object(body.get('snippet')).get('channelId') == target and (
        resource_id is None or body.get('id') == resource_id
    )


async def _prepare_youtube(client, tokens, target, title, description, checkpoint) -> dict:
    token = _google_token(tokens, target)
    channels = await _json(client, 'GET', GOOGLE_API + 'channels', token,
                           {'part': 'id', 'mine': 'true', 'maxResults': 2})
    items = channels.get('items')
    if (not isinstance(items, list) or len(items) != 1 or _object(items[0]).get('id') != target
            or channels.get('nextPageToken')):
        raise LiveNetworkError('YouTube returned a different channel. Reconnect the exact channel before going live.')
    stream = await _json(client, 'POST', GOOGLE_API + 'liveStreams', token,
                         {'part': 'id,snippet,cdn,contentDetails'}, payload={
                             'snippet': {'title': title[:100]},
                             'cdn': {'frameRate': 'variable', 'resolution': 'variable', 'ingestionType': 'rtmp'},
                             'contentDetails': {'isReusable': False},
                         })
    stream_id = stream.get('id')
    if not _owned_youtube_resource(stream, target) or not isinstance(stream_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', stream_id):
        raise LiveNetworkError('YouTube created an ingest stream without confirming the selected channel and receipt.', uncertain=True)
    if checkpoint:
        await checkpoint(None, stream_id)
    ingest = _youtube_ingest(stream)
    # Auto-start is driven by encoder input. This resource may appear to viewers
    # as upcoming, so this function is called only after explicit Go Live.
    start_time = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(timespec='seconds')
    broadcast = await _json(client, 'POST', GOOGLE_API + 'liveBroadcasts', token,
                            {'part': YOUTUBE_PARTS}, payload={
                                'snippet': {'title': title[:100], 'description': description, 'scheduledStartTime': start_time},
                                'status': {'privacyStatus': 'public'},
                                'contentDetails': {'enableAutoStart': True, 'enableAutoStop': True,
                                                   'monitorStream': {'enableMonitorStream': False}},
                            })
    event_id = broadcast.get('id')
    if not _owned_youtube_resource(broadcast, target) or not isinstance(event_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{11}', event_id):
        raise LiveNetworkError('YouTube created a broadcast without confirming the selected channel and receipt.', uncertain=True)
    if checkpoint:
        await checkpoint(event_id, stream_id)
    bound = await _json(client, 'POST', GOOGLE_API + 'liveBroadcasts/bind', token,
                        {'part': YOUTUBE_PARTS, 'id': event_id, 'streamId': stream_id})
    details = _object(bound.get('contentDetails'))
    if (not _owned_youtube_resource(bound, target, event_id) or details.get('boundStreamId') != stream_id
            or details.get('enableAutoStart') is not True or details.get('enableAutoStop') is not True
            or _object(bound.get('status')).get('privacyStatus') != 'public'):
        raise LiveNetworkError('YouTube did not confirm the approved broadcast and ingest configuration.', uncertain=True)
    return {'event_id': event_id, 'stream_id': stream_id, 'ingest_url': ingest,
            'playback_url': f'https://www.youtube.com/watch?v={event_id}'}


async def _prepare_facebook(client, tokens, target, title, description, settings, checkpoint) -> dict:
    base, token, proof = _meta_credentials(tokens, target, settings)
    # This is a Page's live event. LIVE_NOW is permitted only after Go Live
    # confirmation. Status reads require a subsequent actual start timestamp.
    result = await _json(client, 'POST', base + target + '/live_videos', token,
                         {'appsecret_proof': proof}, payload={'title': title, 'description': description,
                                                              'status': 'LIVE_NOW', 'stop_on_delete_stream': True})
    event_id = result.get('id')
    if not isinstance(event_id, str) or not re.fullmatch(r'[1-9][0-9]{0,49}', event_id):
        raise LiveNetworkError('Facebook created a broadcast without returning a verifiable receipt.', uncertain=True)
    if checkpoint:
        await checkpoint(event_id, None)
    event = await _facebook_event(client, base, token, proof, target, event_id)
    if event is None or _facebook_state(event) == 'ended':
        raise LiveNetworkError('Facebook did not verify a usable Page broadcast.')
    return {'event_id': event_id, 'stream_id': None, 'ingest_url': _facebook_ingest(result)}


async def prepare(provider: str, tokens: dict, target_id: str, title: str, description: str,
                  *, settings=None, checkpoint: Checkpoint | None = None) -> dict:
    """Create provider resources for one exact approved channel/Page.

    The checkpoint receives `(event_id, stream_id)` immediately after a verified
    create. A stream-only checkpoint has a null event ID. If a write times out,
    retain checkpoints and reconcile any unidentified resource in the provider.
    Never automatically repeat a create. Provider archives follow provider rules.
    """
    async with _client() as client:
        if provider == 'youtube':
            return await _prepare_youtube(client, tokens, target_id, title, description, checkpoint)
        if provider == 'facebook':
            return await _prepare_facebook(client, tokens, target_id, title, description, settings, checkpoint)
    raise LiveNetworkError('This provider does not support managed live broadcasting in Ziipa.')


async def _youtube_event(client, token, target, event_id):
    _identity(event_id, r'[A-Za-z0-9_-]{11}')
    data = await _json(client, 'GET', GOOGLE_API + 'liveBroadcasts', token, {'part': YOUTUBE_PARTS, 'id': event_id})
    items = data.get('items')
    if items == []:
        return None
    if not isinstance(items, list) or len(items) != 1 or not _owned_youtube_resource(items[0], target, event_id):
        raise LiveNetworkError('YouTube could not verify the broadcast belongs to the selected channel.')
    return items[0]


async def _youtube_stream(client, token, target, stream_id):
    _identity(stream_id, r'[A-Za-z0-9_-]{1,128}')
    data = await _json(client, 'GET', GOOGLE_API + 'liveStreams', token,
                       {'part': 'id,snippet,status,contentDetails', 'id': stream_id})
    items = data.get('items')
    if items == []:
        return None
    if not isinstance(items, list) or len(items) != 1 or not _owned_youtube_resource(items[0], target, stream_id):
        raise LiveNetworkError('YouTube could not verify the ingest stream belongs to the selected channel.')
    return items[0]


async def _facebook_event(client, base, token, proof, target, event_id):
    _identity(event_id, r'[1-9][0-9]{0,49}')
    event = await _json(client, 'GET', base + event_id, token,
                        {'fields': META_FIELDS, 'appsecret_proof': proof}, missing_ok=True)
    if event is not None and (event.get('id') != event_id or _object(event.get('from')).get('id') != target):
        raise LiveNetworkError('Facebook could not verify the broadcast belongs to the selected Page.')
    return event


def _facebook_state(event: dict | None) -> str:
    data = _object(event)
    observed = data.get('status')
    if isinstance(observed, str) and observed in META_END_STATES:
        return 'ended'
    if observed == 'LIVE':
        try:
            when = datetime.fromisoformat(data['broadcast_start_time'])
            if when.tzinfo is not None and when <= datetime.now(timezone.utc) + timedelta(seconds=5):
                return 'live'
        except (KeyError, ValueError, TypeError):
            pass
        return 'starting'
    if observed in ('LIVE_NOW', 'UNPUBLISHED', 'SCHEDULED_LIVE', 'SCHEDULED_UNPUBLISHED'):
        return 'starting'
    return 'unknown'


async def status(provider: str, tokens: dict, target_id: str, event_id: str, stream_id: str | None,
                 *, settings=None) -> str:
    """Read authoritative provider status. Missing/foreign evidence is unknown."""
    try:
        async with _client() as client:
            if provider == 'facebook':
                base, token, proof = _meta_credentials(tokens, target_id, settings)
                return _facebook_state(await _facebook_event(client, base, token, proof, target_id, event_id))
            if provider == 'youtube':
                token = _google_token(tokens, target_id)
                event = await _youtube_event(client, token, target_id, event_id)
                observed = _object(_object(event).get('status'))
                lifecycle = observed.get('lifeCycleStatus')
                if isinstance(lifecycle, str) and lifecycle in YOUTUBE_END_STATES:
                    return 'ended'
                if lifecycle == 'live' and stream_id and _object(event.get('contentDetails')).get('boundStreamId') == stream_id:
                    stream = await _youtube_stream(client, token, target_id, stream_id)
                    if observed.get('privacyStatus') == 'public' and _object(_object(stream).get('status')).get('streamStatus') == 'active':
                        return 'live'
                if lifecycle in ('created', 'ready', 'testStarting', 'testing', 'liveStarting'):
                    return 'starting'
    except LiveNetworkError:
        pass
    return 'unknown'


async def _end_youtube(client, token, target, event_id, stream_id) -> None:
    if event_id:
        event = await _youtube_event(client, token, target, event_id)
        if event is not None:
            lifecycle = _object(event.get('status')).get('lifeCycleStatus')
            if lifecycle in ('created', 'ready'):
                # Only delete the unstarted event Ziipa created for this run.
                await _json(client, 'DELETE', GOOGLE_API + 'liveBroadcasts', token, {'id': event_id}, missing_ok=True)
                if await _youtube_event(client, token, target, event_id) is not None:
                    raise LiveNetworkError('YouTube has not confirmed cancellation. Recheck the broadcast in YouTube Studio.', uncertain=True)
            elif lifecycle in ('live', 'testing'):
                try:
                    await _json(client, 'POST', GOOGLE_API + 'liveBroadcasts/transition', token,
                                {'part': 'id,status', 'id': event_id, 'broadcastStatus': 'complete'})
                except LiveNetworkError:
                    # Auto-stop can finish while our completion request is in flight.
                    pass
                latest = await _youtube_event(client, token, target, event_id)
                last_lifecycle = _object(_object(latest).get('status')).get('lifeCycleStatus')
                if not isinstance(last_lifecycle, str) or last_lifecycle not in YOUTUBE_END_STATES:
                    raise LiveNetworkError('YouTube has not confirmed the broadcast ended. Recheck YouTube Studio.', uncertain=True)
            elif not isinstance(lifecycle, str) or lifecycle not in YOUTUBE_END_STATES:
                raise LiveNetworkError('YouTube is still changing broadcast state. Check YouTube Studio and retry End.', uncertain=True)
    if stream_id:
        stream = await _youtube_stream(client, token, target, stream_id)
        if stream is not None:
            if _object(stream.get('contentDetails')).get('isReusable') is not False:
                raise LiveNetworkError('YouTube did not confirm cleanup of the temporary ingest resource.', uncertain=True)
            await _json(client, 'DELETE', GOOGLE_API + 'liveStreams', token, {'id': stream_id}, missing_ok=True)


async def end(provider: str, tokens: dict, target_id: str, event_id: str | None, stream_id: str | None,
              *, settings=None) -> None:
    """Close or cancel only the provider resources checkpointed for this run."""
    async with _client() as client:
        if provider == 'youtube':
            await _end_youtube(client, _google_token(tokens, target_id), target_id, event_id, stream_id)
            return
        if provider == 'facebook' and event_id:
            base, token, proof = _meta_credentials(tokens, target_id, settings)
            event = await _facebook_event(client, base, token, proof, target_id, event_id)
            if event is None or _facebook_state(event) == 'ended':
                return
            try:
                await _json(client, 'POST', base + event_id, token, {'appsecret_proof': proof},
                            payload={'end_live_video': True})
            except LiveNetworkError:
                # The provider may have stopped the feed independently.
                pass
            latest = await _facebook_event(client, base, token, proof, target_id, event_id)
            if latest is not None and _facebook_state(latest) != 'ended':
                raise LiveNetworkError('Facebook has not confirmed the broadcast ended. Check Live Producer and retry End.', uncertain=True)
            return
    raise LiveNetworkError('The provider did not confirm the live destination ended.', uncertain=True)
