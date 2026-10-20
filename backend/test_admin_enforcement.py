"""Owner-status/moderation checkpoints; isolated SQL and no provider network."""
import asyncio
import base64
import hashlib
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import hmac
import json
from types import SimpleNamespace
import uuid

from fastapi import HTTPException
import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

import app
import admin_services as admin
import agent_api
import agent_worker
import campaign_worker
from creation_campaigns import CreationCampaign
from creator import CreatorItem, CreatorMedia
import live_api
import media_workflows as workflows
import workflow_worker
import notification_services as notifications
import notification_worker
import social_publishing as publishing


def identifier():
    return str(uuid.uuid4())


@pytest.fixture
def h(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    app.Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as session:
        user = app.User(name='Security owner', email='security-owner@example.test', password_hash='unused')
        session.add(user); session.commit()
        owner_id = user.id
    def no_network(*args, **kwargs):
        pytest.fail('Enforcement must not contact a real network')
    monkeypatch.setattr(notification_worker, 'send_web', no_network)
    monkeypatch.setattr(notification_worker, 'send_expo', no_network)
    yield factory, owner_id
    engine.dispose()


def suspend(factory, owner_id):
    with factory() as session:
        session.add(admin.AdminUserState(user_id=owner_id, status='suspended'))
        session.commit()


def maintenance(factory):
    with factory() as session:
        session.add(admin.AdminSettings(id=1, maintenance_mode=True))
        session.commit()


def campaign(session, owner_id, **changes):
    row = CreationCampaign(owner_id=owner_id, request_id=identifier(), request_hash='a' * 64,
        item_id=identifier(), name='Retain intent', title='Reviewed content', status='queued',
        next_run=datetime.now(timezone.utc) - timedelta(seconds=5), **changes)
    session.add(row); session.commit()
    return row


def test_suspended_campaign_claim_pauses_without_losing_approval_or_history(h):
    factory, owner_id = h
    with factory() as session:
        row = campaign(session, owner_id, approved_hash='b' * 64)
        row_id = row.id
    suspend(factory, owner_id)
    with factory() as session:
        assert campaign_worker.claim(session) is None
        row = session.get(CreationCampaign, row_id)
        assert row.status == 'paused' and row.paused_status == 'queued'
        assert row.approved_hash == 'b' * 64 and row.lease_token == '' and row.next_run is None
        assert 'suspended' in row.detail.lower()


def test_suspension_after_campaign_claim_stops_preparation_before_tools(h):
    factory, owner_id = h
    with factory() as session:
        row = campaign(session, owner_id)
        row_id = row.id
        claimed = campaign_worker.claim(session)
    assert claimed
    suspend(factory, owner_id)
    campaign_worker.prepare(factory, *claimed,
        render_dispatch=lambda *a: pytest.fail('Suspended account rendered'),
        transcribe=lambda *a: pytest.fail('Suspended account transcribed'))
    with factory() as session:
        assert session.get(CreationCampaign, row_id).status == 'paused'


def test_maintenance_defers_campaign_without_discarding_schedule_or_approval(h):
    factory, owner_id = h
    with factory() as session:
        row = campaign(session, owner_id, approved_hash='b' * 64)
        row_id = row.id
    maintenance(factory)
    with factory() as session:
        assert campaign_worker.claim(session) is None
        row = session.get(CreationCampaign, row_id)
        assert row.status == 'queued' and row.approved_hash == 'b' * 64
        assert row.next_run is not None and row.lease_token == ''
        assert 'maintenance' in row.detail.lower()


@pytest.mark.parametrize('blocked_by', ['suspension', 'maintenance'])
def test_agent_claim_retains_task_but_pauses_before_inference(h, blocked_by):
    factory, owner_id = h
    with factory() as session:
        task = agent_api.AgentTask(owner_id=owner_id, request_id=identifier(), request_hash='a' * 64,
            objective='Private work must remain in history')
        session.add(task); session.commit(); task_id = task.id
    (suspend(factory, owner_id) if blocked_by == 'suspension' else maintenance(factory))
    with factory() as session:
        assert agent_worker.claim_task(session) is None
        row = session.get(agent_api.AgentTask, task_id)
        assert row.status == 'paused' and row.model_calls == 0 and row.step_count == 0


def test_agent_suspension_after_claim_blocks_private_action(h):
    factory, owner_id = h
    now = datetime.now(timezone.utc)
    with factory() as session:
        task = agent_api.AgentTask(owner_id=owner_id, request_id=identifier(), request_hash='a' * 64,
            objective='Preserve completed receipts', status='running', lease_token='lease',
            lease_until=now + timedelta(minutes=2), deadline=now + timedelta(minutes=10))
        session.add(task); session.commit(); task_id = task.id
    suspend(factory, owner_id)
    agent_worker.execute_step(factory, task_id, 'lease', identifier(),
        approve=lambda *a: pytest.fail('Suspended task reached action execution'))
    with factory() as session:
        assert session.get(agent_api.AgentTask, task_id).status == 'paused'


def workflow(session, owner_id):
    now = datetime.now(timezone.utc)
    row = workflows.OsWorkflow(owner_id=owner_id, name='Keep this reminder', action='reminder',
        trigger='scheduled', enabled=True, run_at=now - timedelta(seconds=5), next_run=now - timedelta(seconds=5))
    session.add(row); session.flush()
    run = workflows.OsWorkflowRun(owner_id=owner_id, workflow_id=row.id, occurrence_key='owned-once',
        snapshot={'revision': 1, 'manual': True, 'action': 'reminder'})
    session.add(run); session.commit()
    return row.id, run.id


def test_workflow_suspension_blocks_durable_run_and_disables_schedule(h):
    factory, owner_id = h
    with factory() as session:
        workflow_id, run_id = workflow(session, owner_id)
    suspend(factory, owner_id)
    with factory() as session:
        assert workflow_worker.claim_run(session) is None
        row, run = session.get(workflows.OsWorkflow, workflow_id), session.get(workflows.OsWorkflowRun, run_id)
        assert not row.enabled and run.status == 'blocked'
        assert row.name == 'Keep this reminder' and 'suspended' in run.detail.lower()


def test_workflow_scan_does_not_enqueue_for_suspended_owner(h):
    factory, owner_id = h
    with factory() as session:
        workflow_id, _ = workflow(session, owner_id)
    suspend(factory, owner_id)
    with factory() as session:
        assert workflow_worker.scan_due(session) == 0
        assert not session.get(workflows.OsWorkflow, workflow_id).enabled
        assert len(list(session.scalars(select(workflows.OsWorkflowRun)))) == 1


def test_push_suspended_owner_revokes_credential_before_session_or_transport(h, monkeypatch):
    factory, owner_id = h
    with factory() as session:
        device = notifications.PushDevice(owner_id=owner_id, installation_id=identifier(), provider='web',
            label='Synthetic', fingerprint='a' * 64, endpoint_cipher='never-decrypt', session_key='session:synthetic')
        session.add(device); session.commit()
        device_id = device.id
    suspend(factory, owner_id)
    monkeypatch.setattr(notifications, 'cache', SimpleNamespace(get=lambda key: pytest.fail('Suspended push consulted session')))
    with factory() as session:
        device, error = notification_worker.current_permission(session,
            SimpleNamespace(owner_id=owner_id, device_id=device_id, device_revision=1, category='calendar', provider='web'))
        assert error == 'revoked' and device.status == 'revoked' and device.endpoint_cipher == ''


def test_suspended_author_is_hidden_from_anonymous_live_discovery(h):
    factory, owner_id = h
    suspend(factory, owner_id)
    with factory() as session:
        assert live_api.public_visible(session, SimpleNamespace(owner_id=owner_id), None) is False


def prepared_stream(factory, owner_id, *, twitch=False, enabled=False):
    with factory() as session:
        stream = live_api.LiveStream(owner_id=owner_id, request_id=identifier(),
            title='Reviewed live plan', provider_id=identifier(), playback_id='synthetic123',
            status='awaiting_media' if enabled else 'prepared', publish_enabled=enabled)
        session.add(stream); session.flush()
        if twitch:
            session.add(live_api.TwitchDestination(stream_id=stream.id, owner_id=owner_id,
                channel_id='123456', target_id=identifier(), status='configured'))
        session.add(publishing.PublishingGrant(owner_id=owner_id, provider='twitch',
            token_cipher='synthetic', selected_target_id='123456', status='authorized'))
        session.commit()
        return stream.id


def block_live(factory, owner_id, condition):
    (suspend(factory, owner_id) if condition == 'suspension' else maintenance(factory))


@pytest.mark.parametrize('condition', ['suspension', 'maintenance'])
def test_live_start_rechecks_after_twitch_commit_and_before_public_unsuspend(h, monkeypatch, condition):
    factory, owner_id = h
    stream_id = prepared_stream(factory, owner_id, twitch=True)
    monkeypatch.setattr(live_api, 'require_provider', lambda: None)
    async def refresh_twitch(user, session):
        session.commit()  # Exact real helper's authority-release boundary.
        block_live(factory, owner_id, condition)
        return {'target_id': '123456'}
    async def forbidden(*args, **kwargs):
        pytest.fail('Suspended/maintenance live start reached a provider operation')
    monkeypatch.setattr(publishing, 'twitch_ingest_for_live', refresh_twitch)
    monkeypatch.setattr(live_api, 'provider_request', forbidden)
    with factory() as session, pytest.raises(HTTPException) as caught:
        asyncio.run(live_api.start_stream(uuid.UUID(stream_id),
            live_api.StartLive(confirm_public=True), session.get(app.User, owner_id), session))
    assert caught.value.status_code == (403 if condition == 'suspension' else 503)
    with factory() as session:
        assert not session.get(live_api.LiveStream, stream_id).publish_enabled


@pytest.mark.parametrize('operation', ['start', 'ingest'])
def test_live_provider_read_cannot_outlive_new_maintenance_before_public_handoff(h, monkeypatch, operation):
    factory, owner_id = h
    stream_id = prepared_stream(factory, owner_id, enabled=operation == 'ingest')
    monkeypatch.setattr(live_api, 'require_provider', lambda: None)
    calls = []
    async def provider(method, path, payload=None, **kwargs):
        calls.append(method)
        assert method == 'GET', 'Maintenance must block public PATCH/encoder credential handoff'
        maintenance(factory)
        with factory() as other:
            row = other.get(live_api.LiveStream, stream_id)
            return {'id': row.provider_id, 'suspended': False, 'isActive': False,
                    'playbackPolicy': {'type': 'public'}, 'streamKey': 'never-return-this-key'}
    monkeypatch.setattr(live_api, 'provider_request', provider)
    with factory() as session, pytest.raises(HTTPException) as caught:
        if operation == 'start':
            asyncio.run(live_api.start_stream(uuid.UUID(stream_id), live_api.StartLive(confirm_public=True),
                session.get(app.User, owner_id), session))
        else:
            asyncio.run(live_api.ingest(uuid.UUID(stream_id), session.get(app.User, owner_id), session))
    assert caught.value.status_code == 503 and calls == ['GET']


@pytest.mark.parametrize('condition', ['suspension', 'maintenance'])
@pytest.mark.parametrize('boundary', ['authorization', 'reservation', 'target_created'])
def test_twitch_relay_rechecks_every_commit_before_new_provider_write(h, monkeypatch, condition, boundary):
    factory, owner_id = h
    stream_id = prepared_stream(factory, owner_id)
    calls = []; blocked = False
    grant = {'target_id': '123456', 'server_url': 'rtmps://ingest.global-contribute.live-video.net/app/',
             'stream_key': 'synthetic-approved-relay-key'}
    async def refresh(user, session):
        session.commit()
        if boundary == 'authorization':
            block_live(factory, owner_id, condition)
        return grant
    async def provider(method, path, payload=None, **kwargs):
        calls.append((method, path))
        assert method == 'POST' and path == '/multistream/target'
        return {'id': identifier()}
    monkeypatch.setattr(publishing, 'twitch_ingest_for_live', refresh)
    monkeypatch.setattr(live_api, 'provider_request', provider)
    with factory() as session:
        original_commit = session.commit
        def commit():
            nonlocal blocked
            original_commit()
            destination = session.get(live_api.TwitchDestination, stream_id)
            at_boundary = (boundary == 'reservation' and destination and not destination.target_id
                or boundary == 'target_created' and destination and destination.target_id)
            if not blocked and at_boundary:
                blocked = True
                block_live(factory, owner_id, condition)
        monkeypatch.setattr(session, 'commit', commit)
        with pytest.raises(HTTPException) as caught:
            asyncio.run(live_api.set_twitch_destination(uuid.UUID(stream_id),
                live_api.TwitchDestinationInput(enabled=True, consent=True, expected_target_id='123456'),
                session.get(app.User, owner_id), session))
        assert caught.value.status_code in (403, 502, 503)
    assert len(calls) == (1 if boundary == 'target_created' else 0)
    with factory() as session:
        assert not session.get(live_api.LiveStream, stream_id).publish_enabled
        if boundary == 'target_created':
            # Preserve the exact unattached target ID so explicit cleanup can
            # remove it. The provider was never told to attach it to a stream.
            assert session.get(live_api.TwitchDestination, stream_id).target_id


@pytest.mark.parametrize('condition', ['suspension', 'maintenance'])
def test_live_creation_rechecks_durable_reservation_without_false_provider_uncertainty(h, monkeypatch, condition):
    factory, owner_id = h
    monkeypatch.setattr(live_api, 'require_provider', lambda: None)
    async def forbidden(*args, **kwargs):
        pytest.fail('Changed account reached stream provisioning')
    monkeypatch.setattr(live_api, 'provider_request', forbidden)
    with factory() as session:
        original_commit = session.commit; changed = False
        def commit():
            nonlocal changed
            original_commit()
            if not changed:
                changed = True
                block_live(factory, owner_id, condition)
        monkeypatch.setattr(session, 'commit', commit)
        with pytest.raises(HTTPException):
            asyncio.run(live_api.create_stream(live_api.CreateLive(request_id=uuid.uuid4(), title='Approved session'),
                                               session.get(app.User, owner_id), session))
    with factory() as session:
        stream = session.scalar(select(live_api.LiveStream))
        assert stream.status == 'ended' and stream.provider_id is None and not stream.publish_enabled


def test_maintenance_does_not_prevent_explicit_live_stop_or_destination_detach(h, monkeypatch):
    factory, owner_id = h
    stream_id = prepared_stream(factory, owner_id, twitch=True, enabled=True)
    maintenance(factory); calls = []
    async def provider(method, path, payload=None, **kwargs):
        calls.append((method, path, payload))
        if method == 'GET':
            return {'id': path.rsplit('/', 1)[-1], 'suspended': True, 'isActive': False,
                    'playbackPolicy': {'type': 'public'}, 'multistream': {'targets': []}}
        if method == 'PATCH':
            assert payload.get('suspended') is True or payload == {'multistream': {'targets': []}}
        return None
    monkeypatch.setattr(live_api, 'provider_request', provider)
    with factory() as session:
        result = asyncio.run(live_api.set_twitch_destination(uuid.UUID(stream_id),
            live_api.TwitchDestinationInput(enabled=False), session.get(app.User, owner_id), session))
        assert result['status'] == 'detached'
        result = asyncio.run(live_api.end_stream(uuid.UUID(stream_id), session.get(app.User, owner_id), session))
        assert result['status'] == 'ended'
    assert any(method == 'DELETE' for method, _, _ in calls)
    assert any(payload == {'suspended': True} for _, _, payload in calls)


def test_signed_tiktok_capability_cannot_serve_suspended_owner(h, monkeypatch):
    factory, owner_id = h
    suspend(factory, owner_id)
    nonce, secret = 'n' * 43, b'k' * 32
    signature = base64.urlsafe_b64encode(hmac.digest(secret, b'ziipa-tiktok-pull-v1:' + nonce.encode(), 'sha256')).decode().rstrip('=')
    monkeypatch.setattr(publishing, 'encryption_key', lambda: secret)
    monkeypatch.setattr(publishing.tiktok_adapter, 'media_origin', lambda config: 'https://ziipa.test')
    monkeypatch.setattr(publishing, 'cache', SimpleNamespace(get=lambda key: json.dumps(
        {'owner_id': owner_id, 'expires': publishing.time.time() + 60, 'job_id': identifier()})))
    monkeypatch.setattr(publishing, 'grant_for', lambda *a: None)
    request = Request({'type': 'http', 'method': 'GET', 'headers': []})
    with factory() as session, pytest.raises(HTTPException) as error:
        publishing.tiktok_pull_media(nonce + '.' + signature, request, session)
    assert error.value.status_code == 404


class Cache:
    def set(self, *a, **kw):
        return True
    def eval(self, *a):
        return 1


def publication_setup(factory, owner_id, provider='youtube'):
    with factory() as session:
        media = CreatorMedia(id=identifier(), owner_id=owner_id, content_type='video/mp4', size=12)
        item = CreatorItem(owner_id=owner_id, data={'title': 'Approved video', 'media_id': media.id}, visibility='published')
        session.add_all([media, item]); session.flush()
        grant = publishing.PublishingGrant(owner_id=owner_id, provider=provider, token_cipher='synthetic',
            selected_target_id='UC' + 'a' * 22, status='authorized')
        session.add(grant); session.commit()
        return publishing.PublishInput(item_id=item.id, expected_media_id=media.id,
            expected_target_id=grant.selected_target_id, provider=provider, idempotency_key=identifier(),
            consent=True, made_for_kids=False, privacy='private' if provider == 'youtube' else 'public', original_media_acknowledged=True)


@pytest.mark.parametrize('change', ['suspended', 'hidden', 'maintenance'])
def test_provider_prewrite_rechecks_after_awaited_token_step(h, monkeypatch, change):
    factory, owner_id = h
    request = publication_setup(factory, owner_id)
    monkeypatch.setattr(publishing, 'cache', Cache())
    monkeypatch.setattr(publishing, 'require_ready', lambda provider: None)
    monkeypatch.setattr(publishing, 'original_bytes', lambda *a: b'synthetic-video')
    monkeypatch.setattr(publishing, 'decrypt_tokens', lambda grant: {'access_token': 'synthetic'})
    async def token(*args):
        if change == 'suspended':
            suspend(factory, owner_id)
        elif change == 'maintenance':
            maintenance(factory)
        else:
            with factory() as other:
                other.add(admin.AdminContentState(item_id=str(request.item_id), hidden=True))
                other.commit()
        return 'synthetic'
    async def channels(*args):
        return [{'id': request.expected_target_id}]
    async def forbidden(*args, **kwargs):
        pytest.fail('A changed actor/source reached provider upload')
    monkeypatch.setattr(publishing, 'access_token', token)
    monkeypatch.setattr(publishing, 'channels', channels)
    monkeypatch.setattr(publishing, 'provider_json', forbidden)
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: pytest.fail('Real provider call'))))
    with factory() as session:
        result = asyncio.run(publishing.publish(request, session.get(app.User, owner_id), session))
    assert result['status'] == 'failed'  # Existing API retains a safe pre-handoff failure receipt.
    with factory() as session:
        job = session.scalar(select(publishing.PublishingJob))
        assert job.status == 'failed' and not job.external_id


