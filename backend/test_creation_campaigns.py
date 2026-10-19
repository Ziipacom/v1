"""Campaign lifecycle acceptance; isolated SQL, clock, Redis and provider effects."""
from datetime import datetime, timedelta, timezone
import asyncio
import hashlib
import uuid
import httpx

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, guard
from creator import CreatorItem, CreatorMedia
import creation_campaigns as api
import campaign_worker as worker
import media_workflows
import render_api
import render_services
import social_publishing as publishing

NOW = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)


class Hints:
    def __init__(self):
        self.values = {}
    def get(self, key):
        return self.values.get(key)
    def set(self, key, value, **_kwargs):
        self.values[key] = value
        return True
    def eval(self, _script, _count, key, *_args):
        return int(self.values.pop(key, None) is not None)


@pytest.fixture
def isolated(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    hints = Hints()
    monkeypatch.setattr(api, 'cache', hints)
    monkeypatch.setattr(worker, 'cache', hints)
    monkeypatch.setattr(media_workflows, 'cache', hints)
    monkeypatch.setattr(render_services, 'cache', hints)
    monkeypatch.setattr(api.config, 'enabled', True)
    monkeypatch.setattr(api, 'now', lambda: NOW)
    monkeypatch.setattr(render_api, 'readiness', lambda: {'can_render': True})
    monkeypatch.setattr(publishing, 'readiness', lambda p: {'provider': p, 'publish_ready': True})
    hints.set(api.heartbeat_key(), '{"preparation":true,"publish_providers":["youtube"]}')
    with factory() as session:
        user = User(name='Campaign owner', email='campaign-owner@example.test', password_hash='unused')
        stranger = User(name='Stranger', email='campaign-stranger@example.test', password_hash='unused')
        session.add_all([user, stranger]); session.commit()
        video = CreatorMedia(id=str(uuid.uuid4()), owner_id=user.id, content_type='video/mp4', size=10)
        item = CreatorItem(owner_id=user.id, data={'title': 'Original', 'media_id': video.id}, visibility='draft')
        session.add_all([video, item]); session.commit()
        selected = {'owner': user}
        app = FastAPI(); app.include_router(api.router)
        app.dependency_overrides[current_user] = lambda: selected['owner']
        app.dependency_overrides[guard] = lambda: None
        def connection():
            with factory() as current:
                yield current
        app.dependency_overrides[db] = connection
        with TestClient(app) as client:
            yield factory, session, user, stranger, item, selected, client, hints
    engine.dispose()


def create(context, **changes):
    _, _, _, _, item, _, client, _ = context
    result = client.post('/api/os/campaigns', json={'request_id': str(uuid.uuid4()), 'item_id': item.id,
        'name': 'Autumn film', 'title': 'Reviewed title', 'description': 'Reviewed copy',
        'rights_confirmed': True, 'schedule_at': NOW.isoformat(), **changes})
    assert result.status_code == 200, result.text
    return result.json()


def post(context, row, operation, **changes):
    result = context[6].post(f'/api/os/campaigns/{row["id"]}/{operation}', json={'revision': row['revision'], **changes})
    assert result.status_code == 200, result.text
    return result.json()


def get(context, row):
    return context[6].get('/api/os/campaigns/' + row['id']).json()


def render_ready(context, row):
    factory = context[0]
    worker.tick(factory)
    row = get(context, row)
    assert row['status'] == 'preparing', row
    with factory() as session:
        job = session.get(render_services.RenderJob, row['render_job_id'])
        job.status = 'ready'; job.output_sha256 = 'a' * 64
        session.add(CreatorMedia(id=job.output_media_id, owner_id=job.owner_id, content_type='video/mp4', size=10))
        campaign = session.get(api.CreationCampaign, row['id']); campaign.next_run = NOW
        session.commit()
    worker.tick(factory)
    return get(context, row)


def approve(context, row):
    row = post(context, row, 'review')
    return post(context, row, 'approve', review_hash=row['review_hash'], consent=True, publish_to_ziipa=True)


def due(context, row):
    with context[0]() as session:
        session.get(api.CreationCampaign, row['id']).next_run = NOW
        session.commit()


def destination(provider='youtube', **changes):
    return {'provider': provider, 'target_id': 'channel-' + provider, 'privacy': 'private' if provider == 'youtube' else 'public',
            'made_for_kids': False, **changes}


def fake_publish(calls, status='processing'):
    async def publish(request, user, session):
        calls.append(request.model_dump(mode='json'))
        existing = session.scalar(select(publishing.PublishingJob).where(publishing.PublishingJob.owner_id == user.id,
            publishing.PublishingJob.idempotency_key == str(request.idempotency_key)))
        if existing:
            return publishing.receipt(existing)
        job = publishing.PublishingJob(owner_id=user.id, item_id=str(request.item_id), provider=request.provider,
            idempotency_key=str(request.idempotency_key), source_hash=api.digest(request.model_dump(mode='json')),
            target_id=request.expected_target_id, privacy=request.privacy, status=status, detail='Mock verified receipt',
            external_id='provider-receipt', external_url='https://provider.example/video', provider_data={})
        session.add(job); session.commit()
        return publishing.receipt(job)
    return publish


def test_creation_is_owner_scoped_request_idempotent_and_private(isolated):
    context = isolated
    row = create(context)
    assert row['status'] == 'draft' and row['approved_at'] is None
    context[1].expire_all()
    assert context[1].get(CreatorItem, context[4].id).visibility == 'draft'
    duplicate = context[6].post('/api/os/campaigns', json={'request_id': context[1].get(api.CreationCampaign, row['id']).request_id,
        'item_id': context[4].id, 'name': 'Autumn film', 'title': 'Reviewed title', 'description': 'Reviewed copy',
        'rights_confirmed': True, 'schedule_at': NOW.isoformat()})
    assert duplicate.json()['id'] == row['id']
    changed = duplicate.request.content.decode().replace('Reviewed title', 'Different title')
    assert context[6].post('/api/os/campaigns', content=changed, headers={'Content-Type': 'application/json'}).status_code == 409
    context[5]['owner'] = context[3]
    assert context[6].get('/api/os/campaigns/' + row['id']).status_code == 404
    assert context[6].get('/api/os/campaigns').json() == []
    result = context[6].post('/api/os/campaigns', json={'request_id': str(uuid.uuid4()), 'item_id': context[4].id,
        'name': 'Other', 'title': 'Other'})
    assert result.status_code == 404


def test_ziipa_only_full_lifecycle_requires_exact_review_and_due_time(isolated):
    row = create(isolated, schedule_at=(NOW + timedelta(hours=1)).isoformat())
    row = post(isolated, row, 'prepare')
    row = render_ready(isolated, row)
    assert row['status'] == 'review' and row['artifact']['output_sha256'] == 'a' * 64
    row = post(isolated, row, 'review')
    assert isolated[6].post(f'/api/os/campaigns/{row["id"]}/approve', json={'revision': row['revision'],
        'review_hash': row['review_hash'], 'consent': True}).status_code == 422
    row = post(isolated, row, 'approve', review_hash=row['review_hash'], consent=True, publish_to_ziipa=True)
    isolated[1].expire_all()
    assert isolated[1].get(CreatorItem, row['item_id']).visibility == 'draft'
    assert worker.tick(isolated[0]) is False
    with isolated[0]() as session:
        campaign = session.get(api.CreationCampaign, row['id']); campaign.schedule_at = NOW
        # Changing a schedule outside review must not be treated as approval.
        campaign.next_run = NOW; session.commit()
    worker.tick(isolated[0])
    assert get(isolated, row)['status'] == 'needs_review'


def test_ziipa_only_approved_export_completes_without_external_post(isolated):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated), 'prepare')))
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('No external destination selected'))
    result = get(isolated, row)
    assert result['status'] == 'completed' and result['ziipa_published_at']
    isolated[1].expire_all()
    assert isolated[1].get(CreatorItem, row['item_id']).visibility == 'draft'
    published = isolated[1].get(CreatorItem, result['published_item_id'])
    assert published.visibility == 'published' and published.data['media_id'] == row['artifact']['media_id']
    assert published.data['captions'] == [] and published.data['overlays'] == [] and published.data['soundtrack'] is None


