"""Official Twitch OAuth and broadcaster controls, not arbitrary video uploads.

The caller owns encryption, consent, owner checks and token refresh coordination.
Every authenticated operation validates client, broadcaster and granted scopes.
"""
import asyncio
import json
import re
import time
from urllib.parse import urlencode

import httpx

TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke'
USERS_URL = 'https://api.twitch.tv/helix/users'
CHANNELS_URL = 'https://api.twitch.tv/helix/channels'
STREAMS_URL = 'https://api.twitch.tv/helix/streams'
KEY_URL = 'https://api.twitch.tv/helix/streams/key'
FOLLOWS_URL = 'https://api.twitch.tv/helix/channels/followed'
SCOPES = frozenset(('channel:manage:broadcast', 'channel:read:stream_key', 'user:read:follows'))
URLS = frozenset((TOKEN_URL, VALIDATE_URL, REVOKE_URL, USERS_URL, CHANNELS_URL, STREAMS_URL, KEY_URL, FOLLOWS_URL))


class TwitchError(Exception):
    def __init__(self, detail, *, reconnect=False, uncertain=False):
        super().__init__(detail)
        self.reconnect, self.uncertain = reconnect, uncertain


def authorization_url(settings, redirect_uri, state):
    return 'https://id.twitch.tv/oauth2/authorize?' + urlencode({'client_id': settings.twitch_client_id,
        'redirect_uri': redirect_uri, 'response_type': 'code', 'scope': ' '.join(sorted(SCOPES)),
        'state': state, 'force_verify': 'true'})


async def request(client, method, url, **kwargs):
    if url not in URLS:
        raise TwitchError('The Twitch endpoint is not permitted.')
    try:
        async with asyncio.timeout(15), client.stream(method, url, follow_redirects=False, **kwargs) as response:
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                if len(raw) + len(chunk) > 1024 * 1024:
                    raise TwitchError('Twitch returned an oversized response.')
                raw.extend(chunk)
            body = json.loads(raw) if raw else {}
            if not isinstance(body, dict):
                raise TwitchError('Twitch returned an unverifiable response.')
            if not 200 <= response.status_code < 300:
                raise TwitchError('Twitch could not complete this request. Check authorization and broadcaster eligibility.',
                    reconnect=response.status_code in (401, 403), uncertain=method == 'PATCH' and response.status_code >= 500)
            return body
    except (httpx.HTTPError, TimeoutError, ValueError) as exc:
        raise TwitchError('The Twitch response could not be verified. No automatic repeat will run.', uncertain=method == 'PATCH') from exc


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,29}', value):
        raise TwitchError('Twitch did not return a verifiable broadcaster identity.', reconnect=True)
    return value


def headers(tokens, settings):
    token = tokens.get('access_token')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,4096}', token):
        raise TwitchError('Twitch authorization is invalid.', reconnect=True)
    return {'Authorization': 'Bearer ' + token, 'Client-Id': settings.twitch_client_id}


async def validate(tokens, target_id, client, settings):
    identifier(target_id)
    body = await request(client, 'GET', VALIDATE_URL, headers={'Authorization': 'OAuth ' + tokens['access_token']})
    if (body.get('client_id') != settings.twitch_client_id or body.get('user_id') != target_id
            or not SCOPES.issubset(set(body.get('scopes', []))) or body.get('expires_in', 0) <= 0):
        raise TwitchError('Twitch authorization does not match this app, broadcaster or required permissions.', reconnect=True)
    return body


async def exchange(code, redirect_uri, client, settings):
    result = await request(client, 'POST', TOKEN_URL, data={'client_id': settings.twitch_client_id,
        'client_secret': settings.twitch_client_secret, 'code': code, 'grant_type': 'authorization_code', 'redirect_uri': redirect_uri})
    if not isinstance(result.get('access_token'), str):
        raise TwitchError('Twitch did not grant a valid access token.')
    proof = await request(client, 'GET', VALIDATE_URL, headers={'Authorization': 'OAuth ' + result['access_token']})
    target = identifier(proof.get('user_id'))
    tokens = {'provider': 'twitch', 'access_token': result['access_token'], 'refresh_token': result.get('refresh_token', ''),
              'subject': target, 'expires_at': time.time() + min(max(int(result.get('expires_in', 0)), 0), 86400)}
    await validate(tokens, target, client, settings)
    users = await request(client, 'GET', USERS_URL, headers=headers(tokens, settings))
    rows = users.get('data')
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get('id') != target:
        raise TwitchError('Twitch did not return the authenticated broadcaster.', reconnect=True)
    login = rows[0].get('login')
    if not isinstance(login, str) or not re.fullmatch(r'[a-zA-Z0-9_]{1,25}', login):
        raise TwitchError('Twitch did not return a valid channel name.')
    tokens.update(login=login, scope=sorted(SCOPES))
    return {'tokens': tokens, 'targets': [{'id': target, 'name': str(rows[0].get('display_name', login))[:150],
        'kind': 'twitch_channel', 'url': 'https://www.twitch.tv/' + login}]}


