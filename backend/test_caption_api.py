"""Private caption proposal boundaries; providers are always mocked unless opted in."""
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import threading
import time
import uuid
import wave

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, guard
from admin_services import AdminUserState
import caption_api as captions
from creator import CreatorItem, CreatorMedia, ItemInput, bootstrap, save_item, serialize_item
from personal_media import OSAssetMetadata
from render_services import input_fingerprint
REAL_TRANSCRIBE = captions.speech.transcribe_media


class PrivateCache:
    def __init__(self):
        self.values, self.sets = {}, {}
    def get(self, key):
        return self.values.get(key)
    def set(self, key, value, *, nx=False, ex=None):
        assert ex and ex <= 90000
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True
    def delete(self, key):
        self.sets.pop(key, None)
        return self.values.pop(key, None) is not None
    def sadd(self, key, value):
        self.sets.setdefault(key, set()).add(value)
    def smembers(self, key):
        return self.sets.get(key, set())
    def expire(self, key, ttl):
        assert ttl == captions.TTL
    def eval(self, script, count, key, *arguments):
        assert count == 1
        if script == captions._COUNT:
            self.values[key] = self.values.get(key, 0) + 1
            return self.values[key]
        if script == captions._RELEASE:
            return self.delete(key) if self.values.get(key) == arguments[0] else 0
        assert script == captions._REPLACE
        old, ttl, new = arguments
        return int(self.set(key, new, ex=ttl)) if self.values.get(key) == old else 0


class CapturedPool:
    def __init__(self):
        self.pending = []
    def submit(self, function, job_id):
        self.pending.append((function, job_id))
    def run(self):
        function, job_id = self.pending.pop(0)
        function(job_id)


@pytest.fixture
def workspace(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as session:
        owner = User(name='Caption owner', email='captions@example.test', password_hash='unused')
        other = User(name='Caption stranger', email='other-captions@example.test', password_hash='unused')
        session.add_all([owner, other]); session.flush()
        media = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=123)
        item = CreatorItem(owner_id=owner.id, data=ItemInput(title='Private speech', media_id=media.id,
            trim_start=1, trim_end=3, captions=[{'start': 0, 'end': .5, 'text': 'Existing caption'}]).model_dump())
        session.add_all([media, item]); session.flush()
        rights = OSAssetMetadata(owner_id=owner.id, item_id=item.id, rights={'basis': 'original', 'allow_ai': True})
        session.add(rights); session.commit()
        actor = {'user': owner}
        cache, pool = PrivateCache(), CapturedPool()
        monkeypatch.setattr(captions, 'cache', cache)
        monkeypatch.setattr(captions, '_pool', pool)
        monkeypatch.setattr(captions, '_slot', threading.BoundedSemaphore(1))
        monkeypatch.setattr(captions, 'SessionLocal', factory)
        monkeypatch.setattr(captions.config, 'enabled', True)
        monkeypatch.setattr(captions.config, 'inference_provider', 'private')
        monkeypatch.setattr(captions, 'readiness', lambda: {'can_run': True})
        def fake_speech(*args, before_recognize=None, **kwargs):
            if before_recognize:
                before_recognize()
            return {'status': 'ready', 'segments': [{'start': .2, 'end': 1.7, 'text': 'Welcome to Ziipa'}],
                'detail': 'Machine transcript; review before applying.'}
        monkeypatch.setattr(captions.speech, 'transcribe_media', fake_speech)
        app = FastAPI(); app.include_router(captions.router)
        def signed_in():
            if actor['user'] is None:
                raise HTTPException(401, 'Sign in')
            return actor['user']
        app.dependency_overrides.update({db: lambda: session, current_user: signed_in, guard: lambda: None})
        with TestClient(app) as client:
            yield client, session, owner, other, item, media, rights, cache, pool, actor
    engine.dispose()


def request(media, **changes):
    return {'request_id': str(uuid.uuid4()), 'expected_media_id': media.id, 'consent': True, 'language': 'auto',
        'expected_provider': 'private', **changes}


def create(workspace, **changes):
    client, _, _, _, item, media, *_ = workspace
    return client.post(f'/api/editor/items/{item.id}/captions', json=request(media, **changes))


