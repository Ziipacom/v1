"""Oracle deployment boundary tests; no provider calls or VM provisioning."""
import importlib.util
import json
from pathlib import Path
import stat
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import app  # Register models before renderer imports.
import render_services as render
import render_worker as worker
from test_render_deployment import Coordinator, Stop, session_factory


PACKAGE = Path(__file__).resolve().parents[1] / 'deploy' / 'oracle-free'
SPEC = importlib.util.spec_from_file_location('oracle_preflight', PACKAGE / 'preflight.py')
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


def environment(**overrides):
    values = {
        'DATABASE_URL': 'postgresql+psycopg://owner:percent%24encoded@db.neon.tech/ziipa?sslmode=require',
        'REDIS_URL': 'rediss://default:percent%23encoded@cache.upstash.io:6379/0',
        'R2_ENDPOINT_URL': 'https://testaccount.r2.cloudflarestorage.com',
        'R2_BUCKET_NAME': 'ziipa-private', 'R2_ACCESS_KEY_ID': 'not-real',
        'R2_SECRET_ACCESS_KEY': 'literal$value#not-a-comment',
        'MEDIA_OWNER_MAX_BYTES': '1073741824', 'MEDIA_PROJECT_MAX_BYTES': '6442450944',
    }
    values.update(overrides)
    return '\n'.join(f'{key}={value}' for key, value in values.items())


def test_raw_secret_values_survive_without_shell_expansion_or_extra_credentials():
    assert preflight.parse_environment(environment())['R2_SECRET_ACCESS_KEY'] == 'literal$value#not-a-comment'
    for extra in ('PUBLISHING_TOKEN_KEY', 'AWS_SESSION_TOKEN', 'NODE_OPTIONS', 'ENVIRONMENT'):
        with pytest.raises(ValueError):
            preflight.parse_environment(environment() + f'\n{extra}=must-not-reach-worker')


@pytest.mark.parametrize('overrides', [
    {'DATABASE_URL': 'sqlite:///local.db'},
    {'DATABASE_URL': 'postgresql://owner:do-not-print@db.neon.tech/ziipa'},
    {'DATABASE_URL': 'postgresql://owner:do-not-print@db.neon.tech/ziipa?sslmode=disable'},
    {'DATABASE_URL': 'postgresql://owner:do-not-print@db.neon.tech/ziipa?sslmode=require&sslmode=disable'},
    {'REDIS_URL': 'redis://default:do-not-print@cache.upstash.io:6379'},
    {'REDIS_URL': 'rediss://cache.upstash.io:6379'},
    {'REDIS_URL': 'rediss://default:do-not-print@cache.upstash.io:6379/0?ssl_cert_reqs=none'},
    {'R2_ENDPOINT_URL': 'http://testaccount.r2.cloudflarestorage.com'},
    {'R2_ENDPOINT_URL': 'https://key:do-not-print@testaccount.r2.cloudflarestorage.com'},
    {'R2_ENDPOINT_URL': 'https://testaccount.r2.cloudflarestorage.com/private/file'},
    {'R2_ENDPOINT_URL': 'https://testaccount.r2.cloudflarestorage.com:bad'},
    {'R2_BUCKET_NAME': '../a-private-path'},
    {'R2_SECRET_ACCESS_KEY': ''},
    {'R2_SECRET_ACCESS_KEY': '"do-not-print"'},
    {'MEDIA_OWNER_MAX_BYTES': '0'},
    {'MEDIA_PROJECT_MAX_BYTES': '0'},
    {'MEDIA_PROJECT_MAX_BYTES': '6442450945'},
    {'MEDIA_OWNER_MAX_BYTES': 'not-a-number'},
    {'MEDIA_PROJECT_MAX_BYTES': '1024'},
])
def test_worker_configuration_rejects_insecure_or_incomplete_settings_without_secret_output(overrides):
    with pytest.raises(ValueError) as failure:
        preflight.parse_environment(environment(**overrides))
    assert 'do-not-print' not in str(failure.value)


def test_duplicate_and_oversized_secret_files_are_rejected():
    with pytest.raises(ValueError):
        preflight.parse_environment(environment() + '\nREDIS_URL=duplicate')
    with pytest.raises(ValueError):
        preflight.parse_environment(environment(R2_SECRET_ACCESS_KEY='a' * 17000))