@pytest.mark.parametrize('field,value', [('title', 'Corrected title'), ('description', 'Corrected description'),
    ('manual_transcript', 'Corrected spoken words'), ('schedule_at', '2026-10-20T12:00:00+00:00'),
    ('destinations', [destination()])])
def test_edit_invalidates_artifact_and_approval(isolated, field, value):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated), 'prepare')))
    response = isolated[6].patch('/api/os/campaigns/' + row['id'], json={'revision': row['revision'], field: value})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['revision'] == row['revision'] + 1
    assert result['status'] == 'draft' and not result['review_hash'] and result['approved_at'] is None
    assert isolated[6].post(f'/api/os/campaigns/{row["id"]}/approve', json={'revision': row['revision'],
        'review_hash': row['review_hash'], 'consent': True, 'publish_to_ziipa': True}).status_code == 409


def test_source_edit_or_rights_change_stops_approved_handoff(isolated):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated, destinations=[destination()]), 'prepare')))
    with isolated[0]() as session:
        item = session.get(CreatorItem, row['item_id']); item.data = {**item.data, 'overlays': [{'id': 'changed', 'text': 'New overlay'}]}; session.commit()
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('Stale edit must never hand off'))
    result = get(isolated, row)
    assert result['status'] == 'needs_review' and result['deliveries'][0]['status'] == 'cancelled'


