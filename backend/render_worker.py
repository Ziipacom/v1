"""Dedicated serial worker; queue metadata is durable, Redis wake hints are not."""
import argparse
import signal
import threading
import time
import uuid
from urllib.parse import urlsplit
from sqlalchemy.engine import make_url

from app import SessionLocal, cache, engine, settings
from render_migrate import ensure_schema_ready
from render_services import (config, runtime_paths, claim_job, process_job, HEARTBEAT_KEY,
                             WAKE_KEY, LEASE_SECONDS, _r2_client)


def validate_hosted_settings():
    if engine.dialect.name != 'postgresql' or settings.media_storage_backend != 'r2':
        raise RuntimeError('A hosted render worker requires the API PostgreSQL database and private R2 storage.')
    database = make_url(settings.database_url)
    if database.query.get('sslmode') not in ('require', 'verify-ca', 'verify-full'):
        raise RuntimeError('The hosted worker requires a TLS PostgreSQL URL (sslmode=require or verification).')
    endpoint = urlsplit(settings.r2_endpoint_url)
    if endpoint.scheme != 'https' or endpoint.username or endpoint.password or not endpoint.hostname or endpoint.query or endpoint.fragment:
        raise RuntimeError('A hosted render worker requires an HTTPS R2 endpoint without URL credentials.')
    if not all((settings.r2_access_key_id, settings.r2_secret_access_key, settings.r2_bucket_name)):
        raise RuntimeError('The private R2 worker credentials are incomplete.')
    redis = urlsplit(settings.redis_url)
    if redis.scheme != 'rediss' or not redis.hostname:
        raise RuntimeError('The hosted worker must use the same TLS Redis (rediss://) connection as the API.')
    # Read-only existence/permission check; uploads are never created at startup.
    _r2_client().head_bucket(Bucket=settings.r2_bucket_name)


def run_worker(stop, *, once=False, coordinator=cache, session_factory=SessionLocal,
               claim=claim_job, process=process_job, clock=time.monotonic):
    identity = str(uuid.uuid4())
    seen = object()
    next_reconcile = 0.0
    draining_queue = False
    try:
        while not stop.is_set():
            coordinator.set(HEARTBEAT_KEY, identity, ex=max(90, config.poll_seconds * 3))
            revision = coordinator.get(WAKE_KEY)
            current = clock()
            should_scan = once or draining_queue or revision != seen or current >= next_reconcile
            claimed = None
            if should_scan:
                # Read revision BEFORE the DB scan so an enqueue racing with an
                # empty result always changes the next revision we observe.
                seen = revision
                next_reconcile = current + config.reconcile_seconds
                with session_factory() as session:
                    claimed = claim(session)
            if claimed:
                if stop.is_set():
                    # A shutdown after claiming retains a durable lease. Another
                    # worker recovers it; it never becomes an untracked retry.
                    break
                coordinator.set(HEARTBEAT_KEY, identity, ex=LEASE_SECONDS)
                process(session_factory, *claimed)
                draining_queue = True
            else:
                draining_queue = False
            if once:
                break
            if not claimed:
                stop.wait(config.poll_seconds)
    finally:
        # A rolling deploy may already have installed a replacement heartbeat.
        try:
            coordinator.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
                             1, HEARTBEAT_KEY, identity)
        except Exception:
            pass  # TTL expires if Redis is unavailable during shutdown.


def main():
    parser = argparse.ArgumentParser(description='Ziipa private media render worker')
    parser.add_argument('--once', action='store_true', help='Process at most one durable queued job')
    parser.add_argument('--require-hosted', action='store_true', help='Require shared PostgreSQL, TLS Redis and private R2')
    args = parser.parse_args()
    if not config.enabled:
        raise SystemExit('Set RENDER_ENABLED=true to run the media worker.')
    stop = threading.Event()
    def shutdown(_signal, _frame):
        stop.set()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        runtime_paths()
        ensure_schema_ready()
        if args.require_hosted:
            validate_hosted_settings()
        cache.ping()
        run_worker(stop, once=args.once)
    finally:
        cache.close()
        engine.dispose()


if __name__ == '__main__':
    main()
