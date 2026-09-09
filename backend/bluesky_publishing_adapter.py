"""AT Protocol OAuth via the official Node SDK and a bounded private stdio bridge.

SDK state and sessions include DPoP keys: the caller must encrypt them and hold
a per-grant lease across every bridge operation. No child command receives
credentials in arguments and no provider error/stderr is exposed.
"""
import asyncio
import base64
import json
import os
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit
from Crypto.PublicKey import ECC

BRIDGE_ROOT = Path(__file__).resolve().parent / 'atproto_bridge'
BRIDGE_STDOUT_LIMIT = 2 * 1024 * 1024
BRIDGE_ENV_KEYS = frozenset({'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'})
SCOPE = 'atproto repo:app.bsky.feed.post?action=create blob:video/mp4'
DID = re.compile(r'did:plc:[a-z2-7]{24}\Z')


class BlueskyError(Exception):
    def __init__(self, detail, *, reconnect=False, uncertain=False):
        super().__init__(detail)
        self.reconnect, self.uncertain = reconnect, uncertain


def normalize_handle(value):
    handle = str(value or '').strip().lower().removeprefix('@')
    if len(handle) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+', handle):
        raise BlueskyError('Enter your Bluesky handle, such as creator.bsky.social. Account URLs, passwords and arbitrary servers are not accepted.')
    return handle


def validate_settings(settings):
    if not settings.bluesky_enabled:
        raise BlueskyError('Enable the reviewed Bluesky OAuth bridge in the API configuration.')
    try:
        key = json.loads(settings.bluesky_private_jwk)
        if key.get('kty') != 'EC' or key.get('crv') != 'P-256' or not all(isinstance(key.get(k), str) and key[k] for k in ('d', 'x', 'y', 'kid')):
            raise ValueError('Invalid client key')
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', key['kid']) or not all(re.fullmatch(r'[A-Za-z0-9_-]{43}', key[k]) for k in ('d', 'x', 'y')):
            raise ValueError('Invalid JWK encoding')
        values = {k: int.from_bytes(base64.urlsafe_b64decode(key[k] + '='), 'big') for k in ('d', 'x', 'y')}
        checked = ECC.construct(curve='P-256', d=values['d'])
        if int(checked.pointQ.x) != values['x'] or int(checked.pointQ.y) != values['y']:
            raise ValueError('JWK public/private mismatch')
        for origin in extra_origins(settings):
            parsed = urlsplit(origin)
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or parsed.port:
                raise ValueError('Invalid approved resource origin')
    except (ValueError, TypeError, AttributeError) as exc:
        raise BlueskyError('Configure a stable private P-256 OAuth client JWK and exact approved HTTPS PDS origins.') from exc
    if not shutil.which(settings.bluesky_node_binary) or not (BRIDGE_ROOT / 'node_modules/@atproto/oauth-client-node/package.json').is_file():
        raise BlueskyError('Install Node 22 or newer and the pinned official AT Protocol bridge dependencies.')


def extra_origins(settings):
    return [v.strip().rstrip('/') for v in settings.bluesky_extra_origins.split(',') if v.strip()]


