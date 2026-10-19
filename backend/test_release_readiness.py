"""Offline release checks: no secrets, cloud mutations or real HTTPS requests."""
import importlib.util
import json
from pathlib import Path
import re

from sqlalchemy import create_engine, inspect

import render_migrate

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ziipa_public_release_checks', ROOT / 'scripts' / 'check-production-readiness.py')
checks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checks)


def test_render_blueprint_additions_remain_manual_and_no_paid_worker_is_created():
    source = (ROOT / 'render.yaml').read_text()
    assert re.findall(r'^  - type: (.+)$', source, re.MULTILINE) == ['web']
    assert re.findall(r'^    plan: (.+)$', source, re.MULTILINE) == ['free']
    blocks = re.findall(r'^      - key: ([A-Z_]+)\n((?:        [^\n]*\n?)*)', source, re.MULTILINE)
    assert len({key for key, _ in blocks}) == len(blocks)
    settings = dict(blocks)
    manual = {'CREATION_CAMPAIGN_ENABLED', 'OS_CALENDAR_ENABLED', 'LIVE_RECORDINGS_ENABLED',
        'LIVE_WEBHOOK_ID', 'LIVE_WEBHOOK_SECRET', 'TRANSCRIPTION_ENABLED', 'PUSH_ENABLED',
        'PUSH_ENCRYPTION_KEY', 'PUSH_EXPO_ENABLED', 'PUSH_EXPO_ACCESS_TOKEN',
        'PUSH_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PUBLIC_KEY'}
    for key in manual:
        assert settings[key].strip() == 'sync: false'
    assert settings['PUSH_VAPID_SUBJECT'].strip() == 'value: https://ziipa.com'
    assert 'value: true' not in ''.join(settings[key] for key in manual)


def test_new_private_config_routes_are_verified_on_api_and_website_without_authentication():
    cases = checks.cases()
    assert len(cases) == len(set(cases)) == 25
    for origin in (checks.API, checks.WEBSITE):
        for path in ('/api/os/campaigns/config', '/api/os/calendar/config',
                     '/api/live/recordings/config', '/api/notifications/config'):
            assert (origin + path, 'authenticated') in cases
    assert checks.validate('authenticated', 401, 'application/json', b'{"detail":"Please sign in"}')[0]
    assert not checks.validate('authenticated', 200, 'application/json', b'{"enabled":true}')[0]
    assert checks.validate('liveness', 200, 'application/json', b'{"status":"alive","scope":"process"}')[0]
    assert not checks.validate('liveness', 200, 'application/json', b'{"status":"alive"}')[0]


def test_new_feature_tables_migrate_fresh_and_idempotently_to_single_head():
    engine = create_engine('sqlite://')
    try:
        for _ in range(2):
            render_migrate.upgrade_database(engine)
            render_migrate.ensure_schema_ready(engine)
        expected = {'creation_campaigns', 'campaign_deliveries', 'calendar_events', 'calendar_occurrences',
            'live_recording_automation', 'live_recordings', 'live_webhook_receipts',
            'notification_preferences', 'push_devices', 'notification_events', 'notification_deliveries'}
        assert expected <= set(inspect(engine).get_table_names())
        private_columns = {column['name'] for column in inspect(engine).get_columns('push_devices')}
        assert {'endpoint_cipher', 'session_key', 'revision'} <= private_columns
        assert not {'expo_token', 'endpoint', 'auth', 'p256dh'} & private_columns
    finally:
        engine.dispose()
