"""Oracle deployment boundary tests; no provider calls or VM provisioning."""
import importlib.util
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import app  # Register models before renderer imports.
import render_services as render
import render_worker as worker
from test_render_deployment import Coordinator, Stop, session_factory
from test_live_recordings import harness as recording_harness
from test_rendering import runtime


PACKAGE = Path(__file__).resolve().parents[1] / 'deploy' / 'oracle-free'
SPEC = importlib.util.spec_from_file_location('oracle_preflight', PACKAGE / 'preflight.py')
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)
WORKFLOW_SPEC = importlib.util.spec_from_file_location('oracle_workflow_preflight', PACKAGE / 'workflow-preflight.py')
workflow_preflight = importlib.util.module_from_spec(WORKFLOW_SPEC)
WORKFLOW_SPEC.loader.exec_module(workflow_preflight)


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


def workflow_environment(**overrides):
    values = {key: 'false' for key in workflow_preflight.FLAGS}
    values.update(LIVEPEER_API_KEY='', PUSH_ENCRYPTION_KEY='', PUSH_VAPID_PRIVATE_KEY='',
                  PUSH_VAPID_PUBLIC_KEY='', PUSH_VAPID_SUBJECT='https://ziipa.com')
    values.update(overrides)
    return '\n'.join(f'{key}={value}' for key, value in values.items())


def test_workflow_example_defaults_new_features_off_and_does_not_grant_renderer_secrets():
    example = (PACKAGE / 'workflow.env.example').read_text()
    values = workflow_preflight.parse_environment(example)
    for key in ('LIVE_RECORDINGS_ENABLED', 'PUSH_ENABLED', 'OS_CALENDAR_ENABLED', 'CREATION_CAMPAIGN_ENABLED'):
        assert values[key] == 'false'
    assert all(not values[key] for key in workflow_preflight.PUSH_KEYS | {'LIVEPEER_API_KEY'})
    with pytest.raises(ValueError):
        preflight.parse_environment(environment() + '\nLIVEPEER_API_KEY=fixture-only-must-not-reach-renderer')
    with pytest.raises(ValueError):
        workflow_preflight.parse_environment(workflow_environment() + '\nDATABASE_URL=must-stay-in-storage-file')


@pytest.mark.parametrize('changes', [
    {'LIVE_RECORDINGS_ENABLED': 'true'}, {'LIVE_RECORDINGS_ENABLED': 'True'},
    {'PUSH_ENABLED': 'true'}, {'PUSH_ENCRYPTION_KEY': 'do-not-print'},
    {'LIVEPEER_API_KEY': 'do-not-print\t'}, {'LIVEPEER_API_KEY': '"do-not-print"'},
    {'PUSH_VAPID_SUBJECT': 'https://unreviewed.example'},
])
def test_optional_workflow_settings_fail_closed_without_secret_errors(changes):
    with pytest.raises(ValueError) as error:
        workflow_preflight.parse_environment(workflow_environment(**changes))
    assert 'do-not-print' not in str(error.value)


@pytest.mark.parametrize('key', ['PUBLISHING_ENCRYPTION_KEY', 'LIVE_WEBHOOK_SECRET', 'PUSH_EXPO_ACCESS_TOKEN',
                                   'PUSH_WEB_ALLOWED_ORIGINS', 'OS_WORKFLOW_ENABLED', 'NODE_OPTIONS', 'AWS_SESSION_TOKEN'])
def test_optional_workflow_file_rejects_unrelated_secrets_and_runtime_overrides(key):
    with pytest.raises(ValueError):
        workflow_preflight.parse_environment(workflow_environment() + f'\n{key}=do-not-print')


def test_optional_workflow_file_requires_unique_bounded_explicit_flags():
    for content in [workflow_environment() + '\nPUSH_ENABLED=false', workflow_environment(LIVEPEER_API_KEY='x' * 17000),
                    workflow_environment().replace('PUSH_ENABLED=false', ''), workflow_environment(LIVEPEER_API_KEY='x\x00y')]:
        with pytest.raises(ValueError):
            workflow_preflight.parse_environment(content)
    valid = workflow_preflight.parse_environment(workflow_environment(LIVE_RECORDINGS_ENABLED='true',
                                                   LIVEPEER_API_KEY='fixture-only-no-real-key-12345'))
    assert valid['LIVE_RECORDINGS_ENABLED'] == 'true'


