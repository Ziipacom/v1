"""Opt-in, free-gated preset narration; no cloning, retention or fallback model."""
from __future__ import annotations

from array import array
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import json
import struct
import sys
import threading
import time
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException
import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import User, cache, current_user, db, guard, settings


router = APIRouter(prefix='/api/audio/narration', dependencies=[Depends(current_user)])
MODEL = '@cf/deepgram/aura-1'
ORIGIN = 'https://ziipa.com'
PATH = '/internal/narration-inference'
INPUT_RATE = 24000
OUTPUT_RATE = 22050
MAX_SECONDS = 30
MAX_TEXT = 300
MAX_WAV_BYTES = 44 + INPUT_RATE * 2 * MAX_SECONDS + 65536
# Aura-1, not Aura-2: https://developers.deepgram.com/docs/tts-models
# The model generation matters: Athena's Aura-2 accent differs.
VOICES = (
    {'id': 'athena', 'label': 'Athena · British female', 'language': 'en-GB', 'accent': 'British', 'gender': 'female'},
    {'id': 'helios', 'label': 'Helios · British male', 'language': 'en-GB', 'accent': 'British', 'gender': 'male'},
    {'id': 'asteria', 'label': 'Asteria · US female', 'language': 'en-US', 'accent': 'US', 'gender': 'female'},
    {'id': 'orion', 'label': 'Orion · US male', 'language': 'en-US', 'accent': 'US', 'gender': 'male'},
)
_slot = threading.BoundedSemaphore(1)
_RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0"
_BUDGET = """
local u=tonumber(redis.call('GET',KEYS[1]) or '0')
local g=tonumber(redis.call('GET',KEYS[2]) or '0')
local c=tonumber(redis.call('GET',KEYS[3]) or '0')
local n=tonumber(ARGV[1])
if not u or not g or not c or not n or u<0 or g<0 or c<0 then return -4 end
if u>=3 then return -1 end
if g>=10 then return -2 end
if c+n>4000 then return -3 end
redis.call('INCR',KEYS[1]); redis.call('INCR',KEYS[2]); redis.call('INCRBY',KEYS[3],n)
for i=1,3 do redis.call('EXPIRE',KEYS[i],90000) end
return 1
"""


class NarrationSettings(BaseSettings):
    enabled: bool = False
    # Deliberately process-only: no new credential store or dotenv read.
    model_config = SettingsConfigDict(env_prefix='NARRATION_', env_file=None, extra='ignore', hide_input_in_errors=True)


config = NarrationSettings()


class NarrationInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, str_strip_whitespace=True, hide_input_in_errors=True)
    version: Literal[1]
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    voice_id: Literal['athena', 'helios', 'asteria', 'orion']
    consent: Literal[True]
    expected_provider: Literal['cloudflare']

    @field_validator('version', mode='before')
    @classmethod
    def actual_version(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError('Narration version one is required')
        return value

    @field_validator('consent', mode='before')
    @classmethod
    def actual_consent(cls, value):
        if value is not True:
            raise ValueError('Explicit consent is required before sending narration text')
        return value

    @field_validator('text', mode='before')
    @classmethod
    def plain_text(cls, value):
        if isinstance(value, str) and any((ord(char) < 32 and char not in '\n\t') or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value):
            # Do not echo invalid Unicode or submitted script in validation JSON.
            raise HTTPException(422, 'Use plain narration text without control characters.')
        return value


def signed_headers(body: bytes):
    if len(settings.ziipa_proxy_secret) < 32:
        raise ValueError('A protected narration bridge is required')
    stamp = str(int(time.time()))
    if len(stamp) != 10 or not stamp.isdigit():
        raise ValueError('A valid bridge timestamp is required')
    message = 'ziipa-narration-v1\n' + stamp + '\n' + hashlib.sha256(body).hexdigest()
    signature = hmac.new(settings.ziipa_proxy_secret.encode(), message.encode(), hashlib.sha256).hexdigest()
    return {'X-Ziipa-Narration-Timestamp': stamp, 'X-Ziipa-Narration-Signature': signature,
            'Content-Type': 'application/json', 'Accept': 'audio/wav' if body else 'application/json'}


def cloudflare(payload=None):
    """Only a fixed HTTPS origin/path; streamed bytes, no redirects/proxy/env auth."""
    body = b'' if payload is None else json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    if len(body) > 4096:
        raise ValueError('Narration request exceeds its byte budget')
    status = payload is None
    bound = 2048 if status else MAX_WAV_BYTES
    timeout = 2 if status else 24
    deadline = time.monotonic() + timeout
    with httpx.Client(timeout=httpx.Timeout(timeout, connect=3), trust_env=False, follow_redirects=False) as client:
        with client.stream('GET' if status else 'POST', ORIGIN + PATH + ('/status' if status else ''),
                           headers=signed_headers(body), content=body) as response:
            if response.status_code != 200:
                raise ValueError('Narration bridge is unavailable')
            kind = response.headers.get('content-type', '').split(';')[0].strip().lower()
            if kind != ('application/json' if status else 'audio/wav'):
                raise ValueError('Unexpected narration response type')
            length = response.headers.get('content-length')
            if length is not None and (not length.isdigit() or not 0 < int(length) <= bound):
                raise ValueError('Narration response exceeds its byte budget')
            chunks, size = [], 0
            for chunk in response.iter_bytes(chunk_size=65536):
                size += len(chunk)
                if size > bound or time.monotonic() > deadline:
                    raise ValueError('Narration response exceeds its resource budget')
                chunks.append(chunk)
            if not size or time.monotonic() > deadline:
                raise ValueError('No bounded narration response')
            raw = b''.join(chunks)
    return json.loads(raw) if status else raw


def provider_status():
    if not config.enabled or len(settings.ziipa_proxy_secret) < 32:
        return False
    try:
        value = cloudflare()
        return (isinstance(value, dict) and set(value) == {'version', 'model', 'available'}
                and type(value['version']) is int and value['version'] == 1
                and value['model'] == MODEL and value['available'] is True)
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        return False


def canonical_audio(raw: bytes):
    """Parse bounded 24kHz PCM, discard metadata, produce canonical 22.05kHz PCM."""
    if (not isinstance(raw, bytes) or not 44 <= len(raw) <= MAX_WAV_BYTES
            or raw[:4] != b'RIFF' or raw[8:12] != b'WAVE'
            or struct.unpack_from('<I', raw, 4)[0] + 8 != len(raw)):
        raise ValueError('Invalid narration WAV container')
    offset, overhead, fmt, data = 12, 12, None, None
    while offset < len(raw):
        if offset + 8 > len(raw):
            raise ValueError('Truncated WAV chunk')
        kind, size = struct.unpack_from('<4sI', raw, offset)
        start = offset + 8
        end = start + size
        offset = end + size % 2
        if end > len(raw) or offset > len(raw):
            raise ValueError('Truncated WAV data')
        overhead += 8 + (0 if kind == b'data' else size + size % 2)
        if overhead > 65536:
            raise ValueError('Narration WAV metadata exceeds its byte budget')
        if kind == b'fmt ':
            if fmt is not None or size not in (16, 18) or (size == 18 and raw[start + 16:end] != b'\0\0'):
                raise ValueError('Unsupported WAV format chunk')
            fmt = struct.unpack_from('<HHIIHH', raw, start)
        elif kind == b'data':
            if data is not None or not 0 < size <= INPUT_RATE * 2 * MAX_SECONDS or size % 2:
                raise ValueError('Invalid PCM narration data')
            data = raw[start:end]
    if fmt != (1, 1, INPUT_RATE, INPUT_RATE * 2, 2, 16) or data is None:
        raise ValueError('Only mono 24kHz 16-bit PCM narration is supported')
    samples = array('h')
    samples.frombytes(data)
    if sys.byteorder != 'little':
        samples.byteswap()
    count = len(samples) * OUTPUT_RATE // INPUT_RATE
    if count < 1:
        raise ValueError('Narration audio is empty')
    output = array('h')
    for index in range(count):
        numerator = index * INPUT_RATE
        left, fraction = divmod(numerator, OUTPUT_RATE)
        right = min(left + 1, len(samples) - 1)
        value = round((samples[left] * (OUTPUT_RATE - fraction) + samples[right] * fraction) / OUTPUT_RATE)
        output.append(max(-32768, min(32767, value)))
    if sys.byteorder != 'little':
        output.byteswap()
    pcm = output.tobytes()
    header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + len(pcm), b'WAVE', b'fmt ', 16,
                         1, 1, OUTPUT_RATE, OUTPUT_RATE * 2, 2, 16, b'data', len(pcm))
    return header + pcm, count / OUTPUT_RATE


