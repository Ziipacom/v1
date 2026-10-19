"""Limited Micro profile: private calendar reminders and consented notifications.

This is deliberately not the general workflow dispatcher. It cannot execute
render jobs, recording imports, provider sync, campaigns or agent tools.
"""
from __future__ import annotations

import argparse
import os
import signal
import threading
import time
import uuid

from app import SessionLocal, cache, engine
import calendar_services
import calendar_worker
import notification_services
import notification_worker
from media_workflows import aware, utcnow, wake_key


POLL_SECONDS = 60
RECONCILE_SECONDS = 3600
FORBIDDEN_FLAGS = (
    'RENDER_ENABLED', 'OS_WORKFLOW_ENABLED', 'CREATION_CAMPAIGN_ENABLED',
    'LIVE_RECORDINGS_ENABLED', 'TRANSCRIPTION_ENABLED', 'OS_AGENT_ENABLED',
    'OS_ASSISTANT_LOCAL_AI_ENABLED', 'SOCIAL_PUBLIC_SYNC_ENABLED',
)


def validate_runtime():
    """Fail closed if this limited package was accidentally given wider powers."""
    if os.environ.get('SCHEDULER_ENABLED') != 'true' or not calendar_services.config.enabled:
        raise ValueError('Explicitly enable the limited calendar scheduler first.')
    if any(os.environ.get(key) != 'false' for key in FORBIDDEN_FLAGS):
        raise ValueError('All unsupported Micro profile features must be explicitly disabled.')
    # Check the effective application settings too; a stray .env must not enable
    # a sender or execution feature behind the environment-only profile guard.
    from app import settings
    import render_services
    import media_workflows
    import creation_campaigns
    import live_recordings
    import media_transcription
    import agent_api
    import assistant_api
    active = (
        render_services.config.enabled, media_workflows.config.enabled,
        creation_campaigns.config.enabled, live_recordings.config.live_recordings_enabled,
        media_transcription.config.enabled, agent_api.config.enabled,
        assistant_api.config.local_ai_enabled, settings.social_public_sync_enabled,
    )
    if any(active):
        raise ValueError('This scheduler accepts no media/agent execution configuration.')
    native = os.environ.get('PUSH_EXPO_ENABLED', 'false')
    token = os.environ.get('PUSH_EXPO_ACCESS_TOKEN', '')
    if native not in {'true', 'false'} or notification_services.config.expo_enabled != (native == 'true'):
        raise ValueError('Native push must be an explicit separately reviewed opt-in.')
    if native == 'false' and token:
        raise ValueError('Do not copy a native sender credential while native push is disabled.')
    if native == 'true':
        if not notification_services.config.enabled:
            raise ValueError('Native push requires enabled notification consent handling.')
        notification_services.expo_sender_token()
    if notification_services.config.enabled:
        ready = notification_services.sender_capabilities()
        if not ready.get('web_ready') or (native == 'true' and not ready.get('expo_ready')):
            raise ValueError('Push requires its complete separately approved sender configuration.')


def allowed_providers():
    """Default Web-only; never claim/defer an unsupported native recipient."""
    return ('web', 'expo') if notification_services.config.expo_enabled else ('web',)


def next_wakeup_at(session):
    deadlines = [aware(value) for value in (
        calendar_worker.next_wakeup_at(session), notification_worker.next_wakeup_at(session, providers=allowed_providers())
    ) if value is not None]
    return min(deadlines) if deadlines else None


def run_worker(stop, *, once=False, coordinator=cache, session_factory=SessionLocal,
               clock=time.monotonic):
    """Redis hints + cached deadlines avoid minute-by-minute Neon DB polling.

    Hourly reconciliation covers lost hints, SQL remains authoritative, and a
    restart always scans. Readiness is feature-specific, never generic workflow.
    """
    hint_key, seen = wake_key(), object()
    next_reconcile, next_due, database_ready = 0.0, None, False
    while not stop.is_set():
        try:
            revision = coordinator.get(hint_key)
            missing = revision is None
            if missing:
                coordinator.set(hint_key, str(uuid.uuid4()), nx=True, ex=7200)
                revision = coordinator.get(hint_key)
            current = clock()
            due = next_due is not None and aware(next_due) <= utcnow()
            scan = once or not database_ready or missing or revision != seen or due or current >= next_reconcile
            if scan:
                calendar_worker.tick(session_factory)
                if not stop.is_set():
                    notification_worker.tick(session_factory, providers=allowed_providers())
                with session_factory() as session:
                    next_due = next_wakeup_at(session)
                database_ready, seen = True, revision
                next_reconcile = current + RECONCILE_SECONDS
            # These renewals do not read SQL or awaken an idle Neon database.
            calendar_worker.heartbeat(coordinator)
            notification_worker.heartbeat(coordinator, providers=allowed_providers())
            if once:
                return
        except Exception:
            database_ready = False
            # Never print transport, database URL, subscription or key values.
            if once:
                raise RuntimeError('The limited scheduler could not complete its bounded scan.') from None
        stop.wait(POLL_SECONDS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    try:
        validate_runtime()
        from render_migrate import ensure_schema_ready
        ensure_schema_ready()
        cache.ping()
    except Exception:
        raise SystemExit('Limited scheduler startup failed. Review its disabled features, root-only configuration and matching schema; no work was started.') from None
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    try:
        run_worker(stop, once=args.once)
    finally:
        cache.close()
        engine.dispose()


if __name__ == '__main__':
    main()
