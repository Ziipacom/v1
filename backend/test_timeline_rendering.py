"""Versioned edit validation and tiny, real, generated-media export checks."""
import json
import math
from pathlib import Path
import shutil
import uuid

from fastapi import HTTPException
from pydantic import ValidationError
import pytest

import app  # Register flat application's models before importing its routers.
from creator import CreatorItem, CreatorMedia, ItemInput, save_item
import render_services as render
from timeline_edit import TimelineEdit, checked_timeline, sequence_captions, EFFECT_FILTERS
from test_rendering import database, runtime, creation  # Shared isolated generated-media fixtures.
from test_creation_campaigns import isolated, create, post, render_ready


def timeline(*regions):
    return {'version': 1, 'clips': [{'id': f'clip_{i}', 'start': start, 'end': end, 'speed': speed}
            for i, (start, end, speed) in enumerate(regions)]}


@pytest.mark.parametrize('value', [
    {'version': 2, 'clips': [{'id': 'a', 'start': 0, 'end': 1}]},
    {'version': True, 'clips': [{'id': 'a', 'start': 0, 'end': 1}]},
    {'version': 1, 'clips': []},
    timeline(*[(0, 1, 1)] * 13),
    timeline((0, 0.1, 1)), timeline((2, 1, 1)), timeline((0, 91, 1)),
    timeline((0, 50, 0.5)), timeline((0, 1, 3)), timeline((0, math.inf, 1)),
    timeline((math.nan, 1, 1)), timeline((True, 1, 1)),
    {'version': 1, 'clips': [{'id': 'a', 'start': 0, 'end': 1, 'media_id': str(uuid.uuid4())}]},
    {'version': 1, 'clips': [{'id': 'a];movie=/secret', 'start': 0, 'end': 1}]},
    {'version': 1, 'clips': [{'id': 'a', 'start': 0, 'end': 1}, {'id': 'a', 'start': 1, 'end': 2}]},
])
def test_timeline_rejects_unbounded_or_ambiguous_edits(value):
    with pytest.raises(ValidationError):
        TimelineEdit.model_validate(value)


def test_caption_mapping_uses_output_order_and_speed_and_omits_deleted_regions():
    value = timeline((4, 6, 2), (0, 1, 0.5))
    result = sequence_captions([{'start': 0.5, 'end': 1.5, 'text': 'first'},
                               {'start': 4, 'end': 5, 'text': 'last'},
                               {'start': 2, 'end': 3, 'text': 'deleted'}], value)
    assert result == [{'start': 0, 'end': 0.5, 'text': 'last'}, {'start': 2, 'end': 3, 'text': 'first'}]
    assert TimelineEdit.model_validate(value).duration == 3
    with pytest.raises(ValueError):
        checked_timeline(value, 5)


def test_legacy_fingerprints_unchanged_and_new_edit_stales_old_export(database):
    _, session, user, stranger, _ = database
    item, source, _ = creation(session, user)
    legacy = render.input_snapshot(session, item)
    assert legacy['schema'] == 1 and 'timeline' not in legacy['edit'] and 'visual_effect' not in legacy['edit']
    expected = {'schema': 1, 'source': {'id': source.id, 'content_type': source.content_type, 'size': source.size},
                'audio': None, 'edit': ItemInput.model_validate(item.data).model_dump(include={'trim_start', 'trim_end', 'captions', 'overlays', 'soundtrack'})}
    assert legacy == expected
    fingerprint = render.input_fingerprint(session, item)
    item.data = {**item.data, 'timeline': None, 'visual_effect': 'none'}
    assert render.input_fingerprint(session, item) == fingerprint
    output = CreatorMedia(id=str(uuid.uuid4()), owner_id=user.id, content_type='video/mp4', size=10)
    job = render.RenderJob(owner_id=user.id, item_id=item.id, status='ready', snapshot=legacy,
                           input_fingerprint=fingerprint, output_media_id=output.id)
    session.add_all([job, output]); session.commit()
    item.data = {**item.data, 'timeline': timeline((2, 3, 1), (0, 1, 1)), 'visual_effect': 'mono'}
    snapshot = render.input_snapshot(session, item)
    assert snapshot['schema'] == 2 and snapshot['edit']['visual_effect'] == 'mono'
    first = render.input_fingerprint(session, item)
    assert first != fingerprint
    item.data = {**item.data, 'timeline': timeline((0, 1, 1), (2, 3, 1))}
    assert render.input_fingerprint(session, item) != first
    with pytest.raises(HTTPException) as stale:
        render.resolve_rendered_media(session, user.id, item, job.id)
    assert stale.value.status_code == 409
    source.owner_id = stranger.id
    with pytest.raises(HTTPException) as denied:
        render.input_snapshot(session, item)
    assert denied.value.status_code == 404


