"""Isolated livestream security/lifecycle tests. No database, Redis or Livepeer service is contacted."""
import asyncio
from datetime import timedelta
from functools import partial
import hashlib
import json
from types import SimpleNamespace
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
from pydantic import SecretStr
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import app as main
import live_api as live
import mobile_api
import account_services
from account_services import AccountState
from creator import CreatorPreferences


PROVIDER_ID = '209fbea3-2a64-45cc-a656-aeec2f900971'
PLAYBACK_ID = 'abcd1234efgh5678'
STREAM_KEY = 'private-ingest-test-key-12345'
API_KEY = 'server-only-livepeer-test-secret'
PLAYBACK_URL = 'https://livepeercdn.studio/hls/' + PLAYBACK_ID + '/index.m3u8'
AUTH = {'Authorization': 'Bearer owner-one'}
OTHER = {'Authorization': 'Bearer owner-two'}


@pytest.fixture
def harness(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    main.User.__table__.create(engine)
    live.LiveStream.__table__.create(engine)
    AccountState.__table__.create(engine)
    CreatorPreferences.__table__.create(engine)
    main.Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add_all([main.User(id=1, name='One', email='one@example.test', password_hash='unused'),
                         main.User(id=2, name='Two', email='two@example.test', password_hash='unused')])
        session.commit()

    class Cache:
        def __init__(self):
            self.counts = {}

        def get(self, key):
            for token, owner in [('owner-one', '1'), ('owner-two', '2')]:
                if key == 'mobile_session:' + hashlib.sha256(token.encode()).hexdigest():
                    return owner
            return None

        def eval(self, script, count, key):
            self.counts[key] = self.counts.get(key, 0) + 1
            return self.counts[key]

    monkeypatch.setattr(main, 'cache', Cache())
    monkeypatch.setattr(mobile_api, 'revoke_user_sessions', lambda owner_id: None)
    monkeypatch.setattr(mobile_api, 'drain_media_deletions', lambda session: None)
    monkeypatch.setattr(mobile_api, 'storage', lambda: SimpleNamespace())
    monkeypatch.setattr(live.config, 'livepeer_api_key', SecretStr(API_KEY))
    monkeypatch.setattr(live.config, 'live_max_streams_per_owner', 3)
    monkeypatch.setattr(live.config, 'live_daily_create_limit', 10)
    state = {'id': PROVIDER_ID, 'playbackId': PLAYBACK_ID, 'streamKey': STREAM_KEY,
             'isActive': False, 'suspended': False, 'playbackPolicy': {'type': 'public'}}
    calls = []
    fixture = SimpleNamespace(engine=engine, state=state, calls=calls, override=None,
                              playback={'meta': {'source': [{'url': PLAYBACK_URL, 'type': 'html5/video/hls'}]}})

    def upstream(request):
        assert request.url.scheme == 'https'
        assert request.url.host == 'livepeer.studio'
        assert request.headers.get('authorization') == 'Bearer ' + API_KEY
        assert request.headers.get('cookie') is None
        payload = json.loads(request.content) if request.content else None
        calls.append((request.method, request.url.path, payload))
        if fixture.override:
            response = fixture.override(request)
            if response is not None:
                return response
        path = request.url.path
        if request.method == 'POST' and path == '/api/stream':
            return httpx.Response(201, json=state.copy())
        if request.method == 'GET' and path == '/api/stream/' + PROVIDER_ID:
            return httpx.Response(200, json=state.copy())
        if request.method == 'PATCH' and path == '/api/stream/' + PROVIDER_ID:
            state.update(payload)
            return httpx.Response(204)
        if request.method == 'DELETE' and path == '/api/stream/' + PROVIDER_ID + '/terminate':
            state['isActive'] = False
            return httpx.Response(204)
        if request.method == 'GET' and path == '/api/playback/' + PLAYBACK_ID:
            return httpx.Response(200, json=fixture.playback)
        pytest.fail('Unexpected provider operation: ' + request.method + ' ' + path)

    original_client = httpx.AsyncClient
    monkeypatch.setattr(live.httpx, 'AsyncClient', partial(original_client, transport=httpx.MockTransport(upstream)))

    def database():
        with Session(engine) as session:
            yield session

    application = FastAPI()
    application.include_router(live.router)
    application.include_router(mobile_api.router)
    application.include_router(account_services.router)
    application.dependency_overrides[main.db] = database
    with TestClient(application) as client:
        fixture.client = client
        yield fixture
    engine.dispose()


def create(h, request_id=None, **kwargs):
    response = h.client.post('/api/live/streams', headers=AUTH,
                             json={'request_id': request_id or str(uuid.uuid4()), 'title': 'Studio live', **kwargs})
    assert response.status_code == 201, response.text
    return response.json()


def start(h, stream):
    response = h.client.post('/api/live/streams/' + stream['id'] + '/start', headers=AUTH, json={'confirm_public': True})
    assert response.status_code == 200, response.text
    return response.json()


def make_live(h):
    stream = create(h)
    start(h, stream)
    h.state['isActive'] = True
    response = h.client.get('/api/live/streams/' + stream['id'], headers=AUTH)
    assert response.status_code == 200, response.text
    assert response.json()['live'] is True
    return response.json()


def assert_no_secrets(response):
    for secret in (API_KEY, STREAM_KEY, PROVIDER_ID):
        assert secret not in response.text


def test_unconfigured_is_explicit_without_provider_contact(harness, monkeypatch):
    h = harness
    monkeypatch.setattr(live.config, 'livepeer_api_key', SecretStr(''))
    config = h.client.get('/api/live/config')
    assert config.json()['configured'] is False
    response = h.client.post('/api/live/streams', headers=AUTH, json={'request_id': str(uuid.uuid4()), 'title': 'Test'})
    assert response.status_code == 409
    assert 'LIVEPEER_API_KEY' in response.json()['detail']
    assert h.calls == []


@pytest.mark.parametrize('method,path,body', [
    ('GET', '/api/live/streams', None),
    ('POST', '/api/live/streams', {'request_id': str(uuid.uuid4()), 'title': 'Test'}),
    ('GET', '/api/live/streams/' + PROVIDER_ID, None),
    ('POST', '/api/live/streams/' + PROVIDER_ID + '/start', {'confirm_public': True}),
    ('POST', '/api/live/streams/' + PROVIDER_ID + '/ingest', None),
    ('POST', '/api/live/streams/' + PROVIDER_ID + '/end', None),
])
def test_owner_routes_require_real_auth(harness, method, path, body):
    response = harness.client.request(method, path, json=body)
    assert response.status_code == 401
    assert harness.calls == []


def test_origin_guard_runs_before_provisioning(harness):
    response = harness.client.post('/api/live/streams', headers={**AUTH, 'Origin': 'https://untrusted.example'},
                                   json={'request_id': str(uuid.uuid4()), 'title': 'Test'})
    assert response.status_code == 403
    assert harness.calls == []


@pytest.mark.parametrize('method,suffix,body', [
    ('GET', '', None), ('POST', '/start', {'confirm_public': True}), ('POST', '/ingest', None), ('POST', '/end', None),
])
def test_cross_owner_access_is_404(harness, method, suffix, body):
    h = harness
    stream = create(h)
    h.calls.clear()
    response = h.client.request(method, '/api/live/streams/' + stream['id'] + suffix, headers=OTHER, json=body)
    assert response.status_code == 404
    assert h.calls == []
    assert h.client.get('/api/live/streams', headers=OTHER).json() == []


def test_create_is_prepared_without_public_playback_or_stored_ingest_key(harness):
    h = harness
    stream = create(h)
    assert stream['status'] == 'prepared' and stream['live'] is False and stream['playback_url'] is None
    assert h.state['suspended'] is True
    assert h.calls[0][2]['record'] is False
    assert h.client.get('/api/live/public').json() == []
    denied = h.client.post('/api/live/streams/' + stream['id'] + '/ingest', headers=AUTH)
    assert denied.status_code == 409
    listing = h.client.get('/api/live/streams', headers=AUTH)
    assert listing.headers['cache-control'] == 'private, no-store'
    assert_no_secrets(listing)
    with Session(h.engine) as session:
        row = session.get(live.LiveStream, stream['id'])
        assert 'stream_key' not in row.__table__.columns
        assert STREAM_KEY not in str({column.name: getattr(row, column.name) for column in row.__table__.columns})


def test_start_requires_explicit_boolean_confirmation_and_does_not_claim_live(harness):
    h = harness
    stream = create(h)
    for body in ({}, {'confirm_public': False}, {'confirm_public': 'true'}, {'confirm_public': 1}):
        response = h.client.post('/api/live/streams/' + stream['id'] + '/start', headers=AUTH, json=body)
        assert response.status_code == 422
    result = start(h, stream)
    assert result['status'] == 'awaiting_media' and result['live'] is False and result['playback_url'] is None
    assert h.state['suspended'] is False
    assert h.client.get('/api/live/public').json() == []


def test_encoder_secrets_only_return_to_owner_after_start(harness):
    h = harness
    stream = create(h)
    start(h, stream)
    response = h.client.post('/api/live/streams/' + stream['id'] + '/ingest', headers=AUTH)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['referrer-policy'] == 'no-referrer'
    assert response.json()['stream_key'] == STREAM_KEY
    assert response.json()['whip_url'] == 'https://playback.livepeer.studio/webrtc/' + STREAM_KEY
    assert response.json()['rtmp_server'] == 'rtmp://rtmp.livepeer.studio/live'
    assert API_KEY not in response.text
    h.state['suspended'] = True
    assert h.client.post('/api/live/streams/' + stream['id'] + '/ingest', headers=AUTH).status_code == 409


def test_only_verified_active_provider_stream_is_live_and_public(harness):
    h = harness
    stream = make_live(h)
    assert stream['playback_url'] == PLAYBACK_URL
    for response in (h.client.get('/api/live/public'), h.client.get('/api/live/public/' + stream['id'])):
        assert response.status_code == 200
        assert_no_secrets(response)
        assert 'request_id' not in response.text
        assert 'record' not in response.json() if isinstance(response.json(), dict) else True
    assert h.client.get('/api/live/public').json()[0]['id'] == stream['id']
    h.state['isActive'] = False
    detail = h.client.get('/api/live/streams/' + stream['id'], headers=AUTH).json()
    assert detail['status'] == 'awaiting_media' and detail['playback_url'] is None
    assert h.client.get('/api/live/public').json() == []


def test_stale_verification_never_remains_live(harness):
    h = harness
    stream = make_live(h)
    with Session(h.engine) as session:
        session.get(live.LiveStream, stream['id']).checked_at = live.now() - timedelta(seconds=21)
        session.commit()
    assert h.client.get('/api/live/public').json() == []
    listing = h.client.get('/api/live/streams', headers=AUTH).json()[0]
    assert listing['status'] == 'unknown' and listing['live'] is False and listing['playback_url'] is None


@pytest.mark.parametrize('change', [
    {'isActive': 'true'}, {'suspended': None}, {'id': 'not-a-uuid'},
    {'playbackId': 'different-but-valid-id'}, {'playbackPolicy': 'public'},
])
def test_malformed_provider_status_invalidates_live_without_leaking(harness, change):
    h = harness
    stream = make_live(h)
    h.state.update(change)
    response = h.client.get('/api/live/streams/' + stream['id'], headers=AUTH)
    assert response.status_code == 502
    assert_no_secrets(response)
    assert h.client.get('/api/live/public').json() == []


@pytest.mark.parametrize('malformed', [{'meta': 'wrong'}, {'meta': {'source': 'wrong'}}, {'meta': [STREAM_KEY]}])
def test_malformed_playback_response_is_safe(harness, malformed):
    h = harness
    stream = make_live(h)
    h.playback = malformed
    response = h.client.get('/api/live/streams/' + stream['id'], headers=AUTH)
    assert response.status_code == 502
    assert_no_secrets(response)
    assert h.client.get('/api/live/public').json() == []


@pytest.mark.parametrize('unsafe', [
    'http://livepeercdn.studio/hls/a.m3u8', 'https://evil.example/a.m3u8',
    'https://livepeercdn.studio.evil.example/a.m3u8', 'https://127.0.0.1/a.m3u8',
    'https://user:pass@livepeercdn.studio/a.m3u8', 'https://livepeercdn.studio:443/a.m3u8',
    'https://livepeercdn.studio/a.m3u8?secret=key', 'https://livepeercdn.studio/%2e%2e/a.m3u8',
    'https://livepeercdn.studio/../a.m3u8', 'file:///camera.mp4', None, 12,
])
def test_unsafe_playback_urls_are_not_published(unsafe):
    assert live.safe_playback_url(unsafe) is None


def test_no_safe_hls_source_means_not_publicly_listed(harness):
    h = harness
    h.playback = {'meta': {'source': [{'url': 'https://evil.example/video.m3u8'}]}}
    stream = make_live(h)
    assert stream['playback_url'] is None
    assert h.client.get('/api/live/public').json() == []
    assert h.client.get('/api/live/public/' + stream['id']).status_code == 404


def test_end_suspends_then_terminates_then_verifies_and_cannot_restart(harness):
    h = harness
    stream = make_live(h)
    h.calls.clear()
    response = h.client.post('/api/live/streams/' + stream['id'] + '/end', headers=AUTH)
    assert response.status_code == 200
    assert response.json()['status'] == 'ended' and response.json()['live'] is False
    assert [(method, path.rsplit('/', 1)[-1], payload) for method, path, payload in h.calls] == [
        ('PATCH', PROVIDER_ID, {'suspended': True}), ('DELETE', 'terminate', None), ('GET', PROVIDER_ID, None)]
    assert h.client.get('/api/live/public').json() == []
    h.calls.clear()
    assert h.client.post('/api/live/streams/' + stream['id'] + '/end', headers=AUTH).json()['status'] == 'ended'
    assert h.calls == []
    assert h.client.post('/api/live/streams/' + stream['id'] + '/start', headers=AUTH, json={'confirm_public': True}).status_code == 409
    assert h.client.post('/api/live/streams/' + stream['id'] + '/ingest', headers=AUTH).status_code == 409


def test_failed_end_unlists_immediately_but_does_not_claim_ended(harness):
    h = harness
    stream = make_live(h)
    h.override = lambda request: httpx.Response(500, text=API_KEY + STREAM_KEY)
    response = h.client.post('/api/live/streams/' + stream['id'] + '/end', headers=AUTH)
    assert response.status_code == 502
    assert_no_secrets(response)
    assert h.client.get('/api/live/public').json() == []
    status = h.client.get('/api/live/streams', headers=AUTH).json()[0]
    assert status['status'] == 'ending' and status['playback_url'] is None
    h.override = None
    assert h.client.post('/api/live/streams/' + stream['id'] + '/end', headers=AUTH).json()['status'] == 'ended'


def test_active_after_terminate_remains_ending_until_provider_verifies_stopped(harness):
    h = harness
    stream = make_live(h)
    h.override = lambda request: httpx.Response(204) if request.method == 'DELETE' else None
    result = h.client.post('/api/live/streams/' + stream['id'] + '/end', headers=AUTH).json()
    assert result['status'] == 'ending' and result['live'] is False
    h.state['isActive'] = False
    assert h.client.get('/api/live/streams/' + stream['id'], headers=AUTH).json()['status'] == 'ended'


def test_idempotent_create_and_settings_mismatch_never_duplicate_provider_call(harness):
    h = harness
    request_id = str(uuid.uuid4())
    first = create(h, request_id)
    second = create(h, request_id)
    assert first['id'] == second['id']
    assert len([c for c in h.calls if c[0] == 'POST']) == 1
    response = h.client.post('/api/live/streams', headers=AUTH, json={'request_id': request_id, 'title': 'Changed'})
    assert response.status_code == 409
    assert len([c for c in h.calls if c[0] == 'POST']) == 1


def test_create_timeout_is_reserved_and_not_automatically_retried(harness):
    h = harness
    request_id = str(uuid.uuid4())

    def timeout(request):
        raise httpx.ReadTimeout(API_KEY + STREAM_KEY, request=request)

    h.override = timeout
    response = h.client.post('/api/live/streams', headers=AUTH, json={'request_id': request_id, 'title': 'Studio live'})
    assert response.status_code == 502
    assert_no_secrets(response)
    assert len(h.calls) == 1
    saved = create(h, request_id)
    assert saved['status'] == 'provisioning_unknown'
    assert len(h.calls) == 1
    assert h.client.post('/api/live/streams/' + saved['id'] + '/end', headers=AUTH).status_code == 409


def test_owner_create_quota_is_checked_before_provider_call(harness):
    h = harness
    for _ in range(3):
        create(h)
    response = h.client.post('/api/live/streams', headers=AUTH, json={'request_id': str(uuid.uuid4()), 'title': 'Too many'})
    assert response.status_code == 429
    assert len([c for c in h.calls if c[0] == 'POST']) == 3


@pytest.mark.parametrize('failure', ['redirect', 'oversized', 'secret_error', 'non_json', 'non_object'])
def test_bad_upstream_response_is_not_followed_or_exposed(harness, failure):
    h = harness
    responses = {
        'redirect': httpx.Response(302, headers={'Location': 'https://evil.example/' + STREAM_KEY}),
        'oversized': httpx.Response(200, content=b'x' * (live.MAX_RESPONSE_BYTES + 1)),
        'secret_error': httpx.Response(401, text=API_KEY + STREAM_KEY),
        'non_json': httpx.Response(200, text=API_KEY + STREAM_KEY),
        'non_object': httpx.Response(200, json=[STREAM_KEY]),
    }
    h.override = lambda request: responses[failure]
    response = h.client.post('/api/live/streams', headers=AUTH, json={'request_id': str(uuid.uuid4()), 'title': 'Studio live'})
    assert response.status_code == 502
    assert_no_secrets(response)
    assert len(h.calls) == 1


def test_safe_get_retries_only_once_and_clears_stale_live(harness):
    h = harness
    stream = make_live(h)
    h.calls.clear()
    h.override = lambda request: httpx.Response(503, text=STREAM_KEY)
    response = h.client.get('/api/live/streams/' + stream['id'], headers=AUTH)
    assert response.status_code == 502
    assert_no_secrets(response)
    assert len(h.calls) == 2
    assert h.client.get('/api/live/public').json() == []


@pytest.mark.parametrize('method,path', [
    ('GET', 'https://evil.example/stream'), ('GET', '/stream/../../secret'),
    ('POST', '/playback/' + PLAYBACK_ID), ('DELETE', '/stream/' + PROVIDER_ID),
])
def test_provider_request_rejects_non_allowlisted_paths_without_network(harness, method, path):
    with pytest.raises(HTTPException) as error:
        asyncio.run(live.provider_request(method, path))
    assert error.value.status_code == 500
    assert harness.calls == []


@pytest.mark.parametrize('privacy', ['private', 'members'])
def test_nonpublic_profile_cannot_enable_public_ingest(harness, privacy):
    h = harness
    stream = create(h)
    with Session(h.engine) as session:
        session.add(AccountState(owner_id=1, privacy={'profile_visibility': privacy}))
        session.commit()
    h.calls.clear()
    response = h.client.post('/api/live/streams/' + stream['id'] + '/start', headers=AUTH, json={'confirm_public': True})
    assert response.status_code == 409
    assert h.calls == []


@pytest.mark.parametrize('privacy', [{'profile_visibility': 'private'}, {'profile_visibility': 'members'}, {'discoverable': False}])
def test_public_list_respects_current_privacy(harness, privacy):
    h = harness
    stream = make_live(h)
    with Session(h.engine) as session:
        session.add(AccountState(owner_id=1, privacy=privacy))
        session.commit()
    assert h.client.get('/api/live/public').json() == []
    if privacy.get('profile_visibility'):
        h.calls.clear()
        assert h.client.get('/api/live/public/' + stream['id']).status_code == 404
        assert h.calls == []


@pytest.mark.parametrize('blocking_owner,blocked', [(1, 2), (2, 1)])
def test_signed_in_viewer_blocking_is_bidirectional(harness, blocking_owner, blocked):
    h = harness
    stream = make_live(h)
    with Session(h.engine) as session:
        session.add(CreatorPreferences(owner_id=blocking_owner, data={'blocked_user_ids': [blocked]}))
        session.commit()
    assert h.client.get('/api/live/public', headers=OTHER).json() == []
    h.calls.clear()
    assert h.client.get('/api/live/public/' + stream['id'], headers=OTHER).status_code == 404
    assert h.calls == []


def test_account_delete_stops_ingest_before_removing_foreign_key_records(harness):
    h = harness
    stream = make_live(h)
    with Session(h.engine) as session:
        asyncio.run(live.delete_live_account(1, session))
        session.commit()
        assert session.get(live.LiveStream, stream['id']) is None
        assert session.get(main.User, 1) is not None  # Caller still owns account deletion.
    assert h.state['suspended'] is True and h.state['isActive'] is False


def test_failed_account_shutdown_preserves_owner_and_stream_records(harness):
    h = harness
    stream = make_live(h)
    h.override = lambda request: httpx.Response(500, text=STREAM_KEY)
    with Session(h.engine) as session:
        with pytest.raises(HTTPException) as error:
            asyncio.run(live.delete_live_account(1, session))
        assert error.value.status_code == 503
        assert STREAM_KEY not in error.value.detail
        session.rollback()
        assert session.get(live.LiveStream, stream['id']) is not None
        assert session.get(main.User, 1) is not None


@pytest.mark.parametrize('failure', [False, True])
def test_actual_account_delete_endpoint_has_no_live_orphan(harness, failure):
    h = harness
    stream = make_live(h)
    password = 'Ziipa-delete-test-only-password'
    with Session(h.engine) as session:
        session.get(main.User, 1).password_hash = main.passwords.hash(password)
        session.commit()
    if failure:
        h.override = lambda request: httpx.Response(500, text=STREAM_KEY)
    response = h.client.post('/api/account/delete', headers=AUTH, json={'password': password, 'confirmation': 'DELETE'})
    assert response.status_code == (503 if failure else 200), response.text
    assert_no_secrets(response)
    with Session(h.engine) as session:
        assert (session.get(main.User, 1) is not None) is failure
        assert (session.get(live.LiveStream, stream['id']) is not None) is failure
        assert session.get(main.User, 2) is not None
    if not failure:
        assert h.state['suspended'] is True and h.state['isActive'] is False
        assert h.client.get('/api/live/public').json() == []


@pytest.mark.parametrize('failure', [False, True])
def test_actual_privacy_endpoint_stops_before_change_and_rolls_back_on_failure(harness, failure):
    h = harness
    stream = make_live(h)
    with Session(h.engine) as session:
        session.add(AccountState(owner_id=1, privacy={'profile_visibility': 'public', 'discoverable': True}))
        session.commit()
    if failure:
        h.override = lambda request: httpx.Response(500, text=STREAM_KEY)
    response = h.client.post('/api/account/privacy', headers=AUTH, json={'profile_visibility': 'private', 'discoverable': False})
    assert response.status_code == (503 if failure else 200), response.text
    assert_no_secrets(response)
    with Session(h.engine) as session:
        assert session.get(main.User, 1) is not None
        assert session.get(AccountState, 1).privacy['profile_visibility'] == ('public' if failure else 'private')
        assert session.get(live.LiveStream, stream['id']).status == ('live' if failure else 'ended')
    if not failure:
        assert h.state['suspended'] is True and h.state['isActive'] is False
        assert h.client.get('/api/live/public').json() == []
