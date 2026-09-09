"""TikTok OAuth and server-media Direct Post adapter; transport is injected.

No requests use user-controlled URLs. This module does not store credentials or
send messages; the publishing coordinator owns consent, leases and receipts.
"""
import ipaddress
import json
import math
from fractions import Fraction
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import urlencode, urlsplit

import httpx

TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'
REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/'
USER_URL = 'https://open.tiktokapis.com/v2/user/info/'
CREATOR_URL = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/'
INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/'
STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/'
FIXED_URLS = frozenset((TOKEN_URL, REVOKE_URL, USER_URL, CREATOR_URL, INIT_URL, STATUS_URL))
SCOPES = frozenset(('user.info.basic', 'video.publish'))
MAX_JSON_BYTES = 1024 * 1024
PULL_PATH = '/api/publishing/tiktok/media/'


class TikTokError(Exception):
    def __init__(self, detail, *, uncertain=False, reconnect=False):
        super().__init__(detail)
        self.uncertain, self.reconnect = uncertain, reconnect


def probe_video(body, content_type):
    """Probe verified owned bytes, never a URL; use renderer subprocess limits."""
    from render_services import FORMATS, _run, runtime_paths
    if content_type not in ('video/mp4', 'video/quicktime', 'video/webm') or not 0 < len(body) <= 25 * 1024 * 1024:
        raise TikTokError('Choose an owned MP4, MOV or WebM video up to 25 MB.')
    try:
        _, ffprobe, _ = runtime_paths()
        with tempfile.TemporaryDirectory(prefix='ziipa-tiktok-probe-') as temporary:
            work = Path(temporary)
            (work / 'source.bin').write_bytes(body)
            raw = _run([ffprobe, '-v', 'error', '-max_alloc', '67108864', '-threads', '2',
                        '-protocol_whitelist', 'file', '-f', FORMATS[content_type],
                        '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate',
                        '-of', 'json', 'source.bin'], work, 15)
        result = json.loads(raw)
        duration = float(result['format']['duration'])
        streams = result['streams']
        video = next(stream for stream in streams if stream.get('codec_type') == 'video')
        fps = float(Fraction(video['avg_frame_rate']))
        if (not math.isfinite(duration) or not 0 < duration <= 600 or len(streams) > 16
                or not 360 <= int(video['width']) <= 4096 or not 360 <= int(video['height']) <= 4096
                or video['codec_name'] not in ('h264', 'hevc', 'vp8', 'vp9') or not 23 <= fps <= 60):
            raise ValueError('Unsupported video characteristics')
        return duration
    except Exception as exc:
        raise TikTokError('The actual video must be readable, at most 10 minutes, 360–4096 pixels per side, and 23–60 fps in a supported codec. Ask the operator if ffprobe is unavailable.') from exc


def authorization_url(settings, redirect_uri, state, challenge):
    return 'https://www.tiktok.com/v2/auth/authorize/?' + urlencode({
        'client_key': settings.tiktok_client_key, 'response_type': 'code',
        'scope': ','.join(sorted(SCOPES)), 'redirect_uri': redirect_uri, 'state': state,
        'code_challenge': challenge, 'code_challenge_method': 'S256'})


async def request(client, method, url, **kwargs):
    if url not in FIXED_URLS:
        raise ValueError('TikTok endpoint is not allowlisted')
    try:
        async with client.stream(method, url, **kwargs) as response:
            raw = bytearray()
            async for block in response.aiter_bytes():
                if len(raw) + len(block) > MAX_JSON_BYTES:
                    raise TikTokError('TikTok returned an oversized response.')
                raw.extend(block)
            body = json.loads(raw) if raw else {}
            if not isinstance(body, dict):
                raise ValueError('Expected an object')
            if response.status_code >= 400:
                raise TikTokError('TikTok rejected this request. Check account authorization and provider limits.', reconnect=response.status_code == 401)
            if response.status_code != 200:
                raise TikTokError('TikTok returned an unexpected response; redirects are not followed.')
            error = body.get('error')
            if isinstance(error, dict) and error.get('code') != 'ok':
                raise TikTokError('TikTok did not approve this action. Check creator privacy choices, publishing access and account limits.')
            if isinstance(error, str) and error:
                raise TikTokError('TikTok authorization was not approved.', reconnect=error in ('invalid_grant', 'invalid_token'))
            return body
    except (httpx.HTTPError, ValueError) as exc:
        raise TikTokError('TikTok response could not be verified.') from exc


