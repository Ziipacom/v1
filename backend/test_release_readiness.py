"""Offline release checks: no secrets, cloud mutations or real HTTPS requests."""
import importlib.util
import json
from pathlib import Path
import re
from email.message import Message
from io import BytesIO

import pytest

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


class PublicResponse(BytesIO):
    def __init__(self, status=200, body=b'<!doctype html><html><script src="/studio/_expo/app.js"></script></html>', location=None):
        super().__init__(body)
        self.status = status
        self.headers = Message()
        self.headers['Content-Type'] = 'text/html'
        if location is not None:
            self.headers['Location'] = location


def public_opener(monkeypatch, responses):
    requests = []

    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            assert len(requests) <= len(responses), 'An unexpected redirect was followed'
            assert not {'cookie', 'authorization'} & {key.lower() for key in request.headers}
            return responses[len(requests) - 1]

    monkeypatch.setattr(checks, 'build_opener', lambda *args: Opener())
    return requests


def test_public_studio_allows_only_its_exact_static_canonical_redirect(monkeypatch):
    requests = public_opener(monkeypatch, [PublicResponse(307, b'', '/studio/'), PublicResponse()])
    result = checks.check((checks.WEBSITE + '/studio/index.html', 'studio'), 5, 0)
    assert result['passed'] and result['status'] == 200 and result['canonical_studio_redirect']
    assert [request.full_url for request in requests] == [checks.WEBSITE + '/studio/index.html', checks.WEBSITE + '/studio/']


@pytest.mark.parametrize('status,location', [(302, '/studio/'), (308, '/studio/'),
    (307, '/portal'), (307, '//evil.example/studio/'), (307, 'https://evil.example/studio/'),
    (307, '/studio/?next=private'), (307, '/studio/other'), (307, 'https://ziipa.com/studio/')])
def test_public_smoke_never_follows_general_or_cross_origin_redirects(monkeypatch, status, location):
    requests = public_opener(monkeypatch, [PublicResponse(status, b'', location)])
    result = checks.check((checks.WEBSITE + '/studio/index.html', 'studio'), 5, 0)
    assert not result['passed'] and len(requests) == 1
    assert 'canonical_studio_redirect' not in result


@pytest.mark.parametrize('response', [PublicResponse(307, b'', '/portal'),
    PublicResponse(200, b'<!doctype html><html>Sign in</html>')])
def test_canonical_studio_still_rejects_second_redirect_or_login_fallback(monkeypatch, response):
    requests = public_opener(monkeypatch, [PublicResponse(307, b'', '/studio/'), response])
    result = checks.check((checks.WEBSITE + '/studio/index.html', 'studio'), 5, 0)
    assert not result['passed'] and len(requests) == 2


def json_check(kind, value):
    return checks.validate(kind, 200, 'application/json', json.dumps(value).encode())


def test_launch_cases_add_only_fixed_public_get_targets_and_keep_default_compatible():
    assert len(checks.cases()) == 25
    launch = checks.cases(public_launch=True)
    assert len(launch) == len(set(launch)) == 37
    assert all(url.startswith((checks.WEBSITE + '/', checks.API + '/')) for url, _ in launch)
    for origin in (checks.API, checks.WEBSITE):
        assert (origin + '/api/health', 'launch_health') in launch
        assert (origin + '/api/platform/status', 'signup') in launch
        assert (origin + '/api/web3/config', 'web3_launch') in launch
        for path in ('/api/editor/title/config', '/api/store/payments/config'):
            assert (origin + path, 'authenticated') in launch
    assert not any('/privacy-beta' in url for url, _ in launch)
    for path, kind in (('/privacy', 'policy_privacy'), ('/terms', 'policy_terms'),
                       ('/community', 'policy_community'), ('/account-deletion', 'policy_deletion')):
        assert (checks.WEBSITE + path, kind) in launch