def test_optional_workflow_webpush_accepts_bounded_real_p256_encoding():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
    values = workflow_preflight.parse_environment(workflow_environment(PUSH_ENABLED='true',
        PUSH_ENCRYPTION_KEY=encode(b'x' * 32),
        PUSH_VAPID_PRIVATE_KEY=encode(key.private_bytes(serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption())),
        PUSH_VAPID_PUBLIC_KEY=encode(key.public_key().public_bytes(serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint))))
    assert values['PUSH_ENABLED'] == 'true'


def test_workflow_package_has_separate_optional_credentials_and_bounded_writable_scratch():
    service = json.loads((PACKAGE / 'workflow-compose.json').read_text())['services']['workflow-worker']
    assert service['env_file'] == [
        {'path': '/etc/ziipa/render-worker.env', 'required': True, 'format': 'raw'},
        {'path': '/etc/ziipa/workflow-worker.env', 'required': False, 'format': 'raw'}]
    assert service['environment']['OS_WORKFLOW_ENABLED'] == 'true'
    assert service['environment']['RENDER_WORK_DIR'] == '/tmp/ziipa-workflows'
    assert not workflow_preflight.FLAGS.intersection(service['environment'])  # No shadowing optional feature choices.
    assert service['environment']['TRANSCRIPTION_ENABLED'] == 'false'
    assert 'PUSH_EXPO_ENABLED' not in service['environment']  # Optional file must not be shadowed.
    assert service['environment']['OS_ASSISTANT_LOCAL_AI_ENABLED'] == 'false'
    assert service['mem_limit'] == service['memswap_limit'] == '512m' and service['cpus'] == '0.25'
    assert service['platform'] == 'linux/arm64' and service['pull_policy'] == 'never'
    assert 'size=134217728' in service['tmpfs'][0] and 'noexec' in service['tmpfs'][0]
    assert render.MAX_INPUT_BYTES + 16 * 1024**2 < 128 * 1024**2  # One import; rendering uses the other worker.
    assert service['read_only'] and service['user'] == '10001:10001'
    assert not any(key in service for key in ('ports', 'expose', 'volumes', 'privileged', 'network_mode'))
    assert service['cap_drop'] == ['ALL'] and service['security_opt'] == ['no-new-privileges:true']
    unit = (PACKAGE / 'ziipa-workflow-worker.service').read_text()
    assert 'workflow-preflight.py' in unit and '--no-build --pull never' in unit
    assert '--timeout 300' in unit and 'TimeoutStopSec=330' in unit
    assert 'EnvironmentFile=' not in unit and 'StartLimitBurst=3' in unit


@pytest.mark.parametrize('has_file', [False, True])
def test_workflow_preflight_preserves_missing_file_default_and_reuses_protected_storage_checks(monkeypatch, tmp_path, capsys, has_file):
    optional = tmp_path / 'workflow-worker.env'
    if has_file:
        optional.write_text(workflow_environment())
    validate = Mock()
    capture = Mock(return_value='Storage preflight passed.')
    monkeypatch.setattr(workflow_preflight.storage_preflight, 'validate_secret_file', validate)
    monkeypatch.setattr(workflow_preflight.storage_preflight, 'capture', capture)
    monkeypatch.setattr(workflow_preflight.sys, 'argv', ['workflow-preflight.py', '--env-file', str(optional)])
    original = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *args, **kwargs: 'MemTotal: 4194304 kB\n' if str(path).replace('\\', '/') == '/proc/meminfo' else original(path, *args, **kwargs))
    assert workflow_preflight.main() == 0
    assert validate.call_count == int(has_file)
    capture.assert_called_once()
    assert capture.call_args.args[0][-2:] == ['--env-file', str(Path('/etc/ziipa/render-worker.env'))]
    assert ('new features disabled' in capsys.readouterr().out) is not has_file


