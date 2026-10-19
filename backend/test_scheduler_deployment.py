"""Offline Micro package guards; never provisions a host or reads live keys."""
import base64
import importlib.util
import json
import io
import ast
import hashlib
import os
import sys
from pathlib import Path
import stat
from types import SimpleNamespace

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / 'deploy' / 'oracle-free'
spec = importlib.util.spec_from_file_location('scheduler_preflight_tests', PACKAGE / 'scheduler-preflight.py')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
profiles = preflight.profiles


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


def test_fixed_compact_capacity_keeps_the_same_os_reserve_without_changing_default():
    standard, compact = profiles.profile(), profiles.profile('compact256')
    assert standard['memory_limit_bytes'] == 384 * 1024**2
    assert standard['required_available_bytes'] == 512 * 1024**2
    assert compact['memory_limit_bytes'] == 256 * 1024**2
    assert compact['required_available_bytes'] == 384 * 1024**2
    for value in (standard, compact):
        assert value['required_available_bytes'] - value['memory_limit_bytes'] == value['os_reserve_bytes'] == 128 * 1024**2
        assert value['minimum_total_bytes'] == 768 * 1024**2
    memory = 'MemTotal: 979412 kB\nMemAvailable: 400000 kB\n'
    preflight.validate_capacity(memory, 'compact256')
    with pytest.raises(ValueError):
        preflight.validate_capacity(memory)
    for memory in ('MemTotal: 786432 kB\nMemAvailable: 393215 kB\n',
                   'MemTotal: 786431 kB\nMemAvailable: 524288 kB\n', ''):
        with pytest.raises(ValueError):
            preflight.validate_capacity(memory, 'compact256')
    for name in ('compact128', '256', '', None, 256):
        with pytest.raises(ValueError):
            profiles.profile(name)


def test_compact_manifest_changes_only_project_name_and_memory_caps():
    standard = json.loads((PACKAGE / 'scheduler-compose.json').read_text())
    compact = json.loads((PACKAGE / 'scheduler-compact-compose.json').read_text())
    assert compact['name'] != standard['name']
    service = compact['services']['scheduler-worker']
    assert service['mem_limit'] == service['memswap_limit'] == '256m'
    compact['name'] = standard['name']
    service['mem_limit'] = service['memswap_limit'] = '384m'
    assert compact == standard
    standard_unit = (PACKAGE / 'ziipa-scheduler-worker.service').read_text()
    compact_unit = (PACKAGE / 'ziipa-scheduler-compact-worker.service').read_text()
    for value in (standard_unit, compact_unit):
        assert '/usr/bin/flock --nonblock /run/ziipa-scheduler-worker.lock' in value
        assert 'Conflicts=' not in value and 'EnvironmentFile=' not in value
        assert 'scheduler_worker.py' not in value  # only the fixed reviewed Compose service
    assert 'scheduler-preflight.py --profile compact256' in compact_unit
    assert 'scheduler-compact-compose.json' in compact_unit
    assert '--profile' not in standard_unit


def test_profile_receipt_binds_exact_image_limits_native_status_and_test_source():
    image, test_hash = 'sha256:' + 'a' * 64, 'b' * 64
    value = profiles.receipt_payload('compact256', image, test_hash)
    assert profiles.validate_receipt(value, 'compact256', image, test_hash) == value
    for changes in ({'profile': 'standard384'}, {'native_acceptance': False}, {'schema': 1},
                    {'image_id': 'sha256:' + 'c' * 64}, {'acceptance_test_sha256': 'd' * 64},
                    {'profile_source_sha256': 'e' * 64},
                    {'resource_limits': profiles.profile('standard384')}, {'extra': 'unreviewed'}):
        with pytest.raises(ValueError):
            profiles.validate_receipt(value | changes, 'compact256', image, test_hash)
    false_numeric = value | {'resource_limits': value['resource_limits'] | {'swap_limit_bytes': False}}
    with pytest.raises(ValueError):
        profiles.validate_receipt(false_numeric, 'compact256', image, test_hash)
    for legacy in ({'native_acceptance': True, 'image_id': image}, image, {'schema': 1, 'profile': 'compact256'}):
        with pytest.raises(ValueError):
            profiles.validate_receipt(legacy, 'compact256', image, test_hash)


