"""Opt-in visual title proposals. One bounded JPEG, no media URLs or publication."""
from contextlib import contextmanager
from datetime import datetime, timezone
import base64
import hashlib
import hmac
import json
import threading
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import User, cache, current_user, db, guard, settings

router = APIRouter(prefix='/api/editor/title', dependencies=[Depends(current_user)])
MODEL = '@cf/meta/llama-3.2-11b-vision-instruct'
MAX_IMAGE = 196608
MAX_BODY = MAX_IMAGE + 128
ORIGIN = 'https://ziipa.com/internal/title-inference'
_slot = threading.BoundedSemaphore(1)
_COUNT = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n"
_RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0"


class TitleSettings(BaseSettings):
    enabled: bool = False
    model_config = SettingsConfigDict(env_prefix='TITLE_AI_', env_file='.env', extra='ignore')


config = TitleSettings()


class TitleInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, hide_input_in_errors=True)
    image: str = Field(min_length=16, max_length=MAX_IMAGE, pattern=r'^[A-Za-z0-9+/]+={0,2}$')
    consent: bool

    def preview(self):
        if self.consent is not True:
            raise ValueError('Explicit consent is required')
        image = base64.b64decode(self.image, validate=True)
        if (not image.startswith(b'\xff\xd8\xff') or not image.endswith(b'\xff\xd9')
                or base64.b64encode(image).decode() != self.image):
            raise ValueError('Use a resized JPEG preview')
        return image


def _bridge(image=None):
    if len(settings.ziipa_proxy_secret) < 32:
        raise ValueError('Title inference is not configured')
    body = b'' if image is None else json.dumps({'image': image}, separators=(',', ':')).encode()
    stamp = str(int(time.time()))
    message = f'ziipa-title-v1\n{stamp}\n{hashlib.sha256(body).hexdigest()}'
    signature = hmac.new(settings.ziipa_proxy_secret.encode(), message.encode(), hashlib.sha256).hexdigest()
    headers = {'X-Ziipa-Title-Timestamp': stamp, 'X-Ziipa-Title-Signature': signature,
               'Content-Type': 'application/json'}
    with httpx.Client(timeout=22 if image is not None else 2, trust_env=False, follow_redirects=False) as client:
        with client.stream('POST' if image is not None else 'GET', ORIGIN + ('' if image is not None else '/status'),
                           headers=headers, content=body) as response:
            response.raise_for_status()
            chunks, size = [], 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > 4096:
                    raise ValueError('Oversized title response')
                chunks.append(chunk)
            value = json.loads(b''.join(chunks))
    if not isinstance(value, dict) or value.get('model') != MODEL:
        raise ValueError('Unexpected title provider')
    return value


@router.get('/config')
def configuration():
    available = False
    if config.enabled:
        try:
            status = _bridge()
            available = status.get('available') is True and status.get('metadata_version') == 2
        except (httpx.HTTPError, ValueError, TypeError):
            pass
    return {'available': available, 'metadata_version': 2, 'provider': 'Cloudflare Workers AI',
            'detail': ('AI autofill shares one resized photo or video frame with Cloudflare Workers AI to suggest a title and description. '
                       'Suggestions fill the editing form. No filename, audio or account history is sent. Review before saving.' if available else
                       'AI autofill is not available yet. Enter your own title and description.')}


@contextmanager
def title_budget(owner_id):
    if not _slot.acquire(blocking=False):
        raise HTTPException(429, 'Title suggestions are busy. Try again shortly.')
    token, leased = uuid.uuid4().hex, False
    key = 'editor:title:slot'
    try:
        leased = bool(cache.set(key, token, nx=True, ex=35))
        if not leased:
            raise HTTPException(429, 'Title suggestions are busy. Try again shortly.')
        if cache.eval(_COUNT, 1, f'editor:title:user:{owner_id}', 600) > 4:
            raise HTTPException(429, 'Your free title suggestion allowance is reached. Try again later.')
        day = datetime.now(timezone.utc).strftime('%Y%m%d')
        if cache.eval(_COUNT, 1, f'editor:title:day:{day}', 90000) > 20:
            raise HTTPException(429, 'The free title suggestion allowance is reached. Enter your own title for now.')
        yield
    except RedisError:
        raise HTTPException(503, 'Title suggestion limits are unavailable. Enter your own title for now.') from None
    finally:
        if leased:
            try:
                cache.eval(_RELEASE, 1, key, token)
            except RedisError:
                pass
        _slot.release()


def propose(data: TitleInput, user: User, session: Session):
    from admin_services import require_mutations_open
    require_mutations_open(session, user)
    if not config.enabled:
        raise HTTPException(503, 'AI title suggestions are not enabled. Enter your own title for now.')
    owner_id = user.id
    with title_budget(owner_id):
        try:
            output = _bridge(data.image)
            title = output.get('title')
            description = output.get('description')
            if (not isinstance(title, str) or not 1 <= len(title.strip()) <= 140
                    or any(ord(char) < 32 or ord(char) == 127 or char in '<>' for char in title) or '://' in title):
                raise ValueError('Invalid title')
            if (not isinstance(description, str) or not 1 <= len(description.strip()) <= 600
                    or any(ord(char) < 32 or ord(char) == 127 or char in '<>' for char in description) or '://' in description):
                raise ValueError('Invalid description')
        except (httpx.HTTPError, ValueError, TypeError):
            raise HTTPException(503, 'A title could not be suggested. Try again or enter your own title.') from None
        session.expire_all()
        actor = session.scalar(select(User).where(User.id == owner_id).execution_options(populate_existing=True))
        if actor is None:
            raise HTTPException(401, 'Please sign in again.')
        require_mutations_open(session, actor)
        return {'title': title.strip(), 'description': description.strip(), 'review_required': True}


@router.post('/suggest', dependencies=[Depends(guard)])
async def suggest(request: Request, user: User = Depends(current_user), session: Session = Depends(db)):
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json' or request.headers.get('content-encoding'):
        raise HTTPException(415, 'Use a JPEG preview in a JSON request.')
    body = bytearray()
    try:
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY:
                raise HTTPException(413, 'The title preview is too large.')
        data = TitleInput.model_validate_json(body)
        data.preview()
    except (ValidationError, ValueError, TypeError):
        # Never echo private image bytes or a data URI in validation errors.
        raise HTTPException(400, 'Allow preview sharing and supply one small JPEG preview.') from None
    return await run_in_threadpool(propose, data, user, session)
