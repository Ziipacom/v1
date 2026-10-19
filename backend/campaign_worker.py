"""Bounded campaign stages run inside the existing workflow worker process."""
import asyncio
from datetime import timedelta
import json
import uuid

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select

from app import User, cache
import creation_campaigns as campaigns
from creation_campaigns import CreationCampaign, CampaignDelivery


def _locked(session, campaign_id, token):
    identity = session.execute(select(CreationCampaign.owner_id).where(CreationCampaign.id == campaign_id)).scalar_one_or_none()
    if identity is None or not campaigns.owner_lock(session, identity):
        return None
    row = campaigns.owned(session, identity, campaign_id, True)
    if row.status not in campaigns.ACTIVE or row.lease_token != token:
        return None
    return row


def _release(row, *, delay=None):
    row.lease_token = ''; row.lease_until = None; row.updated_at = campaigns.now()
    row.next_run = campaigns.now() + timedelta(seconds=delay) if delay is not None else None


def claim(session):
    current = campaigns.now()
    candidates = session.execute(select(CreationCampaign.id, CreationCampaign.owner_id).where(
        CreationCampaign.status.in_(campaigns.ACTIVE), CreationCampaign.next_run <= current,
        or_(CreationCampaign.lease_until.is_(None), CreationCampaign.lease_until < current))
        .order_by(CreationCampaign.next_run, CreationCampaign.id).limit(30)).all()
    for campaign_id, owner_id in candidates:
        if not session.scalar(select(User).where(User.id == owner_id).with_for_update(skip_locked=True)):
            session.rollback(); continue
        row = session.scalar(select(CreationCampaign).where(CreationCampaign.id == campaign_id,
                    CreationCampaign.owner_id == owner_id).with_for_update(skip_locked=True).execution_options(populate_existing=True))
        if not row or row.status not in campaigns.ACTIVE or not row.next_run or campaigns.aware(row.next_run) > current or row.lease_until and campaigns.aware(row.lease_until) >= current:
            session.rollback(); continue
        if row.lease_token:
            row.attempts += 1
        if row.attempts >= 3:
            row.status = 'blocked'; row.detail = 'Preparation reached its recovery limit. Review the existing receipts before an explicit retry.'
            _release(row); session.commit(); continue
        row.lease_token = str(uuid.uuid4()); row.lease_until = current + timedelta(seconds=campaigns.LEASE_SECONDS)
        row.next_run = row.lease_until
        token = row.lease_token
        session.commit()
        return campaign_id, token
    return None


def _stale(session, row):
    try:
        item, fingerprint = campaigns.source(session, row)
        expected_visibility = row.source_visibility
        if fingerprint != row.source_fingerprint or item.visibility != expected_visibility:
            raise HTTPException(409, 'changed')
        return False
    except HTTPException:
        row.status = 'needs_review'; row.detail = 'The source, Studio edit or rights changed. Existing delivery receipts are retained; prepare and review the current version.'
        row.approved_hash = ''; row.review_hash = ''; row.approved_at = None
        _release(row)
        for delivery in campaigns.delivery_rows(session, row):
            if delivery.status == 'pending':
                delivery.status = 'cancelled'; delivery.detail = 'The approved source changed before handoff.'
        session.commit()
        return True


def _manual(row):
    options = row.options or {}
    if options.get('manual_transcript') or options.get('manual_segments'):
        return {'status': 'ready', 'text': options.get('manual_transcript', ''),
                'segments': options.get('manual_segments', []), 'engine': 'user',
                'detail': 'User-reviewed transcript. Caption cues are not applied until you explicitly choose Apply captions.'}
    return None


def _transcript(value):
    # Treat even internal adapter output as untrusted; keep bounded, typed cues.
    from creator import Caption
    text = str(value.get('text', ''))[:12000]
    segments = [Caption.model_validate(c).model_dump() for c in value.get('segments', [])[:100]]
    if value.get('status') not in ('ready', 'unavailable', 'no_speech'):
        raise ValueError('Invalid transcription result')
    return {'status': value['status'], 'text': text, 'segments': segments,
            'engine': str(value.get('engine', ''))[:40], 'detail': str(value.get('detail', ''))[:400]}