def test_manual_transcript_captions_require_exact_review_and_rerender(isolated):
    row = create(isolated, manual_transcript='Hello world', manual_segments=[{'start': 0, 'end': 1.5, 'text': 'Hello world'}])
    row = render_ready(isolated, post(isolated, row, 'prepare'))
    wrong = isolated[6].post(f'/api/os/campaigns/{row["id"]}/apply-captions', json={'revision': row['revision'], 'transcript_hash': 'b' * 64})
    assert wrong.status_code == 409
    result = post(isolated, row, 'apply-captions', transcript_hash=row['transcript_hash'])
    assert result['status'] == 'queued' and result['revision'] == row['revision'] + 1 and not result['review_hash']
    isolated[1].expire_all()
    item = isolated[1].get(CreatorItem, row['item_id'])
    assert item.data['captions'][0]['text'] == 'Hello world' and item.visibility == 'draft'


def test_transcription_unavailable_preserves_private_render_and_manual_fallback(isolated):
    row = post(isolated, create(isolated, request_transcription=True, transcription_consent=True), 'prepare')
    calls = []
    def unavailable(*_args):
        calls.append(True)
        return {'status': 'unavailable', 'text': '', 'segments': [], 'engine': '', 'detail': 'Local speech model unavailable; enter a manual transcript.'}
    worker.tick(isolated[0], transcribe=unavailable)
    result = get(isolated, row)
    assert calls and result['transcript']['status'] == 'unavailable' and result['render_job_id']
    isolated[1].expire_all()
    assert isolated[1].get(CreatorItem, row['item_id']).visibility == 'draft'


def test_pause_claim_cannot_apply_late_results_and_resume_is_private(isolated):
    row = post(isolated, create(isolated), 'prepare')
    with isolated[0]() as session:
        claim = worker.claim(session)
    paused = post(isolated, row, 'pause')
    worker.prepare(isolated[0], *claim, render_dispatch=lambda *_: pytest.fail('Revoked claim must not dispatch'))
    assert get(isolated, row)['status'] == 'paused'
    resumed = post(isolated, paused, 'resume')
    assert resumed['status'] == 'queued' and resumed['approved_at'] is None


def test_expired_lease_recovery_is_token_bound_and_bounded(isolated):
    row = post(isolated, create(isolated), 'prepare')
    with isolated[0]() as session:
        old = worker.claim(session)
        campaign = session.get(api.CreationCampaign, row['id']); campaign.lease_until = NOW - timedelta(seconds=1); campaign.next_run = campaign.lease_until
        session.commit()
        fresh = worker.claim(session)
        assert old[1] != fresh[1] and campaign.attempts == 1
        assert worker._locked(session, *old) is None
        session.rollback()
        campaign = session.get(api.CreationCampaign, row['id']); campaign.attempts = 3; campaign.lease_until = NOW - timedelta(seconds=1); campaign.next_run = campaign.lease_until
        session.commit()
        assert worker.claim(session) is None
    assert get(isolated, row)['status'] == 'blocked'