@pytest.mark.parametrize('flags,expected', [
    ({'signup_paused': False, 'maintenance_mode': False}, True),
    ({'signup_paused': True, 'maintenance_mode': False}, False),
    ({'signup_paused': False, 'maintenance_mode': True}, False),
    ({'signup_paused': 0, 'maintenance_mode': False}, False),
    ({'signup_paused': 'false', 'maintenance_mode': False}, False),
    ({'maintenance_mode': False}, False),
])
def test_launch_signup_requires_explicit_open_flags_without_claiming_registration(flags, expected):
    passed, detail, facts = json_check('signup', flags | {'banner': 'DO_NOT_ECHO_PRIVATE_TEXT'})
    assert passed is expected
    assert 'unverified' in detail
    assert 'DO_NOT_ECHO_PRIVATE_TEXT' not in json.dumps(facts)


@pytest.mark.parametrize('environment,renderer,expected', [
    ('production', {'enabled': True, 'worker_ready': True, 'can_render': True}, True),
    ('production', {'enabled': True, 'worker_ready': False, 'can_render': False}, False),
    ('production', {'enabled': True, 'worker_ready': True, 'can_render': 'true'}, False),
    ('production', None, False),
    ('development', {'enabled': True, 'worker_ready': True, 'can_render': True}, False),
])
def test_launch_health_requires_real_worker_heartbeat_beyond_default_health(environment, renderer, expected):
    value = {'database': 'connected', 'redis': 'connected', 'media_storage': 'r2',
             'email': 'configured', 'environment': environment, 'renderer': renderer}
    assert json_check('health', value)[0]  # Preserve existing smoke behavior.
    passed, detail, facts = json_check('launch_health', value)
    assert passed is expected
    assert 'real export still unverified' in detail
    assert isinstance(facts['renderer_worker_ready'], bool)


def policy_html(kind, extra='', heading=None):
    title = checks.POLICY_HEADINGS[kind] if heading is None else heading
    text = ('Niche Labs LLC contact ziipaziipa@gmail.com. Current password. Type DELETE to confirm. '
            'We describe account information, storage, deletion, moderation and contact choices. ' * 4)
    return f'<!doctype html><html><h1>{title}</h1><p>{text} {extra}</p></html>'.encode()


@pytest.mark.parametrize('kind', list(checks.POLICY_HEADINGS))
def test_public_policy_checks_require_actual_documents_and_do_not_echo_contents(kind):
    passed, detail, facts = checks.validate(kind, 200, 'text/html', policy_html(kind, 'DO_NOT_ECHO_CONTENT'))
    assert passed and facts['expected_heading'] and facts['substantive_document']
    assert 'unverified' in detail and 'DO_NOT_ECHO_CONTENT' not in json.dumps(facts)
    assert not checks.validate(kind, 200, 'text/html', policy_html(kind, heading='Sign in'))[0]
    assert not checks.validate(kind, 200, 'text/html', b'<html><h1>Ziipa</h1>App preview</html>')[0]


@pytest.mark.parametrize('extra', [
    'Existing Ziipa accounts only', 'Limited iPhone beta', 'Beta Privacy Notice',
    'Draft Privacy Policy', 'Proposed Terms of Use',
])
def test_beta_or_draft_policy_is_not_counted_as_public_launch_policy(extra):
    passed, _, facts = checks.validate('policy_privacy', 200, 'text/html', policy_html('policy_privacy', extra))
    assert not passed and facts['restricted_beta_notice']


def test_policy_document_ignores_embedded_script_props_and_accepts_normal_private_drafts_wording():
    embedded = b'<html><h1>Sign in</h1><script>' + policy_html('policy_privacy') + b'</script></html>'
    assert not checks.validate('policy_privacy', 200, 'text/html', embedded)[0]
    assert checks.validate('policy_privacy', 200, 'text/html', policy_html('policy_privacy', 'Your private drafts stay private.'))[0]
    assert not checks.validate('policy_privacy', 200, 'text/html', b'<html>\xff</html>')[0]


