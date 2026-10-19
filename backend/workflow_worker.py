"""Free, serial Media OS scheduler. Durable jobs survive Redis/process restarts."""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import math
import signal
import threading
import time
import uuid

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select, update

from app import SessionLocal, User, cache, engine
from creator import CreatorItem
from media_workflows import (OsWorkflow, OsWorkflowRun, ACTIVE, MAX_ATTEMPTS, LEASE_SECONDS, INITIAL_CURSOR_ID, config,
                             aware, utcnow, heartbeat_key, wake_key, enqueue, _activity, validate_target)
from render_services import RenderJob


def _valid(run, workflow):
    return bool(workflow and workflow.owner_id == run.owner_id and
                run.snapshot.get('revision') == workflow.revision and
                (workflow.enabled or run.snapshot.get('manual') is True))


def _event_rows(session, workflow, now):
    cursor = workflow.event_cursor or {'at': aware(workflow.created_at).isoformat(), 'id': INITIAL_CURSOR_ID}
    try:
        at = datetime.fromisoformat(cursor['at'])
        at = aware(at)
    except (KeyError, TypeError, ValueError):
        # Corrupt cursors never replay an owner's entire historical library.
        workflow.event_cursor = {**(workflow.event_cursor or {}), 'at': now.isoformat(), 'id': INITIAL_CURSOR_ID}
        return []
    if workflow.trigger == 'media_saved':
        model, timestamp = CreatorItem, CreatorItem.created_at
        query = select(model).where(model.owner_id == workflow.owner_id)
    else:
        model, timestamp = RenderJob, RenderJob.updated_at
        query = select(model).where(model.owner_id == workflow.owner_id, model.status == 'ready')
        if workflow.action == 'render':
            query = query.where(model.item_id == workflow.target_id)
    query = query.where(or_(timestamp > at, and_(timestamp == at, model.id > str(cursor.get('id', '')))), timestamp <= now)
    rows = list(session.scalars(query.order_by(timestamp, model.id).limit(20)))
    return [(row, aware(getattr(row, 'created_at' if model is CreatorItem else 'updated_at'))) for row in rows]


def scan_due(session, *, now=None):
    """Commit each occurrence and its cursor/next time together, never backfill history."""
    now = aware(now or utcnow())
    identities = list(session.execute(select(OsWorkflow.id, OsWorkflow.owner_id).where(OsWorkflow.enabled.is_(True),
                      or_(OsWorkflow.trigger != 'scheduled', OsWorkflow.next_run <= now)).order_by(OsWorkflow.updated_at, OsWorkflow.id).limit(50)))
    created = 0
    for workflow_id, owner_id in identities:
        # All user mutations and dispatch use this same order: owner, workflow, run.
        owner = session.scalar(select(User).where(User.id == owner_id).with_for_update(skip_locked=True))
        if not owner:
            session.rollback(); continue
        workflow = session.scalar(select(OsWorkflow).where(OsWorkflow.id == workflow_id, OsWorkflow.owner_id == owner_id).with_for_update(skip_locked=True).execution_options(populate_existing=True))
        if not workflow or not workflow.enabled:
            session.rollback(); continue
        if workflow.trigger == 'scheduled':
            due = aware(workflow.next_run)
            if due is not None and due <= now:
                run = enqueue(session, workflow, f'scheduled:r{workflow.revision}:' + due.isoformat())
                if run:
                    created += 1
                    if workflow.interval_minutes:
                        interval = timedelta(minutes=workflow.interval_minutes)
                        jumps = math.floor((now - due).total_seconds() / interval.total_seconds()) + 1
                        workflow.next_run = due + interval * jumps
                    else:
                        workflow.next_run = None
        else:
            for event, at in _event_rows(session, workflow, now):
                key = f'{workflow.trigger}:{event.id}:{at.isoformat()}'
                run = enqueue(session, workflow, key, event_id=event.id)
                if run is None:
                    break  # Retain this event for the next durable scan.
                created += 1
                workflow.event_cursor = {**workflow.event_cursor, 'at': at.isoformat(), 'id': event.id}
        # The persisted timestamp gives bounded scans fair rotation across owners.
        workflow.updated_at = now
        session.commit()
    return created