def test_real_background_contract_no_saved_edit_mutation(workspace):
    client, session, _, _, item, _, _, cache, pool, _ = workspace
    original = json.loads(json.dumps(item.data))
    response = create(workspace)
    assert response.status_code == 202
    value = response.json()
    assert value['status'] == 'queued' and value['clock'] == 'source' and value['segments'] == []
    assert not {'owner_id', 'token', 'deadline', 'request_id'} & set(value)
    pool.run()
    result = client.get('/api/editor/caption-jobs/' + value['job_id']).json()
    assert result['status'] == 'ready' and result['segments'][0]['start'] == .2
    assert result['source_media_id'] == original['media_id']
    assert result['segments'][0]['end'] == 1.7  # Raw source clock, not trim/output clock.
    session.refresh(item)
    assert item.data == original and cache.get(captions._LEASE_KEY) is None


@pytest.mark.parametrize('status,detail', [
    ('no_speech', 'No speech was recognized.'),
    ('unavailable', 'The speech runtime is unavailable.'),
])
def test_empty_or_unavailable_recognition_preserves_saved_caption_track(workspace, monkeypatch, status, detail):
    client, session, _, _, item, _, _, cache, pool, _ = workspace
    original = json.loads(json.dumps(item.data))

    def recognize(*args, before_recognize=None, **kwargs):
        if before_recognize:
            before_recognize()
        return {'status': status, 'segments': [], 'detail': detail}

    monkeypatch.setattr(captions.speech, 'transcribe_media', recognize)
    response = create(workspace)
    assert response.status_code == 202
    pool.run()
    result = client.get('/api/editor/caption-jobs/' + response.json()['job_id'])
    assert result.status_code == 200
    assert result.json()['status'] == status and result.json()['segments'] == []
    session.refresh(item)
    assert item.data == original
    assert item.data['captions'] == [{'start': 0, 'end': .5, 'text': 'Existing caption'}]
    assert cache.get(captions._LEASE_KEY) is None


@pytest.mark.parametrize('changes', [{'consent': False}, {'consent': 1}, {'consent': 'true'},
    {'language': 'en'}, {'media_url': 'https://private.example/source.mp4'}, {'expected_media_id': '../secret'},
    {'expected_provider': 'arbitrary'}, {'request_id': 'not-a-uuid'}])
def test_bounded_input_rejected_without_background_work(workspace, changes):
    response = create(workspace, **changes)
    assert response.status_code == 422
    assert not workspace[8].pending and not workspace[7].values


def test_auth_owner_rights_and_exact_selected_source_precede_queue(workspace):
    client, session, owner, other, item, _, rights, cache, pool, actor = workspace
    actor['user'] = other
    assert create(workspace).status_code == 404
    actor['user'] = None
    assert client.get('/api/editor/captions/config').status_code == 401
    actor['user'] = owner
    assert create(workspace, expected_media_id=str(uuid.uuid4())).status_code == 409
    rights.rights = {'basis': 'original', 'allow_ai': False}; session.commit()
    assert create(workspace).status_code == 403
    assert not pool.pending and not cache.values


@pytest.mark.parametrize('kind,size', [('image/png', 123), ('video/mp4', 100 * 1024 * 1024 + 1), ('audio/wav', 0)])
def test_unsupported_source_never_reaches_engine(workspace, kind, size):
    _, session, _, _, _, media, *_ = workspace
    media.content_type, media.size = kind, size; session.commit()
    assert create(workspace).status_code == 422
    assert not workspace[8].pending


def test_provider_change_requires_new_explicit_consent(workspace, monkeypatch):
    monkeypatch.setattr(captions.config, 'inference_provider', 'cloudflare')
    assert create(workspace).status_code == 409
    assert create(workspace, expected_provider='cloudflare').status_code == 202


def test_unavailable_runtime_never_queues_a_placeholder(workspace, monkeypatch):
    monkeypatch.setattr(captions, 'readiness', lambda: {'can_run': False})
    assert create(workspace).status_code == 503
    assert not workspace[8].pending and not workspace[7].values