def test_profile_receipt_missing_symlink_or_loose_metadata_fails_before_read(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, 'CONFIG', tmp_path)
    with pytest.raises(FileNotFoundError):
        profiles.read_receipt('compact256', 'sha256:' + 'a' * 64, 'b' * 64)
    class ProtectedFixture(Receipt):
        def lstat(self):
            return SimpleNamespace(st_mode=self.mode, st_uid=self.uid, st_gid=0)
    for mode, uid in ((stat.S_IFLNK | 0o600, 0), (stat.S_IFREG | 0o644, 0), (stat.S_IFREG | 0o600, 1000)):
        path = ProtectedFixture(b'{}', mode, uid)
        monkeypatch.setattr(profiles, 'receipt_path', lambda name: path)
        with pytest.raises(ValueError):
            profiles.read_receipt('compact256', 'sha256:' + 'a' * 64, 'b' * 64)
        assert path.opened is False


def test_receipt_write_is_atomic_exclusive_and_replay_never_overwrites(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, 'CONFIG', tmp_path)
    monkeypatch.setattr(profiles, 'protected', lambda *a, **kw: None)
    # Linux CI exercises the actual atomic link. Windows' workspace sandbox
    # forbids hard links, so model only that syscall's exclusive-create contract.
    safe_os = SimpleNamespace(**vars(os))
    safe_os.geteuid = lambda: 0
    safe_os.fchown = lambda *args: None
    safe_os.fchmod = lambda *args: None
    safe_os.O_DIRECTORY, safe_os.O_NOFOLLOW = getattr(os, 'O_DIRECTORY', 0), getattr(os, 'O_NOFOLLOW', 0)
    directory_descriptor = tmp_path / 'directory-fsync-fixture'
    directory_descriptor.touch()
    safe_os.open = lambda path, flags: os.open(directory_descriptor, os.O_RDWR) if Path(path) == tmp_path else os.open(path, flags)
    if os.name == 'nt':
        def exclusive_link(source, target, **kwargs):
            with Path(target).open('xb') as stream:
                stream.write(Path(source).read_bytes())
        safe_os.link = exclusive_link
    monkeypatch.setattr(profiles, 'os', safe_os)
    image, test_hash = 'sha256:' + 'a' * 64, 'b' * 64
    target = profiles.write_receipt('compact256', image, test_hash)
    before = target.read_bytes()
    assert json.loads(before) == profiles.receipt_payload('compact256', image, test_hash)
    with pytest.raises(ValueError, match='already exists'):
        profiles.write_receipt('compact256', 'sha256:' + 'c' * 64, test_hash)
    assert target.read_bytes() == before and not list(tmp_path.glob('.scheduler-acceptance-*'))


def test_receipt_link_failure_leaves_no_receipt_and_cleans_temporary_file(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, 'CONFIG', tmp_path)
    monkeypatch.setattr(profiles, 'protected', lambda *a, **kw: None)
    safe_os = SimpleNamespace(**vars(os))
    safe_os.geteuid = lambda: 0
    safe_os.fchown = lambda *args: None
    safe_os.fchmod = lambda *args: None
    safe_os.link = lambda *a, **kw: (_ for _ in ()).throw(OSError('synthetic link failure'))
    monkeypatch.setattr(profiles, 'os', safe_os)
    with pytest.raises(OSError):
        profiles.write_receipt('compact256', 'sha256:' + 'a' * 64, 'b' * 64)
    assert not profiles.receipt_path('compact256').exists()
    assert not list(tmp_path.glob('.scheduler-acceptance-*'))


