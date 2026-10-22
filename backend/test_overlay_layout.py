"""Owned API round trips and actual output pixels for positioned/timed text."""
import math
import json
from pathlib import Path
import shutil

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app  # Register all flat-application models before router imports.
from app import current_user, db, guard
import creator
from creator import Overlay, CreatorItem
import render_services as render
import render_api
import creation_campaigns as campaigns
from test_rendering import database, runtime, creation
from test_timeline_rendering import timeline, generate_colors, pixels
from test_creation_campaigns import isolated, create, post, render_ready, approve, get


LEGACY = {'id': 'title', 'text': 'My work', 'position': 'center', 'theme': 'lime'}
PLACED = {**LEGACY, 'x': 0.2, 'y': 0.3, 'scale': 1.5, 'start': 0.5, 'end': 1.5}


@pytest.mark.parametrize('changes', [
    {'x': 0.2}, {'y': 0.2}, {'x': -0.01, 'y': 0.2}, {'x': 0.2, 'y': 1.01},
    {'x': True, 'y': 0.2}, {'x': '0.5', 'y': 0.2}, {'scale': 0.49}, {'scale': 2.01},
    {'scale': math.inf}, {'start': math.nan}, {'end': math.inf}, {'start': -1},
    {'start': 2, 'end': 2}, {'start': 2, 'end': 1}, {'end': 0}, {'end': True},
])
def test_invalid_overlay_layout_is_rejected(changes):
    with pytest.raises(ValidationError):
        Overlay.model_validate({**LEGACY, **changes})


def test_legacy_and_null_extensions_keep_identical_wire_values():
    assert Overlay.model_validate(LEGACY).model_dump() == LEGACY
    assert Overlay.model_validate({**LEGACY, **dict.fromkeys(('x', 'y', 'scale', 'start', 'end'))}).model_dump() == LEGACY
    assert Overlay.model_validate(PLACED).model_dump() == PLACED
    assert Overlay.model_validate({**LEGACY, 'end': 2}).model_dump()['end'] == 2


@pytest.mark.parametrize('case', json.loads((Path(__file__).resolve().parent / 'fixtures' / 'overlay-text-cases.json').read_text(encoding='utf-8')))
def test_shared_custom_text_wrapping(case):
    assert render._custom_display_text(case['text'], case['scale']) == case['output']


@pytest.mark.parametrize('messages,expected', [
    # Distro builds print without an AVExpr logging context.
    ('Input #0, lavfi, from generated color:\n  Stream #0:0: 2x2, 1 fps\n'
     '69.000000\n18.000000\n69.000000\nframe=1 fps=0.0\n', (69, 18)),
    # The Windows FFmpeg 9 runtime prefixes the same print() values.
    ('[Eval @ 0000019d9f310a40] 69.000000\n[Eval @ 0000019d9f310a40] 18.000000\n'
     '[Eval @ 0000019d9f310a40] 69.000000\n', (69, 18)),
    # A square glyph box needs both values, even when the log lines are equal.
    ('18.000000\n18.000000\n18.000000\n', (18, 18)),
])
def test_text_measurement_accepts_ffmpeg_print_log_formats(tmp_path, monkeypatch, messages, expected):
    commands = []
    def run(command, work, timeout):
        commands.append((command, timeout))
        (work / 'stderr.log').write_text(messages, encoding='utf-8')
    monkeypatch.setattr(render, '_run', run)
    assert render._measure_text('ffmpeg', tmp_path, 'text0.txt', 24) == expected
    command, timeout = commands[0]
    assert command[command.index('-loglevel') + 1] == 'repeat+info'
    assert command[command.index('-frames:v') + 1] == '1' and timeout == 10
    assert 'textfile=text0.txt:expansion=none:' in command[command.index('-vf') + 1]


