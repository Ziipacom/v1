"""Twitch relay lifecycle/security checks; every provider call is mocked."""
import asyncio
import json
from types import SimpleNamespace

from fastapi import HTTPException
import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from test_live import harness, create, AUTH, OTHER
from account_services import AccountState
import live_api as live
import social_publishing as publishing


TARGET_ID = '42d7d341-e992-4cce-88b2-b124b5768a52'
TWITCH_KEY = 'private-twitch-relay-stream-key-12345'
CHANNEL_ID = '987654321'


@pytest.fixture
def relay(harness, monkeypatch):
    h = harness
    h.twitch_calls, h.twitch_hook, h.fail_attach, h.fail_create, h.fail_delete = [], None, False, False, False
    with Session(h.engine) as session:
        session.add(publishing.PublishingGrant(owner_id=1, provider='twitch', token_cipher='unused-test-cipher',
            status='authorized', targets=[{'id': CHANNEL_ID, 'name': 'Test Twitch', 'kind': 'twitch_channel', 'url': ''}], selected_target_id=CHANNEL_ID))
        session.commit()
    async def authorized_ingest(user, session):
        h.twitch_calls.append(user.id)
        session.commit()  # Real helper commits while refreshing token state.
        if h.twitch_hook:
            h.twitch_hook()
        return {'target_id': CHANNEL_ID, 'server_url': 'rtmps://ingest.global-contribute.live-video.net/app/', 'stream_key': TWITCH_KEY}
    monkeypatch.setattr(publishing, 'twitch_ingest_for_live', authorized_ingest)
    def override(request):
        if request.method == 'POST' and request.url.path == '/api/multistream/target':
            assert json.loads(request.content)['url'] == 'rtmps://ingest.global-contribute.live-video.net/app/' + TWITCH_KEY
            if h.fail_create:
                return httpx.Response(503, json={'message': TWITCH_KEY})
            return httpx.Response(201, json={'id': TARGET_ID, 'url': 'rtmps://ingest.global-contribute.live-video.net/app/' + TWITCH_KEY})
        if request.method == 'DELETE' and request.url.path == '/api/multistream/target/' + TARGET_ID:
            return httpx.Response(503 if h.fail_delete else 204)
        if request.method == 'PATCH' and h.fail_attach:
            payload = json.loads(request.content)
            if (payload.get('multistream') or {}).get('targets'):
                return httpx.Response(503)
        return None
    h.override = override
    return h


def endpoint(stream):
    return '/api/live/streams/' + stream['id'] + '/destinations/twitch'


def target_creates(h):
    return [call for call in h.calls if call[0] == 'POST' and call[1] == '/api/multistream/target']


def test_relay_requires_owner_consent_and_twitch_scope_before_any_target(relay, monkeypatch):
    h = relay; stream = create(h)
    assert h.client.post(endpoint(stream), headers=OTHER, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID}).status_code == 404
    assert h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': False}).status_code == 422
    assert not target_creates(h) and not h.twitch_calls
    async def no_scope(*args):
        raise HTTPException(409, 'Twitch did not grant channel:read:stream_key. Reconnect and approve it.')
    monkeypatch.setattr(publishing, 'twitch_ingest_for_live', no_scope)
    assert h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID}).status_code == 409
    assert not target_creates(h)


def test_relay_receipt_is_private_idempotent_and_never_claims_live(relay):
    h = relay; stream = create(h)
    response = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID})
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'configured'
    assert 'not confirmation' in response.json()['detail']
    assert TWITCH_KEY not in response.text and TARGET_ID not in response.text and 'rtmps://' not in response.text
    assert 'no-store' in response.headers['cache-control']
    repeat = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID})
    assert repeat.status_code == 200 and len(target_creates(h)) == 1
    listed = h.client.get(endpoint(stream), headers=AUTH)
    assert TWITCH_KEY not in listed.text and h.client.get(endpoint(stream), headers=OTHER).status_code == 404
    with Session(h.engine) as session:
        destination = session.get(live.TwitchDestination, stream['id'])
        assert destination.target_id == TARGET_ID and not hasattr(destination, 'stream_key')


def test_unknown_attachment_retains_cleanup_id_and_never_reprovisions(relay):
    h = relay; stream = create(h); h.fail_attach = True
    result = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID})
    assert result.status_code == 502 and TWITCH_KEY not in result.text
    with Session(h.engine) as session:
        destination = session.get(live.TwitchDestination, stream['id'])
        assert destination.status == 'unknown' and destination.target_id == TARGET_ID
    assert h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID}).status_code == 409
    assert len(target_creates(h)) == 1
    h.fail_attach = False
    detached = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': False})
    assert detached.status_code == 200 and detached.json()['status'] == 'detached'
    assert any(call[0] == 'DELETE' and call[1].endswith(TARGET_ID) for call in h.calls)


def test_unknown_create_without_receipt_blocks_orphan_secret_hiding(relay):
    h = relay; stream = create(h); h.fail_create = True
    result = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID})
    assert result.status_code == 502 and TWITCH_KEY not in result.text
    assert h.client.post(endpoint(stream), headers=AUTH, json={'enabled': False}).status_code == 503
    assert h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID}).status_code == 409
    assert len(target_creates(h)) == 1


