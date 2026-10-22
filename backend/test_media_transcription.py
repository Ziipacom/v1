"""Offline speech boundary tests. No downloaded models, providers or user media."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import wave

from fastapi import HTTPException
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import Base, User
from creator import CreatorItem, CreatorMedia
from personal_media import OSAssetMetadata
import media_transcription as speech

REAL_RUNTIME = speech._runtime


@pytest.fixture
def source(tmp_path, monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        owner = User(name='Speech owner', email='speech@example.test', password_hash='unused')
        stranger = User(name='Other owner', email='other-speech@example.test', password_hash='unused')
        session.add_all([owner, stranger]); session.flush()
        media = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=123)
        item = CreatorItem(owner_id=owner.id, data={'title': 'Original', 'media_id': media.id})
        session.add_all([media, item]); session.flush()
        metadata = OSAssetMetadata(owner_id=owner.id, item_id=item.id,
            rights={'basis': 'original', 'allow_ai': True})
        session.add(metadata); session.commit()
        monkeypatch.setattr(speech.config, 'enabled', True)
        monkeypatch.setattr(speech.config, 'work_dir', str(tmp_path / 'work'))
        monkeypatch.setattr(speech, '_runtime', lambda: ('whisper-cli', 'model.bin', 'ffmpeg', 'ffprobe'))
        monkeypatch.setattr(speech, '_materialize', lambda owner, descriptor, target: target.write_bytes(b'owned'))
        yield session, owner, stranger, item, media, metadata, tmp_path
    engine.dispose()


def segment(start=0, end=1000, text='Hello Ziipa'):
    return {'offsets': {'from': start, 'to': end}, 'text': text}


def install_fake_engine(monkeypatch, payload=None, duration=2, audio=True, after=None):
    commands = []
    def run(command, work, deadline, watched=None):
        commands.append(command)
        if command[0] == 'ffprobe':
            return json.dumps({'format': {'duration': duration},
                'streams': [{'codec_type': 'audio' if audio else 'video'}]}).encode()
        if command[0] == 'ffmpeg':
            with wave.open(str(work / 'speech.wav'), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(b'\x01\x00' * 16000 * 2)
        else:
            (work / 'transcript.json').write_text(json.dumps(payload if payload is not None
                else {'transcription': [segment(0, 750, ' Hello\nZiipa '), segment(750, 1500, 'Creators.')]}
            ), encoding='utf-8')
            if after:
                after()
        return b''
    monkeypatch.setattr(speech, '_run', run)
    return commands


def test_owned_real_pipeline_contract_and_private_cleanup(source, monkeypatch):
    session, owner, _, item, _, _, tmp_path = source
    commands = install_fake_engine(monkeypatch)
    original = dict(item.data)
    result = speech.transcribe_media(session, owner.id, item.id)
    assert result['status'] == 'ready' and result['engine'] == 'whisper.cpp'
    assert result['text'] == 'Hello Ziipa Creators.'
    assert result['segments'] == [{'start': 0, 'end': .75, 'text': 'Hello Ziipa'},
                                  {'start': .75, 'end': 1.5, 'text': 'Creators.'}]
    assert item.data == original and not session.dirty
    assert list((tmp_path / 'work').iterdir()) == [tmp_path / 'work' / 'speech.lock']
    for command in commands[:2]:
        assert command[command.index('-protocol_whitelist') + 1] == 'file'
        assert command[command.index('-f') + 1] == 'mov'
        assert not any('http' in value for value in command)
    assert '-ng' in commands[-1] and commands[-1][commands[-1].index('-m') + 1] == 'model.bin'


@pytest.mark.parametrize('rights', [{}, {'basis': 'unknown', 'allow_ai': False},
    {'basis': 'original', 'allow_ai': False}, {'basis': 'original', 'allow_ai': True,
        'expires_at': (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()},
    {'basis': 'unknown', 'allow_ai': True}])
def test_rights_denial_precedes_storage_or_execution(source, monkeypatch, rights):
    session, owner, _, item, _, metadata, _ = source
    metadata.rights = rights; session.commit()
    monkeypatch.setattr(speech, '_runtime', lambda: pytest.fail('Runtime accessed without rights'))
    monkeypatch.setattr(speech, '_materialize', lambda *args: pytest.fail('Private bytes accessed without rights'))
    with pytest.raises(HTTPException) as error:
        speech.transcribe_media(session, owner.id, item.id)
    assert error.value.status_code == 403


def test_foreign_item_media_and_path_ids_never_read(source, monkeypatch):
    session, owner, stranger, item, media, _, _ = source
    monkeypatch.setattr(speech, '_runtime', lambda: pytest.fail('Runtime accessed for foreign media'))
    for identity in (item.id, '../secret', 'https://example.test/video.mp4'):
        with pytest.raises(HTTPException) as error:
            speech.transcribe_media(session, stranger.id, identity)
        assert error.value.status_code == 404
    media.owner_id = stranger.id; session.commit()
    with pytest.raises(HTTPException) as error:
        speech.transcribe_media(session, owner.id, item.id)
    assert error.value.status_code == 404


def test_disabled_and_missing_runtime_never_fabricate_or_read(source, monkeypatch):
    session, owner, _, item, _, _, _ = source
    monkeypatch.setattr(speech, '_materialize', lambda *args: pytest.fail('Storage read without runtime'))
    monkeypatch.setattr(speech.config, 'enabled', False)
    assert speech.transcribe_media(session, owner.id, item.id)['status'] == 'unavailable'
    monkeypatch.setattr(speech.config, 'enabled', True)
    monkeypatch.setattr(speech, '_runtime', lambda: (_ for _ in ()).throw(RuntimeError('missing model')))
    result = speech.transcribe_media(session, owner.id, item.id)
    assert result['status'] == 'unavailable' and result['text'] == '' and result['segments'] == []


@pytest.mark.parametrize('size,kind', [(100 * 1024 * 1024 + 1, 'video/mp4'), (0, 'video/mp4'),
                                     (123, 'image/png'), (123, 'image/jpeg'), (123, 'image/webp'), (123, 'image/gif'),
                                     (123, 'application/vnd.apple.mpegurl')])
def test_unsupported_or_large_media_never_read(source, monkeypatch, size, kind):
    session, owner, _, item, media, _, _ = source
    media.size, media.content_type = size, kind; session.commit()
    monkeypatch.setattr(speech, '_materialize', lambda *args: pytest.fail('Invalid media was read'))
    assert speech.transcribe_media(session, owner.id, item.id)['status'] == 'unavailable'


@pytest.mark.parametrize('duration', [91, 0, float('nan'), float('inf')])
def test_reject_long_or_unknown_duration(source, monkeypatch, duration):
    session, owner, _, item, _, _, _ = source
    commands = install_fake_engine(monkeypatch, duration=duration)
    assert speech.transcribe_media(session, owner.id, item.id)['status'] == 'unavailable'
    assert len(commands) == 1


def test_no_audio_and_empty_engine_output_are_not_fake_success(source, monkeypatch):
    session, owner, _, item, _, _, _ = source
    commands = install_fake_engine(monkeypatch, audio=False)
    assert speech.transcribe_media(session, owner.id, item.id)['status'] == 'no_speech'
    assert len(commands) == 1
    install_fake_engine(monkeypatch, {'transcription': []})
    assert speech.transcribe_media(session, owner.id, item.id)['status'] == 'no_speech'


@pytest.mark.parametrize('payload', [{}, {'transcription': 'text'},
    {'transcription': [segment(-1, 500)]}, {'transcription': [segment(0, float('nan'))]},
    {'transcription': [segment(True, 500)]}, {'transcription': [segment(0, 3000)]},
    {'transcription': [segment(0, 900), segment(800, 1000)]},
    {'transcription': [segment(0, 10 ** 400)]}, {'transcription': [segment(.1, .2)]},
    {'transcription': [segment(text='x' * 251)]}, {'transcription': [segment()] * 101}])
def test_bad_engine_output_is_rejected(payload):
    with pytest.raises(ValueError):
        speech.normalize_segments(payload, 2)


def test_last_caption_does_not_round_beyond_audio():
    cues = speech.normalize_segments({'transcription': [segment(0, 1000)]}, .9996)
    assert cues[0]['end'] == .999


def test_concurrent_revocation_and_source_change_discard_transcript(source, monkeypatch):
    session, owner, _, item, media, metadata, _ = source
    def revoke():
        metadata.rights = {'basis': 'original', 'allow_ai': False}; session.commit()
    install_fake_engine(monkeypatch, after=revoke)
    with pytest.raises(HTTPException) as error:
        speech.transcribe_media(session, owner.id, item.id)
    assert error.value.status_code == 403
    metadata.rights = {'basis': 'original', 'allow_ai': True}; session.commit()
    def change():
        media.size += 1; session.commit()
    install_fake_engine(monkeypatch, after=change)
    result = speech.transcribe_media(session, owner.id, item.id)
    assert result['status'] == 'unavailable' and not result['text']


def test_storage_failure_sanitized_and_scratch_cleaned(source, monkeypatch):
    session, owner, _, item, _, _, tmp_path = source
    def fail(*args):
        raise HTTPException(503, 'private-provider-secret-path')
    monkeypatch.setattr(speech, '_materialize', fail)
    result = speech.transcribe_media(session, owner.id, item.id)
    assert result['status'] == 'unavailable' and 'secret' not in json.dumps(result)
    assert not list((tmp_path / 'work').glob('speech-*'))


def test_failed_engine_never_returns_partial_text(source, monkeypatch):
    session, owner, _, item, _, _, tmp_path = source
    def fail(command, work, deadline, watched=None):
        (work / 'transcript.json').write_text('{"private":"partial transcript"}', encoding='utf-8')
        raise subprocess.TimeoutExpired(command, 1)
    monkeypatch.setattr(speech, '_run', fail)
    result = speech.transcribe_media(session, owner.id, item.id)
    assert result['status'] == 'unavailable' and not result['text'] and not result['segments']
    assert not list((tmp_path / 'work').glob('speech-*'))


def test_runtime_requires_explicit_local_model_and_executable(tmp_path, monkeypatch):
    monkeypatch.setattr(speech.config, 'model', 'https://example.test/model.bin')
    monkeypatch.setattr(speech.config, 'executable', 'whisper-cli')
    with pytest.raises(RuntimeError):
        REAL_RUNTIME()


def test_exact_silence_skips_recognizer(source, monkeypatch):
    session, owner, _, item, _, _, _ = source
    commands = install_fake_engine(monkeypatch)
    original = speech._run
    def run(command, work, deadline, watched=None):
        output = original(command, work, deadline, watched)
        if command[0] == 'ffmpeg':
            with wave.open(str(work / 'speech.wav'), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(b'\0' * 64000)
        return output
    monkeypatch.setattr(speech, '_run', run)
    assert speech.transcribe_media(session, owner.id, item.id)['status'] == 'no_speech'
    assert len(commands) == 2


def test_cross_process_slot_refuses_parallel_job_and_releases(tmp_path):
    with speech._slot(tmp_path):
        with pytest.raises(RuntimeError):
            with speech._slot(tmp_path):
                pytest.fail('Concurrent speech job admitted')
    with speech._slot(tmp_path):
        pass


def test_subprocess_environment_drops_credentials_and_limits_timeout(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLISHING_SECRET_TEST', 'never-inherited')
    output = speech._run([sys.executable, '-c',
        'import os;print(os.environ.get("PUBLISHING_SECRET_TEST","absent"))'],
        tmp_path, time.monotonic() + 5)
    assert output.strip() == b'absent'
    started = time.monotonic()
    with pytest.raises(RuntimeError):
        speech._run([sys.executable, '-c', 'import time;time.sleep(10)'], tmp_path, time.monotonic() + .2)
    assert time.monotonic() - started < 3


def test_subprocess_output_is_bounded(tmp_path):
    with pytest.raises(RuntimeError):
        speech._run([sys.executable, '-c', 'import sys;sys.stdout.write("x"*300000)'],
                    tmp_path, time.monotonic() + 5)


@pytest.mark.skipif(os.environ.get('ZIIPA_TEST_TRANSCRIPTION_REAL') != '1',
                    reason='Opt-in local CPU speech acceptance; no implicit model downloads')
def test_real_decoder_silence_never_calls_recognition_or_changes_saved_edit(source, monkeypatch):
    session, owner, _, item, media, _, tmp_path = source
    root = Path(__file__).resolve().parents[1]
    ffmpeg = root / '.local/ffmpeg-runtime/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe'
    ffprobe = ffmpeg.with_name('ffprobe.exe')
    assert ffmpeg.is_file() and ffprobe.is_file(), 'Use the documented installed local decoder'
    fixture = tmp_path / 'digital-silence.wav'
    with wave.open(str(fixture), 'wb') as writer:
        writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(22050)
        writer.writeframes(b'\0' * 22050 * 2 * 2)
    monkeypatch.setattr(speech.config, 'ffmpeg', str(ffmpeg))
    monkeypatch.setattr(speech.config, 'ffprobe', str(ffprobe))
    monkeypatch.setattr(speech, '_materialize', lambda owner, descriptor, target: target.write_bytes(fixture.read_bytes()))
    media.content_type, media.size = 'audio/wav', fixture.stat().st_size
    item.data = {**item.data, 'captions': [{'start': 0, 'end': 1, 'text': 'Keep my manual words'}]}
    session.commit()
    original = json.loads(json.dumps(item.data))
    result = speech.transcribe_media(session, owner.id, item.id,
        recognize=lambda *args: pytest.fail('Digital silence reached the recognition engine'))
    assert result['status'] == 'no_speech' and result['segments'] == [] and result['text'] == ''
    session.refresh(item)
    assert item.data == original and not session.dirty
    assert list((tmp_path / 'work').iterdir()) == [tmp_path / 'work' / 'speech.lock']


@pytest.mark.skipif(os.environ.get('ZIIPA_TEST_TRANSCRIPTION_REAL') != '1',
                    reason='Opt-in local CPU speech acceptance; no implicit model downloads')
def test_real_engine_synthetic_speech(source, monkeypatch):
    session, owner, _, item, media, _, _ = source
    root = Path(__file__).resolve().parents[1]
    fixture = root / '.local/speech-runtime/acceptance.wav'
    runtime = root / '.local/speech-runtime/whisper-b5454/Release/whisper-cli.exe'
    model = root / '.local/speech-runtime/ggml-tiny.en.bin'
    ffmpeg = root / '.local/ffmpeg-runtime/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe'
    assert all(path.is_file() for path in (fixture, runtime, model, ffmpeg)), 'Install the documented local runtime first'
    monkeypatch.setattr(speech.config, 'executable', str(runtime))
    monkeypatch.setattr(speech.config, 'model', str(model))
    monkeypatch.setattr(speech.config, 'ffmpeg', str(ffmpeg))
    monkeypatch.setattr(speech.config, 'ffprobe', str(ffmpeg.with_name('ffprobe.exe')))
    monkeypatch.setattr(speech, '_runtime', REAL_RUNTIME)
    monkeypatch.setattr(speech, '_materialize', lambda owner, descriptor, target: target.write_bytes(fixture.read_bytes()))
    media.content_type, media.size = 'audio/wav', fixture.stat().st_size
    session.commit()
    result = speech.transcribe_media(session, owner.id, item.id)
    assert result['status'] == 'ready', result['detail']
    assert 'welcome' in result['text'].lower() and 'create' in result['text'].lower()
    with wave.open(str(fixture), 'rb') as wav:
        duration = wav.getnframes() / wav.getframerate()
    assert all(0 <= cue['start'] < cue['end'] <= duration for cue in result['segments'])