def test_exact_request_retries_reuse_one_job_and_changed_request_is_rejected(workspace):
    client, _, _, _, item, media, _, _, pool, _ = workspace
    body = request(media)
    first = client.post(f'/api/editor/items/{item.id}/captions', json=body)
    second = client.post(f'/api/editor/items/{item.id}/captions', json=body)
    assert first.status_code == second.status_code == 202
    assert first.json()['id'] == second.json()['id'] and len(pool.pending) == 1
    body['language'] = 'auto'; body['expected_provider'] = 'cloudflare'
    assert client.post(f'/api/editor/items/{item.id}/captions', json=body).status_code == 409
    assert create(workspace).status_code == 429


@pytest.mark.parametrize('change', ['rights', 'source', 'suspend', 'provider', 'disable', 'delete_job'])
def test_revoked_authority_before_inference_never_leaks_transcript(workspace, monkeypatch, change):
    client, session, owner, _, item, media, rights, cache, pool, _ = workspace
    value = create(workspace).json()
    if change == 'rights':
        rights.rights = {'basis': 'original', 'allow_ai': False}
    elif change == 'source':
        media.size += 1
    elif change == 'suspend':
        session.add(AdminUserState(user_id=owner.id, status='suspended'))
    elif change == 'provider':
        monkeypatch.setattr(captions.config, 'inference_provider', 'cloudflare')
    elif change == 'disable':
        monkeypatch.setattr(captions.config, 'enabled', False)
    else:
        captions.delete_caption_jobs(owner.id)
    session.commit()
    monkeypatch.setattr(captions.speech, 'transcribe_media', lambda *a, **k: pytest.fail('Inference after revoked authority'))
    pool.run()
    raw = cache.get(captions._key(value['id']))
    if change == 'delete_job':
        assert raw is None and client.get('/api/editor/caption-jobs/' + value['id']).status_code == 404
    else:
        assert json.loads(raw)['status'] == 'unavailable' and json.loads(raw)['segments'] == []


def test_post_inference_rights_revocation_discards_result(workspace, monkeypatch):
    _, _, _, _, _, _, _, cache, pool, _ = workspace
    response = create(workspace).json()
    def revoke(session, owner_id, item_id, **kwargs):
        metadata = session.scalar(select(OSAssetMetadata).where(OSAssetMetadata.owner_id == owner_id, OSAssetMetadata.item_id == item_id))
        metadata.rights = {'basis': 'original', 'allow_ai': False}; session.commit()
        return {'status': 'ready', 'segments': [{'start': 0, 'end': 1, 'text': 'Must remain private'}], 'detail': 'ready'}
    monkeypatch.setattr(captions.speech, 'transcribe_media', revoke)
    pool.run()
    row = json.loads(cache.get(captions._key(response['id'])))
    assert row['status'] == 'unavailable' and row['segments'] == []


def test_owner_scoped_poll_expiry_and_deleted_job_is_not_resurrected(workspace):
    client, _, owner, other, _, _, _, cache, pool, actor = workspace
    value = create(workspace).json()
    actor['user'] = other
    assert client.get('/api/editor/caption-jobs/' + value['id']).status_code == 404
    actor['user'] = owner
    key = captions._key(value['id']); row = json.loads(cache.get(key)); row['deadline'] = time.time() - 1
    cache.values[key] = captions._encode(row)
    assert client.get('/api/editor/caption-jobs/' + value['id']).json()['status'] == 'unavailable'
    pool.run()
    assert json.loads(cache.get(key))['status'] == 'unavailable'
    captions.delete_caption_jobs(owner.id)
    assert client.get('/api/editor/caption-jobs/' + value['id']).status_code == 404
    assert not [key for key in cache.values if ':request:' in key]


def test_finished_proposal_cannot_be_read_for_changed_source_descriptor(workspace):
    client, session, _, _, _, media, _, _, pool, _ = workspace
    result = create(workspace).json()
    pool.run()
    assert client.get('/api/editor/caption-jobs/' + result['id']).json()['status'] == 'ready'
    media.size += 1; session.commit()
    response = client.get('/api/editor/caption-jobs/' + result['id'])
    assert response.status_code == 409 and 'segments' not in response.json()