def test_workflow_preflight_protected_file_failure_is_sanitized(monkeypatch, tmp_path, capsys):
    optional = tmp_path / 'workflow-worker.env'
    optional.write_text(workflow_environment())
    monkeypatch.setattr(workflow_preflight.sys, 'argv', ['workflow-preflight.py', '--env-file', str(optional)])
    monkeypatch.setattr(workflow_preflight.storage_preflight, 'validate_secret_file', Mock(side_effect=ValueError('do-not-print')))
    capture = Mock()
    monkeypatch.setattr(workflow_preflight.storage_preflight, 'capture', capture)
    assert workflow_preflight.main() == 1
    capture.assert_not_called()
    output = capsys.readouterr()
    assert 'do-not-print' not in output.out + output.err


@pytest.mark.skipif(os.environ.get('ZIIPA_ORACLE_WORKFLOW_RESOURCE_TEST') != '1', reason='Opt-in 100 MiB private workflow import acceptance')
def test_maximum_recording_import_fits_workflow_scratch_with_mocked_r2(recording_harness, runtime, monkeypatch, tmp_path):
    """Real MP4/probe and 100 MiB allocation; no network or provider mutation."""
    import live_recordings as recordings
    import live_recordings_worker as imports
    from creator import CreatorItem, CreatorMedia
    from sqlalchemy import select
    from test_live_recordings import REAL_PROBE, consent, send
    h = recording_harness
    ffmpeg, _ = runtime
    seed_dir = tmp_path / 'seed'
    seed_dir.mkdir()
    render._run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1',
        '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=6:d=46', '-c:v', 'libx264',
        '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-f', 'mp4', 'seed.mp4'], seed_dir, 30)
    seed = (seed_dir / 'seed.mp4').read_bytes()
    h.asset['size'] = recordings.MAX_BYTES
    h.asset['hash'] = []
    consent(h, clip_seconds=15)
    assert send(h).status_code == 200
    monkeypatch.setattr(render, '_probe', REAL_PROBE)
    stored = []
    def store(**kwargs):
        assert kwargs['ContentType'] == 'video/mp4' and len(kwargs['Body']) == recordings.MAX_BYTES
        assert all(not value.is_file() or value.stat().st_size <= recordings.MAX_BYTES for value in Path(render.config.work_dir).rglob('*'))
        stored.append((kwargs['Key'], hashlib.sha256(kwargs['Body']).hexdigest()))
    fake_r2 = SimpleNamespace(bucket='fixture-private', delete=lambda owner_id, media_id: None)
    monkeypatch.setattr(imports, 'storage', lambda: fake_r2)
    monkeypatch.setattr(render, '_r2_client', lambda: SimpleNamespace(put_object=store))
    def fetch(url, path):
        assert url == h.asset['downloadUrl']
        remainder = recordings.MAX_BYTES - len(seed)
        with path.open('wb') as output:
            output.write(seed)
            output.write(struct.pack('>I4s', remainder, b'free'))
            left = remainder - 8
            chunk = bytes(64 * 1024)
            while left:
                count = min(left, len(chunk))
                output.write(chunk[:count]); left -= count
        with path.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        return path.stat().st_size, digest
    with h.factory() as session:
        claimed = imports.claim(session)
    assert claimed
    started = time.monotonic()
    imports.import_source(h.factory, *claimed, fetch=fetch)
    h.session.expire_all()
    row = h.session.scalar(select(recordings.LiveRecording))
    assert row.size == recordings.MAX_BYTES and row.sha256 == stored[0][1]
    assert len(stored) == 1 and len(row.clips) == 3
    assert h.session.get(CreatorMedia, row.media_id).size == recordings.MAX_BYTES
    assert all(item.visibility == 'draft' for item in h.session.scalars(select(CreatorItem)))
    assert all(method == 'GET' for method, _ in h.calls)
    assert not list(Path(render.config.work_dir).glob('recording-*'))
    print(f'Private workflow acceptance: {time.monotonic() - started:.2f}s, {row.size} source bytes; mocked R2, no provider mutations')
    peak = Path('/sys/fs/cgroup/memory.peak')
    if peak.exists():
        print(f'Whole-container memory peak: {peak.read_text().strip()} bytes')
