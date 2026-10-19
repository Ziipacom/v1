"""Livepeer Studio raw-body HMAC webhooks. Events are hints, never live authority.

Verified against official Studio src/webhooks/cannon.ts: HMAC-SHA256(raw body),
Livepeer-Signature t=<Unix milliseconds>, and identical body.timestamp.
Only sanitized IDs and an event binding hash are durable; no raw stream keys.

Sources verified 2026-10-19:
https://docs.livepeer.org/developers/guides/setup-and-listen-to-webhooks
https://github.com/livepeer/studio/blob/master/packages/api/src/webhooks/cannon.ts
https://github.com/livepeer/studio/blob/master/packages/api/src/schema/api-schema.yaml
https://docs.livepeer.org/v1/api-reference/session/get
"""
import asyncio
from datetime import timedelta
import hashlib
import hmac
import json
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app import User, db
import live_api as live
import live_recordings as recordings
from live_recordings import LiveRecording, LiveWebhookReceipt, RecordingAutomation

router = APIRouter(prefix='/api/live/webhooks', dependencies=[Depends(live.no_store)])
MAX_BODY = 64 * 1024
TOLERANCE_MS = 300_000
EVENTS = frozenset({'stream.started', 'stream.idle', 'asset.ready'})


def strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate JSON member')
        value[key] = item
    return value