@contextmanager
def inference_budget(owner_id: int, characters: int):
    if not _slot.acquire(blocking=False):
        raise HTTPException(429, 'Narration is busy. Try again shortly.', headers={'Retry-After': '90'})
    token, leased, entered, completed = uuid.uuid4().hex, False, False, False
    try:
        leased = bool(cache.set('narration:inference:slot', token, nx=True, ex=90))
        if not leased:
            raise HTTPException(429, 'Narration is busy. Try again shortly.', headers={'Retry-After': '90'})
        day = datetime.now(timezone.utc).strftime('%Y%m%d')
        result = cache.eval(_BUDGET, 3, f'narration:user:{owner_id}:day:{day}',
                            f'narration:global:day:{day}', f'narration:characters:day:{day}', characters)
        if type(result) is not int or result not in (1, -1, -2, -3):
            raise HTTPException(503, 'Narration limits could not be verified. Try again later.')
        if result != 1:
            raise HTTPException(429, 'The free narration allowance is reached. Try again tomorrow.',
                                headers={'Retry-After': '3600'})
        entered = True
        yield
        completed = True
    except RedisError:
        raise HTTPException(503, 'Narration limits are unavailable. No new request will be sent.') from None
    finally:
        # An uncertain provider request retains the 90s lease; never overlap a
        # still-running remote generation or blindly refund/replay its allowance.
        if leased and (not entered or completed):
            try:
                cache.eval(_RELEASE, 1, 'narration:inference:slot', token)
            except RedisError:
                pass
        _slot.release()


@router.get('/config')
def configuration():
    available = provider_status()
    return {'version': 1, 'provider': 'cloudflare', 'model': MODEL, 'available': available,
            'max_text_chars': MAX_TEXT, 'max_duration_seconds': MAX_SECONDS, 'requires_consent': True,
            'voices': [{**voice, 'available': available} for voice in VOICES],
            'detail': ('Preset synthetic narration. Only your submitted text and selected voice are sent; review before saving.'
                       if available else 'Free, verified narration is unavailable. No substitute audio will be generated.'),
            'clone': {'available': False, 'verified': False, 'max_reference_seconds': 20,
                      'max_reference_bytes': 2 * 1024 * 1024,
                      'detail': 'Private free voice-cloning runtime is unavailable. No voice sample upload or retention is enabled.'}}


@router.post('', dependencies=[Depends(guard)])
def narrate(data: NarrationInput, user: User = Depends(current_user), session: Session = Depends(db)):
    from admin_services import require_mutations_open
    require_mutations_open(session, user)
    if not provider_status():
        raise HTTPException(503, 'Free, verified narration is unavailable. No substitute audio was generated.')
    owner_id = user.id
    with inference_budget(owner_id, len(data.text)):
        try:
            raw = cloudflare({'version': 1, 'text': data.text, 'voice_id': data.voice_id})
            audio, duration = canonical_audio(raw)
        except (httpx.HTTPError, ValueError, TypeError, KeyError, OverflowError, struct.error):
            raise HTTPException(503, 'Narration did not return valid bounded audio. Refresh status before trying again; requests are not repeated automatically.') from None
        session.expire_all()
        actor = session.scalar(select(User).where(User.id == owner_id).execution_options(populate_existing=True))
        if actor is None:
            raise HTTPException(401, 'Please sign in again.')
        require_mutations_open(session, actor)
        return {'version': 1, 'provider': 'cloudflare', 'model': MODEL, 'voice_id': data.voice_id,
                'format': 'wav', 'sample_rate': OUTPUT_RATE, 'duration_seconds': duration,
                'sha256': hashlib.sha256(audio).hexdigest(), 'audio_base64': base64.b64encode(audio).decode('ascii'),
                'detail': 'Preset AI narration. Review before sharing; no cloned voice or exclusivity claim.'}