async def creator_options(tokens, client):
    response = await request(client, 'POST', CREATOR_URL, headers={'Authorization': 'Bearer ' + tokens['access_token']}, json={})
    data = response.get('data', {})
    if not isinstance(data, dict) or not isinstance(data.get('privacy_level_options'), list):
        raise TikTokError('TikTok did not return creator posting options.')
    options = [x for x in data['privacy_level_options'] if x in ('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY')]
    if not options:
        raise TikTokError('This TikTok creator has no available posting privacy options.')
    try:
        maximum_duration = max(0, min(int(data.get('max_video_post_duration_sec', 0)), 86400))
    except (ValueError, TypeError) as exc:
        raise TikTokError('TikTok did not return a verifiable creator duration limit.') from exc
    return {'creator_username': str(data.get('creator_username', ''))[:100],
            'creator_nickname': str(data.get('creator_nickname', ''))[:150], 'privacy_level_options': options,
            'comment_disabled': data.get('comment_disabled') is not False,
            'duet_disabled': data.get('duet_disabled') is not False, 'stitch_disabled': data.get('stitch_disabled') is not False,
            'max_video_post_duration_sec': maximum_duration}


async def exchange(code, redirect_uri, verifier, client, settings):
    response = await request(client, 'POST', TOKEN_URL, data={
        'client_key': settings.tiktok_client_key, 'client_secret': settings.tiktok_client_secret,
        'code': code, 'grant_type': 'authorization_code', 'redirect_uri': redirect_uri, 'code_verifier': verifier})
    scope = set(response.get('scope', '').split(',')) if isinstance(response.get('scope'), str) else set()
    if not SCOPES.issubset(scope) or not isinstance(response.get('access_token'), str) or not isinstance(response.get('open_id'), str):
        raise TikTokError('TikTok did not grant account identity and direct-post permissions.')
    tokens = {'provider': 'tiktok', 'access_token': response['access_token'], 'refresh_token': response.get('refresh_token', ''),
              'open_id': response['open_id'], 'scope': sorted(scope),
              'expires_at': time.time() + min(max(int(response.get('expires_in', 0)), 0), 86400)}
    user = await request(client, 'GET', USER_URL, params={'fields': 'open_id,display_name'}, headers={'Authorization': 'Bearer ' + tokens['access_token']})
    identity = user.get('data', {}).get('user', {})
    if not isinstance(identity, dict) or identity.get('open_id') != tokens['open_id']:
        raise TikTokError('TikTok did not verify this authorized account identity.')
    options = await creator_options(tokens, client)
    username = options['creator_username']
    profile_url = 'https://www.tiktok.com/@' + username if re.fullmatch(r'[A-Za-z0-9_.]{1,24}', username) else 'https://www.tiktok.com/'
    return {'tokens': tokens, 'targets': [{'id': tokens['open_id'], 'name': options['creator_nickname'] or str(identity.get('display_name', 'TikTok account'))[:150],
                                        'kind': 'tiktok_account', 'url': profile_url}]}


async def refresh(tokens, client, settings):
    result = await request(client, 'POST', TOKEN_URL, data={'client_key': settings.tiktok_client_key,
        'client_secret': settings.tiktok_client_secret, 'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token']})
    if not isinstance(result.get('access_token'), str) or result.get('open_id') != tokens.get('open_id'):
        raise TikTokError('TikTok refresh did not match the authorized account.', reconnect=True)
    return {**tokens, 'access_token': result['access_token'], 'refresh_token': result.get('refresh_token') or tokens['refresh_token'],
            'expires_at': time.time() + min(max(int(result.get('expires_in', 0)), 0), 86400)}


def media_origin(settings):
    """Only an operator-verified origin also approved for this Ziipa API."""
    origin = settings.api_origin.rstrip('/')
    verified = {value.strip().rstrip('/') for value in settings.tiktok_verified_media_origins.split(',') if value.strip()}
    approved = {value.strip().rstrip('/') for value in settings.approved_origins.split(',') if value.strip()}
    try:
        parsed = urlsplit(origin)
        allowed = (origin in verified and origin in approved and parsed.scheme == 'https' and parsed.hostname
                   and parsed.hostname not in ('localhost',) and not parsed.hostname.endswith('.localhost')
                   and parsed.port in (None, 443) and not parsed.username and not parsed.password
                   and not parsed.path and not parsed.query and not parsed.fragment)
        try:
            ipaddress.ip_address(parsed.hostname or '')
            allowed = False
        except ValueError:
            pass
    except ValueError:
        allowed = False
    if not allowed:
        raise TikTokError('Verify this Ziipa HTTPS media domain in TikTok Manage URL properties, then configure its exact verified origin.')
    return origin


def pull_url(value, settings):
    origin = media_origin(settings)
    if not isinstance(value, str) or not value.startswith(origin + PULL_PATH):
        raise TikTokError('TikTok requires a verified Ziipa media handoff URL.')
    token = value[len(origin + PULL_PATH):]
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}', token):
        raise TikTokError('The private media handoff URL is invalid.')
    return value


