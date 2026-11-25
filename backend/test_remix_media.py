"""Real offline Remix graphs and durable worker authority/capability boundaries."""
import array
import hashlib
import math
from pathlib import Path
import shutil
import uuid

import pytest
from fastapi import HTTPException, Response

from app import Base, User
from creator import CreatorItem, CreatorMedia, ItemInput
import creator
import remix_api
import remix_media
import remix_services as remix
import render_services as render
import render_api
from test_rendering import creation, database, runtime


class Coordinator:
    def __init__(self, *keys):
        self.keys = set(keys)

    def get(self, key):
        return b'alive' if key in self.keys else None


def snapshot(mode='stitch', *, start=1, seconds=1):
    return {'schema': 4, 'source': {'id': str(uuid.uuid4()), 'content_type': 'video/mp4', 'size': 100},
            'audio': None, 'edit': {'trim_start': 0, 'trim_end': None, 'captions': [], 'overlays': [], 'soundtrack': None},
            'remix': {'mode': mode, 'source_start': start, 'source_seconds': seconds,
                      'source_owner_id': 2, 'source': {'id': str(uuid.uuid4()), 'content_type': 'video/mp4', 'size': 100},
                      'policy_revision': 1}}


@pytest.fixture
def generated(runtime, tmp_path):
    ffmpeg, _ = runtime
    work = tmp_path / 'generated'; work.mkdir()
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1',
        '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=30:d=1',
        '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1',
        '-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*if(lt(t\\,1)\\,330\\,if(lt(t\\,2)\\,660\\,990))*t):s=48000:d=3',
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
        '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'parent.mp4'], work, 20)
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=yellow:s=160x90:r=30:d=1.5',
        '-f', 'lavfi', '-i', 'sine=frequency=1320:sample_rate=48000:duration=1.5',
        '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'response.mp4'], work, 15)
    return work


def staged_snapshot(work, generated, mode):
    value = snapshot(mode)
    for original, target, descriptor in [('response.mp4', 'source.bin', value['source']),
                                          ('parent.mp4', 'remix-source.bin', value['remix']['source'])]:
        shutil.copyfile(generated / original, work / target)
        descriptor['size'] = (work / target).stat().st_size
    return value


def pixel(runtime, output, seconds, x, y):
    ffmpeg, _ = runtime
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(seconds), '-i', output.name,
        '-vf', f'crop=2:2:{x}:{y}', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'sample.rgb'], output.parent, 10)
    return tuple((output.parent / 'sample.rgb').read_bytes()[:3])


def tones(runtime, output, seconds):
    ffmpeg, _ = runtime
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(seconds), '-i', output.name,
        '-t', '0.5', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'sample.pcm'], output.parent, 10)
    values = array.array('h', (output.parent / 'sample.pcm').read_bytes())
    def amplitude(hz):
        # Phase independent frequency energy; AAC may change the phase.
        real = sum(value * math.cos(2 * math.pi * hz * i / 48000) for i, value in enumerate(values))
        imag = sum(value * math.sin(2 * math.pi * hz * i / 48000) for i, value in enumerate(values))
        return math.hypot(real, imag) / len(values)
    return {hz: amplitude(hz) for hz in (330, 660, 990, 1320)}