def test_adapter_checkpoint_cannot_advance_suspended_owner(h, monkeypatch):
    factory, owner_id = h
    request = publication_setup(factory, owner_id, 'bluesky')
    monkeypatch.setattr(publishing, 'cache', Cache())
    monkeypatch.setattr(publishing, 'require_ready', lambda provider: None)
    monkeypatch.setattr(publishing, 'original_bytes', lambda *a: b'synthetic-video')
    monkeypatch.setattr(publishing, 'decrypt_tokens', lambda grant: {'access_token': 'synthetic'})
    async def token(*a):
        return 'synthetic'
    @asynccontextmanager
    async def bridge(grant):
        yield
    async def adapter(tokens, target, source, client, config, checkpoint):
        suspend(factory, owner_id)
        await checkpoint({'stage': 'publish_next'})
        pytest.fail('Suspended owner crossed the adapter write checkpoint')
    monkeypatch.setattr(publishing, 'access_token', token)
    monkeypatch.setattr(publishing, 'provider_bridge_lease', bridge)
    monkeypatch.setattr(publishing.bluesky_adapter, 'publish_prepare', adapter)
    monkeypatch.setattr(publishing, 'approved_api_origin', lambda: 'https://ziipa.test')
    monkeypatch.setattr(publishing, 'storage', lambda: object.__new__(publishing.LocalStorage))
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: pytest.fail('Real provider call'))))
    with factory() as session:
        result = asyncio.run(publishing.publish(request, session.get(app.User, owner_id), session))
    assert result['status'] == 'failed'
    with factory() as session:
        assert session.scalar(select(publishing.PublishingJob)).status == 'failed'