@pytest.mark.parametrize('messages', [
    '', '69.000000\n', '[Eval @ 0x123] 69.000000\n',
    # Other logging contexts and numbers inside metadata are not dimensions.
    '[Parsed_drawtext_0 @ 0x123] 69.000000\n[Parsed_drawtext_0 @ 0x123] 18.000000\n',
    'width=69.000000\nheight=18.000000\n',
    'nan\n18.000000\n', '69.000000\ninf\n', '-1.000000\n18.000000\n',
    # Drawtext evaluates x,y,x. Never replace an invalid height with the last x.
    '69.000000\nnan\n69.000000\n', '69.000000\n-1.000000\n69.000000\n',
    '[Eval @ 0x123] 69.000000\n[Eval @ 0x123] inf\n[Eval @ 0x123] 69.000000\n',
    '69.000000\n1e999\n69.000000\n',
    ('9' * 400) + '\n18.000000\n',
])
def test_text_measurement_fails_closed_on_missing_or_invalid_metrics(tmp_path, monkeypatch, messages):
    def run(command, work, timeout):
        (work / 'stderr.log').write_text(messages, encoding='utf-8')
    monkeypatch.setattr(render, '_run', run)
    with pytest.raises(render.OverlayLayoutError, match='could not (verify|be verified)'):
        render._measure_text('ffmpeg', tmp_path, 'text0.txt', 24)


def test_real_text_measurement_preserves_width_height_order(runtime, tmp_path):
    ffmpeg, _ = runtime
    shutil.copyfile(render.config.font, tmp_path / 'font.ttf')
    (tmp_path / 'text0.txt').write_text('MMMMMMiij', encoding='utf-8')
    width, height = render._measure_text(ffmpeg, tmp_path, 'text0.txt', 24)
    assert width > height * 3 and height > 5
    (tmp_path / 'text0.txt').write_text('i', encoding='utf-8')
    width, height = render._measure_text(ffmpeg, tmp_path, 'text0.txt', 24)
    assert 0 < width < height


@pytest.fixture
def api_client(database, monkeypatch):
    factory, _, user, _, _ = database
    import media_workflows
    monkeypatch.setattr(media_workflows, 'notify_workflows', lambda *_: None)
    monkeypatch.setattr(creator, 'connections_for', lambda *_: [])
    monkeypatch.setattr(creator.settings, 'enable_demo_catalog', False)
    api = FastAPI(); api.include_router(creator.router); api.include_router(render_api.router)
    api.dependency_overrides[current_user] = lambda: user
    api.dependency_overrides[guard] = lambda: None
    def connection():
        with factory() as session:
            yield session
    api.dependency_overrides[db] = connection
    with TestClient(api) as client:
        yield client, user
        api.dependency_overrides[current_user] = lambda: (_ for _ in ()).throw(HTTPException(401, 'Sign in'))
        assert client.get('/api/creator/config').status_code == 401


def test_owned_draft_public_and_legacy_edit_preserve_overlay_fields(api_client, database):
    client, user = api_client
    _, session, _, _, _ = database
    item, _, _ = creation(session, user)
    config = client.get('/api/creator/config').json()
    assert config['overlay_layout']['version'] == 1
    updated = client.post('/api/creator/items/' + item.id, json={'title': 'Positioned', 'overlays': [PLACED]})
    assert updated.status_code == 200, updated.text
    assert updated.json()['overlays'] == [PLACED]
    # A legacy client omits the track; its defaults must not erase extensions.
    assert client.post('/api/creator/items/' + item.id, json={'title': 'Renamed'}).status_code == 200
    invalid = client.post('/api/creator/items/' + item.id, json={'title': 'Do not save', 'overlays': [{**PLACED, 'end': 0.2}]})
    assert invalid.status_code == 422
    feed = client.get('/api/creator/bootstrap').json()
    assert feed['editor_capabilities'] == config
    assert next(value for value in feed['drafts'] if value['id'] == item.id)['overlays'] == [PLACED]
    published = client.post('/api/creator/items/' + item.id, json={'title': 'Public positioned', 'visibility': 'published'})
    assert published.status_code == 200
    feed = client.get('/api/creator/bootstrap').json()
    assert next(value for value in feed['items'] if value['id'] == item.id)['overlays'] == [PLACED]
    session.expire_all()
    assert session.get(CreatorItem, item.id).data['overlays'] == [PLACED]


def test_new_item_and_clear_keep_optional_semantics(api_client):
    client, _ = api_client
    response = client.post('/api/creator/items', json={'title': 'No source yet', 'overlays': [PLACED]})
    assert response.status_code == 201 and response.json()['overlays'] == [PLACED]
    clear = client.post('/api/creator/items/' + response.json()['id'], json={'title': 'Back to anchors', 'overlays': [LEGACY]})
    assert clear.status_code == 200 and clear.json()['overlays'] == [LEGACY]