def test_provider_handoff_passes_bound_consent_sha_and_stable_uuid(isolated):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated, destinations=[destination()]), 'prepare')))
    calls = []
    worker.tick(isolated[0], publish_dispatch=fake_publish(calls))
    result = get(isolated, row)
    assert result['status'] == 'delivering' and result['deliveries'][0]['status'] == 'processing'
    assert len(calls) == 1 and calls[0]['consent'] is True
    assert calls[0]['expected_source_sha256'] == row['artifact']['output_sha256']
    assert calls[0]['render_id'] is None and calls[0]['expected_media_id'] == row['artifact']['media_id']
    assert calls[0]['item_id'] == result['published_item_id'] and calls[0]['expected_target_id'] == 'channel-youtube'
    async def refresh(job_id, user, session):
        job = session.get(publishing.PublishingJob, str(job_id)); job.status = 'delivered'; session.commit()
        return publishing.receipt(job)
    due(isolated, row)
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('Accepted upload must never be resent'), refresh_dispatch=refresh)
    result = get(isolated, row)
    assert result['status'] == 'completed' and result['deliveries'][0]['external_id'] == 'provider-receipt'
    assert len(calls) == 1


def test_restart_recovers_committed_receipt_instead_of_duplicate_handoff(isolated):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated, destinations=[destination()]), 'prepare')))
    calls = []
    async def crash_after_receipt(request, user, session):
        await fake_publish(calls, 'delivered')(request, user, session)
        raise RuntimeError('simulated crash after durable provider receipt')
    worker.tick(isolated[0], publish_dispatch=crash_after_receipt)
    blocked = get(isolated, row)
    assert blocked['status'] == 'blocked'
    post(isolated, blocked, 'resume')
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('No duplicate post'))
    result = get(isolated, row)
    assert result['status'] == 'completed' and len(calls) == 1


def test_uncertain_receipt_is_terminal_not_automatic_retry(isolated):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated, destinations=[destination()]), 'prepare')))
    calls = []
    worker.tick(isolated[0], publish_dispatch=fake_publish(calls, 'uncertain'))
    result = get(isolated, row)
    assert result['status'] == 'partial' and result['deliveries'][0]['status'] == 'uncertain'
    post(isolated, result, 'resume')
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('Uncertain posts are never retried'))
    assert len(calls) == 1


def test_partial_provider_readiness_and_tiktok_handoff_are_truthful(isolated, monkeypatch):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated,
            destinations=[destination('tiktok'), destination()]), 'prepare')))
    monkeypatch.setattr(publishing, 'readiness', lambda p: {'provider': p, 'publish_ready': False})
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('Unconfigured providers must not post'))
    due(isolated, row)
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('TikTok must retain fresh creator consent'))
    result = get(isolated, row)
    assert result['status'] == 'partial'
    assert {d['status'] for d in result['deliveries']} == {'needs_handoff', 'blocked'}


def test_disabled_worker_and_guarded_bounded_input(isolated, monkeypatch):
    row = create(isolated)
    monkeypatch.setattr(api.config, 'enabled', False)
    assert isolated[6].post(f'/api/os/campaigns/{row["id"]}/prepare', json={'revision': 1}).status_code == 503
    assert worker.tick(isolated[0]) is False
    assert isolated[6].patch('/api/os/campaigns/' + row['id'], json={'revision': 1, 'title': '<bad>'}).status_code == 422
    assert isolated[6].patch('/api/os/campaigns/' + row['id'], json={'revision': 1, 'schedule_at': '2026-10-19T14:00:00'}).status_code == 422


@pytest.mark.parametrize('visibility,category', [('hidden', 'video'), ('draft', 'nft'), ('draft', 'live'), ('draft', 'store')])
def test_moderation_and_nonvideo_campaigns_cannot_be_bypassed(isolated, visibility, category):
    item = isolated[1].get(CreatorItem, isolated[4].id)
    item.visibility = visibility; item.data = {**item.data, 'category': category}; isolated[1].commit()
    result = isolated[6].post('/api/os/campaigns', json={'request_id': str(uuid.uuid4()), 'item_id': item.id, 'name': 'Blocked', 'title': 'Blocked'})
    assert result.status_code == 409


def test_export_and_delete_are_owned_and_include_receipts(isolated):
    row = create(isolated)
    with isolated[0]() as session:
        assert api.export_campaigns_data(session, isolated[3].id) == []
        assert api.export_campaigns_data(session, isolated[2].id)[0]['id'] == row['id']
        api.delete_campaigns_data(session, isolated[3].id); session.commit()
        assert session.get(api.CreationCampaign, row['id'])
        api.delete_campaigns_data(session, isolated[2].id); session.commit()
        assert session.get(api.CreationCampaign, row['id']) is None


