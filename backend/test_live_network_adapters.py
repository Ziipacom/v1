"""Provider contract tests. All calls use an in-process transport."""

import asyncio
from datetime import datetime, timezone
import json
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest

import live_network_adapters as adapters


CHANNEL = 'UC' + 'a' * 22
VIDEO = 'ZiipaTest01'
STREAM = 'temporary-relay'
PAGE = '12345'
FACEBOOK_EVENT = '54321'
YT_TOKENS = {'provider': 'youtube', 'scope': [adapters.YOUTUBE_LIVE_SCOPE], 'access_token': 'synthetic-youtube-token'}
FB_TOKENS = {
    'provider': 'facebook', 'scope': ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    'page_tokens': {PAGE: {'page_id': PAGE, 'access_token': 'synthetic-page-token'}},
}
META_SETTINGS = SimpleNamespace(meta_client_secret='synthetic-app-secret', meta_graph_version='v25.0')


def mock_provider(monkeypatch, handle):
    monkeypatch.setattr(adapters, '_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle)))


def test_youtube_confirms_destination_and_cleans_up_only_its_temporary_input(monkeypatch):
    state = {'broadcast': 'ready', 'stream': 'inactive'}
    checkpoints = []

    def event():
        return {'id': VIDEO, 'snippet': {'channelId': CHANNEL},
                'status': {'lifeCycleStatus': state['broadcast'], 'privacyStatus': 'public'},
                'contentDetails': {'boundStreamId': STREAM, 'enableAutoStart': True, 'enableAutoStop': True}}

    def handler(request):
        assert request.url.host == 'www.googleapis.com'
        assert request.headers['Authorization'] == 'Bearer synthetic-youtube-token'
        if request.url.path.endswith('/channels'):
            return httpx.Response(200, json={'items': [{'id': CHANNEL}]})
        if request.url.path.endswith('/liveStreams'):
            if request.method == 'POST':
                assert json.loads(request.content)['contentDetails']['isReusable'] is False
                return httpx.Response(200, json={'id': STREAM, 'snippet': {'channelId': CHANNEL},
                    'cdn': {'ingestionInfo': {'rtmpsIngestionAddress': 'rtmps://a.rtmps.youtube.com/live2',
                                              'streamName': 'synthetic-key'}}})
            if request.method == 'DELETE':
                assert request.url.params['id'] == STREAM
                state['deleted'] = True
                return httpx.Response(204)
            return httpx.Response(200, json={'items': [{'id': STREAM, 'snippet': {'channelId': CHANNEL},
                'status': {'streamStatus': state['stream']}, 'contentDetails': {'isReusable': False}}]})
        if request.url.path.endswith('/liveBroadcasts'):
            if request.method == 'POST':
                assert checkpoints == [(None, STREAM)]
                body = json.loads(request.content)
                assert body['contentDetails']['enableAutoStart'] and body['contentDetails']['enableAutoStop']
                assert body['contentDetails']['monitorStream']['enableMonitorStream'] is False
                assert 'recordFromStart' not in body['contentDetails']
                return httpx.Response(200, json=event())
            return httpx.Response(200, json={'items': [event()]})
        if request.url.path.endswith('/bind'):
            assert checkpoints == [(None, STREAM), (VIDEO, STREAM)]
            assert request.url.params['streamId'] == STREAM
            return httpx.Response(200, json=event())
        if request.url.path.endswith('/transition'):
            assert request.url.params['broadcastStatus'] == 'complete'
            state['broadcast'] = 'complete'
            return httpx.Response(200, json=event())
        pytest.fail(f'Unexpected operation {request.method} {request.url.path}')

    mock_provider(monkeypatch, handler)

    async def checkpoint(event_id, stream_id):
        checkpoints.append((event_id, stream_id))

    async def scenario():
        receipt = await adapters.prepare('youtube', YT_TOKENS, CHANNEL, 'Example', '', checkpoint=checkpoint)
        assert receipt == {'event_id': VIDEO, 'stream_id': STREAM,
                           'ingest_url': 'rtmps://a.rtmps.youtube.com/live2/synthetic-key',
                           'playback_url': f'https://www.youtube.com/watch?v={VIDEO}'}
        assert await adapters.status('youtube', YT_TOKENS, CHANNEL, VIDEO, STREAM) == 'starting'
        state['broadcast'] = 'live'
        assert await adapters.status('youtube', YT_TOKENS, CHANNEL, VIDEO, STREAM) == 'unknown'
        state['stream'] = 'active'
        assert await adapters.status('youtube', YT_TOKENS, CHANNEL, VIDEO, STREAM) == 'live'
        await adapters.end('youtube', YT_TOKENS, CHANNEL, VIDEO, STREAM)
        assert state['deleted']
        assert await adapters.status('youtube', YT_TOKENS, CHANNEL, VIDEO, STREAM) == 'ended'

    asyncio.run(scenario())


def test_youtube_rejects_upload_only_grant_and_checkpoints_before_ingest_validation(monkeypatch):
    calls = []
    checkpoints = []

    def handler(request):
        calls.append(request.method)
        if request.method == 'GET':
            return httpx.Response(200, json={'items': [{'id': CHANNEL}]})
        assert request.url.path.endswith('/liveStreams')
        return httpx.Response(200, json={'id': STREAM, 'snippet': {'channelId': CHANNEL},
            'cdn': {'ingestionInfo': {'rtmpsIngestionAddress': 'rtmps://localhost/live2', 'streamName': 'secret-do-not-log'}}})

    mock_provider(monkeypatch, handler)

    async def checkpoint(event_id, stream_id):
        checkpoints.append((event_id, stream_id))

    async def scenario():
        without_live_scope = {**YT_TOKENS, 'scope': ['https://www.googleapis.com/auth/youtube.upload']}
        with pytest.raises(adapters.LiveNetworkError, match='authorize live'):
            await adapters.prepare('youtube', without_live_scope, CHANNEL, 'Example', '')
        assert calls == []
        with pytest.raises(adapters.LiveNetworkError, match='approved secure ingest') as exc:
            await adapters.prepare('youtube', YT_TOKENS, CHANNEL, 'Example', '', checkpoint=checkpoint)
        assert 'secret-do-not-log' not in str(exc.value)
        assert calls == ['GET', 'POST'] and checkpoints == [(None, STREAM)]

    asyncio.run(scenario())


def test_facebook_reports_live_only_for_started_owned_page_event(monkeypatch):
    state = {'status': 'LIVE_NOW', 'owner': PAGE, 'start': None}
    checkpoints = []

    def handler(request):
        assert request.url.host == 'graph.facebook.com'
        assert request.headers['Authorization'] == 'Bearer synthetic-page-token'
        assert len(request.url.params['appsecret_proof']) == 64
        if request.url.path.endswith(f'/{PAGE}/live_videos'):
            assert parse_qs(request.content.decode())['status'] == ['LIVE_NOW']
            return httpx.Response(200, json={'id': FACEBOOK_EVENT,
                'secure_stream_url': 'rtmps://live-api-s.facebook.com:443/rtmp/FB-synthetic?mode=1'})
        assert request.url.path.endswith('/' + FACEBOOK_EVENT)
        if request.method == 'POST':
            assert state['owner'] == PAGE
            assert parse_qs(request.content.decode())['end_live_video'] == ['true']
            state['status'] = 'LIVE_STOPPED'
            return httpx.Response(200, json={'success': True})
        return httpx.Response(200, json={'id': FACEBOOK_EVENT, 'from': {'id': state['owner']},
            'status': state['status'], 'broadcast_start_time': state['start']})

    mock_provider(monkeypatch, handler)

    async def checkpoint(event_id, stream_id):
        checkpoints.append((event_id, stream_id))

    async def scenario():
        receipt = await adapters.prepare('facebook', FB_TOKENS, PAGE, 'Example', '', settings=META_SETTINGS,
                                         checkpoint=checkpoint)
        assert checkpoints == [(FACEBOOK_EVENT, None)] and receipt['event_id'] == FACEBOOK_EVENT
        args = ('facebook', FB_TOKENS, PAGE, FACEBOOK_EVENT, None)
        assert await adapters.status(*args, settings=META_SETTINGS) == 'starting'
        state['status'] = 'LIVE'
        assert await adapters.status(*args, settings=META_SETTINGS) == 'starting'
        state['start'] = datetime.now(timezone.utc).isoformat()
        assert await adapters.status(*args, settings=META_SETTINGS) == 'live'
        state['owner'] = '11111'
        assert await adapters.status(*args, settings=META_SETTINGS) == 'unknown'
        with pytest.raises(adapters.LiveNetworkError, match='selected Page'):
            await adapters.end(*args, settings=META_SETTINGS)
        state['owner'] = PAGE
        await adapters.end(*args, settings=META_SETTINGS)
        assert await adapters.status(*args, settings=META_SETTINGS) == 'ended'

    asyncio.run(scenario())