def test_user_budget_cannot_consume_shared_daily_allowance(workspace):
    _, _, owner, _, _, _, _, cache, pool, _ = workspace
    for _ in range(3):
        assert create(workspace).status_code == 202
        pool.run()
    daily_key = next(key for key in cache.values if key.startswith('editor:captions:day:'))
    assert cache.values[daily_key] == 3
    assert create(workspace).status_code == 429 and cache.values[daily_key] == 3


def test_failed_executor_submission_releases_lease_and_private_rows(workspace, monkeypatch):
    class BrokenPool:
        def submit(self, *args):
            raise RuntimeError('executor stopped')
    monkeypatch.setattr(captions, '_pool', BrokenPool())
    with pytest.raises(RuntimeError):
        create(workspace)
    cache = workspace[7]
    assert not [key for key in cache.values if ':job:' in key or ':request:' in key or key == captions._LEASE_KEY]
    assert captions._slot.acquire(blocking=False)
    captions._slot.release()


def wav_bytes(frames=1600, channels=1):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as writer:
        writer.setnchannels(channels); writer.setsampwidth(2); writer.setframerate(16000)
        writer.writeframes(b'\1\0' * frames * channels)
    return buffer.getvalue()


def test_cloud_wav_is_exact_pcm_with_no_decoder_metadata(tmp_path):
    path = tmp_path / 'speech.wav'; path.write_bytes(wav_bytes())
    body = captions.canonical_audio(path)
    assert body[:4] == b'RIFF' and body[36:40] == b'data' and len(body) == 44 + 3200
    path.write_bytes(wav_bytes(channels=2))
    with pytest.raises(ValueError):
        captions.canonical_audio(path)
    path.write_bytes(wav_bytes(frames=90 * 16000 + 1))
    with pytest.raises(ValueError):
        captions.canonical_audio(path)


def test_fixed_cloud_transport_hmac_audio_only_no_proxy_or_redirect(monkeypatch):
    monkeypatch.setattr(captions.settings, 'ziipa_proxy_secret', 's' * 40)
    monkeypatch.setattr(captions.time, 'time', lambda: 1234567)
    seen = []
    def dispatch(request):
        seen.append(request)
        return httpx.Response(200, json={'result': {'segments': []}, 'model': captions.CF_MODEL})
    real = httpx.Client
    def client(**kwargs):
        assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        return real(**kwargs, transport=httpx.MockTransport(dispatch))
    monkeypatch.setattr(captions.httpx, 'Client', client)
    body = wav_bytes()
    assert captions._cloud('/internal/caption-inference', body)['model'] == captions.CF_MODEL
    request = seen[0]
    assert str(request.url) == 'https://ziipa.com/internal/caption-inference' and request.content == body
    assert request.headers['content-type'] == 'audio/wav'
    expected = hmac.new(b's' * 40, ('ziipa-caption-v1\n1234567\n' + hashlib.sha256(body).hexdigest()).encode(), hashlib.sha256).hexdigest()
    assert request.headers['x-ziipa-caption-signature'] == expected
    with pytest.raises(ValueError):
        captions._cloud('https://attacker.example/audio', body)


@pytest.mark.parametrize('cue', [
    {'start': True, 'end': 1, 'text': 'text'}, {'start': 0, 'end': float('nan'), 'text': 'text'},
    {'start': 0, 'end': 3.001, 'text': 'text'}, {'start': 1, 'end': 1, 'text': 'text'},
    {'start': 0, 'end': 1, 'text': 'x' * 251}, {'start': 0, 'end': 1, 'text': 123},
    {'start': 0, 'end': 1, 'text': 'text', 'url': 'https://attacker.example'}])
def test_cloud_caption_schema_rejects_untrusted_output(cue):
    with pytest.raises(ValueError):
        captions.cloud_segments({'model': captions.CF_MODEL, 'result': {'segments': [cue]}}, 3)


