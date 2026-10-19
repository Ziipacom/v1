"""Offline Micro package guards; never provisions a host or reads live keys."""
import base64
import importlib.util
import json
import io
from pathlib import Path
import stat
from types import SimpleNamespace

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / 'deploy' / 'oracle-free'
spec = importlib.util.spec_from_file_location('scheduler_preflight_tests', PACKAGE / 'scheduler-preflight.py')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def environment(**changes):
    data = {'DATABASE_URL': 'postgresql+psycopg://synthetic:private@db.invalid/ziipa?sslmode=require',
        'REDIS_URL': 'rediss://default:private@redis.invalid:6379/0', 'PUSH_ENABLED': 'false'}
    data.update(changes)
    return '\n'.join(key + '=' + value for key, value in data.items())


def test_minimal_tls_calendar_only_file_needs_no_media_or_sender_credentials():
    assert set(preflight.parse_environment(environment())) == preflight.REQUIRED
    assert preflight.parse_environment(environment(PUSH_ENABLED='false'))['PUSH_ENABLED'] == 'false'


@pytest.mark.parametrize('changes', [
    {'DATABASE_URL': 'sqlite:///local.db'}, {'DATABASE_URL': 'postgresql://u:p@db.invalid/z'},
    {'REDIS_URL': 'redis://default:private@redis.invalid/0'}, {'PUSH_ENABLED': 'TRUE'},
    {'PUSH_ENABLED': 'true'}, {'PUSH_EXPO_ENABLED': 'true'}, {'PUSH_EXPO_ACCESS_TOKEN': 'synthetic'},
    {'LIVEPEER_API_KEY': 'synthetic'}, {'R2_ACCESS_KEY_ID': 'synthetic'},
    {'PUBLISHING_ENCRYPTION_KEY': 'synthetic'}, {'OS_ASSISTANT_INFERENCE_KEY': 'synthetic'},
    {'RESEND_API_KEY': 'synthetic'}, {'LIVEPEER_WEBHOOK_SECRET': 'synthetic'},
    {'PUSH_VAPID_SUBJECT': 'https://other.invalid'},
])
def test_wrong_connections_and_broader_secrets_are_rejected_without_echo(changes):
    with pytest.raises(ValueError) as result:
        preflight.parse_environment(environment(**changes))
    assert 'synthetic' not in str(result.value) and 'private' not in str(result.value)


def test_duplicates_control_characters_and_injected_values_are_rejected():
    for content in [environment() + '\nPUSH_ENABLED=false', environment() + '\nEXTRA=x',
        environment() + '\x00', environment().replace('PUSH_ENABLED=false', 'PUSH_ENABLED="false"'),
        environment() + '\n#' + 'x' * 16384]:
        with pytest.raises(ValueError):
            preflight.parse_environment(content)


def test_optional_native_default_off_and_requires_explicit_complete_sender():
    assert preflight.parse_environment(environment(PUSH_EXPO_ENABLED='false', PUSH_EXPO_ACCESS_TOKEN=''))['PUSH_EXPO_ENABLED'] == 'false'
    b64 = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
    values = {'PUSH_ENABLED': 'true', 'PUSH_ENCRYPTION_KEY': b64(b's' * 32),
        'PUSH_VAPID_PUBLIC_KEY': b64(b'\x04' + b'p' * 64),
        'PUSH_VAPID_PRIVATE_KEY': b64(b'\x30' + b'v' * 100), 'PUSH_VAPID_SUBJECT': 'https://ziipa.com',
        'PUSH_EXPO_ENABLED': 'true', 'PUSH_EXPO_ACCESS_TOKEN': 'synthetic-expo-sender-token-only'}
    assert preflight.parse_environment(environment(**values))['PUSH_EXPO_ENABLED'] == 'true'
    for changes in [{'PUSH_ENABLED': 'false'}, {'PUSH_EXPO_ACCESS_TOKEN': ''},
        {'PUSH_EXPO_ENABLED': 'false'}, {'PUSH_EXPO_ACCESS_TOKEN': 'invalid whitespace'}]:
        with pytest.raises(ValueError):
            preflight.parse_environment(environment(**(values | changes)))


def test_image_is_native_amd64_unprivileged_and_does_not_change_a1_gate():
    preflight.validate_image({'Os': 'linux', 'Architecture': 'amd64', 'Config': {'User': '10001:10001'}})
    for metadata in [{'Os': 'linux', 'Architecture': 'arm64', 'Config': {'User': '10001'}},
        {'Os': 'linux', 'Architecture': 'amd64', 'Config': {'User': 'root'}}]:
        with pytest.raises(ValueError):
            preflight.validate_image(metadata)
    assert preflight.checks.IMAGE == 'ziipa-render:oracle-arm64'
    with pytest.raises(ValueError):
        preflight.checks.validate_image({'Os': 'linux', 'Architecture': 'amd64', 'Config': {'User': '10001'}})


class Receipt:
    """Portable protected-metadata fixture, including Windows test runners."""
    parents = []
    def __init__(self, data, mode=stat.S_IFREG | 0o600, uid=0):
        self.data, self.mode, self.uid, self.opened = data, mode, uid, False
    def lstat(self):
        return SimpleNamespace(st_mode=self.mode, st_uid=self.uid)
    def open(self, mode):
        assert mode == 'rb'
        self.opened = True
        return io.BytesIO(self.data)