async def publish_prepare(tokens, target_id, source, client, settings, checkpoint):
    if target_id != tokens.get('open_id'):
        raise TikTokError('Select the TikTok account authorized by this grant.')
    choice = source.get('tiktok')
    if not isinstance(choice, dict) or not choice.get('music_usage_confirmed'):
        raise TikTokError('Confirm TikTok music rights and explicitly choose creator posting settings.')
    url = pull_url(source.get('url'), settings)
    options = await creator_options(tokens, client)
    privacy = choice.get('privacy_level')
    if privacy not in options['privacy_level_options'] or not settings.tiktok_public_approved and privacy != 'SELF_ONLY':
        raise TikTokError('Choose an available creator privacy option. This app permits only SELF_ONLY before TikTok audit approval.')
    duration = source.get('duration_seconds', 0)
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0 or duration > options['max_video_post_duration_sec']:
        raise TikTokError('The actual video duration is outside this creator’s current TikTok posting limit.')
    for option, disabled in (('disable_comment', 'comment_disabled'), ('disable_duet', 'duet_disabled'), ('disable_stitch', 'stitch_disabled')):
        if options[disabled] and not choice.get(option):
            raise TikTokError('This creator has disabled an interaction. Refresh TikTok posting options.')
    if choice.get('brand_content_toggle') and privacy == 'SELF_ONLY':
        raise TikTokError('TikTok branded content cannot use private visibility. Public posting also requires app approval.')
    disclosures = bool(choice.get('brand_content_toggle') or choice.get('brand_organic_toggle'))
    if bool(choice.get('content_disclosure_enabled')) != disclosures:
        raise TikTokError('Enable commercial disclosure and choose Your brand, Branded content, or both; otherwise turn disclosure off.')
    if choice.get('brand_content_toggle') and not choice.get('branded_content_policy_confirmed'):
        raise TikTokError('Agree to TikTok’s Branded Content Policy before posting branded content.')
    caption = source['title'] + ('\n' + source['description'] if source['description'] else '')
    if len(caption.encode('utf-16-le')) // 2 > 2200:
        raise TikTokError('Shorten the TikTok title and description to 2,200 characters combined.')
    post_info = {key: choice[key] for key in ('privacy_level', 'disable_comment', 'disable_duet', 'disable_stitch', 'brand_content_toggle', 'brand_organic_toggle', 'is_aigc')}
    post_info['title'] = caption
    await checkpoint({'provider': 'tiktok', 'stage': 'init_started'})
    try:
        response = await request(client, 'POST', INIT_URL, headers={'Authorization': 'Bearer ' + tokens['access_token']},
            json={'post_info': post_info, 'source_info': {'source': 'PULL_FROM_URL', 'video_url': url}})
    except TikTokError as exc:
        raise TikTokError('TikTok initialization outcome is uncertain. Check its publishing history before a new attempt.', uncertain=True) from exc
    data = response.get('data', {})
    publish_id = data.get('publish_id') if isinstance(data, dict) else None
    if not isinstance(publish_id, str) or not re.fullmatch(r'[A-Za-z0-9_.:~\-]{1,64}', publish_id):
        raise TikTokError('TikTok did not return a verifiable publishing ID.', uncertain=True)
    progress = {'provider': 'tiktok', 'stage': 'processing', 'publish_id': publish_id}
    await checkpoint(progress)
    return {'status': 'processing', 'detail': 'TikTok accepted the approved media pull. Downloading and processing can take several minutes.',
            'external_id': publish_id, 'external_url': '', 'provider_data': progress,
            'privacy': 'private' if privacy == 'SELF_ONLY' else 'public' if privacy == 'PUBLIC_TO_EVERYONE' else 'restricted'}


async def poll(tokens, target_id, receipt, client, settings, checkpoint):
    progress = receipt.get('provider_data', {})
    publish_id = progress.get('publish_id') or receipt.get('external_id')
    if target_id != tokens.get('open_id') or not isinstance(publish_id, str):
        raise TikTokError('The TikTok receipt cannot be checked with this account.')
    response = await request(client, 'POST', STATUS_URL, headers={'Authorization': 'Bearer ' + tokens['access_token']}, json={'publish_id': publish_id})
    data = response.get('data', {})
    if not isinstance(data, dict):
        raise TikTokError('TikTok did not return a verifiable publish status.')
    state = data.get('status')
    if state == 'PUBLISH_COMPLETE':
        return {'status': 'delivered', 'detail': 'TikTok confirmed publishing completed with the approved privacy selection.', 'provider_data': {**progress, 'stage': 'complete'}}
    if state == 'FAILED':
        return {'status': 'rejected', 'detail': 'TikTok reported that this publishing attempt failed. No automatic re-upload will run.', 'provider_data': {**progress, 'stage': 'failed'}}
    return {'status': 'processing', 'detail': 'TikTok has not confirmed completion. No repeat upload was started.', 'provider_data': progress}


async def revoke(tokens, client, settings):
    try:
        await request(client, 'POST', REVOKE_URL, data={'client_key': settings.tiktok_client_key,
            'client_secret': settings.tiktok_client_secret, 'token': tokens['access_token']})
        return True
    except (TikTokError, KeyError):
        return False