@pytest.mark.parametrize('operation', ['prepare', 'review', 'apply-captions'])
def test_cancelled_campaign_cannot_be_resurrected(isolated, operation):
    row = render_ready(isolated, post(isolated, create(isolated), 'prepare'))
    row = post(isolated, row, 'cancel')
    response = isolated[6].post(f'/api/os/campaigns/{row["id"]}/{operation}', json={
        'revision': row['revision'], **({'transcript_hash': row['transcript_hash']} if operation == 'apply-captions' else {})})
    assert response.status_code == 409


def test_published_partial_campaign_stays_immutable_even_if_paused(isolated, monkeypatch):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated, destinations=[destination()]), 'prepare')))
    monkeypatch.setattr(publishing, 'readiness', lambda p: {'provider': p, 'publish_ready': False})
    worker.tick(isolated[0])
    result = get(isolated, row)
    assert result['published_item_id'] and result['status'] == 'partial'
    result = post(isolated, result, 'pause')
    assert isolated[6].patch('/api/os/campaigns/' + result['id'], json={'revision': result['revision'], 'title': 'Another version'}).status_code == 409
    assert isolated[6].post(f'/api/os/campaigns/{result["id"]}/prepare', json={'revision': result['revision']}).status_code == 409


def test_paused_private_review_restores_review_without_publishing(isolated):
    row = render_ready(isolated, post(isolated, create(isolated), 'prepare'))
    row = post(isolated, row, 'pause')
    row = post(isolated, row, 'resume')
    assert row['status'] == 'review' and row['approved_at'] is None and row['published_item_id'] is None


def _real_publisher_setup(context, monkeypatch, *, interrupt=None, body_changed=False, private_variant=False):
    body = b'approved rendered bytes'
    if private_variant:
        row, _ = ready_variant_set(context, create(context, renditions=['portrait', 'square'], ziipa_rendition='portrait',
            destinations=[destination(rendition='square')]))
    else:
        row = render_ready(context, post(context, create(context, destinations=[destination()]), 'prepare'))
    with context[0]() as session:
        job = session.get(render_services.RenderJob, row['render_jobs']['square'] if private_variant else row['render_job_id'])
        job.output_sha256 = hashlib.sha256(body).hexdigest()
        session.get(CreatorMedia, job.output_media_id).size = len(body)
        session.add(publishing.PublishingGrant(owner_id=context[2].id, provider='youtube', token_cipher='mock-only',
                    selected_target_id='channel-youtube', targets=[], status='authorized'))
        session.commit()
    row = approve(context, row)
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'id': 'aB123456789'})
    monkeypatch.setattr(publishing, 'api_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(publishing, 'require_ready', lambda p: None)
    monkeypatch.setattr(publishing, 'decrypt_tokens', lambda grant: {'access_token': 'mock-only'})
    monkeypatch.setattr(publishing, 'cache', context[7])
    def interrupt_campaign():
        with context[0]() as session:
            campaign = session.get(api.CreationCampaign, row['id'])
            campaign.status = 'paused'; campaign.lease_token = ''; campaign.lease_until = None; campaign.next_run = None
            session.commit()
    def original(_media, _owner):
        if interrupt == 'download':
            interrupt_campaign()
        return b'changed export bytes' if body_changed else body
    async def access(_session, _grant, _client):
        if interrupt == 'token':
            interrupt_campaign()
        return 'mock-only'
    async def channels(_client, _token):
        return [{'id': 'channel-youtube'}]
    monkeypatch.setattr(publishing, 'original_bytes', original)
    monkeypatch.setattr(publishing, 'access_token', access)
    monkeypatch.setattr(publishing, 'channels', channels)
    return row, requests


@pytest.mark.parametrize('interrupt', ['download', 'token'])
def test_real_publisher_checks_campaign_pause_at_prewrite_boundary(isolated, monkeypatch, interrupt):
    row, requests = _real_publisher_setup(isolated, monkeypatch, interrupt=interrupt)
    worker.tick(isolated[0])
    assert requests == []
    assert get(isolated, row)['status'] == 'paused'
    with isolated[0]() as session:
        job = session.scalar(select(publishing.PublishingJob))
        assert job and job.status == 'failed' and not job.external_id


def test_real_publisher_verifies_reviewed_export_bytes_before_handoff(isolated, monkeypatch):
    row, requests = _real_publisher_setup(isolated, monkeypatch, body_changed=True)
    worker.tick(isolated[0])
    assert requests == []
    with isolated[0]() as session:
        job = session.scalar(select(publishing.PublishingJob))
        assert job.status == 'failed'
    assert get(isolated, row)['deliveries'][0]['status'] == 'failed'


def test_real_publisher_accepts_exact_authority_and_sha_once(isolated, monkeypatch):
    row, requests = _real_publisher_setup(isolated, monkeypatch)
    worker.tick(isolated[0])
    assert len(requests) == 1 and requests[0].method == 'POST'
    result = get(isolated, row)
    assert result['deliveries'][0]['status'] == 'processing'
    post(isolated, result, 'pause')
    due(isolated, result)
    assert worker.tick(isolated[0]) is False
    assert len(requests) == 1


def test_publisher_deduplicated_older_request_receipt_is_followed(isolated):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated, destinations=[destination()]), 'prepare')))
    calls = []
    async def return_prior(request, user, session):
        changed = request.model_copy(update={'idempotency_key': uuid.uuid4()})
        return await fake_publish(calls, 'processing')(changed, user, session)
    worker.tick(isolated[0], publish_dispatch=return_prior)
    result = get(isolated, row)
    assert result['deliveries'][0]['publishing_job_id'] and result['deliveries'][0]['status'] == 'processing'
    async def refresh(job_id, user, session):
        job = session.get(publishing.PublishingJob, str(job_id)); job.status = 'delivered'; session.commit()
        return publishing.receipt(job)
    due(isolated, row)
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('Follow linked receipt instead of another publish'), refresh_dispatch=refresh)
    assert get(isolated, row)['status'] == 'completed' and len(calls) == 1