def claim_run(session, *, now=None):
    now = aware(now or utcnow())
    candidates = list(session.execute(select(OsWorkflowRun.id, OsWorkflowRun.owner_id, OsWorkflowRun.workflow_id).where(
        or_(OsWorkflowRun.status == 'queued', and_(OsWorkflowRun.status == 'running',
             OsWorkflowRun.external_ref.is_(None), OsWorkflowRun.lease_until < now))).order_by(OsWorkflowRun.created_at).limit(50)))
    for run_id, owner_id, workflow_id in candidates:
        owner = session.scalar(select(User).where(User.id == owner_id).with_for_update(skip_locked=True))
        if not owner:
            session.rollback(); continue
        workflow = session.scalar(select(OsWorkflow).where(OsWorkflow.id == workflow_id, OsWorkflow.owner_id == owner_id).with_for_update(skip_locked=True).execution_options(populate_existing=True))
        run = session.scalar(select(OsWorkflowRun).where(OsWorkflowRun.id == run_id, OsWorkflowRun.owner_id == owner_id).with_for_update(skip_locked=True).execution_options(populate_existing=True))
        if not workflow or not run or run.status not in ACTIVE or (run.status == 'running' and (run.external_ref or not run.lease_until or aware(run.lease_until) >= now)):
            session.rollback(); continue
        if not _valid(run, workflow):
            run.status = 'cancelled'; run.detail = 'The workflow was paused, changed or removed before execution.'
            run.lease_token = ''; run.lease_until = None; run.updated_at = now
            session.commit(); continue
        if run.attempts >= MAX_ATTEMPTS:
            run.status = 'failed'; run.detail = 'The workflow reached its recovery limit. Review it before starting a new run.'
            run.lease_token = ''; run.lease_until = None; run.updated_at = now
            session.commit(); continue
        run.status = 'running'; run.attempts += 1
        run.lease_token = str(uuid.uuid4()); run.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        run.updated_at = now
        token = run.lease_token
        session.commit()
        return run.id, token
    return None


def _lock_claim(session, run_id, token):
    # Read only immutable identifiers first, then acquire locks in canonical order.
    identity = session.execute(select(OsWorkflowRun.owner_id, OsWorkflowRun.workflow_id).where(OsWorkflowRun.id == run_id)).first()
    if not identity:
        return None
    owner = session.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    workflow = session.scalar(select(OsWorkflow).where(OsWorkflow.id == identity.workflow_id, OsWorkflow.owner_id == identity.owner_id).with_for_update().execution_options(populate_existing=True))
    run = session.scalar(select(OsWorkflowRun).where(OsWorkflowRun.id == run_id, OsWorkflowRun.owner_id == identity.owner_id).with_for_update().execution_options(populate_existing=True))
    if not owner or not run or run.status != 'running' or run.lease_token != token or not _valid(run, workflow):
        return None
    return owner, workflow, run


def _finish(session, run_id, token, status, detail, external_ref=None):
    locked = _lock_claim(session, run_id, token)
    if not locked:
        session.rollback(); return False
    owner, workflow, run = locked
    run.status = status; run.detail = detail[:400]; run.external_ref = external_ref
    run.lease_token = ''; run.lease_until = None; run.updated_at = utcnow()
    _activity(session, owner.id, 'workflow_run', status, run.detail, workflow.id)
    session.commit()
    return True


