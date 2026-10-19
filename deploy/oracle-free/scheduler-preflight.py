"""Offline checks for the limited native AMD64 Micro calendar/Web Push profile.

No providers, network requests, secret transfers or automatic migrations.
The existing A1/media worker resource and secret boundaries are unchanged.
"""
from __future__ import annotations

import argparse
import hmac
import importlib.util
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

sys.dont_write_bytecode = True

PACKAGE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('ziipa_scheduler_storage_checks', PACKAGE / 'preflight.py')
checks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checks)
SPEC = importlib.util.spec_from_file_location('ziipa_scheduler_push_checks', PACKAGE / 'workflow-preflight.py')
push_checks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(push_checks)
SPEC = importlib.util.spec_from_file_location('ziipa_scheduler_profiles', PACKAGE / 'scheduler-profiles.py')
profiles = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(profiles)

REQUIRED = frozenset({'DATABASE_URL', 'REDIS_URL', 'PUSH_ENABLED'})
OPTIONAL = push_checks.PUSH_KEYS | {'PUSH_VAPID_SUBJECT', 'PUSH_EXPO_ENABLED', 'PUSH_EXPO_ACCESS_TOKEN'}
IMAGE = 'ziipa-scheduler:oracle-amd64'
IMAGE_RECEIPT = Path('/etc/ziipa/scheduler-image.sha256')


def accepted_image(path):
    """An operator installs this ID only after native acceptance of that image."""
    checks.validate_secret_file(path)
    with path.open('rb') as stream:
        value = stream.read(80)
    if not re.fullmatch(rb'sha256:[0-9a-f]{64}\n?', value):
        raise ValueError('Install one exact accepted immutable scheduler image ID in the protected receipt.')
    return value.rstrip(b'\n').decode('ascii')


def parse_environment(contents):
    if not isinstance(contents, str) or len(contents.encode('utf-8')) > 16384 or '\x00' in contents:
        raise ValueError('The limited scheduler settings file is invalid.')
    values = {}
    for line in contents.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if (not separator or key not in REQUIRED | OPTIONAL or key in values
                or value != value.strip() or value.startswith(('"', "'"))
                or any(ord(char) < 32 or ord(char) > 126 for char in value)):
            raise ValueError('Use only unique literal supported scheduler settings; other credentials are forbidden.')
        values[key] = value
    if not REQUIRED <= values.keys() or values['PUSH_ENABLED'] not in {'true', 'false'}:
        raise ValueError('Explicit TLS connections and a push flag are required.')
    try:
        database, redis = (urlsplit(values[key]) for key in ('DATABASE_URL', 'REDIS_URL'))
        database.port, redis.port
        if (database.scheme not in {'postgresql', 'postgresql+psycopg'} or not database.hostname
                or not database.username or not database.password or not database.path.strip('/')
                or parse_qs(database.query).get('sslmode') not in [['require'], ['verify-ca'], ['verify-full']]
                or database.fragment or redis.scheme != 'rediss' or not redis.hostname or not redis.password
                or redis.query or redis.fragment or (redis.path and not re.fullmatch(r'/[0-9]+', redis.path))):
            raise ValueError()
        # Reuse only the reviewed Web Push encoding/format checks, never its
        # eight-key media storage file or provider/recording credentials.
        push_checks.parse_environment('\n'.join([
            'OS_CALENDAR_ENABLED=true', 'CREATION_CAMPAIGN_ENABLED=false',
            'LIVE_RECORDINGS_ENABLED=false', 'SOCIAL_PUBLIC_SYNC_ENABLED=false',
            *[key + '=' + value for key, value in values.items() if key not in {'DATABASE_URL', 'REDIS_URL'}],
        ]))
    except (ValueError, IndexError):
        raise ValueError('Use valid TLS PostgreSQL/Redis and complete dedicated Web Push settings when enabled.') from None
    return values