def test_staged_provider_refresh_cannot_publish_after_campaign_cancel(isolated):
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated, destinations=[destination()]), 'prepare')))
    worker.tick(isolated[0], publish_dispatch=fake_publish([]))
    result = get(isolated, row)
    post(isolated, result, 'cancel')
    with isolated[0]() as session:
        job = session.get(publishing.PublishingJob, result['deliveries'][0]['publishing_job_id'])
        with pytest.raises(HTTPException) as error:
            api.validate_job_campaign_authority(session, job)
        assert error.value.status_code == 409


def test_rights_change_invalidates_even_same_rendered_bytes(isolated):
    from personal_media import OSAssetMetadata
    row = approve(isolated, render_ready(isolated, post(isolated, create(isolated, destinations=[destination()]), 'prepare')))
    with isolated[0]() as session:
        session.add(OSAssetMetadata(owner_id=isolated[2].id, item_id=row['item_id'], rights={'basis': 'original', 'allow_ai': True}))
        session.commit()
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('Changed rights require review'))
    assert get(isolated, row)['status'] == 'needs_review'


def test_global_capacity_rejects_before_source_is_published(isolated):
    with isolated[0]() as session:
        for number in range(30):
            session.add(api.CreationCampaign(owner_id=isolated[3].id, request_id=str(uuid.uuid4()), request_hash='a' * 64,
                item_id=isolated[4].id, name=str(number), title='Queued', options={}, status='queued', next_run=NOW))
        session.commit()
    row = create(isolated)
    result = isolated[6].post(f'/api/os/campaigns/{row["id"]}/prepare', json={'revision': 1})
    assert result.status_code == 429
    isolated[1].expire_all()
    assert isolated[1].get(CreatorItem, row['item_id']).visibility == 'draft'


def ready_variant_set(context, row):
    row = post(context, row, 'prepare')
    worker.tick(context[0])
    first = get(context, row)
    for _ in range(5):
        current = get(context, row)
        if current['status'] == 'review':
            return current, first
        assert current['status'] == 'preparing', current
        with context[0]() as session:
            campaign = session.get(api.CreationCampaign, row['id'])
            for name, job_id in campaign.render_jobs.items():
                job = session.get(render_services.RenderJob, job_id)
                if job.status != 'ready':
                    job.status = 'ready'; job.output_sha256 = hashlib.sha256(name.encode()).hexdigest()
                    canvas = render_services.RENDITIONS[name] or (320, 240)
                    job.output_width, job.output_height = canvas
                    session.add(CreatorMedia(id=job.output_media_id, owner_id=job.owner_id, content_type='video/mp4', size=10))
            campaign.next_run = NOW; session.commit()
        worker.tick(context[0])
    pytest.fail('All selected variants must progress to review after bounded render completions')