def _queue_renditions(session, row, token, render_dispatch=None):
    from render_api import queue_render, RenderInput
    campaign_id = row.id
    for name in campaigns.selected_renditions(row):
        row = _locked(session, campaign_id, token)
        if not row or _stale(session, row):
            return None
        jobs = campaigns.render_job_map(row)
        if name in jobs:
            continue
        try:
            result = (render_dispatch or queue_render)(RenderInput(item_id=row.item_id, rendition=name,
                        soundtrack_rights_confirmed=row.options.get('soundtrack_rights_confirmed', False)),
                        session.get(User, row.owner_id), session)
        except HTTPException as exc:
            if exc.status_code != 429:
                raise
            # Keep the committed subset; the same durable stage admits remaining
            # formats as the existing owner/global render queue frees capacity.
            session.rollback()
            return _locked(session, campaign_id, token)
        row = _locked(session, campaign_id, token)
        if not row or _stale(session, row):
            return None
        jobs[name] = result['id']
        row.render_jobs = jobs; row.render_job_id = jobs.get(row.ziipa_rendition or 'original')
        session.commit()
    return _locked(session, campaign_id, token)


def prepare(session_factory, campaign_id, token, *, render_dispatch=None, transcribe=None, suggest=None):
    with session_factory() as session:
        row = _locked(session, campaign_id, token)
        if not row or _stale(session, row):
            return
        owner_id, item_id, options = row.owner_id, row.item_id, dict(row.options)
        row = _queue_renditions(session, row, token, render_dispatch)
        if not row:
            return
        row.status = 'preparing'
        session.commit()
        transcript = _manual(row)
        if transcript is None and options.get('request_transcription'):
            if not options.get('transcription_consent'):
                transcript = {'status': 'unavailable', 'text': '', 'segments': [], 'engine': '',
                              'detail': 'Explicit transcription consent is required. You can enter your own reviewed transcript instead.'}
            else:
                from media_transcription import transcribe_media
                try:
                    transcript = _transcript((transcribe or transcribe_media)(session, owner_id, item_id))
                except HTTPException:
                    transcript = {'status': 'unavailable', 'text': '', 'segments': [], 'engine': '',
                                  'detail': 'Transcription requires current AI-use rights for this owned source. Enter a manual transcript or review library permissions.'}
        if transcript is None:
            transcript = {'status': 'unavailable', 'text': '', 'segments': [], 'engine': '',
                          'detail': 'Automatic transcription was not requested. Add a reviewed manual transcript if needed.'}
        generated = {'status': 'unavailable', 'title': '', 'description': '', 'engine': '',
                     'detail': 'AI copy suggestions were not requested. Your saved title and description are unchanged.'}
        if options.get('generate_copy'):
            from campaign_planning import propose_copy
            generated = (suggest or propose_copy)(session, owner_id, item_id, transcript)
        session.expire_all()
        row = _locked(session, campaign_id, token)
        if not row or _stale(session, row):
            return
        row.transcript = transcript; row.generated_copy = generated
        row.detail = 'Private render submitted. Transcript and suggested copy require your review; nothing was published.'
        _release(row, delay=30); session.commit()


def reconcile_preparation(session_factory, campaign_id, token, *, render_dispatch=None):
    from render_services import RenderJob
    with session_factory() as session:
        row = _locked(session, campaign_id, token)
        if not row or _stale(session, row):
            return
        row = _queue_renditions(session, row, token, render_dispatch)
        if not row:
            return
        jobs = [session.get(RenderJob, identity) for identity in campaigns.render_job_map(row).values()]
        if any(not job or job.owner_id != row.owner_id or job.item_id != row.item_id for job in jobs):
            row.status = 'blocked'; row.detail = 'The owned render job is unavailable. Prepare the saved Studio edit again.'; _release(row)
        elif len(jobs) == len(campaigns.selected_renditions(row)) and all(job.status == 'ready' for job in jobs):
            row.artifact = campaigns.current_artifact(session, row)
            row.status = 'review'; row.detail = 'The rendered export is ready. Review its playback, transcript, copy, account, privacy and schedule.'; _release(row)
        elif any(job.status in ('failed', 'cancelled', 'stale') for job in jobs):
            row.status = 'blocked'; row.detail = 'Rendering needs review in Exports. Retry the failed render there, then prepare this campaign again.'; _release(row)
        else:
            _release(row, delay=30)
        session.commit()