def test_position_scale_and_timing_each_change_render_fingerprint(database):
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    item.data = {**item.data, 'overlays': [LEGACY]}
    legacy = render.input_snapshot(session, item)
    assert legacy['schema'] == 1 and legacy['edit']['overlays'] == [LEGACY]
    for change in ({'x': 0.2, 'y': 0.3}, {'scale': 1.1}, {'start': 0.2}, {'end': 0.8}):
        item.data = {**item.data, 'overlays': [{**LEGACY, **change}]}
        new = render.input_snapshot(session, item)
        assert new['schema'] == 3
        assert render.snapshot_hash(new) != render.snapshot_hash(legacy)
        new['schema'] = 2
        with pytest.raises(RuntimeError, match='version'):
            render.validate_snapshot_version(new)


def test_campaign_review_invalidates_after_overlay_edit(isolated):
    context = isolated
    row = approve(context, render_ready(context, post(context, create(context), 'prepare')))
    with context[0]() as session:
        item = session.get(CreatorItem, context[4].id)
        item.data = {**item.data, 'overlays': [PLACED]}; session.commit()
        campaign = session.get(campaigns.CreationCampaign, row['id'])
        assert campaigns.source(session, campaign)[1] != campaign.source_fingerprint
    import campaign_worker
    campaign_worker.tick(context[0], publish_dispatch=lambda *_: pytest.fail('Changed overlays must not be published'))
    assert get(context, row)['status'] == 'needs_review'


def test_protocol_three_ignores_v1_and_v2_workers(runtime, monkeypatch):
    class Cache:
        values = {'ziipa:render:worker:' + render.coordination_scope(): 'v1',
                  'ziipa:render:worker:v2:' + render.coordination_scope(): 'v2'}
        def get(self, key): return self.values.get(key)
    cache = Cache()
    monkeypatch.setattr(render, 'cache', cache)
    config = render.readiness()
    assert config['edit_protocol'] == 3 and not config['can_render'] and not config['worker_ready']
    assert config['overlay_layout']['timing'] == 'output'
    cache.values[render.HEARTBEAT_KEY] = 'v3'
    assert not render.readiness()['can_render']  # Mixed versions share the DB queue.
    assert render.readiness()['incompatible_worker_active']
    for key in render.LEGACY_HEARTBEAT_KEYS:
        cache.values.pop(key, None)
    assert render.readiness()['can_render']
    assert render.readiness()['max_duration_seconds'] == 90


def test_mixed_worker_versions_cannot_queue_advanced_render(api_client, runtime, database, monkeypatch):
    client, user = api_client
    _, session, _, _, _ = database
    item, _, _ = creation(session, user)
    item.data = {**item.data, 'overlays': [PLACED]}; session.commit()
    class Cache:
        values = {render.HEARTBEAT_KEY: 'new', render.LEGACY_HEARTBEAT_KEYS[1]: 'old'}
        def get(self, key): return self.values.get(key)
    cache = Cache(); monkeypatch.setattr(render, 'cache', cache)
    response = client.post('/api/render/jobs', json={'item_id': item.id})
    assert response.status_code == 503
    assert session.query(render.RenderJob).count() == 0
    del cache.values[render.LEGACY_HEARTBEAT_KEYS[1]]
    response = client.post('/api/render/jobs', json={'item_id': item.id})
    assert response.status_code == 200, response.text
    session.expire_all()
    job = session.get(render.RenderJob, response.json()['id'])
    assert job.snapshot['schema'] == 3 and job.snapshot['edit']['overlays'] == [PLACED]