def dispatch(session_factory, run_id, token, *, render_dispatch=None, sync_dispatch=None):
    """Only fixed owned tools run. Claim/review/ownership are rechecked immediately."""
    with session_factory() as session:
        locked = _lock_claim(session, run_id, token)
        if not locked:
            session.rollback(); return
        user, workflow, run = locked
        try:
            validate_target(session, user, workflow)
            if workflow.action == 'reminder':
                _finish(session, run_id, token, 'completed', 'Reminder ready in Ziipa: ' + workflow.name)
                return
            if workflow.action == 'render':
                from render_api import RenderInput, queue_render
                call = render_dispatch or queue_render
                result = call(RenderInput(item_id=workflow.target_id, soundtrack_rights_confirmed=workflow.rights_confirmed), user, session)
                job_id = result.get('id')
                if not job_id:
                    raise HTTPException(503, 'Render job submission was unavailable.')
                # queue_render commits itself. Re-check review/lease after its commit.
                if result.get('status') == 'ready':
                    _finish(session, run_id, token, 'completed', 'The current edited creation is rendered and ready.', job_id)
                elif result.get('status') in ('queued', 'processing'):
                    _finish(session, run_id, token, 'running', 'The render job is queued. Completion is tracked in Ziipa.', job_id)
                else:
                    _finish(session, run_id, token, 'blocked', 'The current render needs an explicit retry in Studio.', job_id)
                return
            if workflow.action == 'bluesky_sync':
                from social_api import sync_profile
                call = sync_dispatch or sync_profile
                result = asyncio.run(call('bluesky', user, session))
                provider = next((row for row in result.get('providers', []) if row.get('provider') == 'bluesky'), {})
                if provider.get('sync_status') != 'synced':
                    _finish(session, run_id, token, 'failed', 'Bluesky could not complete public profile sync. The previous snapshot was retained.')
                else:
                    _finish(session, run_id, token, 'completed', 'Synced the limited public Bluesky profile, posts and following snapshot.')
                return
            _finish(session, run_id, token, 'blocked', 'This workflow action is unsupported. Review it in Ziipa.')
        except HTTPException as exc:
            session.rollback()
            state = 'blocked' if exc.status_code in (404, 409, 422, 503, 429) else 'failed'
            # Fixed safe text; upstream bodies, OAuth tokens and provider errors stay out.
            _finish(session, run_id, token, state, 'The workflow needs review: check its saved target, permissions and service readiness, then retry.')
        except Exception:
            session.rollback()
            _finish(session, run_id, token, 'failed', 'The workflow could not complete. Review its target and retry in Ziipa.')


def reconcile_render_runs(session):
    """Submission is not completion. Follow the durable existing render receipt."""
    candidates = list(session.execute(select(OsWorkflowRun.id, OsWorkflowRun.owner_id, OsWorkflowRun.workflow_id).where(
        OsWorkflowRun.status == 'running', OsWorkflowRun.external_ref.is_not(None), OsWorkflowRun.lease_token == '').limit(50)))
    changed = 0
    for run_id, owner_id, workflow_id in candidates:
        owner = session.scalar(select(User).where(User.id == owner_id).with_for_update(skip_locked=True))
        if not owner:
            session.rollback(); continue
        workflow = session.scalar(select(OsWorkflow).where(OsWorkflow.id == workflow_id, OsWorkflow.owner_id == owner_id).with_for_update(skip_locked=True).execution_options(populate_existing=True))
        run = session.scalar(select(OsWorkflowRun).where(OsWorkflowRun.id == run_id, OsWorkflowRun.owner_id == owner_id).with_for_update(skip_locked=True).execution_options(populate_existing=True))
        if not workflow or not run or run.status != 'running' or run.lease_token:
            session.rollback(); continue
        if not _valid(run, workflow):
            run.status = 'cancelled'; run.detail = 'Workflow review changed before rendering completed.'
        else:
            job = session.scalar(select(RenderJob).where(RenderJob.id == run.external_ref, RenderJob.owner_id == owner_id,
                                 RenderJob.item_id == run.snapshot.get('target_id')))
            if not job:
                run.status = 'blocked'; run.detail = 'The tracked render job is no longer available.'
            elif job.status == 'ready':
                from render_services import receipt
                resolved = receipt(job, session)
                if resolved.get('status') == 'ready':
                    run.status = 'completed'; run.detail = 'Rendered creation is ready to export in Studio.'
                else:
                    run.status = 'blocked'; run.detail = 'The creation changed. Review its current edit before rendering again.'
            elif job.status in ('failed', 'cancelled', 'stale'):
                run.status = 'blocked'; run.detail = 'The tracked render needs your review or an explicit retry in Studio.'
            else:
                session.rollback(); continue
        run.updated_at = utcnow(); run.lease_token = ''; run.lease_until = None
        _activity(session, owner_id, 'workflow_run', run.status, run.detail, workflow_id)
        session.commit(); changed += 1
    return changed