def test_relay_rechecks_concurrent_reservation_after_oauth_helper_commits(relay):
    h = relay; stream = create(h)
    with Session(h.engine) as session:
        session.add(live.TwitchDestination(stream_id=stream['id'], owner_id=1, channel_id=CHANNEL_ID, status='detached'))
        session.commit()
    def concurrent_reservation():
        with Session(h.engine) as session:
            row = session.get(live.TwitchDestination, stream['id'])
            row.status = 'creating'; session.commit()
    h.twitch_hook = concurrent_reservation
    result = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID})
    assert result.status_code == 409, result.text
    assert not target_creates(h)


def test_start_rechecks_privacy_changed_during_twitch_key_read(relay):
    h = relay; stream = create(h)
    assert h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID}).status_code == 200
    def privacy_changed():
        with Session(h.engine) as session:
            state = session.get(AccountState, 1)
            if state is None:
                state = AccountState(owner_id=1); session.add(state)
            state.privacy = {'profile_visibility': 'private'}; session.commit()
    h.twitch_hook = privacy_changed
    before = len(h.calls)
    result = h.client.post('/api/live/streams/' + stream['id'] + '/start', headers=AUTH, json={'confirm_public': True})
    assert result.status_code == 409, result.text
    assert not any(call[0] == 'PATCH' and call[2] == {'suspended': False} for call in h.calls[before:])
    assert h.state['suspended'] is True


def test_disconnect_removes_stream_reference_and_target_before_oauth_revocation(relay, monkeypatch):
    h = relay; h.client.app.include_router(publishing.router)
    stream = create(h)
    assert h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID}).status_code == 200
    revoked = []
    async def revoke(grant):
        assert h.state['multistream']['targets'] == []
        assert any(call[0] == 'DELETE' and call[1].endswith(TARGET_ID) for call in h.calls)
        revoked.append(grant.provider); return True
    monkeypatch.setattr(publishing, 'revoke_grant', revoke)
    h.fail_delete = True
    failed = h.client.post('/api/publishing/connections/twitch/disconnect', headers=AUTH)
    assert failed.status_code == 502 and not revoked
    with Session(h.engine) as session:
        assert session.scalar(select(publishing.PublishingGrant).where(publishing.PublishingGrant.provider == 'twitch')) is not None
    h.fail_delete = False
    result = h.client.post('/api/publishing/connections/twitch/disconnect', headers=AUTH)
    assert result.status_code == 200 and revoked == ['twitch']
    assert TWITCH_KEY not in result.text
    assert h.client.get(endpoint(stream), headers=AUTH).json()['status'] == 'detached'


def test_removing_twitch_preserves_other_provider_relays(relay):
    h = relay; stream = create(h)
    assert h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID}).status_code == 200
    other = {'id': '54c4b6cf-4e4d-4a28-9d36-8ebbb95c1e9f', 'profile': 'source', 'videoOnly': False}
    h.state['multistream']['targets'].append(other)
    result = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': False})
    assert result.status_code == 200 and result.json()['status'] == 'detached'
    assert h.state['multistream']['targets'] == [other]
    assert not any(call[0] == 'DELETE' and call[1].endswith(other['id']) for call in h.calls)


def test_adding_twitch_preserves_other_provider_relays(relay):
    h = relay; stream = create(h)
    other = {'id': '54c4b6cf-4e4d-4a28-9d36-8ebbb95c1e9f', 'profile': 'source', 'videoOnly': False}
    h.state['multistream'] = {'targets': [other]}
    result = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID})
    assert result.status_code == 200 and result.json()['status'] == 'configured'
    assert h.state['multistream']['targets'] == [other, {'id': TARGET_ID, 'profile': '720p', 'videoOnly': False}]


def test_approval_binds_displayed_twitch_channel_before_any_key_or_target_call(relay):
    h = relay; stream = create(h)
    missing = h.client.post(endpoint(stream), headers=AUTH, json={'enabled': True, 'consent': True})
    changed = h.client.post(endpoint(stream), headers=AUTH,
        json={'enabled': True, 'consent': True, 'expected_target_id': '123456789'})
    assert missing.status_code == 422 and changed.status_code == 409
    assert not h.twitch_calls and not target_creates(h)


def test_approval_rejects_channel_switch_during_twitch_refresh(relay):
    h = relay; stream = create(h)
    def switch_channel():
        with Session(h.engine) as session:
            grant = session.scalar(select(publishing.PublishingGrant).where(publishing.PublishingGrant.provider == 'twitch'))
            grant.selected_target_id = '123456789'; session.commit()
    h.twitch_hook = switch_channel
    response = h.client.post(endpoint(stream), headers=AUTH,
        json={'enabled': True, 'consent': True, 'expected_target_id': CHANNEL_ID})
    assert response.status_code == 409 and not target_creates(h)
    with Session(h.engine) as session:
        assert session.get(live.TwitchDestination, stream['id']) is None
