"""Offline preset narration consent, budgets, signed transport and real PCM checks."""
from array import array
import base64
import hashlib
import hmac
import io
import json
import math
import struct
import sys
import threading
import wave

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest
from redis.exceptions import RedisError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, guard
from admin_services import AdminSettings, AdminUserState
import narration_api as narration


def request(**changes):
    return {'version': 1, 'text': 'Welcome to my original creation.', 'voice_id': 'athena',
            'consent': True, 'expected_provider': 'cloudflare', **changes}


def wav(*, rate=24000, channels=1, width=2, frames=2400, extra=False):
    pcm = array('h', (round(math.sin(index * 2 * math.pi * 440 / rate) * 10000) for index in range(frames)))
    if sys.byteorder != 'little':
        pcm.byteswap()
    data = pcm.tobytes()
    if width != 2:
        data = bytes(frames * width)
    data *= channels
    chunks = struct.pack('<4sIHHIIHH', b'fmt ', 16, 1, channels, rate, rate * width * channels, width * channels, width * 8)
    if extra:
        chunks += b'JUNK' + struct.pack('<I', 4) + b'test'
    chunks += b'data' + struct.pack('<I', len(data)) + data
    return b'RIFF' + struct.pack('<I', len(chunks) + 4) + b'WAVE' + chunks


class BudgetCache:
    def __init__(self):
        self.values = {}
        self.calls = []
    def set(self, key, value, nx=False, ex=None):
        self.calls.append(('set', key, nx, ex))
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True
    def eval(self, script, count, *arguments):
        self.calls.append(('eval', script, count, arguments))
        if script == narration._RELEASE:
            key, token = arguments
            if self.values.get(key) == token:
                del self.values[key]
                return 1
            return 0
        assert script == narration._BUDGET and count == 3
        user, global_, chars, length = arguments
        if self.values.get(user, 0) >= 3:
            return -1
        if self.values.get(global_, 0) >= 10:
            return -2
        if self.values.get(chars, 0) + length > 4000:
            return -3
        for key, amount in [(user, 1), (global_, 1), (chars, length)]:
            self.values[key] = self.values.get(key, 0) + amount
        return 1


