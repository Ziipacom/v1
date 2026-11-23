"""Control-plane coverage for multiple relays without sending any media."""
import json
import time

import httpx
import pytest
from sqlalchemy.orm import Session

from test_live import AUTH, OTHER, create, harness
import live_api as live
import live_networks as networks
import social_publishing as publishing


CHANNEL = 'UC' + 'a' * 22
INSTAGRAM_KEY = '17900000000000001?s_sw=0&s_vt=ig&a=demoSignature'
INSTAGRAM_SERVER = 'rtmps://live-upload.instagram.com:443/rtmp/'
INSTAGRAM_RELAY = '36f70697-adb4-417c-866a-b3e4c833f5cd'
YOUTUBE_RELAY = 'cb6dc22c-5351-47b2-8bf6-42e5f8c71593'
STAGED = {'event_id': '12345678901', 'stream_id': 'youtube-ingest-1',
          'ingest_url': 'rtmps://a.rtmps.youtube.com/live2/private-youtube-test-key'}


@pytest.fixture
def multistream(harness, monkeypatch):
    h = harness
    h.client.app.include_router(networks.router)
    h.remote_calls = []
    h.target_urls = []
    h.provider_status = 'starting'
    h.prep_error = None
    monkeypatch.setattr(live.config, 'live_youtube_enabled', True)
    monkeypatch.setattr(live.config, 'live_instagram_enabled', True)
    monkeypatch.setattr(live.config, 'live_max_external_destinations', 2)
    monkeypatch.setattr(publishing, 'decrypt_tokens', lambda grant: {
        'provider': 'youtube', 'access_token': 'server-only',
        'scope': [networks.adapters.YOUTUBE_LIVE_SCOPE], 'expires_at': time.time() + 3600,
    })
    with Session(h.engine) as session:
        session.add(publishing.PublishingGrant(owner_id=1, provider='youtube', token_cipher='fixture-only',
                    status='authorized', selected_target_id=CHANNEL,
                    targets=[{'id': CHANNEL, 'name': 'Test YouTube', 'kind': 'youtube_channel'}]))
        session.commit()

    async def prepare(provider, tokens, target, title, description, *, settings, checkpoint):
        assert target == CHANNEL
        h.remote_calls.append(('prepare', provider))
        if h.prep_error:
            raise h.prep_error
        await checkpoint(STAGED['event_id'], STAGED['stream_id'])
        return STAGED

    async def status(provider, tokens, target, event, stream, *, settings):
        assert (target, event, stream) == (CHANNEL, STAGED['event_id'], STAGED['stream_id'])
        return h.provider_status

    async def end(provider, tokens, target, event, stream, *, settings):
        h.remote_calls.append(('end', provider))

    monkeypatch.setattr(networks.adapters, 'prepare', prepare)
    monkeypatch.setattr(networks.adapters, 'status', status)
    monkeypatch.setattr(networks.adapters, 'end', end)

    def override(request):
        if request.method == 'POST' and request.url.path == '/api/multistream/target':
            payload = json.loads(request.content)
            h.target_urls.append(payload['url'])
            identity = INSTAGRAM_RELAY if 'instagram' in payload['name'] else YOUTUBE_RELAY
            return httpx.Response(201, json={'id': identity, 'url': payload['url']})
        if request.method == 'DELETE' and request.url.path.startswith('/api/multistream/target/'):
            return httpx.Response(204)
        return None

    h.override = override
    return h


def stream_path(stream, operation):
    return '/api/live/streams/' + stream['id'] + operation


def select_network(h, stream, provider, **fields):
    return h.client.post(stream_path(stream, '/destinations/selection'), headers=AUTH,
                         json={'provider': provider, 'enabled': True, 'consent': True, **fields})


def snapshot(h, stream):
    result = h.client.get(stream_path(stream, '/destinations'), headers=AUTH)
    assert result.status_code == 200, result.text
    assert INSTAGRAM_KEY not in result.text and STAGED['ingest_url'] not in result.text
    assert result.headers['cache-control'] == 'private, no-store'
    return {row['provider']: row for row in result.json()['destinations']}