def test_multiple_actual_variants_are_queued_in_capacity_bounded_waves(isolated):
    row, first = ready_variant_set(isolated, create(isolated, renditions=['original', 'portrait', 'square', 'landscape']))
    assert len(first['render_jobs']) == 2  # Existing owner queue bound was not raised.
    assert set(row['render_jobs']) == set(render_services.RENDITIONS)
    assert len(set(row['render_jobs'].values())) == 4
    assert set(row['artifacts']) == set(render_services.RENDITIONS)
    assert len({v['output_sha256'] for v in row['artifacts'].values()}) == 4
    for name in ('portrait', 'square', 'landscape'):
        artifact = row['artifacts'][name]
        assert (artifact['output_width'], artifact['output_height']) == render_services.RENDITIONS[name]
    assert row['artifact'] == row['artifacts']['original']


def test_per_destination_format_handoff_uses_correct_approved_private_bytes(isolated):
    row, _ = ready_variant_set(isolated, create(isolated, renditions=['portrait', 'square', 'landscape'], ziipa_rendition='portrait',
        destinations=[destination('facebook', rendition='square'), destination('youtube', rendition='landscape')]))
    row = approve(isolated, row)
    calls = []
    worker.tick(isolated[0], publish_dispatch=fake_publish(calls, 'delivered'))
    result = get(isolated, row)
    assert calls[0]['provider'] == 'facebook'
    assert calls[0]['expected_media_id'] == row['artifacts']['square']['media_id']
    assert calls[0]['expected_source_sha256'] == row['artifacts']['square']['output_sha256']
    assert calls[0]['item_id'] == result['published_items']['square']
    with isolated[0]() as session:
        assert session.get(CreatorItem, row['item_id']).visibility == 'draft'
        for name, item_id in result['published_items'].items():
            post_item = session.get(CreatorItem, item_id)
            assert post_item.visibility == ('published' if name == 'portrait' else 'draft')
            assert post_item.data['media_id'] == row['artifacts'][name]['media_id']
    due(isolated, row)
    worker.tick(isolated[0], publish_dispatch=fake_publish(calls, 'delivered'))
    result = get(isolated, row)
    assert result['status'] == 'completed' and len(calls) == 2
    assert calls[1]['expected_media_id'] == row['artifacts']['landscape']['media_id']
    assert calls[1]['item_id'] == result['published_items']['landscape']


def test_named_format_changes_invalidate_approval_and_queued_mappings(isolated):
    row, _ = ready_variant_set(isolated, create(isolated, renditions=['original', 'square']))
    row = approve(isolated, row)
    response = isolated[6].patch('/api/os/campaigns/' + row['id'], json={'revision': row['revision'],
        'renditions': ['portrait'], 'ziipa_rendition': 'portrait'})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['revision'] == row['revision'] + 1 and result['render_jobs'] == {} and result['artifacts'] == {}
    assert result['approved_at'] is None and not result['review_hash']


@pytest.mark.parametrize('changes', [{'renditions': ['portrait']}, {'renditions': ['original', 'original']},
    {'renditions': ['original'], 'destinations': [destination(rendition='square')]}, {'renditions': ['crop']}])
def test_invalid_or_unselected_destination_formats_are_rejected(isolated, changes):
    result = isolated[6].post('/api/os/campaigns', json={'request_id': str(uuid.uuid4()), 'item_id': isolated[4].id,
        'name': 'Invalid', 'title': 'Invalid', **changes})
    assert result.status_code == 422


def test_swapped_job_format_cannot_be_reviewed_as_another_canvas(isolated):
    row, _ = ready_variant_set(isolated, create(isolated, renditions=['portrait', 'square'], ziipa_rendition='portrait'))
    with isolated[0]() as session:
        campaign = session.get(api.CreationCampaign, row['id'])
        campaign.render_jobs = {'portrait': campaign.render_jobs['square'], 'square': campaign.render_jobs['portrait']}
        session.commit()
    assert isolated[6].post(f'/api/os/campaigns/{row["id"]}/review', json={'revision': row['revision']}).status_code == 409