async def refresh(tokens, client, settings):
    result = await request(client, 'POST', TOKEN_URL, data={'client_id': settings.twitch_client_id,
        'client_secret': settings.twitch_client_secret, 'refresh_token': tokens['refresh_token'], 'grant_type': 'refresh_token'})
    refreshed = {**tokens, 'access_token': result.get('access_token'), 'refresh_token': result.get('refresh_token') or tokens['refresh_token'],
        'expires_at': time.time() + min(max(int(result.get('expires_in', 0)), 0), 86400)}
    headers(refreshed, settings)
    await validate(refreshed, tokens['subject'], client, settings)
    return refreshed


async def channel_status(tokens, target_id, client, settings):
    await validate(tokens, target_id, client, settings)
    channel = await request(client, 'GET', CHANNELS_URL, params={'broadcaster_id': target_id}, headers=headers(tokens, settings))
    rows = channel.get('data')
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get('broadcaster_id') != target_id:
        raise TwitchError('Twitch did not return this broadcaster channel.')
    row = rows[0]
    stream = await request(client, 'GET', STREAMS_URL, params={'user_id': target_id, 'first': 1}, headers=headers(tokens, settings))
    live = stream.get('data')
    if not isinstance(live, list) or any(not isinstance(s, dict) or s.get('user_id') != target_id for s in live):
        raise TwitchError('Twitch returned an inconsistent live status.')
    return {'provider': 'twitch', 'target_id': target_id, 'title': str(row.get('title', ''))[:140],
            'game_id': str(row.get('game_id', ''))[:30], 'game_name': str(row.get('game_name', ''))[:150],
            'language': str(row.get('broadcaster_language', ''))[:10], 'is_live': bool(live),
            'channel_url': 'https://www.twitch.tv/' + tokens['login'], 'stream_id': str(live[0].get('id', '')) if live else None}


async def update_channel(tokens, target_id, values, client, settings):
    await validate(tokens, target_id, client, settings)
    payload = {'title': values['title']}
    if values.get('game_id') is not None:
        payload['game_id'] = values['game_id']
    if values.get('language') is not None:
        payload['broadcaster_language'] = values['language']
    await request(client, 'PATCH', CHANNELS_URL, params={'broadcaster_id': target_id}, json=payload, headers=headers(tokens, settings))
    result = await channel_status(tokens, target_id, client, settings)
    result['settings_confirmed'] = result['title'] == values['title'] and all(
        values.get(key) is None or result[key] == values[key] for key in ('game_id', 'language'))
    return result


async def ingest(tokens, target_id, client, settings):
    await validate(tokens, target_id, client, settings)
    response = await request(client, 'GET', KEY_URL, params={'broadcaster_id': target_id}, headers=headers(tokens, settings))
    rows = response.get('data')
    key = rows[0].get('stream_key') if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) else None
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,250}', key):
        raise TwitchError('Twitch did not return an eligible broadcaster stream key.')
    # Fixed official global ingest, never a user-selected credential destination.
    return {'provider': 'twitch', 'target_id': target_id, 'protocol': 'rtmps',
        'server_url': 'rtmps://ingest.global-contribute.live-video.net/app/', 'stream_key': key,
        'detail': 'Use this secret only in your trusted encoder. Retrieving it does not start a broadcast. Reset it in Twitch if exposed.'}


async def follows(tokens, target_id, client, settings):
    await validate(tokens, target_id, client, settings)
    response = await request(client, 'GET', FOLLOWS_URL, params={'user_id': target_id, 'first': 50}, headers=headers(tokens, settings))
    rows = response.get('data')
    if not isinstance(rows, list):
        raise TwitchError('Twitch did not return followed channels.')
    people = []
    for row in rows[:50]:
        login = row.get('broadcaster_login') if isinstance(row, dict) else None
        if isinstance(login, str) and re.fullmatch(r'[A-Za-z0-9_]{1,25}', login):
            people.append({'id': identifier(row.get('broadcaster_id')), 'name': str(row.get('broadcaster_name', login))[:150],
                           'profile_url': 'https://www.twitch.tv/' + login})
    return {'provider': 'twitch', 'people': people, 'detail': 'Up to 50 followed channels; this is not a reciprocal friends list.'}


async def revoke(tokens, client, settings):
    try:
        await request(client, 'POST', REVOKE_URL, data={'client_id': settings.twitch_client_id, 'token': tokens['access_token']})
        return True
    except TwitchError:
        return False