def test_native_recording_requires_root_and_preserves_existing_receipt(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, 'CONFIG', tmp_path)
    monkeypatch.setattr(profiles, 'protected', lambda *a, **kw: None)
    monkeypatch.setattr(profiles.os, 'geteuid', lambda: 1000, raising=False)
    with pytest.raises(ValueError, match='requires root'):
        profiles.prepare_record('compact256')
    monkeypatch.setattr(profiles.os, 'geteuid', lambda: 0)
    profiles.receipt_path('compact256').write_bytes(b'preserved')
    with pytest.raises(ValueError, match='already exists'):
        profiles.prepare_record('compact256')
    assert profiles.receipt_path('compact256').read_bytes() == b'preserved'


def test_acceptance_and_profiles_are_python310_compatible_and_hash_without_file_digest(tmp_path, monkeypatch):
    for name in ('scheduler-preflight.py', 'scheduler-acceptance.py', 'scheduler-profiles.py'):
        ast.parse((PACKAGE / name).read_text(), feature_version=(3, 10))
    monkeypatch.delattr(profiles.hashlib, 'file_digest', raising=False)
    path = tmp_path / 'test-source'
    path.write_bytes(b'exact acceptance source')
    assert profiles.test_sha256(path) == hashlib.sha256(path.read_bytes()).hexdigest()


def test_compact_acceptance_enforces_exact_cgroup_limits_not_just_a_label():
    spec = importlib.util.spec_from_file_location('scheduler_compact_acceptance', PACKAGE / 'scheduler-acceptance.py')
    acceptance = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(acceptance)
    for name, memory, peak in (('standard384', 384, 350), ('compact256', 256, 224)):
        command = acceptance.command('sha256:' + 'a' * 64, '/reviewed/tests.py', profile_name=name)
        assert '--memory=' + str(memory) + 'm' in command
        assert '--memory-swap=' + str(memory) + 'm' in command
        assert '--cpus=0.125' in command and '--network=none' in command
        assert '--pids-limit=48' in command and '--read-only' in command
        script = command[-1]
        assert "=='" + str(memory * 1024**2) + "'" in script
        assert 'peak<' + str(peak * 1024**2) in script
        assert "'pids.max'" in script and '33554432' in script
        assert '--env-file' not in command and '/etc/ziipa' not in ' '.join(command)


def test_coexistence_checks_opposite_profile_and_all_worker_containers(monkeypatch):
    calls = []
    monkeypatch.setattr(preflight.subprocess, 'run', lambda command, **kw:
        calls.append(command[-1]) or SimpleNamespace(returncode=3, stdout='inactive\n'))
    monkeypatch.setattr(preflight.checks, 'capture', lambda command: '')
    preflight.refuse_coexisting_workers('compact256')
    assert 'ziipa-scheduler-worker.service' in calls and 'ziipa-render-worker.service' in calls
    calls.clear()
    preflight.refuse_coexisting_workers('standard384')
    assert 'ziipa-scheduler-compact-worker.service' in calls
    monkeypatch.setattr(preflight.checks, 'capture', lambda command: 'ziipa-oracle-scheduler-micro-scheduler-worker-1')
    with pytest.raises(ValueError, match='container'):
        preflight.refuse_coexisting_workers('compact256')