def test_cloud_actual_timing_is_preserved_not_fabricated_or_rounded():
    rows = [{'start': .00123, 'end': .12345, 'text': ' First\nword '},
            {'start': .12345, 'end': 1.00111, 'text': 'Second'}]
    result = captions.cloud_segments({'model': captions.CF_MODEL, 'result': {'segments': rows}}, 2)
    assert result[0] == {**rows[0], 'text': 'First word'} and result[1] == rows[1]
    rows[1]['start'] = .12344
    with pytest.raises(ValueError):
        captions.cloud_segments({'model': captions.CF_MODEL, 'result': {'segments': rows}}, 2)
    with pytest.raises(ValueError):
        captions.cloud_segments({'model': captions.CF_MODEL, 'result': {'text': 'Untimed text'}}, 2)


@pytest.mark.parametrize('cues', [
    [{'start': True, 'end': 1, 'text': 'No'}], [{'start': '0', 'end': 1, 'text': 'No'}],
    [{'start': 0, 'end': float('inf'), 'text': 'No'}], [{'start': 0, 'end': 91, 'text': 'No'}],
    [{'start': 0, 'end': 2, 'text': 'One'}, {'start': 1, 'end': 3, 'text': 'Overlap'}],
])
def test_raw_caption_track_requires_finite_ordered_source_intervals(cues):
    with pytest.raises(ValidationError):
        ItemInput(title='Owned', caption_source_cues=cues)


def test_accepted_raw_track_is_private_and_does_not_affect_render_hash(workspace):
    _, session, owner, other, item, media, *_ = workspace
    before = input_fingerprint(session, item)
    raw = [{'start': 0, 'end': 1, 'text': 'Cut-out private speech'}]
    saved = save_item(ItemInput(**{**item.data, 'caption_source_cues': raw}), session, owner, item)
    assert saved['caption_source_cues'] == raw
    assert input_fingerprint(session, item) == before
    assert 'caption_source_cues' not in serialize_item(item, session)
    assert 'caption_source_cues' not in serialize_item(item, session, viewer_id=other.id)
    item.visibility = 'published'; session.commit()
    mine = bootstrap(owner, session)
    assert mine['drafts'][0]['caption_source_cues'] == raw
    assert all('caption_source_cues' not in row for row in mine['items'])
    theirs = bootstrap(other, session)
    assert all('caption_source_cues' not in row for row in theirs['items'])
    alternate = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=200)
    session.add(alternate); session.commit()
    saved = save_item(ItemInput(title='New source', media_id=alternate.id, caption_source_cues=raw), session, owner, item)
    assert saved['caption_source_cues'] is None


@pytest.mark.skipif(os.environ.get('ZIIPA_TEST_TRANSCRIPTION_REAL') != '1', reason='Explicit local speech CPU acceptance only')
def test_actual_editor_job_recognizes_synthetic_fixture_without_applying(workspace, monkeypatch, tmp_path):
    _, session, _, _, item, media, _, _, pool, _ = workspace
    root = Path(__file__).resolve().parents[1]
    fixture = root / '.local/speech-runtime/acceptance.wav'
    runtime = root / '.local/speech-runtime/whisper-b5454/Release/whisper-cli.exe'
    model = root / '.local/speech-runtime/ggml-tiny.en.bin'
    ffmpeg = root / '.local/ffmpeg-runtime/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe'
    assert all(path.is_file() for path in (fixture, runtime, model, ffmpeg))
    monkeypatch.setattr(captions.speech.config, 'enabled', True)
    for key, value in {'executable': runtime, 'model': model, 'ffmpeg': ffmpeg,
                       'ffprobe': ffmpeg.with_name('ffprobe.exe'), 'work_dir': tmp_path / 'speech'}.items():
        monkeypatch.setattr(captions.speech.config, key, str(value))
    # Restore the real transcriber, not the fixture's fake recognizer.
    monkeypatch.setattr(captions.speech, 'transcribe_media', REAL_TRANSCRIBE)
    monkeypatch.setattr(captions.speech, '_materialize', lambda owner, descriptor, target: target.write_bytes(fixture.read_bytes()))
    media.content_type, media.size = 'audio/wav', fixture.stat().st_size; session.commit()
    before = json.loads(json.dumps(item.data))
    result = create(workspace).json(); pool.run()
    response = workspace[0].get('/api/editor/caption-jobs/' + result['id']).json()
    assert response['status'] == 'ready' and 'welcome' in ' '.join(c['text'] for c in response['segments']).lower()
    session.refresh(item)
    assert item.data == before