def test_secret_file_must_be_root_only_and_have_protected_parents():
    def path(file_mode=stat.S_IFREG | 0o600, uid=0, parent_mode=stat.S_IFDIR | 0o700):
        return SimpleNamespace(lstat=lambda: SimpleNamespace(st_uid=uid, st_mode=file_mode),
                               parents=[SimpleNamespace(lstat=lambda: SimpleNamespace(st_uid=0, st_mode=parent_mode))])
    preflight.validate_secret_file(path())
    for unsafe in [path(file_mode=stat.S_IFREG | 0o644), path(uid=1000),
                   path(file_mode=stat.S_IFLNK | 0o600), path(parent_mode=stat.S_IFDIR | 0o777)]:
        with pytest.raises(ValueError):
            preflight.validate_secret_file(unsafe)


def test_wrong_architecture_and_root_image_are_not_accepted():
    safe = {'Os': 'linux', 'Architecture': 'arm64', 'Config': {'User': 'ziipa'}}
    preflight.validate_image(safe)
    for unsafe in [{**safe, 'Architecture': 'amd64'}, {**safe, 'Config': {'User': 'root'}}, {}]:
        with pytest.raises(ValueError):
            preflight.validate_image(unsafe)


def test_package_has_only_private_bounded_worker_and_literal_storage_credentials():
    manifest = json.loads((PACKAGE / 'compose.json').read_text())
    assert set(manifest['services']) == {'render-worker'}
    service = manifest['services']['render-worker']
    assert service['command'] == ['python', 'render_worker.py', '--require-hosted']
    assert service['platform'] == 'linux/arm64' and service['pull_policy'] == 'never'
    assert service['cpus'] == '1.0' and service['mem_limit'] == service['memswap_limit'] == '1g'
    assert not any(key in service for key in ['ports', 'expose', 'volumes', 'privileged', 'network_mode'])
    assert service['read_only'] and service['user'] == '10001:10001' and service['cap_drop'] == ['ALL']
    assert service['security_opt'] == ['no-new-privileges:true']
    assert 'size=268435456' in service['tmpfs'][0] and 'noexec' in service['tmpfs'][0]
    # The ephemeral scratch cap must fit both maximum originals, bounded export,
    # text files and logs; it is included in the container's 1 GiB memory budget.
    assert 2 * render.MAX_INPUT_BYTES + render.MAX_OUTPUT_BYTES + 1024**2 < 256 * 1024**2
    assert service['env_file'] == [{'path': '/etc/ziipa/render-worker.env', 'required': True, 'format': 'raw'}]
    example_keys = {line.partition('=')[0] for line in (PACKAGE / 'worker.env.example').read_text().splitlines()
                    if line and not line.startswith('#')}
    assert example_keys == preflight.REQUIRED
    assert int(service['stop_grace_period'][:-1]) >= 300
    unit = (PACKAGE / 'ziipa-render-worker.service').read_text()
    assert '--no-build --pull never' in unit and 'StartLimitBurst=3' in unit and 'RestartSec=60' in unit
    assert 'preflight.py' in unit and 'EnvironmentFile=' not in unit


def test_free_worker_poll_settings_keep_heartbeat_alive_and_recover_missed_wake(monkeypatch):
    env = json.loads((PACKAGE / 'compose.json').read_text())['services']['render-worker']['environment']
    monkeypatch.setattr(worker.config, 'poll_seconds', int(env['RENDER_POLL_SECONDS']))
    monkeypatch.setattr(worker.config, 'reconcile_seconds', int(env['RENDER_RECONCILE_SECONDS']))
    stop, coordinator, scans = Stop(61), Coordinator(), []
    worker.run_worker(stop, coordinator=coordinator, session_factory=session_factory,
                      claim=lambda _session: scans.append(stop.time), process=Mock(), clock=lambda: stop.time)
    assert scans == [0, 3600]  # Missed notification still recovers from PostgreSQL.
    refreshes = [c for c in coordinator.calls if c[0] == 'set' and c[1] == worker.HEARTBEAT_KEY]
    assert len(refreshes) == 61 and all(c[2]['ex'] == 180 for c in refreshes)
    assert 180 > 2 * worker.config.poll_seconds
    assert len([c for c in coordinator.calls if c[0] != 'eval']) == 122


def test_preflight_failure_does_not_print_a_library_or_secret_exception(monkeypatch, capsys):
    monkeypatch.setattr(preflight.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(preflight.platform, 'machine', lambda: 'aarch64')
    monkeypatch.setattr(preflight.sys, 'argv', ['preflight.py'])
    monkeypatch.setattr(preflight, 'validate_secret_file', Mock(side_effect=ValueError('do-not-print')))
    assert preflight.main() == 1
    captured = capsys.readouterr()
    assert 'do-not-print' not in captured.out + captured.err