def load_acceptance():
    spec = importlib.util.spec_from_file_location('scheduler_acceptance_ordering', PACKAGE / 'scheduler-acceptance.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_desktop_rehearsal_cannot_record_a_native_profile_receipt(monkeypatch):
    acceptance = load_acceptance()
    monkeypatch.setattr(sys, 'argv', ['acceptance', '--profile', 'compact256', '--desktop-review', '--record-native-receipt'])
    monkeypatch.setattr(acceptance.subprocess, 'run', lambda *a, **kw: pytest.fail('Desktop recording reached Docker'))
    with pytest.raises(SystemExit, match='never create'):
        acceptance.main()


@pytest.mark.parametrize('returncode', [0, 1])
def test_only_a_successful_native_run_records_its_exact_profile(monkeypatch, returncode):
    acceptance, calls = load_acceptance(), []
    identifier = 'sha256:' + 'a' * 64
    monkeypatch.setattr(sys, 'argv', ['acceptance', '--profile', 'compact256', '--record-native-receipt'])
    monkeypatch.setattr(acceptance.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(acceptance.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(acceptance.os, 'geteuid', lambda: 1000, raising=False)
    monkeypatch.setattr(acceptance, 'native_capacity', lambda name: calls.append('capacity:' + name))
    monkeypatch.setattr(acceptance, 'refuse_worker_activity', lambda: calls.append('coexistence'))
    monkeypatch.setattr(acceptance.profiles, 'prepare_record', lambda name: calls.append('exclusive:' + name))
    monkeypatch.setattr(acceptance, 'immutable_image', lambda name: identifier)
    monkeypatch.setattr(acceptance.subprocess, 'run', lambda command, **kwargs:
        calls.append('actual-capped-test') or SimpleNamespace(returncode=returncode))
    monkeypatch.setattr(acceptance.profiles, 'write_receipt', lambda name, image, source:
        calls.append(('record', name, image, source)))
    assert acceptance.main() == returncode
    assert calls[:4] == ['capacity:compact256', 'coexistence', 'exclusive:compact256', 'actual-capped-test']
    recorded = [value for value in calls if isinstance(value, tuple)]
    assert recorded == ([] if returncode else [('record', 'compact256', identifier,
        acceptance.profiles.test_sha256())])


def test_profile_provenance_is_separate_from_the_runtime_image_and_test_source():
    compact, standard = profiles.source_sha256('compact256'), profiles.source_sha256('standard384')
    assert len(compact) == len(standard) == 64 and compact != standard
    image = 'sha256:' + 'a' * 64
    value = profiles.receipt_payload('compact256', image, 'b' * 64)
    assert value['profile_source_sha256'] == compact
    assert value['image_id'] == image and value['acceptance_test_sha256'] == 'b' * 64


@pytest.mark.parametrize('state,code', [('active', 0), ('activating', 3), ('deactivating', 3), ('reloading', 0), ('', 1)])
def test_preflight_refuses_starting_stopping_or_unknown_state_workers(monkeypatch, state, code):
    monkeypatch.setattr(preflight.subprocess, 'run', lambda *a, **kw:
        SimpleNamespace(returncode=code, stdout=state + '\n'))
    monkeypatch.setattr(preflight.checks, 'capture', lambda command: pytest.fail('Bad service state reached Docker'))
    with pytest.raises(ValueError, match='worker is active'):
        preflight.refuse_coexisting_workers('compact256')


def test_native_acceptance_checks_both_units_even_without_running_containers(monkeypatch):
    acceptance, calls = load_acceptance(), []
    def inactive(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0 if command[0] == 'docker' else 3,
            stdout='' if command[0] == 'docker' else 'inactive\n')
    monkeypatch.setattr(acceptance.subprocess, 'run', inactive)
    acceptance.refuse_worker_activity()
    assert {command[-1] for command in calls if command[0] != 'docker'} >= {
        'ziipa-scheduler-worker.service', 'ziipa-scheduler-compact-worker.service',
        'ziipa-workflow-worker.service', 'ziipa-render-worker.service',
        'ziipa-agent-worker.service', 'ziipa-agent-worker-small.service'}
    monkeypatch.setattr(acceptance.subprocess, 'run', lambda *a, **kw:
        SimpleNamespace(returncode=3, stdout='activating\n'))
    with pytest.raises(ValueError, match='restart backoff'):
        acceptance.refuse_worker_activity()


@pytest.mark.skipif(os.name == 'nt', reason='Actual Linux fcntl exclusion is verified in Linux CI/native acceptance.')
def test_native_acceptance_lock_excludes_another_profile_and_is_released(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, 'LOCK_FILE', tmp_path / 'shared-scheduler.lock')
    monkeypatch.setattr(profiles, 'protected', lambda *a, **kw: None)
    safe_os = SimpleNamespace(**vars(os))
    safe_os.geteuid = lambda: 0
    safe_os.fstat = lambda descriptor: SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0)
    monkeypatch.setattr(profiles, 'os', safe_os)
    with profiles.native_lock():
        with pytest.raises(BlockingIOError):
            with profiles.native_lock():
                pytest.fail('Concurrent native acceptance acquired the shared lock')
    with profiles.native_lock():
        pass