def test_maintenance_does_not_block_staff_campaign_claim(h):
    factory, owner_id = h
    with factory() as session:
        row = campaign(session, owner_id)
        row_id = row.id
        session.add(admin.AdminUserState(user_id=owner_id, role='moderator', status='active'))
        session.commit()
    maintenance(factory)
    with factory() as session:
        claimed = campaign_worker.claim(session)
        assert claimed and claimed[0] == row_id
        assert session.get(CreationCampaign, row_id).status == 'queued'


def test_publisher_rejects_suspended_actor_before_provider_readiness(h, monkeypatch):
    factory, owner_id = h
    request = publication_setup(factory, owner_id)
    suspend(factory, owner_id)
    monkeypatch.setattr(publishing, 'require_ready', lambda provider: pytest.fail('Provider configuration was reached'))
    with factory() as session, pytest.raises(HTTPException) as error:
        asyncio.run(publishing.publish(request, session.get(app.User, owner_id), session))
    assert error.value.status_code == 403
    with factory() as session:
        assert session.scalar(select(publishing.PublishingJob)) is None


def oauth_browser(owner_id, provider):
    binding = 'synthetic-browser-binding'
    request = Request({'type': 'http', 'method': 'GET', 'query_string': b'code=synthetic-code',
        'headers': [(b'cookie', ('ziipa_session=synthetic-session; ziipa_oauth_' + provider + '=' + binding).encode())]})
    record = {'owner_id': owner_id, 'provider': provider, 'verifier': 'synthetic-verifier',
        'binding_hash': hashlib.sha256(binding.encode()).hexdigest()}
    return request, record