@pytest.mark.parametrize('mode', remix_media.REMIX_MODES)
def test_real_graphs_render_only_authorized_source_window_and_owned_response(runtime, generated, tmp_path, mode):
    work = tmp_path / mode; work.mkdir()
    value = staged_snapshot(work, generated, mode)
    output, duration = render.render_files(value, work)
    expected = 2.5 if mode == 'stitch' else 1
    assert abs(duration - expected) < .08
    _, streams = render._probe(output, 'video/mp4')
    video = next(row for row in streams if row['codec_type'] == 'video')
    assert (video['width'], video['height']) == ((1280, 720) if mode == 'split_screen' else (160, 90))
    assert 0 < output.stat().st_size < render.MAX_OUTPUT_BYTES
    green = pixel(runtime, output, .25, 320 if mode == 'split_screen' else 80, 360 if mode == 'split_screen' else 44)
    if mode != 'use_sound':
        assert green[1] > 80 and green[0] < 20 and green[2] < 20
    if mode == 'stitch':
        yellow = pixel(runtime, output, 1.4, 80, 44)
    elif mode == 'split_screen':
        yellow = pixel(runtime, output, .25, 960, 360)
    else:
        yellow = green
    assert yellow[0] > 180 and yellow[1] > 180 and yellow[2] < 20
    audio = tones(runtime, output, .2)
    assert audio[660] > 100
    assert audio[660] > 20 * max(audio[330], audio[990], 1), audio
    if mode == 'stitch':
        response_audio = tones(runtime, output, 1.2)
        assert response_audio[1320] > 100 and response_audio[660] < response_audio[1320] / 20
    else:
        assert audio[1320] > 100


def test_use_sound_accepts_audio_source_and_rejects_video_without_audio(runtime, generated, tmp_path):
    ffmpeg, _ = runtime
    work = tmp_path / 'audio-source'; work.mkdir()
    value = staged_snapshot(work, generated, 'use_sound')
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', 'remix-source.bin',
                 '-vn', '-c:a', 'pcm_s16le', 'parent.wav'], work, 10)
    shutil.copyfile(work / 'parent.wav', work / 'remix-source.bin')
    value['remix']['source'].update(content_type='audio/wav', size=(work / 'remix-source.bin').stat().st_size)
    output, duration = render.render_files(value, work)
    assert abs(duration - 1) < .08 and tones(runtime, output, .2)[660] > 100
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(generated / 'parent.mp4'),
                 '-an', '-c:v', 'copy', 'silent.mp4'], work, 10)
    shutil.copyfile(work / 'silent.mp4', work / 'remix-source.bin')
    value['remix']['source'].update(content_type='video/mp4', size=(work / 'remix-source.bin').stat().st_size)
    with pytest.raises(remix_media.RemixMediaError, match='audio track'):
        render.render_files(value, work)


@pytest.mark.parametrize('anamorphic', ['source', 'response'])
def test_anamorphic_video_uses_display_aspect_for_canvas_and_containment(runtime, generated, tmp_path, anamorphic):
    ffmpeg, _ = runtime
    value = staged_snapshot(tmp_path, generated, 'stitch')
    name = 'remix-source.bin' if anamorphic == 'source' else 'source.bin'
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', name, '-vf', 'setsar=2',
                 '-c:v', 'libx264', '-threads', '1', '-c:a', 'copy', 'anamorphic.mp4'], tmp_path, 15)
    shutil.copyfile(tmp_path / 'anamorphic.mp4', tmp_path / name)
    descriptor = value['remix']['source'] if anamorphic == 'source' else value['source']
    descriptor['size'] = (tmp_path / name).stat().st_size
    output, _ = render.render_files(value, tmp_path)
    _, streams = render._probe(output, 'video/mp4')
    video = next(row for row in streams if row['codec_type'] == 'video')
    assert (video['width'], video['height']) == ((160, 90) if anamorphic == 'source' else (320, 90))
    assert video['sample_aspect_ratio'] == '1:1'
    if anamorphic == 'source':
        assert max(pixel(runtime, output, .25, 80, 8)) < 15
        assert pixel(runtime, output, .25, 80, 44)[1] > 80
    else:
        assert max(pixel(runtime, output, .25, 8, 44)) < 15
        assert pixel(runtime, output, 1.25, 8, 44)[0] > 180