def test_policy_redirects_are_not_followed_and_use_only_public_unauthenticated_get(monkeypatch):
    requests = public_opener(monkeypatch, [PublicResponse(302, b'', '/portal')])
    result = checks.check((checks.WEBSITE + '/privacy', 'policy_privacy'), 5, 0)
    assert not result['passed'] and len(requests) == 1
    assert requests[0].get_method() == 'GET'
    assert requests[0].get_header('Accept') == 'text/html'


def deployed_chain(chain_id):
    return {'id': chain_id, 'deployed': True, 'contracts': {
        'collectibles': '0x' + '1' * 40, 'factory': '0x' + '2' * 40, 'tips': '0x' + '3' * 40}}


@pytest.mark.parametrize('value,expected', [
    ({'testnet_only': True, 'chains': [deployed_chain(84532)]}, False),
    ({'testnet_only': False, 'chains': [deployed_chain(84532)]}, False),
    ({'testnet_only': True, 'chains': [deployed_chain(8453)]}, False),
    ({'testnet_only': False, 'chains': [deployed_chain(8453)]}, True),
    ({'testnet_only': False, 'chains': [deployed_chain(99999999)]}, False),
    ({'testnet_only': False, 'chains': [{'id': 8453, 'deployed': True}]}, False),
    ({'testnet_only': False, 'chains': [{'id': 8453, 'deployed': False}]}, False),
    ({'testnet_only': False, 'chains': [None]}, False),
    ({'testnet_only': False, 'chains': []}, False),
    ({'testnet_only': 'false', 'chains': [deployed_chain(8453)]}, False),
    ({'testnet_only': False, 'chains': [deployed_chain(8453)] * 17}, False),
])
def test_launch_web3_distinguishes_declared_mainnet_contracts_from_testnets_and_real_minting(value, expected):
    passed, detail, facts = json_check('web3_launch', value)
    assert passed is expected
    assert 'mint execution unverified' in detail
    assert '0x' not in json.dumps(facts)  # Do not print contract addresses or provider URLs.


def test_placeholder_contract_cannot_qualify_for_mainnet_prerequisite():
    chain = deployed_chain(8453)
    chain['contracts']['collectibles'] = '0x' + '0' * 40
    assert not json_check('web3_launch', {'testnet_only': False, 'chains': [chain]})[0]


def test_summary_never_turns_http_and_heartbeat_checks_into_launch_approval():
    results = [{'passed': True}, {'passed': True}]
    smoke, exit_code = checks.result_summary(results)
    assert exit_code == 0 and smoke == {'passed': 2, 'failed': 0, 'acceptance_not_tested': checks.ACCEPTANCE_NOT_TESTED}
    launch, exit_code = checks.result_summary(results, public_launch=True)
    assert exit_code == 3 and launch['public_checks_passed']
    assert launch['launch_readiness'] == 'unverified' and launch['public_launch_approved'] is False
    assert any('sandbox' in item for item in launch['acceptance_not_tested'])
    blocked, exit_code = checks.result_summary([{'passed': False}], public_launch=True)
    assert exit_code == 1 and blocked['launch_readiness'] == 'blocked'


def test_launch_cli_uses_fixed_cases_and_returns_unverified_even_when_all_http_checks_pass(monkeypatch, capsys):
    import sys
    requested = []
    def fake_check(case, timeout, retries):
        requested.append(case)
        assert timeout == 5 and retries == 0
        return {'url': case[0], 'check': case[1], 'passed': True}
    monkeypatch.setattr(checks, 'check', fake_check)
    monkeypatch.setattr(sys, 'argv', ['check-production-readiness.py', '--public-launch', '--timeout', '5', '--retries', '0'])
    assert checks.main() == 3
    assert set(requested) == set(checks.cases(public_launch=True))
    summary = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert summary['launch_readiness'] == 'unverified'
    assert summary['public_launch_approved'] is False
