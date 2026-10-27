"""Bounded read-only Meta/TikTok imports; account binding lives in social_read_imports.

No scraping, private feeds, media downloads, publishing, or caller-supplied URLs.
"""
import asyncio
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import re
import time
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx

MAX_JSON_BYTES = 1024 * 1024
MAX_TARGETS = 20
MAX_POSTS = 20
TIKTOK_ORIGIN = 'https://open.tiktokapis.com'
TIKTOK_SCOPES = frozenset(('user.info.basic', 'video.list'))
META_SCOPES = {'facebook': frozenset(('pages_show_list', 'pages_read_engagement')),
               'instagram': frozenset(('pages_show_list', 'pages_read_engagement', 'instagram_basic'))}
IDENTIFIER = re.compile(r'[1-9][0-9]{0,49}\Z')


class ReadFailure(Exception):
    def __init__(self, detail, *, discard_snapshot=False, reconnect=False):
        super().__init__(detail)
        self.discard_snapshot = discard_snapshot
        self.reconnect = reconnect


def plain(value, maximum=300):
    return ''.join(c for c in value if c.isprintable())[:maximum] if isinstance(value, str) else ''


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ReadFailure('The provider did not return a verifiable account identity.', discard_snapshot=True)
    return value


def token(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 16384 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ReadFailure('Read authorization could not be verified. Reconnect this account.', discard_snapshot=True, reconnect=True)
    return value


def lifetime(value, maximum=86400):
    try:
        result = float(value)
        if not math.isfinite(result) or not 0 < result <= maximum:
            raise ValueError()
        return result
    except (TypeError, ValueError, OverflowError):
        raise ReadFailure('The provider did not return a valid authorization lifetime.', discard_snapshot=True, reconnect=True) from None


def scopes(provider):
    return TIKTOK_SCOPES if provider == 'tiktok' else META_SCOPES[provider]


def meta_url(config, path):
    if not re.fullmatch(r'v[1-9][0-9]{0,2}\.0', config.meta_graph_version or ''):
        raise ReadFailure('Configure an explicitly supported Meta Graph version before importing.')
    if not re.fullmatch(r'(?:oauth/access_token|me(?:/accounts|/permissions)?|[1-9][0-9]{0,49}(?:/posts|/media)?)', path):
        raise ReadFailure('The Meta read endpoint is not permitted.')
    return f'https://graph.facebook.com/{config.meta_graph_version}/{path}'


def meta_auth(value, config, params=None):
    value = token(value)
    return {'headers': {'Authorization': 'Bearer ' + value}, 'params': {
        **(params or {}), 'appsecret_proof': hmac.new(config.meta_client_secret.encode(), value.encode(), hashlib.sha256).hexdigest()}}


async def request_json(client, method, url, **kwargs):
    parsed = urlsplit(url)
    permitted = ((method == 'POST' and parsed.path in ('/v2/oauth/token/', '/v2/video/list/')) or
                 (method == 'GET' and parsed.path == '/v2/user/info/')) if parsed.hostname == 'open.tiktokapis.com' else (
        parsed.hostname == 'graph.facebook.com' and (
            method == 'POST' and re.fullmatch(r'/v[1-9][0-9]{0,2}\.0/oauth/access_token', parsed.path) or
            method == 'GET' and re.fullmatch(r'/v[1-9][0-9]{0,2}\.0/(?:me(?:/permissions|/accounts)?|[1-9][0-9]{0,49}(?:/posts|/media)?)', parsed.path)))
    if not permitted or parsed.scheme != 'https' or parsed.netloc != parsed.hostname or parsed.query or parsed.fragment:
        raise ReadFailure('The provider read endpoint is not permitted.')
    try:
        # Build an independent request: never inherit another account's client
        # Authorization, cookie jar, default params or redirect behavior.
        request = httpx.Request(method, url, **kwargs)
        response = await client.send(request, auth=None, follow_redirects=False, stream=True)
        try:
            if response.status_code in (401, 403):
                raise ReadFailure('Read authorization expired or was withdrawn. Reconnect this account.', discard_snapshot=True, reconnect=True)
            if response.status_code == 429:
                raise ReadFailure('The provider is rate limiting imports. Retry later.')
            if response.status_code != 200:
                raise ReadFailure('The provider could not complete this import. Retry later.')
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                if len(raw) + len(chunk) > MAX_JSON_BYTES:
                    raise ReadFailure('The provider returned more metadata than this import permits.')
                raw.extend(chunk)
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError()
            error = result.get('error')
            if error and not (isinstance(error, dict) and error.get('code') == 'ok'):
                withdrawn = isinstance(error, dict) and error.get('code') in (102, 190, 'access_token_invalid', 'scope_not_authorized')
                raise ReadFailure('The provider did not approve this read. Check permissions and retry.', discard_snapshot=withdrawn, reconnect=withdrawn)
            return result
        finally:
            await response.aclose()
    except (httpx.HTTPError, ValueError, UnicodeError):
        raise ReadFailure('The provider response could not be verified. Retry later.') from None


def authorization_url(provider, config, redirect_uri, state, challenge):
    if provider == 'tiktok':
        return 'https://www.tiktok.com/v2/auth/authorize/?' + urlencode({
            'client_key': config.tiktok_client_key, 'response_type': 'code', 'scope': ','.join(sorted(scopes(provider))),
            'redirect_uri': redirect_uri, 'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'})
    return f'https://www.facebook.com/{config.meta_graph_version}/dialog/oauth?' + urlencode({
        'client_id': config.meta_client_id, 'response_type': 'code', 'scope': ','.join(sorted(scopes(provider))),
        'redirect_uri': redirect_uri, 'state': state, 'auth_type': 'rerequest'})


async def meta_targets(client, provider, access, config):
    fields = 'id,name,access_token,tasks,is_published'
    if provider == 'instagram':
        fields += ',instagram_business_account{id,username}'
    body = await request_json(client, 'GET', meta_url(config, 'me/accounts'), **meta_auth(access, config, {'fields': fields, 'limit': MAX_TARGETS}))
    if not isinstance(body.get('data'), list):
        raise ReadFailure('Meta did not return eligible managed accounts.', discard_snapshot=True)
    targets, credentials = [], {}
    for row in body['data'][:MAX_TARGETS]:
        if not isinstance(row, dict) or row.get('is_published') is not True:
            continue
        try:
            page = identifier(row.get('id'))
            page_token = token(row.get('access_token'))
            if provider == 'instagram':
                account = row.get('instagram_business_account')
                selected = identifier(account.get('id') if isinstance(account, dict) else None)
                handle = account.get('username')
                if not isinstance(handle, str) or not re.fullmatch(r'[A-Za-z0-9_.]{1,30}', handle):
                    continue
                name, kind, url = handle, 'instagram_professional', f'https://www.instagram.com/{handle}/'
            else:
                selected, name, kind, url = page, plain(row.get('name'), 150), 'facebook_page', 'https://www.facebook.com/' + page
            if selected not in credentials:
                targets.append({'id': selected, 'name': name or 'Managed account', 'kind': kind, 'url': url})
                credentials[selected] = {'page_id': page, 'access_token': page_token}
        except ReadFailure:
            continue
    if not targets:
        raise ReadFailure('No published managed Page or linked professional Instagram account was returned.', discard_snapshot=True)
    return targets, credentials


async def exchange(provider, code, redirect_uri, verifier, client, config):
    if provider == 'tiktok':
        body = await request_json(client, 'POST', TIKTOK_ORIGIN + '/v2/oauth/token/', data={
            'client_key': config.tiktok_client_key, 'client_secret': config.tiktok_client_secret,
            'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect_uri, 'code_verifier': verifier})
        granted = set(body.get('scope', '').split(',')) if isinstance(body.get('scope'), str) else set()
        if not scopes(provider).issubset(granted):
            raise ReadFailure('Approve TikTok basic identity and public video-list read permissions.', discard_snapshot=True, reconnect=True)
        access, subject = token(body.get('access_token')), token(body.get('open_id'))
        if len(subject) > 100:
            raise ReadFailure('TikTok did not return a supported account identifier.', discard_snapshot=True)
        data = await request_json(client, 'GET', TIKTOK_ORIGIN + '/v2/user/info/',
            headers={'Authorization': 'Bearer ' + access}, params={'fields': 'open_id,display_name'})
        user = data.get('data', {}).get('user') if isinstance(data.get('data'), dict) else None
        if not isinstance(user, dict) or user.get('open_id') != subject:
            raise ReadFailure('TikTok account ownership could not be verified.', discard_snapshot=True)
        tokens = {'access_token': access, 'subject': subject, 'scope': sorted(scopes(provider)),
            'expires_at': time.time() + lifetime(body.get('expires_in')), 'refresh_token': body.get('refresh_token') or ''}
        if tokens['refresh_token']:
            token(tokens['refresh_token'])
            tokens['refresh_expires_at'] = time.time() + lifetime(body.get('refresh_expires_in'), 366 * 86400)
        return {'tokens': tokens, 'targets': [{'id': subject, 'name': plain(user.get('display_name'), 150) or 'TikTok account',
            'kind': 'tiktok_account', 'url': 'https://www.tiktok.com/'}]}
    body = await request_json(client, 'POST', meta_url(config, 'oauth/access_token'), data={
        'client_id': config.meta_client_id, 'client_secret': config.meta_client_secret,
        'redirect_uri': redirect_uri, 'code': code})
    access = token(body.get('access_token'))
    body = await request_json(client, 'POST', meta_url(config, 'oauth/access_token'), data={
        'client_id': config.meta_client_id, 'client_secret': config.meta_client_secret,
        'grant_type': 'fb_exchange_token', 'fb_exchange_token': access})
    access = token(body.get('access_token'))
    expiry = time.time() + lifetime(body.get('expires_in'), 366 * 86400)
    permissions = await request_json(client, 'GET', meta_url(config, 'me/permissions'), **meta_auth(access, config))
    granted = {row.get('permission') for row in permissions.get('data', []) if isinstance(row, dict)
               and row.get('status') == 'granted' and isinstance(row.get('permission'), str)}
    if not scopes(provider).issubset(granted):
        raise ReadFailure('The required managed-account read permissions were not approved.', discard_snapshot=True, reconnect=True)
    owner = await request_json(client, 'GET', meta_url(config, 'me'), **meta_auth(access, config, {'fields': 'id'}))
    subject = identifier(owner.get('id'))
    targets, page_tokens = await meta_targets(client, provider, access, config)
    return {'tokens': {'access_token': access, 'subject': subject, 'scope': sorted(scopes(provider)),
                      'expires_at': expiry, 'page_tokens': page_tokens}, 'targets': targets}


def thumbnail(provider, value):
    if not isinstance(value, str) or len(value) > 1500:
        return None
    try:
        url = urlsplit(value)
        suffixes = ('tiktokcdn.com', 'tiktokcdn-us.com') if provider == 'tiktok' else ('fbcdn.net', 'cdninstagram.com')
        host = url.hostname or ''
        if (url.scheme == 'https' and not url.username and not url.password and not url.port and not url.fragment
                and any(host == suffix or host.endswith('.' + suffix) for suffix in suffixes)
                and not any(key.lower() in ('access_token', 'refresh_token', 'client_secret', 'authorization') for key, _ in parse_qsl(url.query))):
            return value
    except ValueError:
        pass
    return None


def tiktok_post_url(value, video_id):
    if not isinstance(value, str) or len(value) > 1500:
        return None
    try:
        url = urlsplit(value)
        match = re.fullmatch(r'/@([A-Za-z0-9_.]{1,24})/video/([1-9][0-9]{0,49})/?', url.path)
        if url.scheme == 'https' and url.netloc in ('www.tiktok.com', 'tiktok.com') and not url.fragment and match and match[2] == video_id:
            return f'https://www.tiktok.com/@{match[1]}/video/{video_id}', match[1]
    except ValueError:
        pass
    return None


async def fetch_snapshot(provider, tokens, target, client, config):
    if not scopes(provider).issubset(set(tokens.get('scope', []))):
        raise ReadFailure('Required public import permissions are missing. Reconnect.', discard_snapshot=True, reconnect=True)
    access = token(tokens.get('access_token'))
    if tokens.get('expires_at', 0) <= time.time() + 60:
        if provider != 'tiktok' or not tokens.get('refresh_token') or tokens.get('refresh_expires_at', 0) <= time.time() + 60:
            raise ReadFailure('Read authorization expired. Reconnect this account.', discard_snapshot=True, reconnect=True)
        body = await request_json(client, 'POST', TIKTOK_ORIGIN + '/v2/oauth/token/', data={
            'client_key': config.tiktok_client_key, 'client_secret': config.tiktok_client_secret,
            'grant_type': 'refresh_token', 'refresh_token': token(tokens['refresh_token'])})
        granted = set(body.get('scope', '').split(',')) if isinstance(body.get('scope'), str) else set()
        if body.get('open_id') != tokens.get('subject') or not scopes(provider).issubset(granted):
            raise ReadFailure('TikTok refresh did not preserve this account and its read permissions.', discard_snapshot=True, reconnect=True)
        access = token(body.get('access_token'))
        tokens = {**tokens, 'access_token': access, 'refresh_token': token(body.get('refresh_token') or tokens['refresh_token']),
            'expires_at': time.time() + lifetime(body.get('expires_in')), 'scope': sorted(scopes(provider))}
    media, targets = [], [target]
    if provider == 'tiktok':
        data = await request_json(client, 'GET', TIKTOK_ORIGIN + '/v2/user/info/',
            headers={'Authorization': 'Bearer ' + access}, params={'fields': 'open_id,display_name'})
        user = data.get('data', {}).get('user') if isinstance(data.get('data'), dict) else None
        if not isinstance(user, dict) or user.get('open_id') != tokens.get('subject') or target['id'] != tokens['subject']:
            raise ReadFailure('TikTok no longer verifies the selected account.', discard_snapshot=True, reconnect=True)
        targets = [{**target, 'name': plain(user.get('display_name'), 150) or 'TikTok account'}]
        body = await request_json(client, 'POST', TIKTOK_ORIGIN + '/v2/video/list/',
            headers={'Authorization': 'Bearer ' + access}, params={'fields': 'id,title,video_description,cover_image_url,share_url,create_time'},
            json={'max_count': MAX_POSTS})
        videos = body.get('data', {}).get('videos') if isinstance(body.get('data'), dict) else None
        if not isinstance(videos, list):
            raise ReadFailure('TikTok did not return a verifiable public video list.')
        for row in videos[:MAX_POSTS]:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not IDENTIFIER.fullmatch(row['id']):
                continue
            if row.get('privacy_level') not in (None, 'PUBLIC_TO_EVERYONE'):
                continue
            link = tiktok_post_url(row.get('share_url'), row['id'])
            if not link:
                continue
            try:
                timestamp = datetime.fromtimestamp(float(row.get('create_time')), timezone.utc).isoformat()
            except (ValueError, TypeError, OverflowError, OSError):
                timestamp = None
            media.append({'id': row['id'], 'provider': provider, 'title': plain(row.get('title'), 100) or 'TikTok video',
                'text': plain(row.get('video_description'), 3000), 'url': link[0], 'handle': link[1],
                'author': plain(user.get('display_name')), 'thumbnail_url': thumbnail(provider, row.get('cover_image_url')),
                'published_at': timestamp, 'kind': 'video'})
    else:
        # A fresh managed-account enumeration verifies consent and roles on every
        # sync. Never trust a stale Page token or an arbitrary target identifier.
        targets, credentials = await meta_targets(client, provider, access, config)
        current = next((row for row in targets if row['id'] == target['id']), None)
        if current is None:
            raise ReadFailure('The selected managed account is no longer available.', discard_snapshot=True, reconnect=True)
        tokens = {**tokens, 'page_tokens': credentials}
        page = credentials[target['id']]
        fields = ('id,caption,media_type,media_url,thumbnail_url,permalink,timestamp' if provider == 'instagram' else
            'id,message,created_time,is_published,is_hidden,is_expired,privacy,from,full_picture')
        body = await request_json(client, 'GET', meta_url(config, target['id'] + ('/media' if provider == 'instagram' else '/posts')),
            **meta_auth(page['access_token'], config, {'fields': fields, 'limit': MAX_POSTS}))
        if not isinstance(body.get('data'), list):
            raise ReadFailure('Meta did not return a verifiable public media list.')
        for row in body['data'][:MAX_POSTS]:
            if not isinstance(row, dict):
                continue
            if provider == 'instagram':
                try:
                    post_id = identifier(row.get('id'))
                    url = urlsplit(row.get('permalink', ''))
                except (ReadFailure, ValueError, TypeError):
                    continue
                if (url.scheme != 'https' or url.netloc not in ('www.instagram.com', 'instagram.com') or url.query or url.fragment
                        or not re.fullmatch(r'/(?:p|reel)/[A-Za-z0-9_-]{1,100}/?', url.path)
                        or row.get('media_type') not in ('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM')):
                    continue
                link, text, kind, picture, stamp = ('https://www.instagram.com' + url.path.rstrip('/') + '/',
                    row.get('caption'), 'video' if row.get('media_type') == 'VIDEO' else 'image',
                    row.get('media_url') if row.get('media_type') == 'IMAGE' else row.get('thumbnail_url'), row.get('timestamp'))
            else:
                match = re.fullmatch(re.escape(target['id']) + r'_([1-9][0-9]{0,49})', row.get('id', '')) if isinstance(row.get('id'), str) else None
                privacy = row.get('privacy')
                author = row.get('from')
                if (not match or row.get('is_published') is not True or row.get('is_hidden') is not False or row.get('is_expired') is not False
                        or not isinstance(privacy, dict) or privacy.get('value') != 'EVERYONE'
                        or not isinstance(author, dict) or author.get('id') != target['id']):
                    continue
                post_id, link, text, kind, picture, stamp = (row['id'], f'https://www.facebook.com/{target["id"]}/posts/{match[1]}',
                    row.get('message'), 'post', row.get('full_picture'), row.get('created_time'))
            media.append({'id': post_id, 'provider': provider, 'title': plain(text, 100) or 'Public account post',
                'text': plain(text, 3000), 'url': link, 'thumbnail_url': thumbnail(provider, picture), 'author': current['name'],
                'handle': current['name'], 'published_at': plain(stamp, 64) or None, 'kind': kind})
    # Complete bounded replacement: absence/private/deletion is a tombstone, not
    # an append that leaves old withdrawn metadata visible indefinitely.
    return {'tokens': tokens, 'snapshot': {'media': list({row['id']: row for row in media}.values()), 'people': []}, 'targets': targets}