@pytest.fixture
def workspace(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        owner = User(name='Narrator', email='narration@example.test', password_hash='unused')
        session.add(owner); session.commit()
        actor = {'user': owner}
        app = FastAPI(); app.include_router(narration.router)
        def signed_in():
            if actor['user'] is None:
                raise HTTPException(401, 'Please sign in')
            return actor['user']
        app.dependency_overrides.update({db: lambda: session, current_user: signed_in, guard: lambda: None})
        budget = BudgetCache()
        calls = []
        monkeypatch.setattr(narration, 'cache', budget)
        monkeypatch.setattr(narration, '_slot', threading.BoundedSemaphore(1))
        monkeypatch.setattr(narration, 'provider_status', lambda: True)
        monkeypatch.setattr(narration, 'cloudflare', lambda payload=None: calls.append(payload) or wav(extra=True))
        with TestClient(app) as client:
            yield client, session, owner, actor, budget, calls
    engine.dispose()


def test_real_pcm_narration_response_and_exact_inference_payload(workspace):
    client, _, _, actor, _, calls = workspace
    response = client.post('/api/audio/narration', json=request())
    assert response.status_code == 200
    result = response.json()
    assert calls == [{'version': 1, 'text': request()['text'], 'voice_id': 'athena'}]
    audio = base64.b64decode(result['audio_base64'], validate=True)
    assert result['sha256'] == hashlib.sha256(audio).hexdigest()
    assert result['provider'] == 'cloudflare' and result['model'] == narration.MODEL
    assert result['format'] == 'wav' and result['sample_rate'] == 22050
    assert result['duration_seconds'] == .1 and len(audio) == 44 + 2205 * 2
    assert b'JUNK' not in audio[:44]
    with wave.open(io.BytesIO(audio), 'rb') as stream:
        assert (stream.getnchannels(), stream.getsampwidth(), stream.getframerate(), stream.getnframes()) == (1, 2, 22050, 2205)
        assert max(array('h', stream.readframes(2205))) > 9000
    actor['user'] = None
    assert client.get('/api/audio/narration/config').status_code == 401
    assert client.post('/api/audio/narration', json=request()).status_code == 401


@pytest.mark.parametrize('changes', [
    {'version': True}, {'version': 1.0}, {'version': '1'}, {'consent': False}, {'consent': 1},
    {'text': ''}, {'text': ' '}, {'text': 'x' * 301}, {'text': '\x00'}, {'text': '\ud800'},
    {'voice_id': 'custom'}, {'expected_provider': 'private'}, {'reference_audio': 'private.wav'},
    {'model': 'arbitrary'}, {'url': 'https://external.example'},
])
def test_strict_request_rejected_before_status_or_inference(workspace, monkeypatch, changes):
    client, *_, calls = workspace
    monkeypatch.setattr(narration, 'provider_status', lambda: pytest.fail('invalid input must not query status'))
    # ensure_ascii keeps an invalid surrogate inside JSON rather than failing the client encoder.
    response = client.post('/api/audio/narration', content=json.dumps(request(**changes)), headers={'Content-Type': 'application/json'})
    assert response.status_code == 422 and not calls


def test_missing_consent_and_disabled_status_never_generate_or_spend(workspace, monkeypatch):
    client, _, _, _, budget, calls = workspace
    missing = request(); del missing['consent']
    assert client.post('/api/audio/narration', json=missing).status_code == 422
    monkeypatch.setattr(narration, 'provider_status', lambda: False)
    result = client.get('/api/audio/narration/config').json()
    assert result['available'] is False and result['model'] == narration.MODEL
    assert all(voice['available'] is False for voice in result['voices'])
    assert result['clone'] == {'available': False, 'verified': False, 'max_reference_seconds': 20,
                               'max_reference_bytes': 2097152,
                               'detail': 'Private free voice-cloning runtime is unavailable. No voice sample upload or retention is enabled.'}
    assert client.post('/api/audio/narration', json=request()).status_code == 503
    assert not calls and not budget.calls


def test_daily_per_user_limit_does_not_burn_shared_allowance(workspace):
    client, _, _, _, budget, calls = workspace
    for _ in range(3):
        assert client.post('/api/audio/narration', json=request()).status_code == 200
    before = dict(budget.values)
    assert client.post('/api/audio/narration', json=request()).status_code == 429
    assert budget.values == before and len(calls) == 3


def test_cross_user_daily_and_character_caps_are_enforced_before_generation(workspace):
    *_, budget, calls = workspace
    for owner in range(10):
        with narration.inference_budget(owner, 20):
            pass
    with pytest.raises(HTTPException) as error:
        with narration.inference_budget(11, 20):
            pytest.fail('global cap must deny')
    assert error.value.status_code == 429 and not calls
    budget.values.clear()
    with narration.inference_budget(1, 4000):
        pass
    before = dict(budget.values)
    with pytest.raises(HTTPException) as error:
        with narration.inference_budget(2, 1):
            pytest.fail('character cap must deny')
    assert error.value.status_code == 429 and budget.values == before


def test_missing_redis_or_global_and_local_concurrency_fail_closed(workspace, monkeypatch):
    client, _, _, _, budget, calls = workspace
    budget.values['narration:inference:slot'] = 'another-owner'
    assert client.post('/api/audio/narration', json=request()).status_code == 429
    assert budget.values['narration:inference:slot'] == 'another-owner' and not calls
    budget.values.clear()
    assert narration._slot.acquire(blocking=False)
    try:
        assert client.post('/api/audio/narration', json=request()).status_code == 429
    finally:
        narration._slot.release()
    monkeypatch.setattr(budget, 'set', lambda *a, **k: (_ for _ in ()).throw(RedisError('sensitive detail')))
    response = client.post('/api/audio/narration', json=request())
    assert response.status_code == 503 and 'sensitive' not in response.text and not calls


@pytest.mark.parametrize('raw', [b'', b'not wav', wav(rate=22050), wav(channels=2), wav(width=1),
    wav(frames=720001), wav()[:-1], wav() + b'junk'],
    ids=['empty', 'not-wav', 'wrong-rate', 'stereo', 'eight-bit', 'too-long', 'truncated', 'trailing-data'])
def test_malformed_unsupported_and_oversized_wav_rejected_without_fallback(workspace, monkeypatch, raw):
    client, _, _, _, budget, calls = workspace
    monkeypatch.setattr(narration, 'cloudflare', lambda payload=None: calls.append(payload) or raw)
    response = client.post('/api/audio/narration', json=request())
    assert response.status_code == 503 and 'audio_base64' not in response.json()
    assert len(calls) == 1 and 'narration:inference:slot' in budget.values
    assert client.post('/api/audio/narration', json=request()).status_code == 429
    assert len(calls) == 1


def test_maximum_pcm_is_bounded_and_extra_or_duplicate_chunks_cannot_evade_format_check():
    audio, duration = narration.canonical_audio(wav(frames=720000, extra=True))
    assert duration == 30 and len(audio) == 44 + 22050 * 30 * 2
    raw = wav()
    duplicate = raw[:12] + raw[12:36] + raw[12:]
    duplicate = duplicate[:4] + struct.pack('<I', len(duplicate) - 8) + duplicate[8:]
    with pytest.raises(ValueError):
        narration.canonical_audio(duplicate)
    with pytest.raises(ValueError):
        narration.canonical_audio(b'RIFF' + struct.pack('<I', narration.MAX_WAV_BYTES) + b'WAVE' + bytes(narration.MAX_WAV_BYTES))


def test_cumulative_header_budget_rejects_excess_metadata_even_with_small_pcm():
    original = wav()
    for excess in (0, 2, 100000):
        junk = bytes(65536 - 44 - 8 + excess)
        raw = original[:36] + b'JUNK' + struct.pack('<I', len(junk)) + junk + original[36:]
        raw = raw[:4] + struct.pack('<I', len(raw) - 8) + raw[8:]
        if excess:
            with pytest.raises(ValueError, match='metadata'):
                narration.canonical_audio(raw)
        else:
            assert narration.canonical_audio(raw) == narration.canonical_audio(original)


def test_status_is_exact_free_verified_model_gate_and_disabled_does_not_call_bridge(monkeypatch):
    monkeypatch.setattr(narration.settings, 'ziipa_proxy_secret', 'fixture-only-secret-' * 3)
    monkeypatch.setattr(narration.config, 'enabled', False)
    monkeypatch.setattr(narration, 'cloudflare', lambda: pytest.fail('disabled must not call bridge'))
    assert narration.provider_status() is False
    monkeypatch.setattr(narration.config, 'enabled', True)
    for value, expected in [({'version': 1, 'available': True, 'model': narration.MODEL}, True),
                            ({'version': True, 'available': True, 'model': narration.MODEL}, False),
                            ({'version': 1, 'available': 1, 'model': narration.MODEL}, False),
                            ({'version': 1, 'available': True, 'model': 'other'}, False)]:
        monkeypatch.setattr(narration, 'cloudflare', lambda: value)
        assert narration.provider_status() is expected


def test_fixed_signed_transport_confines_text_to_one_bridge_and_bounds_responses(monkeypatch):
    real_client = httpx.Client
    secret = 'fixture-bridge-secret-' * 3
    monkeypatch.setattr(narration.settings, 'ziipa_proxy_secret', secret)
    monkeypatch.setattr(narration.time, 'time', lambda: 1780000000)
    seen = []
    def handler(req):
        seen.append(req)
        assert str(req.url) in {narration.ORIGIN + narration.PATH, narration.ORIGIN + narration.PATH + '/status'}
        assert 'authorization' not in req.headers and 'cookie' not in req.headers
        signed = 'ziipa-narration-v1\n1780000000\n' + hashlib.sha256(req.content).hexdigest()
        assert req.headers['X-Ziipa-Narration-Signature'] == hmac.new(secret.encode(), signed.encode(), hashlib.sha256).hexdigest()
        if req.method == 'GET':
            assert req.content == b''
            return httpx.Response(200, json={'version': 1, 'model': narration.MODEL, 'available': True})
        assert json.loads(req.content) == {'version': 1, 'text': 'Original line', 'voice_id': 'orion'}
        return httpx.Response(200, content=wav(), headers={'content-type': 'audio/wav'})
    def client(**kwargs):
        assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        return real_client(transport=httpx.MockTransport(handler), **kwargs)
    monkeypatch.setattr(narration.httpx, 'Client', client)
    assert narration.cloudflare()['available'] is True
    assert narration.canonical_audio(narration.cloudflare({'version': 1, 'text': 'Original line', 'voice_id': 'orion'}))[1] == .1
    assert len(seen) == 2


@pytest.mark.parametrize('response', [
    lambda: httpx.Response(302, headers={'location': 'https://other.example'}),
    lambda: httpx.Response(500, text='private upstream diagnostics'),
    lambda: httpx.Response(200, content=b'x', headers={'content-type': 'text/html'}),
    lambda: httpx.Response(200, content=b'x' * (narration.MAX_WAV_BYTES + 1), headers={'content-type': 'audio/wav'}),
])
def test_transport_rejects_redirects_unexpected_types_and_oversize(monkeypatch, response):
    real_client = httpx.Client
    monkeypatch.setattr(narration.settings, 'ziipa_proxy_secret', 'fixture-secret-' * 4)
    monkeypatch.setattr(narration.httpx, 'Client', lambda **kwargs: real_client(transport=httpx.MockTransport(lambda _: response()), **kwargs))
    with pytest.raises(ValueError):
        narration.cloudflare({'version': 1, 'text': 'A line', 'voice_id': 'orion'})


def test_guard_and_suspension_block_before_provider(workspace):
    client, session, owner, _, _, calls = workspace
    session.add(AdminUserState(user_id=owner.id, status='suspended')); session.commit()
    assert client.post('/api/audio/narration', json=request()).status_code == 403 and not calls


@pytest.mark.parametrize('change', ['suspend', 'maintenance', 'delete'])
def test_authority_change_during_generation_discards_audio(workspace, monkeypatch, change):
    client, session, owner, _, _, calls = workspace
    def inference(payload):
        calls.append(payload)
        if change == 'suspend':
            session.add(AdminUserState(user_id=owner.id, role='member', status='suspended'))
        elif change == 'maintenance':
            session.add(AdminSettings(id=1, maintenance_mode=True))
        else:
            session.delete(owner)
        session.commit()
        return wav()
    monkeypatch.setattr(narration, 'cloudflare', inference)
    response = client.post('/api/audio/narration', json=request())
    assert response.status_code == {'suspend': 403, 'maintenance': 503, 'delete': 401}[change]
    assert 'audio_base64' not in response.json() and len(calls) == 1


def test_mutation_guard_is_required_and_production_routes_registered(workspace):
    client, *_, calls = workspace
    def deny():
        raise HTTPException(403, 'Protected mutation')
    client.app.dependency_overrides[guard] = deny
    assert client.post('/api/audio/narration', json=request()).status_code == 403 and not calls
    from app import app
    assert {'/api/audio/narration/config', '/api/audio/narration'} <= set(app.openapi()['paths'])
