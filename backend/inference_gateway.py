"""Private, bounded inference transport. It cannot execute tools or manage models.

Run one Uvicorn worker with ``inference_gateway:create_app --factory``. Keep the
Ollama server on loopback or the isolated ``ollama`` Docker service; only this
authenticated gateway may be routed through the optional outbound TLS tunnel.
"""
from __future__ import annotations

import asyncio
from collections import deque
import hmac
import json
import re
import threading
import time
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from starlette.responses import JSONResponse

MAX_REQUEST_BYTES = 32768
MAX_RESPONSE_BYTES = 32768
MAX_TEXT_BYTES = 16000
BODY_TIMEOUT_SECONDS = 10


class GatewaySettings(BaseSettings):
    api_key: SecretStr
    model: str = 'qwen3:1.7b'
    ollama_url: str = 'http://127.0.0.1:11434'
    timeout_seconds: int = Field(default=45, ge=10, le=90)
    requests_per_minute: int = Field(default=12, ge=1, le=30)
    context_tokens: int = Field(default=6144, ge=1024, le=6144)
    output_tokens: int = Field(default=650, ge=64, le=700)
    model_config = SettingsConfigDict(env_prefix='ZIIPA_INFERENCE_', extra='ignore', hide_input_in_errors=True)

    @field_validator('api_key')
    @classmethod
    def secure_key(cls, value):
        if (not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', value.get_secret_value())
                or value.get_secret_value().lower().startswith('replace-')):
            raise ValueError('Use a random URL-safe inference key of at least 32 characters')
        return value

    @field_validator('model')
    @classmethod
    def downloaded_model(cls, value):
        if not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,120}', value) or 'cloud' in value.lower():
            raise ValueError('Choose a downloaded model; cloud models are not supported')
        return value

    @field_validator('ollama_url')
    @classmethod
    def private_ollama(cls, value):
        try:
            parsed = urlsplit(value)
            if (parsed.scheme != 'http' or parsed.hostname not in {'localhost', '127.0.0.1', '::1', 'ollama'}
                    or parsed.port not in {None, 11434} or parsed.username or parsed.password
                    or parsed.path not in {'', '/'} or parsed.query or parsed.fragment):
                raise ValueError
        except ValueError:
            raise ValueError('Ollama must use loopback or the isolated ollama Docker service on port 11434') from None
        return value.rstrip('/')


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['system', 'user', 'assistant']
    content: str = Field(min_length=1, max_length=12000)


class ChatInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    messages: list[ChatMessage] = Field(min_length=1, max_length=12)
    format: dict

    @model_validator(mode='after')
    def bounded_input(self):
        if sum(len(message.content.encode('utf-8')) for message in self.messages) > MAX_TEXT_BYTES:
            raise ValueError('Private context and messages exceed the inference limit')
        branches = self.format.get('oneOf')
        object_union = (isinstance(branches, list) and 1 <= len(branches) <= 8
                        and all(isinstance(branch, dict) and branch.get('type') == 'object' for branch in branches))
        if (self.format.get('type') != 'object' and not object_union) or len(json.dumps(self.format).encode('utf-8')) > 12000:
            raise ValueError('Provide a bounded JSON object schema')
        pending, count = [(self.format, 0)], 0
        while pending:
            node, depth = pending.pop(); count += 1
            if depth > 16 or count > 800:
                raise ValueError('The response schema is too complex')
            if isinstance(node, dict):
                for key, value in node.items():
                    if key in {'$ref', '$dynamicRef'} and (not isinstance(value, str) or not value.startswith('#/')):
                        raise ValueError('External schema references are not supported')
                    pending.append((value, depth + 1))
            elif isinstance(node, list):
                pending.extend((value, depth + 1) for value in node)
        return self