def _job_delivery(delivery, job):
    if not job:
        return
    delivery.publishing_job_id = job.id
    delivery.external_id = job.external_id; delivery.external_url = job.external_url
    delivery.status = {'rejected': 'failed', 'sending': 'sending'}.get(job.status, job.status)
    delivery.detail = job.detail[:400]; delivery.updated_at = campaigns.now()


def _finish_deliveries(row, deliveries, *, session=None):
    previous_status = row.status
    live = [d for d in deliveries if d.campaign_revision == row.revision]
    if any(d.status in ('pending', 'sending', 'processing') for d in live):
        row.status = 'delivering'; row.detail = 'Following durable provider receipts; accepted uploads are not yet completed posts.'
        _release(row, delay=60)
    elif all(d.status == 'delivered' for d in live):
        row.status = 'completed'; row.detail = 'Ziipa publication and every selected provider delivery completed.'; _release(row)
        if session is not None and previous_status != 'completed':
            from notification_services import enqueue_notification
            enqueue_notification(session, row.owner_id, 'campaigns', row.id)
    else:
        row.status = 'partial'; row.detail = 'Review individual receipts. Handoff, blocked, failed or uncertain destinations are not reported as delivered.'; _release(row)


def deliver(session_factory, campaign_id, token, *, publish_dispatch=None, refresh_dispatch=None):
    import social_publishing as publishing
    from creator import CreatorItem, ItemInput, save_item
    with session_factory() as session:
        row = _locked(session, campaign_id, token)
        if not row or _stale(session, row):
            return
        artifact = campaigns.current_artifact(session, row)
        if not row.approved_hash or campaigns.digest(campaigns.review_manifest(row, artifact)) != row.approved_hash:
            row.status = 'needs_review'; row.detail = 'The exact artifact, copy, schedule or destinations no longer match approval.'; _release(row); session.commit(); return
        item, _ = campaigns.source(session, row)
        if item.visibility != row.source_visibility:
            row.status = 'needs_review'; row.detail = 'The Ziipa source was made private. No new external delivery will start.'; _release(row); session.commit(); return
        # Publish only Ziipa's selected rendition. Other provider renditions stay
        # private and are accepted only by the exact campaign-bound publisher.
        primary = row.ziipa_rendition or 'original'
        for name in [primary, *[r for r in campaigns.selected_renditions(row) if r != primary]]:
            posts = campaigns.published_item_map(row)
            if name in posts:
                continue
            selected = row.artifacts[name]
            parsed = ItemInput.model_validate({'title': row.title, 'description': row.description,
                'category': item.data.get('category', 'video'), 'media_id': selected['media_id'],
                'visibility': 'published' if name == primary else 'draft'})
            post = CreatorItem(id=str(uuid.uuid4()), owner_id=row.owner_id, data={}, visibility='draft')
            session.add(post)
            row.published_items = {**posts, name: post.id}
            if name == primary:
                row.published_item_id = post.id; row.ziipa_published_at = campaigns.now()
            save_item(parsed, session, session.get(User, row.owner_id), post)
            row = _locked(session, campaign_id, token)
            if not row or _stale(session, row):
                return
        published = session.get(CreatorItem, row.published_item_id)
        if not published or published.owner_id != row.owner_id or published.visibility != 'published' or published.data.get('media_id') != artifact['media_id']:
            row.status = 'needs_review'; row.detail = 'The rendered Ziipa post was removed, made private or changed. No new external delivery will start.'
            _release(row); session.commit(); return
        rows = [d for d in campaigns.delivery_rows(session, row) if d.campaign_revision == row.revision]
        # One destination per bounded tick. Resume uses the same UUID and receipt.
        delivery = next((d for d in rows if d.status in ('pending', 'sending', 'processing')), None)
        if delivery is None:
            _finish_deliveries(row, rows, session=session); session.commit(); return
        if delivery.approval_hash != row.approved_hash:
            delivery.status = 'blocked'; delivery.detail = 'This destination was not part of the exact approved campaign.'
            _finish_deliveries(row, rows, session=session); session.commit(); return
        selected_name = delivery.rendition or 'original'
        artifact = row.artifacts.get(selected_name)
        delivery.published_item_id = campaigns.published_item_map(row).get(selected_name)
        if not artifact or not delivery.published_item_id:
            delivery.status = 'blocked'; delivery.detail = 'The selected approved rendition or derivative is missing.'
            _finish_deliveries(row, rows, session=session); session.commit(); return
        if delivery.provider in ('tiktok', 'twitch'):
            delivery.status = 'needs_handoff'
            delivery.detail = (('Open Publishing for fresh TikTok creator options, source review and consent.' if selected_name == primary else
                               'This rendition is a private Studio draft. Explicitly publish that rendition in Studio before opening fresh TikTok source/creator review; campaign approval never substitutes TikTok consent.') if delivery.provider == 'tiktok' else 'Twitch is a live/channel destination. Open the Live broadcast controls; video upload is not supported.')
            _finish_deliveries(row, rows, session=session); session.commit(); return
        job = session.scalar(select(publishing.PublishingJob).where(publishing.PublishingJob.owner_id == row.owner_id,
                    publishing.PublishingJob.idempotency_key == delivery.request_id))
        if not job and delivery.publishing_job_id:
            candidate = session.get(publishing.PublishingJob, delivery.publishing_job_id)
            if (candidate and candidate.owner_id == row.owner_id and candidate.item_id == delivery.published_item_id
                    and candidate.provider == delivery.provider and candidate.target_id == delivery.target_id):
                job = candidate
        if job:
            _job_delivery(delivery, job)
        if job and job.status not in ('failed', 'sending', 'processing'):
            _finish_deliveries(row, rows, session=session); session.commit(); return
        if job and job.status in ('sending', 'processing'):
            # A sending job without a persisted receipt may have crossed the
            # provider boundary. Never call publish again; inspect/refresh only.
            if job.status == 'sending' and not job.external_id and not job.provider_data:
                if campaigns.aware(job.updated_at) < campaigns.now() - timedelta(seconds=180):
                    delivery.status = 'uncertain'; delivery.detail = 'The provider handoff was interrupted without a verified receipt. Check the provider; no repost will run.'
                _finish_deliveries(row, rows, session=session); session.commit(); return
            user = session.get(User, row.owner_id)
            session.commit()
            try:
                asyncio.run((refresh_dispatch or publishing.refresh_job)(uuid.UUID(job.id), user, session))
            except HTTPException:
                # Do not reset existing receipts or convert an accepted upload to
                # a retryable preparation failure when its status is unavailable.
                pass
            row = _locked(session, campaign_id, token)
            if not row:
                return
            delivery = session.get(CampaignDelivery, delivery.id)
            job = session.get(publishing.PublishingJob, job.id)
            _job_delivery(delivery, job)
            _finish_deliveries(row, campaigns.delivery_rows(session, row), session=session); session.commit(); return
        if not publishing.readiness(delivery.provider).get('publish_ready'):
            delivery.status = 'blocked'; delivery.detail = 'This worker has no accepted provider publishing configuration. Connect and configure the provider before an explicit retry.'
            _finish_deliveries(row, rows, session=session); session.commit(); return
        if delivery.attempts >= 3:
            delivery.status = 'failed'; delivery.detail = 'Safe preparation retries reached their limit. Existing receipts are preserved.'
            _finish_deliveries(row, rows, session=session); session.commit(); return
        request = publishing.PublishInput(item_id=delivery.published_item_id, expected_media_id=artifact['media_id'],
                    expected_target_id=delivery.target_id, render_id=None, provider=delivery.provider,
                    idempotency_key=delivery.request_id, privacy=delivery.privacy, made_for_kids=delivery.made_for_kids,
                    consent=True, original_media_acknowledged=True, retry_failed=bool(job and job.status == 'failed'),
                    title=row.title, description=row.description, expected_source_sha256=artifact['output_sha256'],
                    campaign_id=row.id, campaign_revision=row.revision, campaign_approval_hash=row.approved_hash)
        delivery.status = 'sending'; delivery.attempts += 1
        delivery.detail = 'Starting the exact approved provider handoff. A lost response will not cause an automatic repost.'
        row.status = 'delivering'
        user = session.get(User, row.owner_id)
        session.commit()
        result = None
        try:
            result = asyncio.run((publish_dispatch or publishing.publish)(request, user, session))
        except HTTPException:
            session.rollback()
        row = _locked(session, campaign_id, token)
        if not row:
            return
        delivery = session.get(CampaignDelivery, delivery.id)
        job = session.scalar(select(publishing.PublishingJob).where(publishing.PublishingJob.owner_id == row.owner_id,
                        publishing.PublishingJob.idempotency_key == delivery.request_id))
        if not job and isinstance(result, dict) and result.get('id'):
            # Existing publisher may deduplicate the same approved content under
            # an older request UUID. Keep its verified receipt instead of inventing
            # another delivery or reporting an accepted post as unavailable.
            candidate = session.get(publishing.PublishingJob, result['id'])
            if (candidate and candidate.owner_id == row.owner_id and candidate.item_id == delivery.published_item_id
                    and candidate.provider == delivery.provider and candidate.target_id == delivery.target_id):
                job = candidate
        if job:
            _job_delivery(delivery, job)
        else:
            delivery.status = 'blocked'; delivery.detail = 'Provider validation stopped before a durable handoff. Review connection, account, privacy, source and provider approvals before retrying.'
        _finish_deliveries(row, campaigns.delivery_rows(session, row), session=session); session.commit()