def next_wakeup_at(session):
    """Cache only a scheduling hint; a restart/new revision always re-reads DB."""
    queued = session.scalar(select(OsWorkflowRun.id).where(OsWorkflowRun.status == 'queued').limit(1))
    if queued:
        return utcnow()
    scheduled = session.scalar(select(func.min(OsWorkflow.next_run)).where(OsWorkflow.enabled.is_(True), OsWorkflow.trigger == 'scheduled'))
    recovery = session.scalar(select(func.min(OsWorkflowRun.lease_until)).where(OsWorkflowRun.status == 'running', OsWorkflowRun.external_ref.is_(None)))
    import creation_campaigns
    campaign_due = None
    if creation_campaigns.config.enabled:
        from campaign_worker import next_wakeup_at as campaign_wakeup
        campaign_due = campaign_wakeup(session)
    from calendar_worker import next_wakeup_at as calendar_wakeup
    calendar_due = calendar_wakeup(session)
    from live_recordings_worker import next_wakeup_at as recording_wakeup
    recording_due = recording_wakeup(session)
    from notification_worker import next_wakeup_at as notification_wakeup
    notification_due = notification_wakeup(session)
    deadlines = [aware(value) for value in (scheduled, recovery, campaign_due, calendar_due, recording_due, notification_due) if value is not None]
    return min(deadlines) if deadlines else None


def run_worker(stop, *, once=False, coordinator=cache, session_factory=SessionLocal, clock=time.monotonic):
    identity = str(uuid.uuid4())
    key = heartbeat_key()
    hint_key = wake_key()
    seen = object()
    next_reconcile = 0.0
    next_due = None
    database_ready = False
    try:
        while not stop.is_set():
            claimed = None
            try:
                # Read the hint BEFORE scanning: a commit racing with this scan
                # changes the next hint observation and cannot disappear.
                revision = coordinator.get(hint_key)
                missing_hint = revision is None
                if missing_hint:
                    coordinator.set(hint_key, str(uuid.uuid4()), nx=True, ex=max(7200, config.reconcile_seconds * 2))
                    revision = coordinator.get(hint_key)
                current = clock()
                due = next_due is not None and aware(next_due) <= utcnow()
                should_scan = once or not database_ready or missing_hint or revision != seen or due or current >= next_reconcile
                if should_scan:
                    with session_factory() as session:
                        scan_due(session)
                        reconcile_render_runs(session)
                        claimed = claim_run(session)
                    database_ready = True
                    seen = revision
                    next_reconcile = current + config.reconcile_seconds
                # Idle heartbeat means this process is alive after a successful
                # scoped DB scan, without forcing Neon awake every minute.
                coordinator.set(key, identity, ex=max(180, config.poll_seconds * 3))
                if claimed and not stop.is_set():
                    dispatch(session_factory, *claimed)
                if should_scan and not stop.is_set():
                    from campaign_worker import tick as campaign_tick
                    campaign_tick(session_factory)
                if should_scan and not stop.is_set():
                    from calendar_worker import tick as calendar_tick
                    calendar_tick(session_factory)
                if should_scan and not stop.is_set():
                    from live_recordings_worker import tick as recording_tick
                    recording_tick(session_factory)
                if should_scan and not stop.is_set():
                    from notification_worker import tick as notification_tick
                    notification_tick(session_factory)
                if should_scan:
                    with session_factory() as session:
                        next_due = next_wakeup_at(session)
                from campaign_worker import heartbeat as campaign_heartbeat
                campaign_heartbeat(coordinator)
                from live_recordings_worker import heartbeat as recording_heartbeat
                recording_heartbeat(coordinator)
                from notification_worker import heartbeat as notification_heartbeat
                notification_heartbeat()
                if once:
                    return
            except Exception:
                # Durable lease/cursor recovery; no token/env/provider exception logs.
                database_ready = False
                try:
                    coordinator.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, key, identity)
                except Exception:
                    pass
                if once:
                    raise RuntimeError('The workflow worker could not complete its bounded scan.') from None
            # Drain committed queued work without a minute's delay per action.
            # Empty/delayed queues return to bounded Redis-only idle polling.
            if not (claimed and next_due is not None and aware(next_due) <= utcnow()):
                stop.wait(config.poll_seconds)
    finally:
        try:
            coordinator.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, key, identity)
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description='Ziipa Media OS workflow worker')
    parser.add_argument('--once', action='store_true', help='Scan and execute at most one reviewed workflow')
    args = parser.parse_args()
    if not config.enabled:
        raise SystemExit('Set OS_WORKFLOW_ENABLED=true to run the workflow worker.')
    from render_migrate import ensure_schema_ready
    ensure_schema_ready()
    cache.ping()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    try:
        run_worker(stop, once=args.once)
    finally:
        cache.close(); engine.dispose()


if __name__ == '__main__':
    main()