def validate_image(metadata, expected_id=None):
    if (metadata.get('Os') != 'linux' or metadata.get('Architecture') != 'amd64'
            or metadata.get('Config', {}).get('User') not in {'ziipa', '10001', '10001:10001'}):
        raise ValueError('Build the reviewed unprivileged native AMD64 scheduler image first.')
    if expected_id is not None:
        actual = metadata.get('Id')
        if (not isinstance(actual, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', actual)
                or not hmac.compare_digest(actual, expected_id)):
            raise ValueError('The configured scheduler alias does not identify the exact natively accepted image.')


def validate_capacity(memory, name=profiles.DEFAULT_PROFILE):
    limits = profiles.profile(name)
    values = dict((key, int(value) * 1024) for key, value in re.findall(
        r'^(MemTotal|MemAvailable):\s+(\d+) kB$', memory, re.MULTILINE))
    if (values.get('MemTotal', 0) < limits['minimum_total_bytes']
            or values.get('MemAvailable', 0) < limits['required_available_bytes']):
        raise ValueError('The selected fixed scheduler profile lacks its required total/available RAM and OS reserve.')


def refuse_coexisting_workers(name):
    opposite = 'ziipa-scheduler-compact-worker.service' if name == 'standard384' else 'ziipa-scheduler-worker.service'
    for unit in (opposite, 'ziipa-workflow-worker.service', 'ziipa-render-worker.service',
                 'ziipa-agent-worker.service', 'ziipa-agent-worker-small.service'):
        active = subprocess.run(['/usr/bin/systemctl', 'is-active', unit],
            capture_output=True, text=True, timeout=10, check=False)
        if active.returncode not in (3, 4) or active.stdout.strip() not in ('inactive', 'failed', 'unknown'):
            raise ValueError('Another Ziipa worker is active; never stop it implicitly to select a Micro profile.')
    running = checks.capture(['/usr/bin/docker', 'ps', '--format', '{{.Names}}'])
    if any(term in running for term in ('scheduler-worker', 'workflow-worker', 'render-worker', 'agent-worker')):
        raise ValueError('Keep every Ziipa worker container stopped before choosing this Micro profile.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=Path('/etc/ziipa/scheduler-worker.env'))
    parser.add_argument('--image-receipt', type=Path, default=IMAGE_RECEIPT)
    parser.add_argument('--profile', choices=tuple(profiles.PROFILES), default=profiles.DEFAULT_PROFILE)
    args = parser.parse_args()
    try:
        if platform.system() != 'Linux' or platform.machine().lower() not in {'x86_64', 'amd64'}:
            raise ValueError('This profile requires native Linux AMD64, not emulation.')
        # Refuse coexistence; never use systemd Conflicts= to implicitly stop a
        # preserved workflow/render service merely because this unit was tried.
        refuse_coexisting_workers(args.profile)
        checks.validate_secret_file(args.env_file)
        parse_environment(args.env_file.read_text(encoding='utf-8'))
        expected_id = accepted_image(args.image_receipt)
        validate_capacity(Path('/proc/meminfo').read_text(), args.profile)
        if shutil.disk_usage('/var/lib/docker').free < 3 * 1024**3:
            raise ValueError('Keep at least 3 GiB free on the existing boot disk; never add a paid disk automatically.')
        version = checks.capture(['/usr/bin/docker', 'compose', 'version', '--short'])
        match = re.match(r'^v?(\d+)\.(\d+)', version)
        if not match or tuple(map(int, match.groups())) < (2, 30):
            raise ValueError('Compose 2.30+ is required for literal raw environment settings.')
        images = json.loads(checks.capture(['/usr/bin/docker', 'image', 'inspect', IMAGE]))
        if not isinstance(images, list) or len(images) != 1:
            raise ValueError('The reviewed scheduler image is unavailable.')
        validate_image(images[0], expected_id)
        if args.profile == 'compact256':
            # A legacy 384MiB/image-only receipt cannot authorize compact mode.
            profiles.read_receipt(args.profile, expected_id, profiles.test_sha256())
    except (ValueError, OSError, UnicodeError, subprocess.SubprocessError):
        print('Limited Micro scheduler preflight failed. Check native AMD64 capacity, Docker, the protected accepted-image receipt and its root-only configuration. No providers were contacted.', file=sys.stderr)
        return 1
    print('Limited Micro scheduler offline preflight passed. Native resource and owner-consented Web Push acceptance are still required.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