def test_selection_single_start_independent_proof_and_cleanup(multistream):
    h = multistream
    stream = create(h)
    assert snapshot(h, stream)['youtube']['can_enable'] is True
    assert select_network(h, stream, 'youtube', expected_target_id=CHANNEL).status_code == 200
    assert h.remote_calls == [] and h.target_urls == []
    instagram = select_network(h, stream, 'instagram', ingest_url=INSTAGRAM_SERVER, stream_key=INSTAGRAM_KEY)
    assert instagram.status_code == 200, instagram.text
    assert INSTAGRAM_KEY not in instagram.text and h.state['suspended'] is True
    started = h.client.post(stream_path(stream, '/start'), headers=AUTH, json={'confirm_public': True})
    assert started.status_code == 200, started.text
    assert h.remote_calls == [('prepare', 'youtube')]
    assert h.target_urls == [INSTAGRAM_SERVER + INSTAGRAM_KEY, STAGED['ingest_url']]
    assert {item['id'] for item in h.state['multistream']['targets']} == {INSTAGRAM_RELAY, YOUTUBE_RELAY}
    assert snapshot(h, stream)['youtube']['status'] == 'starting'
    h.state['isActive'], h.provider_status = True, 'live'
    h.client.get(stream_path(stream, ''), headers=AUTH)
    rows = snapshot(h, stream)
    assert rows['ziipa']['status'] == 'live'
    assert rows['youtube']['status'] == 'live' and rows['youtube']['verified_at']
    assert rows['instagram']['status'] == 'verification_unavailable' and not rows['instagram']['verified_at']
    ended = h.client.post(stream_path(stream, '/end'), headers=AUTH)
    assert ended.status_code == 200, ended.text
    assert ended.json()['status'] == 'ended' and h.state['multistream']['targets'] == []
    assert snapshot(h, stream)['youtube']['status'] == 'ended'
    assert h.remote_calls[-1] == ('end', 'youtube')


def test_scope_cap_and_elapsed_approval_do_not_leak_to_other_targets(multistream, monkeypatch):
    h = multistream
    stream = create(h)
    assert h.client.get(stream_path(stream, '/destinations'), headers=OTHER).status_code == 404
    assert select_network(h, stream, 'youtube', expected_target_id='UC' + 'z' * 22).status_code == 409
    assert select_network(h, stream, 'youtube', expected_target_id=CHANNEL).status_code == 200
    monkeypatch.setattr(live.config, 'live_max_external_destinations', 1)
    assert select_network(h, stream, 'instagram', ingest_url=INSTAGRAM_SERVER, stream_key=INSTAGRAM_KEY).status_code == 409
    assert not h.target_urls and not h.remote_calls
    h.state['multistream'] = {'targets': [{'id': INSTAGRAM_RELAY}]}
    stopped = h.client.post(stream_path(stream, '/start'), headers=AUTH, json={'confirm_public': True})
    assert stopped.status_code >= 400
    assert h.state['suspended'] is True
    assert not h.remote_calls


def test_uncertain_provider_create_is_not_repeated(multistream):
    h = multistream
    stream = create(h)
    assert select_network(h, stream, 'youtube', expected_target_id=CHANNEL).status_code == 200
    h.prep_error = networks.adapters.LiveNetworkError('The network did not confirm setup.', uncertain=True)
    for _ in range(2):
        response = h.client.post(stream_path(stream, '/start'), headers=AUTH, json={'confirm_public': True})
        assert response.status_code >= 400
    assert h.remote_calls == [('prepare', 'youtube')] and h.state['suspended'] is True
    assert snapshot(h, stream)['youtube']['status'] == 'error'


def test_manual_request_validation_never_reflects_credentials(multistream):
    h = multistream
    stream = create(h)
    response = select_network(h, stream, 'instagram', ingest_url=INSTAGRAM_SERVER,
                              stream_key={'private': INSTAGRAM_KEY})
    assert response.status_code == 422 and INSTAGRAM_KEY not in response.text
    response = select_network(h, stream, 'instagram', ingest_url='rtmps://example.test/rtmp/', stream_key=INSTAGRAM_KEY)
    assert response.status_code == 422 and INSTAGRAM_KEY not in response.text
    assert not h.target_urls


def test_end_renews_only_the_expired_youtube_token(multistream, monkeypatch):
    h = multistream
    stream = create(h)
    assert select_network(h, stream, 'youtube', expected_target_id=CHANNEL).status_code == 200
    assert h.client.post(stream_path(stream, '/start'), headers=AUTH,
                         json={'confirm_public': True}).status_code == 200
    monkeypatch.setattr(publishing, 'decrypt_tokens', lambda grant: {
        'provider': 'youtube', 'access_token': 'expired', 'refresh_token': 'test-only',
        'scope': [networks.adapters.YOUTUBE_LIVE_SCOPE], 'expires_at': time.time() - 10,
    })

    async def refresh(client, method, url, *, data):
        assert (method, url) == ('POST', publishing.TOKEN_URL)
        assert data['grant_type'] == 'refresh_token' and data['refresh_token'] == 'test-only'
        return 200, {'access_token': 'renewed-for-shutdown'}

    async def end(provider, tokens, target, event, ingest, *, settings):
        assert tokens['access_token'] == 'renewed-for-shutdown'
        assert target == CHANNEL and event == STAGED['event_id']
        h.remote_calls.append(('end', provider))

    monkeypatch.setattr(publishing, 'provider_json', refresh)
    monkeypatch.setattr(networks.adapters, 'end', end)
    result = h.client.post(stream_path(stream, '/end'), headers=AUTH)
    assert result.status_code == 200 and result.json()['status'] == 'ended'
    assert h.remote_calls[-1] == ('end', 'youtube')
    with Session(h.engine) as session:
        assert publishing.grant_for(session, 1, 'youtube').token_cipher == 'fixture-only'