def test_protocol_two_readiness_ignores_old_worker_heartbeats(runtime, monkeypatch):
    class Cache:
        values = {'ziipa:render:worker:' + render.coordination_scope(): 'old-worker'}
        def get(self, key):
            return self.values.get(key)
    coordinator = Cache()
    monkeypatch.setattr(render, 'cache', coordinator)
    assert render.readiness()['edit_protocol'] == 2
    assert render.readiness()['worker_ready'] is False
    coordinator.values[render.HEARTBEAT_KEY] = 'matching-v2-worker'
    assert render.readiness()['can_render'] is True


@pytest.mark.parametrize('schema,edit', [(99, {}), (True, {}), (1, {'visual_effect': 'mono'}),
                                       (1, {'timeline': timeline((0, 1, 1))})])
def test_unsupported_job_version_fails_before_reading_source(tmp_path, schema, edit):
    with pytest.raises(RuntimeError, match='version'):
        render.render_files({'schema': schema, 'edit': edit}, tmp_path)


def test_unknown_effect_is_not_an_ffmpeg_expression():
    with pytest.raises(ValidationError):
        ItemInput(title='Unsafe effect', visual_effect='movie=https://example.test/filter')


def test_save_preserves_new_fields_from_old_clients_and_allows_explicit_clear(database, monkeypatch):
    _, session, user, stranger, _ = database
    monkeypatch.setattr('media_workflows.notify_workflows', lambda *_: None)
    item, source, _ = creation(session, user)
    value = timeline((0, 1, 1), (2, 3, 1))
    save_item(ItemInput.model_validate({**item.data, 'timeline': value, 'visual_effect': 'warm'}), session, user, item)
    save_item(ItemInput(title='Old-client rename'), session, user, item)
    assert item.data['timeline']['clips'][1]['start'] == 2 and item.data['visual_effect'] == 'warm'
    save_item(ItemInput(title='Explicit clear', timeline=None, visual_effect='none'), session, user, item)
    assert item.data['timeline'] is None and item.data['visual_effect'] == 'none'
    source.owner_id = stranger.id; session.commit()
    with pytest.raises(HTTPException) as denied:
        save_item(ItemInput(title='Not owned', media_id=source.id, timeline=value), session, user)
    assert denied.value.status_code == 404


def generate_colors(ffmpeg, work):
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-filter_complex_threads', '1',
                 '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=30:d=2',
                 '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
                 '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
                 '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '4', '-f', 'mp4', 'source.bin'], work, 20)


def pixels(ffmpeg, work, when, name):
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(when), '-i', 'output.mp4', '-frames:v', '1',
                 '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', name], work, 10)
    return (work / name).read_bytes()


def test_real_timeline_reorders_splits_and_speeds_audio_video(runtime, database, tmp_path):
    ffmpeg, _ = runtime
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    item.data = {**item.data, 'timeline': timeline((2, 3, 2), (0, 1, 1)), 'captions': [], 'overlays': []}
    work = tmp_path / 'ordered'; work.mkdir()
    generate_colors(ffmpeg, work)
    snapshot = render.input_snapshot(session, item)
    output, duration = render.render_files(snapshot, work)
    assert output.exists() and abs(duration - 1.5) < 0.15
    first, last = pixels(ffmpeg, work, 0.2, 'first.rgb'), pixels(ffmpeg, work, 0.8, 'last.rgb')
    assert sum(first[2::3]) > sum(first[::3]) * 3
    assert sum(last[::3]) > sum(last[2::3]) * 3
    _, streams = render._probe(output, 'video/mp4')
    assert any(stream['codec_type'] == 'audio' for stream in streams)
    graph = (work / 'filters.txt').read_text(encoding='utf-8')
    assert 'atempo=2.000000' in graph and 'concat=n=2:v=1:a=1' in graph


@pytest.mark.parametrize('effect', list(EFFECT_FILTERS))
def test_real_allowlisted_effects_bake_pixels(runtime, database, tmp_path, effect):
    ffmpeg, _ = runtime
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    item.data = {**item.data, 'trim_start': 0, 'trim_end': 0.3, 'visual_effect': effect, 'captions': [], 'overlays': []}
    work = tmp_path / effect; work.mkdir()
    generate_colors(ffmpeg, work)
    output, duration = render.render_files(render.input_snapshot(session, item), work)
    assert output.exists() and abs(duration - 0.3) < 0.15
    rgb = pixels(ffmpeg, work, 0.1, 'effect.rgb')
    red, green, blue = [sum(rgb[channel::3]) / len(rgb[channel::3]) for channel in range(3)]
    if effect == 'mono':
        assert abs(red - green) < 3 and abs(green - blue) < 3
    elif effect == 'none':
        assert red > blue * 3
    assert all(fragment in (work / 'filters.txt').read_text() for fragment in EFFECT_FILTERS[effect])