@pytest.mark.parametrize('route', ['authorize', 'callback'])
def test_oauth_get_mutations_obey_maintenance_and_consume_state_once(h, monkeypatch, route):
    factory, owner_id = h
    maintenance(factory)
    request, record = oauth_browser(owner_id, 'youtube')
    consumed = []
    def consume(kind, value):
        if consumed:
            raise HTTPException(400, 'Already consumed')
        consumed.append((kind, value))
        return record
    monkeypatch.setattr(publishing, 'consume_state', consume)
    monkeypatch.setattr(publishing, 'verify_initiating_browser', lambda *a: None)
    monkeypatch.setattr(publishing, 'require_ready', lambda provider: None)
    monkeypatch.setattr(publishing, 'store_state', lambda *a: pytest.fail('Maintenance created OAuth state'))
    monkeypatch.setattr(publishing, 'api_client', lambda: pytest.fail('Maintenance contacted a provider'))
    with factory() as session:
        def call():
            return (publishing.authorize('youtube', request, 't' * 40, session) if route == 'authorize' else
                publishing.oauth_callback('youtube', request, 's' * 40, 'synthetic-code', '', session))
        with pytest.raises(HTTPException) as blocked:
            asyncio.run(call())
        assert blocked.value.status_code == 503
        with pytest.raises(HTTPException) as replay:
            asyncio.run(call())
        assert replay.value.status_code == 400
        assert len(consumed) == 1
        assert session.scalar(select(publishing.PublishingGrant)) is None