def test_accepted_image_receipt_is_strict_protected_and_exactly_matches_alias():
    identifier = 'sha256:' + 'a' * 64
    assert preflight.accepted_image(Receipt((identifier + '\n').encode())) == identifier
    metadata = {'Os': 'linux', 'Architecture': 'amd64', 'Config': {'User': '10001'}, 'Id': identifier}
    preflight.validate_image(metadata, identifier)
    for actual in ['sha256:' + 'b' * 64, identifier.upper(), None]:
        with pytest.raises(ValueError, match='exact natively accepted image'):
            preflight.validate_image(metadata | {'Id': actual}, identifier)


@pytest.mark.parametrize('data', [b'', b'a' * 64, b'sha256:' + b'A' * 64,
    b'sha256:' + b'a' * 64 + b'\nextra', b' sha256:' + b'a' * 64,
    b'sha256:' + b'a' * 64 + b'\r\n', b'sha256:' + b'a' * 100])
def test_malformed_image_receipts_fail_closed(data):
    with pytest.raises(ValueError):
        preflight.accepted_image(Receipt(data))


def test_image_receipt_missing_symlink_wrong_owner_or_mode_refuses_before_read(tmp_path):
    with pytest.raises(FileNotFoundError):
        preflight.accepted_image(tmp_path / 'missing-receipt')
    for mode, uid in [(stat.S_IFLNK | 0o600, 0), (stat.S_IFREG | 0o644, 0), (stat.S_IFREG | 0o600, 1000)]:
        receipt = Receipt(b'sha256:' + b'a' * 64, mode, uid)
        with pytest.raises(ValueError):
            preflight.accepted_image(receipt)
        assert receipt.opened is False


def test_acceptance_resolves_alias_before_running_and_only_reports_passed_immutable_id(monkeypatch):
    spec = importlib.util.spec_from_file_location('scheduler_acceptance_tests', PACKAGE / 'scheduler-acceptance.py')
    acceptance = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(acceptance)
    identifier = 'sha256:' + 'c' * 64
    calls = []
    monkeypatch.setattr(acceptance.subprocess, 'run', lambda command, **kw:
        calls.append(command) or SimpleNamespace(stdout=identifier + '\n'))
    assert acceptance.immutable_image('ziipa-scheduler:test') == identifier
    command = acceptance.command(identifier, '/reviewed/test_scheduler_worker.py')
    assert identifier in command and 'ziipa-scheduler:test' not in command
    assert calls == [['docker', 'image', 'inspect', '--format', '{{.Id}}', 'ziipa-scheduler:test']]


def test_micro_manifest_bounds_and_no_unapproved_secret_or_network_grants():
    manifest = json.loads((PACKAGE / 'scheduler-compose.json').read_text())
    assert set(manifest['services']) == {'scheduler-worker'}
    service = manifest['services']['scheduler-worker']
    assert service['image'] == preflight.IMAGE and service['platform'] == 'linux/amd64'
    assert service['cpus'] == '0.125' and service['mem_limit'] == service['memswap_limit'] == '384m'
    assert service['command'] == ['python', 'scheduler_worker.py'] and service['pull_policy'] == 'never'
    assert service['env_file'] == [{'path': '/etc/ziipa/scheduler-worker.env', 'required': True, 'format': 'raw'}]
    assert service['user'] == '10001:10001' and service['read_only'] is True
    assert service['cap_drop'] == ['ALL'] and service['security_opt'] == ['no-new-privileges:true']
    assert not {'ports', 'expose', 'privileged', 'volumes', 'network_mode', 'build'} & service.keys()
    assert service['pids_limit'] <= 48 and 'size=33554432' in service['tmpfs'][0]
    assert all(term in service['tmpfs'][0] for term in ('noexec', 'nosuid', 'nodev'))
    from scheduler_worker import FORBIDDEN_FLAGS
    assert all(service['environment'][key] == 'false' for key in FORBIDDEN_FLAGS)
    assert 'PUSH_EXPO_ENABLED' not in service['environment']  # file/default only; never silently enabled or shadowed
    assert not any(term in key for key in service['environment'] for term in ('SECRET', 'KEY', 'PASSWORD', 'TOKEN'))


def test_micro_unit_cannot_start_media_workers_and_build_has_no_media_binaries():
    unit = (PACKAGE / 'ziipa-scheduler-worker.service').read_text()
    assert 'Conflicts=' not in unit  # trying a new unit must not implicitly stop a preserved service
    assert 'scheduler-preflight.py' in unit and '--exit-code-from scheduler-worker' in unit
    assert 'EnvironmentFile=' not in unit and '-f compose.json' not in unit
    dockerfile = (PACKAGE / 'Dockerfile.scheduler').read_text()
    assert 'ffmpeg' not in dockerfile and 'node:' not in dockerfile
    assert 'COPY . .' in dockerfile and 'USER 10001:10001' in dockerfile
    assert '!scheduler.env.example' in (PACKAGE / '.gitignore').read_text()


def test_root_secret_validation_rejects_symlink_wrong_owner_or_mode(monkeypatch):
    class Path:
        parents = []
        def __init__(self, mode, uid):
            self.mode, self.uid = mode, uid
        def lstat(self):
            return SimpleNamespace(st_mode=self.mode, st_uid=self.uid)
    preflight.checks.validate_secret_file(Path(stat.S_IFREG | 0o600, 0))
    for mode, uid in [(stat.S_IFLNK | 0o600, 0), (stat.S_IFREG | 0o644, 0), (stat.S_IFREG | 0o600, 1000)]:
        with pytest.raises(ValueError):
            preflight.checks.validate_secret_file(Path(mode, uid))