@pytest.mark.parametrize('change', [
    {'schema': 3}, {'audio': {'id': str(uuid.uuid4())}},
    {'remix': {'mode': 'movie=/etc/passwd'}}, {'remix': {'source_start': float('nan')}},
    {'remix': {'source_seconds': .5}}, {'remix': {'source_seconds': 6}},
    {'remix': {'source_owner_id': True}}, {'edit': {'visual_effect': 'warm'}},
])
def test_malformed_or_legacy_remix_fails_before_reading_media(change, tmp_path, monkeypatch):
    value = snapshot()
    for key, update in change.items():
        value[key] = {**value[key], **update} if isinstance(update, dict) and isinstance(value.get(key), dict) else update
    monkeypatch.setattr(render, '_probe', lambda *_: pytest.fail('Invalid Remix must not read media'))
    with pytest.raises(remix_media.RemixMediaError):
        render.render_files(value, tmp_path)


def test_rejects_range_beyond_actual_source_and_combined_stitch_limit(runtime, generated, tmp_path, monkeypatch):
    value = staged_snapshot(tmp_path, generated, 'stitch')
    value['remix']['source_start'] = 2.5
    with pytest.raises(remix_media.RemixMediaError, match='actual media'):
        render.render_files(value, tmp_path)
    value['remix']['source_start'] = 1
    def probe(path, _type):
        return (90 if path.name == 'source.bin' else 3), [{'codec_type': 'video', 'width': 160, 'height': 90}]
    monkeypatch.setattr(render, '_probe', probe)
    with pytest.raises(remix_media.RemixMediaError, match='90 seconds'):
        render.render_files(value, tmp_path)


def project_fixture(database, monkeypatch, generated=None):
    factory, session, owner, source_owner, backend = database
    parent_media = CreatorMedia(id=str(uuid.uuid4()), owner_id=source_owner.id, content_type='video/mp4', size=100)
    response_media = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=100)
    for media, name in ((parent_media, 'parent.mp4'), (response_media, 'response.mp4')):
        if generated:
            shutil.copyfile(generated / name, backend.path(media.id))
            media.size = backend.path(media.id).stat().st_size
        else:
            backend.path(media.id).write_bytes(b'P' * media.size if name == 'parent.mp4' else b'R' * media.size)
    parent = CreatorItem(id=str(uuid.uuid4()), owner_id=source_owner.id, visibility='published',
                         data=ItemInput(title='Licensed source', media_id=parent_media.id).model_dump(mode='json'))
    item = CreatorItem(id=str(uuid.uuid4()), owner_id=owner.id, visibility='draft',
                       data=ItemInput(title='Response', media_id=response_media.id, remix_of=parent.id).model_dump(mode='json'))
    policy = remix.RemixPolicy(item_id=parent.id, owner_id=source_owner.id, revision=1,
                               audience='everyone', modes=['stitch'])
    session.add_all([parent_media, response_media, parent, item, policy]); session.commit()
    project = remix.RemixProject(item_id=item.id, owner_id=owner.id, request_id=str(uuid.uuid4()), request_hash='f' * 64,
        parent_id=parent.id, root_id=parent.id, source_owner_id=source_owner.id, policy_revision=1,
        source_spec=remix.source_spec(session, parent),
        response_spec={'id': response_media.id, 'content_type': response_media.content_type, 'size': response_media.size},
        mode='stitch', source_start_ms=1000, source_seconds_ms=1000, job_id=str(uuid.uuid4()))
    value = remix.expected_snapshot(project)
    job = render.RenderJob(id=project.job_id, owner_id=owner.id, item_id=item.id, snapshot=value,
                           input_fingerprint=render.snapshot_hash(value), status='queued')
    session.add_all([project, job]); session.commit()
    monkeypatch.setattr(render, 'cache', Coordinator(render.HEARTBEAT_KEY))
    return factory, session, owner, backend, parent, item, policy, project, job


@pytest.mark.parametrize('old', [None, render.ORDINARY_V3_HEARTBEAT_KEY, *render.LEGACY_HEARTBEAT_KEYS])
def test_remix_readiness_and_claim_require_isolated_v4_but_preserve_ordinary_v3(database, runtime, monkeypatch, old):
    _, session, _, _, _, _, _, _, job = project_fixture(database, monkeypatch)
    keys = [render.HEARTBEAT_KEY] + ([old] if old else [])
    monkeypatch.setattr(render, 'cache', Coordinator(*keys))
    result = render.readiness()
    assert result['can_remix'] is (old is None)
    assert bool(render.claim_job(session)) is (old is None)
    if old == render.ORDINARY_V3_HEARTBEAT_KEY:
        assert result['can_render']
        monkeypatch.setattr(render, 'cache', Coordinator(old))
        assert render.readiness()['can_render'] and not render.readiness()['can_remix']