async def run_bridge(settings, origin, operation, **data):
    validate_settings(settings)
    payload = {'operation': operation, 'origin': origin, 'private_jwk': json.loads(settings.bluesky_private_jwk),
               'extra_origins': extra_origins(settings), **data}
    environment = {key: value for key, value in os.environ.items() if key.upper() in BRIDGE_ENV_KEYS}
    process = await asyncio.create_subprocess_exec(shutil.which(settings.bluesky_node_binary), '--max-old-space-size=256', str(BRIDGE_ROOT / 'bridge.mjs'),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        cwd=BRIDGE_ROOT, env=environment,
        **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
    async def write_input():
        try:
            process.stdin.write(json.dumps(payload, separators=(',', ':')).encode())
            await process.stdin.drain()
        finally:
            process.stdin.close()

    async def read_output():
        chunks, length = [], 0
        while part := await process.stdout.read(64 * 1024):
            length += len(part)
            if length > BRIDGE_STDOUT_LIMIT:
                raise BlueskyError('The AT Protocol bridge returned an oversized result.', uncertain=operation == 'create')
            chunks.append(part)
        return b''.join(chunks)

    writer, reader = asyncio.create_task(write_input()), asyncio.create_task(read_output())
    try:
        async with asyncio.timeout(45):
            _, stdout = await asyncio.gather(writer, reader)
            await process.wait()
        if process.returncode:
            raise BlueskyError('The AT Protocol bridge could not verify this operation.')
        result = json.loads(stdout)
        if not isinstance(result, dict) or not isinstance(result.get('sessions', {}), dict):
            raise ValueError('Invalid bridge output')
        return result
    except (ValueError, OSError, TimeoutError) as exc:
        raise BlueskyError('The AT Protocol operation timed out or returned an invalid result. Reconnect if needed; no automatic repost will run.', uncertain=operation == 'create') from exc
    finally:
        for task in (writer, reader):
            if not task.done():
                task.cancel()
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass  # The child may have exited between the returncode check and signal.
            await process.wait()
        await asyncio.gather(writer, reader, return_exceptions=True)


def ensure_ok(result):
    if result.get('ok') is not True:
        raise BlueskyError('Bluesky could not verify this operation. Check account permissions and supported hosting; no automatic repost will run.')
    return result['result']


def session_tokens(result, did):
    if not isinstance(did, str) or not DID.fullmatch(did):
        raise BlueskyError('Bluesky did not verify a supported account identity.')
    session = result.get('sessions', {}).get(did)
    token_set = session.get('tokenSet', {}) if isinstance(session, dict) else {}
    if token_set.get('sub') != did or not token_set.get('access_token') or not session.get('dpopJwk'):
        raise BlueskyError('The official SDK did not return a verified DPoP session.', reconnect=True)
    return {'provider': 'bluesky', 'subject': did, 'access_token': token_set['access_token'],
            'sdk_session': session, 'expires_at': 0}


async def authorize(handle, origin, app_state, settings):
    result = await run_bridge(settings, origin, 'authorize', handle=normalize_handle(handle), app_state=app_state)
    value = ensure_ok(result)
    if not isinstance(value.get('state'), str) or not 16 <= len(value['state']) <= 200 or len(result.get('states', {})) != 1:
        raise BlueskyError('The official SDK did not return a valid authorization state.')
    return {**value, 'states': result['states']}


async def exchange(states, params, app_state, origin, settings):
    result = await run_bridge(settings, origin, 'callback', states=states, params=params, app_state=app_state)
    value = ensure_ok(result)
    return {'tokens': session_tokens(result, value['did']), 'targets': value['targets']}


async def operation(tokens, operation_name, settings, origin, save_tokens, **data):
    did = tokens.get('subject')
    if not isinstance(did, str) or not DID.fullmatch(did):
        raise BlueskyError('The stored Bluesky identity is invalid.', reconnect=True)
    result = await run_bridge(settings, origin, operation_name, sessions={did: tokens['sdk_session']}, did=did, **data)
    # Persist rotated SDK sessions even if the media request subsequently failed.
    if did in result.get('sessions', {}):
        updated = session_tokens(result, did)
        await save_tokens(updated)
        tokens.clear()
        tokens.update(updated)
    return ensure_ok(result)


async def publish_prepare(tokens, target_id, source, client, settings, checkpoint):
    if target_id != tokens.get('subject') or source['content_type'] != 'video/mp4':
        raise BlueskyError('Select the authorized Bluesky account and an MP4 video export.')
    text = source['title'] + ('\n' + source['description'] if source['description'] else '')
    if len(text) > 300:
        raise BlueskyError('Keep the Bluesky post title and description within 300 characters.')
    state = {'provider': 'bluesky', 'target_id': target_id, 'stage': 'upload_started', 'rkey': source['job_id'].replace('-', '')}
    await checkpoint(state)
    uploaded = await operation(tokens, 'upload', settings, source['origin'], source['save_tokens'], media_base64=base64.b64encode(source['bytes']).decode())
    record = {'$type': 'app.bsky.feed.post', 'text': text, 'createdAt': source['created_at'],
              'embed': {'$type': 'app.bsky.embed.video', 'video': uploaded['blob']}}
    state.update(stage='create_started', record=record)
    await checkpoint(state)
    try:
        written = await operation(tokens, 'create', settings, source['origin'], source['save_tokens'], rkey=state['rkey'], record=record)
    except BlueskyError as exc:
        raise BlueskyError('The Bluesky post result is uncertain. Refresh its saved record; Ziipa will never create another record automatically.', uncertain=True) from exc
    state.update(stage='record_created', cid=written['cid'])
    await checkpoint(state)
    return {'status': 'processing', 'detail': 'Bluesky accepted the video post record. AppView video availability still requires verification.',
            'privacy': 'public', 'external_id': written['uri'], 'external_url': 'https://bsky.app/profile/' + target_id + '/post/' + state['rkey'], 'provider_data': state}


async def poll(tokens, target_id, job_data, client, settings, checkpoint):
    state = job_data.get('provider_data', {})
    if state.get('provider') != 'bluesky' or state.get('target_id') != target_id or target_id != tokens.get('subject'):
        raise BlueskyError('The saved post does not match this authorized account.')
    if not state.get('record'):
        return {'status': 'uncertain', 'detail': 'The video upload was interrupted before a post record was saved. No automatic retry will run.', 'provider_data': state}
    result = await operation(tokens, 'status', settings, job_data['origin'], job_data['save_tokens'], rkey=state['rkey'], record=state['record'])
    return {'status': 'delivered' if result['video_ready'] else 'processing', 'privacy': 'public',
            'detail': 'The public Bluesky post and video playback are verified.' if result['video_ready'] else 'The owned Bluesky post is verified; video processing or AppView indexing is still pending.',
            'external_id': result['uri'], 'external_url': 'https://bsky.app/profile/' + target_id + '/post/' + state['rkey'], 'provider_data': state}


async def revoke(tokens, settings, origin):
    try:
        result = await run_bridge(settings, origin, 'revoke', sessions={tokens['subject']: tokens['sdk_session']}, did=tokens['subject'])
        return result.get('ok') is True and result['result'].get('revoked') is True
    except BlueskyError:
        return False