def test_real_audio_primary_exports_timeline_with_caption_canvas(runtime, database, tmp_path):
    ffmpeg, _ = runtime
    _, session, user, _, _ = database
    source = CreatorMedia(id=str(uuid.uuid4()), owner_id=user.id, content_type='audio/wav', size=100)
    session.add(source); session.flush()
    item = CreatorItem(owner_id=user.id, visibility='draft', data={'title': 'Audio timeline', 'category': 'music', 'media_id': source.id,
        'timeline': timeline((1, 2, 2), (0, 0.5, 1)), 'captions': [{'start': 0, 'end': 0.4, 'text': 'Reviewed cue'}]})
    session.add(item); session.commit()
    work = tmp_path / 'audio'; work.mkdir()
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                 'sine=frequency=440:sample_rate=48000:duration=3', '-c:a', 'pcm_s16le', '-f', 'wav', 'source.bin'], work, 10)
    output, duration = render.render_files(render.input_snapshot(session, item, 'square'), work)
    assert abs(duration - 1) < 0.15
    _, streams = render._probe(output, 'video/mp4')
    video = next(stream for stream in streams if stream['codec_type'] == 'video')
    assert (video['width'], video['height']) == (720, 720)
    assert any(stream['codec_type'] == 'audio' for stream in streams)
    assert 'between(t,0.000000,0.400000)' in (work / 'filters.txt').read_text()


def test_worker_rejects_actual_out_of_source_timeline_before_encoding(runtime, database, tmp_path):
    ffmpeg, _ = runtime
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    item.data = {**item.data, 'timeline': timeline((4, 5, 1))}
    work = tmp_path / 'bad'; work.mkdir(); generate_colors(ffmpeg, work)
    with pytest.raises(RuntimeError, match='inside the source'):
        render.render_files(render.input_snapshot(session, item), work)
    assert not (work / 'output.mp4').exists()


def test_campaign_applies_source_cues_to_reviewed_output_timeline(isolated):
    context = isolated
    with context[0]() as session:
        item = session.get(CreatorItem, context[4].id)
        item.data = {**item.data, 'timeline': timeline((4, 6, 2), (0, 1, 1))}
        session.commit()
    source_cues = [{'start': 0, 'end': 1, 'text': 'first source'}, {'start': 4, 'end': 5, 'text': 'later source'}]
    row = create(context, manual_transcript='first source later source', manual_segments=source_cues)
    row = render_ready(context, post(context, row, 'prepare'))
    result = post(context, row, 'apply-captions', transcript_hash=row['transcript_hash'])
    assert result['status'] == 'queued' and not result['review_hash']
    with context[0]() as session:
        item = session.get(CreatorItem, context[4].id)
        assert item.data['captions'] == [{'start': 0, 'end': 0.5, 'text': 'later source'},
                                         {'start': 1, 'end': 2, 'text': 'first source'}]
    assert result['manual_segments'] == source_cues  # Preserve source clock; don't double-map on later review.


@pytest.mark.parametrize('kind,codec,demux', [('image/png', 'png', 'image2'), ('image/jpeg', 'mjpeg', 'image2'),
                                            ('image/webp', 'libwebp', 'image2'), ('image/gif', 'gif', 'gif')])
def test_real_owned_still_exports_six_second_effect_and_music(runtime, database, tmp_path, kind, codec, demux):
    ffmpeg, _ = runtime
    _, session, user, _, _ = database
    item, source, music = creation(session, user, audio=True)
    source.content_type = kind
    item.data = {**item.data, 'trim_start': 0, 'trim_end': None, 'captions': [], 'visual_effect': 'mono',
                 'overlays': [{'id': 'title', 'text': 'Title', 'position': 'center', 'theme': 'purple'},
                              {'id': 'credit', 'text': 'By me', 'position': 'bottom', 'theme': 'lime'}],
                 'soundtrack': {**item.data['soundtrack'], 'start': 0}}
    session.commit()
    work = tmp_path / codec; work.mkdir()
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x806040:s=160x120:d=0.1',
                 '-frames:v', '1', '-threads', '1', '-c:v', codec, '-f', demux, 'source.bin'], work, 15)
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                 'sine=frequency=880:sample_rate=48000:duration=0.5', '-c:a', 'pcm_s16le', '-f', 'wav', 'music.bin'], work, 10)
    original = (work / 'source.bin').read_bytes()
    output, duration = render.render_files(render.input_snapshot(session, item), work)
    assert abs(duration - 6) < 0.15 and (work / 'source.bin').read_bytes() == original
    _, streams = render._probe(output, 'video/mp4')
    assert any(stream['codec_type'] == 'audio' for stream in streams)
    rgb = pixels(ffmpeg, work, 0.1, 'still.rgb')
    # Sample top rows, outside the existing center overlay.
    channels = [sum(rgb[channel:160*20*3:3]) / (160 * 20) for channel in range(3)]
    assert max(channels) - min(channels) < 3
    assert (work / 'still.png').exists()
    assert (work / 'text0.txt').read_text() == 'Title' and (work / 'text1.txt').read_text() == 'By me'