def verified_payload(body, signature):
    if not recordings.webhook_configured():
        raise HTTPException(503, 'Livepeer webhooks are not configured.')
    if not 0 < len(body) <= MAX_BODY or not isinstance(signature, str) or len(signature) > 1024:
        raise HTTPException(401, 'Webhook verification failed.')
    values = signature.split(',')
    times = [value[2:] for value in values if value.startswith('t=')]
    signatures = [value[3:] for value in values if value.startswith('v1=')]
    if len(times) != 1 or not re.fullmatch(r'[0-9]{10,16}', times[0]) or not 1 <= len(signatures) <= 5:
        raise HTTPException(401, 'Webhook verification failed.')
    expected = hmac.new(recordings.config.live_webhook_secret.get_secret_value().encode(), body, hashlib.sha256).hexdigest()
    if not any(re.fullmatch(r'[0-9a-f]{64}', supplied) and hmac.compare_digest(expected, supplied) for supplied in signatures):
        raise HTTPException(401, 'Webhook verification failed.')
    try:
        value = json.loads(body, object_pairs_hook=strict_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        timestamp = int(times[0])
        if (not isinstance(value, dict) or type(value.get('timestamp')) is not int
                or value['timestamp'] != timestamp or abs(recordings.now().timestamp() * 1000 - timestamp) > TOLERANCE_MS
                or value.get('webhookId') != recordings.config.live_webhook_id
                or type(value.get('createdAt')) is not int or not 0 <= value['createdAt'] <= timestamp + 1000):
            raise ValueError()
        value['id'] = str(uuid.UUID(value['id']))
    except (ValueError, TypeError, KeyError, UnicodeDecodeError):
        raise HTTPException(401, 'Webhook verification failed.') from None
    return value


def id_value(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(400, 'Webhook resource identifier is invalid.') from None


async def recording_binding(asset_id):
    """API-authenticated asset -> recording session -> exact parent stream."""
    asset = await live.provider_request('GET', '/asset/' + id_value(asset_id), allow_missing=True)
    if not isinstance(asset, dict) or id_value(asset.get('id')) != asset_id:
        raise HTTPException(409, 'Recording asset could not be verified.')
    source = asset.get('source')
    if not isinstance(source, dict) or source.get('type') != 'recording':
        raise HTTPException(409, 'The provider asset is not a livestream recording.')
    session_id = id_value(source.get('sessionId'))
    session = await live.provider_request('GET', '/session/' + session_id, allow_missing=True)
    if not isinstance(session, dict) or id_value(session.get('id')) != session_id or session.get('record') is not True:
        raise HTTPException(409, 'Recording session could not be verified.')
    parent_id = id_value(session.get('parentId'))
    return asset, session_id, parent_id


def lock_owner(session, owner_id):
    if session.bind.dialect.name == 'sqlite':
        session.execute(update(User).where(User.id == owner_id).values(id=owner_id))
    return session.scalar(select(User).where(User.id == owner_id).with_for_update())


@router.post('/livepeer')
async def receive(request: Request, session: Session = Depends(db)):
    if not recordings.webhook_configured():
        raise HTTPException(503, 'Livepeer webhooks are not configured.')
    if request.headers.get('content-encoding', 'identity') != 'identity':
        raise HTTPException(415, 'Encoded webhook bodies are not accepted.')
    if len(request.headers.getlist('livepeer-signature')) != 1:
        raise HTTPException(401, 'Webhook verification failed.')
    body = bytearray()
    try:
        async with asyncio.timeout(5):
            async for part in request.stream():
                body.extend(part)
                if len(body) > MAX_BODY:
                    raise HTTPException(413, 'Webhook body exceeds the limit.')
    except TimeoutError:
        raise HTTPException(408, 'Webhook body timed out.') from None
    value = verified_payload(bytes(body), request.headers.get('livepeer-signature'))
    event = value.get('event')
    if event not in EVENTS:
        return {'accepted': True, 'ignored': True}
    asset_id = session_id = None
    if event == 'asset.ready':
        payload = value.get('payload')
        asset_hint = payload.get('asset') if isinstance(payload, dict) else None
        if not isinstance(asset_hint, dict):
            raise HTTPException(400, 'Use the current asset.ready webhook schema.')
        asset_id = id_value(asset_hint.get('id'))
        # Unknown, URL-uploaded or foreign recordings are never accepted based
        # solely on callback fields, even when the HMAC is valid.
        _, session_id, provider_stream_id = await recording_binding(asset_id)
    else:
        stream_hint = value.get('stream')
        if not isinstance(stream_hint, dict):
            raise HTTPException(400, 'Webhook stream binding is missing.')
        provider_stream_id = id_value(stream_hint.get('id'))
    matches = list(session.scalars(select(live.LiveStream).where(live.LiveStream.provider_id == provider_stream_id).limit(2)))
    if len(matches) != 1:
        return {'accepted': True, 'ignored': True}
    identity = matches[0]
    if not lock_owner(session, identity.owner_id):
        return {'accepted': True, 'ignored': True}
    stream = session.scalar(select(live.LiveStream).where(live.LiveStream.id == identity.id,
        live.LiveStream.owner_id == identity.owner_id).with_for_update().execution_options(populate_existing=True))
    if not stream or stream.provider_id != provider_stream_id:
        return {'accepted': True, 'ignored': True}
    binding = hashlib.sha256(json.dumps([event, provider_stream_id, session_id, asset_id, value['createdAt']], separators=(',', ':')).encode()).hexdigest()
    previous = session.get(LiveWebhookReceipt, value['id'])
    if previous:
        if previous.owner_id != stream.owner_id or not hmac.compare_digest(previous.binding_hash, binding):
            raise HTTPException(409, 'Webhook event identity conflicts with its previous binding.')
        return {'accepted': True, 'duplicate': True}
    # Stable bounded ledger. Old receipt retention exceeds replay tolerance;
    # imported asset IDs remain independently unique for lifetime deduplication.
    session.query(LiveWebhookReceipt).filter(LiveWebhookReceipt.owner_id == stream.owner_id,
        LiveWebhookReceipt.received_at < recordings.now() - timedelta(days=7)).delete(synchronize_session=False)
    if session.scalar(select(func.count()).select_from(LiveWebhookReceipt).where(LiveWebhookReceipt.owner_id == stream.owner_id)) >= 1000:
        raise HTTPException(429, 'Webhook event allowance reached for this account.')
    if event == 'asset.ready':
        policy = session.get(RecordingAutomation, stream.id)
        allowed = bool(recordings.config.live_recordings_enabled and stream.record and policy and policy.enabled and policy.consent
            and policy.owner_id == stream.owner_id and value['createdAt'] >= recordings.aware(policy.updated_at).timestamp() * 1000)
        if allowed and not session.scalar(select(LiveRecording.id).where(LiveRecording.provider_asset_id == asset_id)):
            if session.scalar(select(func.count()).select_from(LiveRecording).where(LiveRecording.owner_id == stream.owner_id)) >= recordings.MAX_RECORDINGS:
                raise HTTPException(429, 'Recording import allowance reached. No new recording was downloaded.')
            active = select(func.count()).select_from(LiveRecording).where(LiveRecording.status.in_(('queued', 'processing')))
            if session.scalar(active.where(LiveRecording.owner_id == stream.owner_id)) >= 3 or session.scalar(active) >= 20:
                raise HTTPException(429, 'The private recording queue is full. No recording was downloaded.')
            session.add(LiveRecording(owner_id=stream.owner_id, stream_id=stream.id, provider_asset_id=asset_id,
                provider_session_id=session_id, provider_stream_id=provider_stream_id,
                title=stream.title, policy=recordings.policy_receipt(stream.id, policy)))
    elif stream.publish_enabled and stream.status not in ('ending', 'ended'):
        # Ignore event ordering/state claims; only a fresh authenticated read
        # can mark live. Explicit user start remains the sole ingest authority.
        from account_services import AccountState, PrivacyInput
        account = session.get(AccountState, stream.owner_id)
        privacy = PrivacyInput(**(account.privacy or {})) if account else PrivacyInput()
        if privacy.profile_visibility == 'public':
            await live.refresh_stream(stream)
        else:
            stream.playback_url = None; stream.checked_at = None
    session.add(LiveWebhookReceipt(id=value['id'], owner_id=stream.owner_id, stream_id=stream.id,
        event=event, binding_hash=binding))
    session.commit(); recordings.notify()
    return {'accepted': True, 'automatic_publication': False}