@pytest.mark.parametrize('stage', ['exchange', 'detach'])
def test_oauth_callback_rechecks_suspension_after_each_provider_await(h, monkeypatch, stage):
    factory, owner_id = h
    request, record = oauth_browser(owner_id, 'twitch')
    with factory() as session:
        grant = publishing.PublishingGrant(owner_id=owner_id, provider='twitch', token_cipher='original-cipher',
            selected_target_id='old-target', targets=[{'id': 'old-target'}], status='authorized')
        session.add(grant); session.commit()
    consumed, exchanges, detaches = [], [], []
    def consume(kind, value):
        if consumed:
            raise HTTPException(400, 'Already consumed')
        consumed.append(kind)
        return record
    async def exchange(*args):
        exchanges.append(True)
        if stage == 'exchange':
            suspend(factory, owner_id)
        return {'tokens': {'access_token': 'synthetic-new'}, 'targets': [{'id': 'new-target'}]}
    async def detach(*args):
        detaches.append(True)
        suspend(factory, owner_id)
    monkeypatch.setattr(publishing, 'consume_state', consume)
    monkeypatch.setattr(publishing, 'verify_initiating_browser', lambda *a: None)
    monkeypatch.setattr(publishing, 'require_ready', lambda provider: None)
    monkeypatch.setattr(publishing, 'approved_api_origin', lambda: 'https://ziipa.test')
    monkeypatch.setattr(publishing.twitch_adapter, 'exchange', exchange)
    monkeypatch.setattr(live_api, 'detach_twitch_destinations', detach)
    monkeypatch.setattr(publishing, 'encrypt_tokens', lambda *a: pytest.fail('Suspended callback encrypted a grant'))
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: pytest.fail('Real provider call'))))
    with factory() as session:
        with pytest.raises(HTTPException) as blocked:
            asyncio.run(publishing.oauth_callback('twitch', request, 's' * 40, 'synthetic-code', '', session))
        assert blocked.value.status_code == 403
        with pytest.raises(HTTPException) as replay:
            asyncio.run(publishing.oauth_callback('twitch', request, 's' * 40, 'synthetic-code', '', session))
        assert replay.value.status_code == 400
    assert len(exchanges) == 1 and len(detaches) == (stage == 'detach') and len(consumed) == 1
    with factory() as session:
        grant = session.scalar(select(publishing.PublishingGrant))
        assert grant.token_cipher == 'original-cipher' and grant.selected_target_id == 'old-target'
        assert grant.targets == [{'id': 'old-target'}]