class PrivateBoundary:
    """Authenticate before reading bodies and cap chunked bodies before parsing."""
    def __init__(self, app, key: str):
        self.app, self.key = app, ('Bearer ' + key).encode('ascii')

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        if scope.get('path') != '/livez':
            authorization = [value for name, value in scope['headers'] if name.lower() == b'authorization']
            if len(authorization) != 1 or not hmac.compare_digest(authorization[0], self.key):
                return await JSONResponse({'detail': 'Inference authentication required'}, status_code=401,
                                          headers={'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store'})(scope, receive, send)
        if scope['method'] == 'POST':
            content_types = [value for name, value in scope['headers'] if name.lower() == b'content-type']
            if len(content_types) != 1 or content_types[0].split(b';')[0].strip().lower() != b'application/json':
                return await JSONResponse({'detail': 'Use application/json'}, status_code=415)(scope, receive, send)
            lengths = [value for name, value in scope['headers'] if name.lower() == b'content-length']
            if lengths:
                try:
                    if len(lengths) != 1 or not lengths[0].isdigit() or int(lengths[0]) > MAX_REQUEST_BYTES:
                        raise ValueError
                except ValueError:
                    return await JSONResponse({'detail': 'Inference request is too large'}, status_code=413)(scope, receive, send)
            parts, size = [], 0
            try:
                async with asyncio.timeout(BODY_TIMEOUT_SECONDS):
                    while True:
                        message = await receive()
                        if message['type'] == 'http.disconnect':
                            return
                        part = message.get('body', b''); size += len(part)
                        if size > MAX_REQUEST_BYTES:
                            return await JSONResponse({'detail': 'Inference request is too large'}, status_code=413)(scope, receive, send)
                        parts.append(part)
                        if not message.get('more_body', False):
                            break
            except TimeoutError:
                return await JSONResponse({'detail': 'Inference request body timed out'}, status_code=408)(scope, receive, send)
            body, delivered = b''.join(parts), False
            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': body, 'more_body': False}
                return await receive()
            return await self.app(scope, bounded_receive, send)
        await self.app(scope, receive, send)


class Gateway:
    def __init__(self, settings: GatewaySettings):
        self.settings = settings
        self.slot = threading.BoundedSemaphore(1)
        self.rate_lock = threading.Lock()
        self.requests = deque()

    def consume_budget(self):
        stamp = time.monotonic()
        with self.rate_lock:
            while self.requests and self.requests[0] <= stamp - 60:
                self.requests.popleft()
            if len(self.requests) >= self.settings.requests_per_minute:
                raise HTTPException(429, 'Inference budget reached; retry later', headers={'Retry-After': '60'})
            self.requests.append(stamp)

    async def request(self, path: str, payload=None, timeout=4):
        # No environment proxies, redirects, URL input, retries or arbitrary paths.
        async with asyncio.timeout(timeout):
            async with httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False) as client:
                async with client.stream('POST' if payload is not None else 'GET', self.settings.ollama_url + path,
                                         json=payload) as response:
                    response.raise_for_status()
                    parts, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_RESPONSE_BYTES:
                            raise ValueError('Oversized inference response')
                        parts.append(chunk)
                    return json.loads(b''.join(parts))

    async def ready(self):
        try:
            data = await self.request('/api/tags')
            return any(isinstance(item, dict) and item.get('name') == self.settings.model
                       and isinstance(item.get('size'), int) and item['size'] > 0
                       for item in data.get('models', []))
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError, AttributeError):
            return False


def create_app(settings: GatewaySettings | None = None) -> FastAPI:
    """Factory deliberately requires the gateway key at startup, never a default."""
    settings = settings or GatewaySettings()
    gateway = Gateway(settings)
    app = FastAPI(title='Ziipa private inference', docs_url=None, redoc_url=None, openapi_url=None)
    app.state.gateway = gateway
    app.add_middleware(PrivateBoundary, key=settings.api_key.get_secret_value())

    @app.exception_handler(RequestValidationError)
    async def invalid_input(_request, _failure):
        # Do not echo a private prompt or supplied credentials in diagnostics.
        return JSONResponse({'detail': 'Invalid bounded inference request'}, status_code=422)

    @app.middleware('http')
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.get('/livez')
    async def live():
        return {'status': 'ok'}

    @app.get('/v1/health')
    async def health():
        return {'available': await gateway.ready(), 'model': settings.model}

    @app.post('/v1/chat')
    async def chat(data: ChatInput):
        if not gateway.slot.acquire(blocking=False):
            raise HTTPException(503, 'Inference is busy; retry later', headers={'Retry-After': '5'})
        try:
            gateway.consume_budget()
            result = await gateway.request('/api/chat', {
                'model': settings.model, 'messages': [message.model_dump() for message in data.messages],
                'format': data.format, 'stream': False, 'think': False, 'keep_alive': '3m',
                'options': {'temperature': 0.2, 'num_ctx': settings.context_tokens,
                            'num_predict': settings.output_tokens},
            }, timeout=settings.timeout_seconds)
            content = result.get('message', {}).get('content', '')
            if (result.get('done') is not True or result.get('model') != settings.model
                    or not isinstance(content, str) or len(content.encode('utf-8')) > MAX_TEXT_BYTES):
                raise ValueError
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                raise ValueError
            return {'result': parsed, 'model': settings.model}
        except (httpx.HTTPError, TimeoutError):
            raise HTTPException(503, 'The private model is unavailable; no tools were executed') from None
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(502, 'The private model returned an invalid plan; no tools were executed') from None
        finally:
            gateway.slot.release()
    return app