def tick(session_factory, *, render_dispatch=None, transcribe=None, suggest=None, publish_dispatch=None, refresh_dispatch=None):
    if not campaigns.config.enabled:
        return False
    with session_factory() as session:
        claimed = claim(session)
    heartbeat()
    if not claimed:
        return False
    campaign_id, token = claimed
    try:
        with session_factory() as session:
            row = _locked(session, campaign_id, token)
            if not row:
                return False
            status = row.status
            session.rollback()
        if status == 'queued':
            prepare(session_factory, campaign_id, token, render_dispatch=render_dispatch, transcribe=transcribe, suggest=suggest)
        elif status == 'preparing':
            reconcile_preparation(session_factory, campaign_id, token, render_dispatch=render_dispatch)
        else:
            deliver(session_factory, campaign_id, token, publish_dispatch=publish_dispatch, refresh_dispatch=refresh_dispatch)
    except Exception:
        with session_factory() as session:
            row = _locked(session, campaign_id, token)
            if row:
                row.status = 'blocked'; row.detail = 'This campaign stage could not finish. Review existing render and delivery receipts before retrying.'
                _release(row); session.commit()
    return True


def heartbeat(coordinator=None):
    if not campaigns.config.enabled:
        return
    import social_publishing as publishing
    # Capability metadata contains no credentials, tokens or account identifiers.
    ready = [p for p in ('youtube', 'bluesky', 'facebook', 'instagram') if publishing.readiness(p).get('publish_ready')]
    (coordinator or cache).set(campaigns.heartbeat_key(), json.dumps({'publish_providers': ready, 'preparation': True}), ex=180)


def next_wakeup_at(session):
    return session.scalar(select(func.min(CreationCampaign.next_run)).where(CreationCampaign.status.in_(campaigns.ACTIVE)))