@pytest.mark.parametrize('stage', ['claim', 'read', 'write'])
def test_revocation_stops_claim_input_access_or_output_commit(database, monkeypatch, tmp_path, stage):
    factory, session, _, backend, _, _, policy, _, job = project_fixture(database, monkeypatch)
    def revoke():
        with factory() as other:
            changed = other.get(remix.RemixPolicy, policy.item_id)
            changed.revision += 1; changed.audience = 'disabled'; other.commit()
    if stage == 'claim':
        revoke(); assert render.claim_job(session) is None
    else:
        claimed = render.claim_job(session)
        if stage == 'read':
            revoke()
            monkeypatch.setattr(render, '_materialize', lambda *_: pytest.fail('Revoked source must not be read'))
        else:
            def interrupted_render(_snapshot, work):
                revoke()
                output = work / 'output.mp4'; output.write_bytes(b'not to be stored')
                return output, 2.5
            monkeypatch.setattr(render, 'render_files', interrupted_render)
            monkeypatch.setattr(render, '_store_output', lambda *_: pytest.fail('Revoked result must not be stored'))
        render.process_job(factory, *claimed)
    session.expire_all(); job = session.get(render.RenderJob, job.id)
    assert job.status == 'stale' and job.output_sha256 == ''
    assert session.get(CreatorMedia, job.output_media_id) is None and not backend.path(job.output_media_id).exists()


def test_revoked_remix_head_does_not_strand_ordinary_job_and_ordinary_claim_needs_no_redis(database, monkeypatch):
    _, session, owner, _, _, _, policy, _, remix_job = project_fixture(database, monkeypatch)
    item, _, _ = creation(session, owner)
    ordinary = render.RenderJob(owner_id=owner.id, item_id=item.id,
        snapshot=render.input_snapshot(session, item), input_fingerprint=render.input_fingerprint(session, item))
    session.add(ordinary); session.commit()
    policy.audience = 'disabled'; policy.revision += 1; session.commit()
    claimed = render.claim_job(session)
    assert claimed[0] == ordinary.id and session.get(render.RenderJob, remix_job.id).status == 'stale'
    ordinary.status = 'queued'; session.commit()
    class Unavailable:
        def get(self, _):
            pytest.fail('An ordinary claim must not depend on Redis availability')
    monkeypatch.setattr(render, 'cache', Unavailable())
    assert render.claim_job(session)[0] == ordinary.id


def test_real_worker_preserves_both_byte_hashes_private_output_and_internal_export_scope(database, runtime, generated, monkeypatch):
    factory, session, owner, backend, parent, item, _, project, job = project_fixture(database, monkeypatch, generated)
    render.process_job(factory, *render.claim_job(session))
    session.expire_all(); job = session.get(render.RenderJob, job.id); project = session.get(remix.RemixProject, item.id)
    assert job.status == 'ready', job.detail
    assert item.visibility == 'draft' and session.get(CreatorItem, parent.id).visibility == 'published'
    assert project.source_sha256 == hashlib.sha256((generated / 'parent.mp4').read_bytes()).hexdigest()
    assert project.response_sha256 == hashlib.sha256((generated / 'response.mp4').read_bytes()).hexdigest()
    assert job.source_sha256 == render.snapshot_hash({'response_sha256': project.response_sha256, 'source_sha256': project.source_sha256})
    assert job.output_sha256 == hashlib.sha256(backend.path(job.output_media_id).read_bytes()).hexdigest()
    assert job.output_width == 160 and job.output_height == 90 and abs(job.duration - 2.5) < .08
    for call in (lambda: render_api.queue_render(render_api.RenderInput(item_id=item.id), owner, session),
                 lambda: render_api.export_render(uuid.UUID(job.id), Response(), owner, session),
                 lambda: render.resolve_rendered_media(session, owner.id, item, job.id)):
        with pytest.raises(HTTPException) as rejected:
            call()
        assert rejected.value.status_code == 409
    # Even deleting the canonical child cannot launder its licensed output.
    copied = CreatorItem(owner_id=owner.id, visibility='draft', data={'title': 'Copied media', 'media_id': job.output_media_id})
    session.add(copied); session.commit()
    with pytest.raises(HTTPException) as rejected:
        remix.assert_external_export_allowed(session, copied.id)
    assert rejected.value.status_code == 409


