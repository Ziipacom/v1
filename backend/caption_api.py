"""Private, opt-in editor caption proposals with bounded temporary background jobs.

No saved creation is edited. Jobs expire and are not silently restarted after an
API restart. A user can explicitly retry; completed suggestions require review.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import hmac
import io
import json
import math
import threading
import time
from typing import Literal
import uuid
import wave

from fastapi import APIRouter, Depends, HTTPException
import httpx
from pydantic import BaseModel, ConfigDict, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.exceptions import RedisError
from sqlalchemy import select

from app import User, SessionLocal, cache, current_user, db, guard, settings
import media_transcription as speech

router = APIRouter(prefix='/api/editor', dependencies=[Depends(current_user)])
CF_MODEL = '@cf/openai/whisper-large-v3-turbo'
ORIGIN = 'https://ziipa.com'
TTL = 900
LEASE_SECONDS = 120
MAX_ROW_BYTES = 131072  # 100 UTF-8 cues plus bounded job metadata.
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='ziipa-captions')
_slot = threading.BoundedSemaphore(1)
_LEASE_KEY = 'editor:captions:slot'
_RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0"
_REPLACE = "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SETEX',KEYS[1],ARGV[2],ARGV[3]); return 1 end; return 0"
_COUNT = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n"


class CaptionSettings(BaseSettings):
    enabled: bool = False
    inference_provider: Literal['private', 'cloudflare'] = 'private'
    model_config = SettingsConfigDict(env_prefix='CAPTION_', env_file='.env', extra='ignore', hide_input_in_errors=True)


config = CaptionSettings()


class CaptionInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, hide_input_in_errors=True)
    request_id: str
    expected_media_id: str
    consent: Literal[True]
    language: Literal['auto'] = 'auto'
    expected_provider: Literal['private', 'cloudflare'] = 'private'

    @field_validator('request_id', 'expected_media_id')
    @classmethod
    def identifier(cls, value):
        try:
            return str(uuid.UUID(value))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Use a saved identifier') from None

    @field_validator('consent', mode='before')
    @classmethod
    def actual_consent(cls, value):
        if value is not True:
            raise ValueError('Explicit speech-processing consent is required')
        return value


def _key(job_id):
    return 'editor:captions:job:' + job_id


def _owner_key(owner_id):
    return 'editor:captions:owner:' + str(owner_id)


def _encode(value):
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    if len(raw.encode()) > MAX_ROW_BYTES:
        raise ValueError('Caption proposal exceeds its private temporary limit')
    return raw


def _load(job_id):
    raw = cache.get(_key(job_id))
    if not raw:
        raise HTTPException(404, 'Caption job expired or was not found. Request a new proposal.')
    if not isinstance(raw, str) or len(raw.encode()) > MAX_ROW_BYTES:
        raise ValueError('Invalid private caption job')
    row = json.loads(raw)
    if not isinstance(row, dict) or row.get('id') != job_id or type(row.get('owner_id')) is not int:
        raise ValueError('Invalid private caption job')
    return raw, row


def _public(row):
    fields = ('id', 'status', 'detail', 'item_id', 'source_media_id', 'source_fingerprint',
              'provider', 'created_at', 'expires_at', 'language', 'segments')
    return {**{name: row[name] for name in fields}, 'job_id': row['id'], 'clock': 'source'}


def _source(session, owner_id, item_id, expected_media_id):
    descriptor = speech._owned_source(session, owner_id, item_id)
    if descriptor['id'] != expected_media_id:
        raise HTTPException(409, 'The selected source changed. Save and select the current creation again.')
    if descriptor['content_type'] not in speech.SPEECH_FORMATS or not 0 < descriptor['size'] <= speech.MAX_INPUT_BYTES:
        raise HTTPException(422, 'Choose owned video or audio up to 100 MiB and 90 seconds.')
    fingerprint = hashlib.sha256(json.dumps({'item_id': item_id, **descriptor}, sort_keys=True).encode()).hexdigest()
    return descriptor, fingerprint


def _headers(body):
    if len(settings.ziipa_proxy_secret) < 32:
        raise ValueError('Private caption gateway is not configured')
    stamp = str(int(time.time()))
    message = 'ziipa-caption-v1\n' + stamp + '\n' + hashlib.sha256(body).hexdigest()
    return {'Content-Type': 'audio/wav', 'X-Ziipa-Caption-Timestamp': stamp,
            'X-Ziipa-Caption-Signature': hmac.new(settings.ziipa_proxy_secret.encode(), message.encode(), hashlib.sha256).hexdigest()}


def _cloud(path, body=b'', *, timeout=1.5):
    if path not in {'/internal/caption-inference', '/internal/caption-inference/status'} or len(body) > 2880044:
        raise ValueError('Only bounded canonical audio may reach the fixed caption gateway')
    with httpx.Client(timeout=httpx.Timeout(timeout, connect=3), trust_env=False, follow_redirects=False) as client:
        with client.stream('POST' if body else 'GET', ORIGIN + path, content=body, headers=_headers(body)) as response:
            response.raise_for_status()
            parts, size = [], 0
            for part in response.iter_bytes():
                size += len(part)
                if size > speech.MAX_JSON_BYTES:
                    raise ValueError('Oversized caption result')
                parts.append(part)
            value = json.loads(b''.join(parts))
            if not isinstance(value, dict):
                raise ValueError('Invalid caption result')
            return value


def readiness():
    ready, model = False, None
    if config.enabled:
        try:
            if config.inference_provider == 'private':
                if speech.config.enabled:
                    speech._runtime()
                    ready, model = True, speech.ENGINE
            else:
                speech.audio_runtime()
                value = _cloud('/internal/caption-inference/status')
                ready = value.get('available') is True and value.get('model') == CF_MODEL
                model = CF_MODEL if ready else None
        except (OSError, RuntimeError, ValueError, TypeError, httpx.HTTPError):
            pass
    private = config.inference_provider == 'private'
    return {'enabled': config.enabled, 'can_run': ready, 'available': ready, 'provider': config.inference_provider,
            'model': model, 'languages': ['auto'], 'max_seconds': 90, 'max_bytes': speech.MAX_INPUT_BYTES,
            'max_segments': 100, 'result_retention_seconds': TTL, 'clock': 'source',
            'consent_detail': ('Process this owned source with the private local speech engine. No audio is sent to a provider.' if private else
                'Send only decoded audio from this owned source to Cloudflare Workers AI for transcription. No public or signed media URL is shared.'),
            'detail': ('Private English speech model; automatic language selection is limited to the installed model.' if private else
                       'Cloudflare-hosted speech recognition, subject to the shared free allowance.') if ready else
                      'Auto captions are unavailable: the configured private runtime or free hosted gateway is not ready. Manual captions remain available.'}


def canonical_audio(path):
    with wave.open(str(path), 'rb') as reader:
        if (reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != 16000
                or not 0 < reader.getnframes() <= 90 * 16000 or reader.getcomptype() != 'NONE'):
            raise ValueError('Invalid decoded caption audio')
        frames = reader.readframes(90 * 16000 + 1)
        if len(frames) != reader.getnframes() * 2:
            raise ValueError('Truncated decoded caption audio')
    output = io.BytesIO()
    with wave.open(output, 'wb') as writer:
        writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(16000); writer.writeframes(frames)
    return output.getvalue()


def cloud_segments(value, duration):
    if not isinstance(value, dict) or value.get('model') != CF_MODEL or not isinstance(value.get('result'), dict):
        raise ValueError('Wrong caption model/result')
    cues = value['result'].get('segments')
    if not isinstance(cues, list) or len(cues) > 100:
        raise ValueError('Invalid caption segments')
    converted, previous_end, characters = [], 0, 0
    for cue in cues:
        if not isinstance(cue, dict) or set(cue) != {'start', 'end', 'text'}:
            raise ValueError('Invalid caption cue')
        start, end = cue['start'], cue['end']
        if (type(start) not in (int, float) or type(end) not in (int, float)
                or not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end <= duration
                or start < previous_end or not isinstance(cue['text'], str)):
            raise ValueError('Invalid caption timestamps')
        text = ' '.join(''.join(c for c in cue['text'] if c.isprintable() or c.isspace()).split())
        if not text:
            continue
        characters += len(text) + 1
        if len(text) > 250 or characters > speech.MAX_TEXT:
            raise ValueError('Caption text exceeds the subtitle limit')
        converted.append({'start': start, 'end': end, 'text': text})
        previous_end = end
    return converted


def _authorize(session, row):
    from admin_services import require_mutations_open
    session.expire_all()
    actor = session.scalar(select(User).where(User.id == row['owner_id']).execution_options(populate_existing=True))
    if actor is None:
        raise HTTPException(401, 'The account is no longer available.')
    require_mutations_open(session, actor)
    _, fingerprint = _source(session, row['owner_id'], row['item_id'], row['source_media_id'])
    if fingerprint != row['source_fingerprint']:
        raise HTTPException(409, 'The source changed during recognition.')


def _update(job_id, raw, row):
    row['expires_at'] = time.time() + TTL
    return bool(cache.eval(_REPLACE, 1, _key(job_id), raw, TTL, _encode(row)))


def _run_job(job_id):
    token = None
    try:
        raw, row = _load(job_id); token = row['token']
        if row['status'] != 'queued' or cache.get(_LEASE_KEY) != token:
            return
        row.update(status='running', detail='Recognizing speech privately; captions are not applied automatically.')
        if not _update(job_id, raw, row):
            return
        with SessionLocal() as session:
            def check_authority():
                _authorize(session, row)
                _, current = _load(job_id)
                if (not config.enabled or config.inference_provider != row['provider']
                        or current['status'] != 'running' or time.time() > row['deadline']
                        or cache.get(_LEASE_KEY) != token):
                    raise HTTPException(409, 'Caption job expired or stopped.')
            check_authority()
            def recognize(path, duration, deadline):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Caption deadline reached')
                body = canonical_audio(path)
                check_authority()  # Fresh rights before any decoded audio leaves.
                result = _cloud('/internal/caption-inference', body, timeout=max(1, min(40, deadline - time.monotonic())))
                return cloud_segments(result, duration)
            result = speech.transcribe_media(session, row['owner_id'], row['item_id'],
                recognize=recognize if row['provider'] == 'cloudflare' else None,
                before_recognize=check_authority)
            check_authority()
        raw, current = _load(job_id)
        if current['status'] == 'running' and current['token'] == token:
            current.update(status=result['status'], detail=result['detail'], segments=result['segments'])
            _update(job_id, raw, current)
    except Exception:
        try:
            raw, current = _load(job_id)
            if current['status'] in ('queued', 'running') and current['token'] == token:
                current.update(status='unavailable', segments=[], detail='Speech recognition stopped, expired or became unavailable. Review source rights and retry; no captions were applied.')
                _update(job_id, raw, current)
        except Exception:
            pass  # A missing/expired job is never recreated by an old worker.
    finally:
        if token:
            try:
                cache.eval(_RELEASE, 1, _LEASE_KEY, token)
            except RedisError:
                pass
        _slot.release()


@router.get('/captions/config')
def configuration():
    return readiness()


@router.post('/items/{item_id}/captions', status_code=202, dependencies=[Depends(guard)])
def create_job(item_id: uuid.UUID, data: CaptionInput, user=Depends(current_user), session=Depends(db)):
    from admin_services import require_mutations_open
    require_mutations_open(session, user)
    owner_id, item_id = user.id, str(item_id)
    _, fingerprint = _source(session, owner_id, item_id, data.expected_media_id)
    if data.expected_provider != config.inference_provider:
        raise HTTPException(409, 'The speech provider changed. Review its current privacy notice and consent again.')
    request_key = f'editor:captions:request:{owner_id}:{data.request_id}'
    signature = hashlib.sha256((_encode(data.model_dump()) + item_id + fingerprint).encode()).hexdigest()
    try:
        previous = cache.get(request_key)
        if previous:
            existing = json.loads(previous)
            if existing['signature'] != signature:
                raise HTTPException(409, 'This caption request changed. Start a new request.')
            _, row = _load(existing['id'])
            return _public(row)
        if not readiness()['can_run']:
            raise HTTPException(503, 'Auto captions are unavailable. Nothing was sent or applied.')
        if not _slot.acquire(blocking=False):
            raise HTTPException(429, 'The caption engine is busy. Try again shortly.')
        token, job_id, leased, request_created = uuid.uuid4().hex, str(uuid.uuid4()), False, False
        try:
            leased = bool(cache.set(_LEASE_KEY, token, nx=True, ex=LEASE_SECONDS))
            if not leased:
                raise HTTPException(429, 'The caption engine is busy. Try again shortly.')
            if cache.eval(_COUNT, 1, f'editor:captions:rate:{owner_id}', 600) > 3:
                raise HTTPException(429, 'Your caption request allowance is reached. Try again later.')
            day = datetime.now(timezone.utc).strftime('%Y%m%d')
            daily_key = ('music:compose:cloudflare:day:' if data.expected_provider == 'cloudflare' else 'editor:captions:day:') + day
            if cache.eval(_COUNT, 1, daily_key, 90000) > (20 if data.expected_provider == 'cloudflare' else 120):
                raise HTTPException(429, 'The shared free AI allowance is reached. Try again later.')
            stamp = time.time()
            row = {'id': job_id, 'owner_id': owner_id, 'item_id': item_id, 'source_media_id': data.expected_media_id,
                'source_fingerprint': fingerprint, 'provider': data.expected_provider, 'language': data.language,
                'status': 'queued', 'detail': 'Queued private caption recognition. Nothing has been applied.',
                'created_at': stamp, 'expires_at': stamp + TTL, 'deadline': stamp + LEASE_SECONDS - 10,
                'token': token, 'request_id': data.request_id, 'segments': []}
            cache.set(_key(job_id), _encode(row), ex=TTL)
            if not cache.set(request_key, _encode({'id': job_id, 'signature': signature}), nx=True, ex=TTL):
                raise HTTPException(409, 'This request is already being prepared. Retry the same request shortly.')
            request_created = True
            cache.sadd(_owner_key(owner_id), job_id); cache.expire(_owner_key(owner_id), TTL)
            _pool.submit(_run_job, job_id)
            return _public(row)
        except Exception:
            try:
                cache.delete(_key(job_id))
                if request_created:
                    cache.delete(request_key)
                if leased:
                    cache.eval(_RELEASE, 1, _LEASE_KEY, token)
            finally:
                _slot.release()
            raise
    except (RedisError, ValueError, KeyError):
        raise HTTPException(503, 'Private caption job storage is unavailable. Please retry later.') from None


@router.get('/caption-jobs/{job_id}')
def job(job_id: uuid.UUID, user=Depends(current_user), session=Depends(db)):
    try:
        raw, row = _load(str(job_id))
        if row['owner_id'] != user.id:
            raise HTTPException(404, 'Caption job not found.')
        _, fingerprint = _source(session, user.id, row['item_id'], row['source_media_id'])
        if fingerprint != row['source_fingerprint']:
            raise HTTPException(409, 'The saved source changed. Request captions for the current source.')
        if row['status'] in ('queued', 'running') and time.time() > row['deadline']:
            row.update(status='unavailable', segments=[], detail='Recognition expired or the API restarted. Request a new caption proposal.')
            _update(str(job_id), raw, row)
        return _public(row)
    except (RedisError, ValueError, KeyError):
        raise HTTPException(503, 'Private caption job storage is unavailable.') from None


def delete_caption_jobs(owner_id):
    """Account deletion hook; no storage paths, keys or audio are returned."""
    for job_id in list(cache.smembers(_owner_key(owner_id)))[:100]:
        try:
            uuid.UUID(job_id)
            _, row = _load(job_id)
            if row['owner_id'] == owner_id:
                cache.delete(_key(job_id))
                cache.delete(f"editor:captions:request:{owner_id}:{row['request_id']}")
        except (ValueError, HTTPException):
            continue
    cache.delete(_owner_key(owner_id))