def lime_bounds(rgb, width):
    points = [(index % width, index // width) for index in range(len(rgb) // 3)
              if rgb[index * 3 + 1] > 150 and rgb[index * 3] > 55 and rgb[index * 3 + 2] < 70
              and rgb[index * 3 + 1] > rgb[index * 3] * 1.15]
    if not points:
        return None
    return min(x for x, _ in points), min(y for _, y in points), max(x for x, _ in points), max(y for _, y in points)


@pytest.mark.parametrize('edited_timeline', [False, True])
def test_real_overlays_use_half_open_output_time_after_trim_or_speed(runtime, database, tmp_path, edited_timeline):
    ffmpeg, _ = runtime
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    item.data = {**item.data, 'captions': [], 'overlays': [{**LEGACY, 'text': 'Timed', 'x': 0.2, 'y': 0.25,
                  'start': 0.5, 'end': 1.0}],
                 **({'timeline': timeline((2, 4, 2), (0, 1, 1))} if edited_timeline else {'trim_start': 1, 'trim_end': 3})}
    work = tmp_path / ('timeline' if edited_timeline else 'trim'); work.mkdir()
    generate_colors(ffmpeg, work)
    output, duration = render.render_files(render.input_snapshot(session, item), work)
    assert output.is_file() and abs(duration - 2) < 0.15
    before = lime_bounds(pixels(ffmpeg, work, 0.4, 'before.rgb'), 160)
    active = lime_bounds(pixels(ffmpeg, work, 0.5, 'active.rgb'), 160)
    ended = lime_bounds(pixels(ffmpeg, work, 1.0, 'ended.rgb'), 160)
    assert before is None and ended is None
    assert active is not None and active[2] < 110 and active[3] < 65


@pytest.mark.parametrize('x,y', [(0, 0), (1, 1)])
def test_real_position_clamps_box_inside_contained_media(runtime, database, tmp_path, x, y):
    ffmpeg, _ = runtime
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    item.data = {**item.data, 'trim_start': 0, 'trim_end': 0.3, 'captions': [],
                 'overlays': [{**LEGACY, 'text': 'Edge', 'x': x, 'y': y, 'scale': 0.5}]}
    work = tmp_path / f'edge-{x}-{y}'; work.mkdir(); generate_colors(ffmpeg, work)
    render.render_files(render.input_snapshot(session, item, 'portrait'), work)
    bounds = lime_bounds(pixels(ffmpeg, work, 0.1, 'edge.rgb'), 720)
    # 160x120 contained in 720x1280 gives 720x540 at y=370.
    assert bounds is not None
    left, top, right, bottom = bounds
    assert left >= 0 and top >= 370 and right < 720 and bottom < 910
    assert (right < 360 and bottom < 640) if x == 0 else (left > 360 and top > 640)


def test_real_scale_changes_text_box_while_preserving_requested_center(runtime, database, tmp_path):
    ffmpeg, _ = runtime
    _, session, user, _, _ = database
    item, _, _ = creation(session, user)
    boxes = []
    for scale in (0.5, 1.5):
        item.data = {**item.data, 'trim_start': 0, 'trim_end': 0.3, 'captions': [],
                     'overlays': [{**LEGACY, 'text': 'X', 'x': 0.5, 'y': 0.5, 'scale': scale}]}
        work = tmp_path / f'scale-{scale}'; work.mkdir(); generate_colors(ffmpeg, work)
        render.render_files(render.input_snapshot(session, item), work)
        box = lime_bounds(pixels(ffmpeg, work, 0.1, 'scale.rgb'), 160)
        assert box is not None
        assert abs((box[0] + box[2]) / 2 - 80) < 3
        assert abs((box[1] + box[3]) / 2 - 60) < 3
        boxes.append(box)
    assert boxes[1][2] - boxes[1][0] > boxes[0][2] - boxes[0][0] + 5
    assert boxes[1][3] - boxes[1][1] > boxes[0][3] - boxes[0][1] + 5


def test_real_oversized_text_fails_without_silent_resizing(runtime, database, tmp_path):
    ffmpeg, _ = runtime
    factory, session, user, _, backend = database
    item, media, _ = creation(session, user)
    item.data = {**item.data, 'trim_start': 0, 'trim_end': 0.3, 'captions': [],
                 'overlays': [{**LEGACY, 'text': '\n'.join(['Too tall'] * 10), 'x': 0.5, 'y': 0.5, 'scale': 2}]}
    work = tmp_path / 'overflow'; work.mkdir(); generate_colors(ffmpeg, work)
    source = (work / 'source.bin').read_bytes()
    with pytest.raises(RuntimeError, match='does not fit.*Reduce its size'):
        render.render_files(render.input_snapshot(session, item), work)
    assert (work / 'source.bin').read_bytes() == source
    assert not (work / 'output.mp4').exists()
    backend.path(media.id).write_bytes(source)
    media.size = len(source); session.commit()
    job = render.RenderJob(owner_id=user.id, item_id=item.id,
        input_fingerprint=render.input_fingerprint(session, item), snapshot=render.input_snapshot(session, item))
    session.add(job); session.commit()
    render.process_job(factory, *render.claim_job(session))
    session.expire_all(); job = session.get(render.RenderJob, job.id)
    assert job.status == 'failed' and 'Reduce its size' in job.detail
    assert backend.path(media.id).read_bytes() == source
    assert session.get(creator.CreatorMedia, job.output_media_id) is None