def test_nonprimary_variant_digest_change_revokes_whole_set_approval(isolated):
    row, _ = ready_variant_set(isolated, create(isolated, renditions=['portrait', 'square'], ziipa_rendition='portrait'))
    row = approve(isolated, row)
    with isolated[0]() as session:
        session.get(render_services.RenderJob, row['render_jobs']['square']).output_sha256 = 'b' * 64
        session.commit()
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('Every approved variant digest must remain bound'))
    assert get(isolated, row)['status'] == 'needs_review'


def test_preview_selects_exact_owned_named_variant(isolated):
    row, _ = ready_variant_set(isolated, create(isolated, renditions=['portrait', 'square'], ziipa_rendition='portrait'))
    response = isolated[6].get(f'/api/os/campaigns/{row["id"]}/preview?rendition=square')
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['media_id'] == row['artifacts']['square']['media_id'] and value['rendition'] == 'square'
    assert (value['output_width'], value['output_height']) == (720, 720)
    assert isolated[6].get(f'/api/os/campaigns/{row["id"]}/preview?rendition=landscape').status_code == 404


def test_private_variant_has_no_ordinary_publishing_authority(isolated):
    row, _ = ready_variant_set(isolated, create(isolated, renditions=['portrait', 'square'], ziipa_rendition='portrait',
        destinations=[destination('youtube', rendition='square')]))
    row = approve(isolated, row)
    requests = []
    async def inspect_authority(request, user, session):
        api.validate_publishing_authority(session, user.id, request)
        forged = request.model_copy(update={'expected_source_sha256': row['artifacts']['portrait']['output_sha256']})
        with pytest.raises(HTTPException):
            api.validate_publishing_authority(session, user.id, forged)
        forged = request.model_copy(update={'item_id': uuid.UUID(row['item_id'])})
        with pytest.raises(HTTPException):
            api.validate_publishing_authority(session, user.id, forged)
        requests.append(request)
        return await fake_publish([], 'delivered')(request, user, session)
    worker.tick(isolated[0], publish_dispatch=inspect_authority)
    assert len(requests) == 1 and get(isolated, row)['status'] == 'completed'


def test_real_publisher_private_format_requires_complete_exact_campaign_authority(isolated, monkeypatch):
    row, requests = _real_publisher_setup(isolated, monkeypatch, private_variant=True)
    worker.tick(isolated[0])
    assert len(requests) == 1
    result = get(isolated, row)
    delivery = result['deliveries'][0]
    assert delivery['rendition'] == 'square' and delivery['published_item_id'] == result['published_items']['square']
    with isolated[0]() as session:
        private = session.get(CreatorItem, delivery['published_item_id'])
        assert private.visibility == 'draft'
        assert private.data['media_id'] == row['artifacts']['square']['media_id']
        request = publishing.PublishInput(item_id=private.id, expected_media_id=private.data['media_id'],
            expected_target_id=delivery['target_id'], idempotency_key=uuid.uuid4(), provider='youtube',
            privacy='private', made_for_kids=False, consent=True, original_media_acknowledged=True)
        with pytest.raises(HTTPException) as error:
            asyncio.run(publishing.publish(request, session.get(User, isolated[2].id), session))
        assert error.value.status_code == 409
        job = session.get(publishing.PublishingJob, delivery['publishing_job_id'])
        api.validate_job_campaign_authority(session, job)
    assert len(requests) == 1


def test_tiktok_private_rendition_stays_explicit_fresh_review_handoff(isolated):
    row, _ = ready_variant_set(isolated, create(isolated, renditions=['portrait', 'square'], ziipa_rendition='square',
        destinations=[destination('tiktok', rendition='portrait')]))
    row = approve(isolated, row)
    worker.tick(isolated[0], publish_dispatch=lambda *_: pytest.fail('TikTok fresh creator review cannot be replaced by a campaign'))
    result = get(isolated, row)
    delivery = result['deliveries'][0]
    assert delivery['status'] == 'needs_handoff' and 'private Studio draft' in delivery['detail']
    with isolated[0]() as session:
        assert session.get(CreatorItem, delivery['published_item_id']).visibility == 'draft'