def test_real_create_process_apply_publish_then_private_parent_blocks_view_and_media(database, runtime, generated, monkeypatch):
    from account_services import AccountState
    factory, session, owner, source_owner, backend = database
    viewer = User(name='Remix viewer', email='remix-viewer@example.test', password_hash='unused')
    parent_media = CreatorMedia(id=str(uuid.uuid4()), owner_id=source_owner.id, content_type='video/mp4',
                                size=(generated / 'parent.mp4').stat().st_size)
    response_media = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4',
                                  size=(generated / 'response.mp4').stat().st_size)
    for media, name in ((parent_media, 'parent.mp4'), (response_media, 'response.mp4')):
        shutil.copyfile(generated / name, backend.path(media.id))
    parent = CreatorItem(id=str(uuid.uuid4()), owner_id=source_owner.id, visibility='published',
                         data=ItemInput(title='Permitted source', media_id=parent_media.id).model_dump(mode='json'))
    session.add_all([viewer, parent_media, response_media, parent]); session.commit()
    monkeypatch.setattr(render, 'cache', Coordinator(render.HEARTBEAT_KEY))
    monkeypatch.setattr(remix_api, 'notify_worker', lambda: None)
    monkeypatch.setattr('media_workflows.notify_workflows', lambda *_: None)
    monkeypatch.setattr(creator, 'storage', lambda: backend)
    monkeypatch.setattr(creator, 'MEDIA_ROOT', backend.root)
    remix_api.set_policy(uuid.UUID(parent.id), remix_api.PolicyInput(revision=0, audience='everyone', modes=['stitch']), source_owner, session)
    receipt = remix_api.create_project(uuid.UUID(parent.id), remix_api.ProjectInput(
        request_id=uuid.uuid4(), mode='stitch', source_start=1, source_seconds=1,
        response_media_id=uuid.UUID(response_media.id), title='My real Remix', rights_confirmed=True), owner, session)
    assert receipt['status'] == 'queued'
    render.process_job(factory, *render.claim_job(session))
    session.expire_all()
    job = session.get(render.RenderJob, receipt['job_id'])
    assert job.status == 'ready', job.detail
    applied = remix_api.apply_project(uuid.UUID(receipt['item_id']), owner, session)
    assert applied['visibility'] == 'draft' and applied['media_id'] == job.output_media_id
    published = creator.edit_item(receipt['item_id'], ItemInput(title='Published Remix', visibility='published'), owner, session)
    assert published['visibility'] == 'published' and published['remix_of'] == parent.id
    assert remix_api.get_item(uuid.UUID(receipt['item_id']), Response(), viewer, session)['attribution']['parent']['id'] == parent.id
    readable = creator.read_media(job.output_media_id, viewer, session)
    assert Path(readable.path) == backend.path(job.output_media_id)
    session.add(AccountState(owner_id=source_owner.id, privacy={'profile_visibility': 'private'})); session.commit()
    for read in (lambda: remix_api.get_item(uuid.UUID(receipt['item_id']), Response(), viewer, session),
                 lambda: creator.read_media(job.output_media_id, viewer, session)):
        with pytest.raises(HTTPException) as rejected:
            read()
        assert rejected.value.status_code == 404
    assert session.get(CreatorItem, receipt['item_id']).data['remix_of'] == parent.id
