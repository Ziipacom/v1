"""Offline Oracle worker checks. Never prints credentials or contacts providers."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit


REQUIRED = frozenset({'DATABASE_URL', 'REDIS_URL', 'R2_ENDPOINT_URL', 'R2_BUCKET_NAME',
                      'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
                      'MEDIA_OWNER_MAX_BYTES', 'MEDIA_PROJECT_MAX_BYTES'})
IMAGE = 'ziipa-render:oracle-arm64'


def parse_environment(contents: str) -> dict[str, str]:
    if len(contents.encode('utf-8')) > 16384 or '\x00' in contents:
        raise ValueError('The worker environment file is invalid or too large.')
    values = {}
    for line in contents.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key not in REQUIRED or key in values:
            raise ValueError('Use each supported worker key exactly once; no other secrets/settings are permitted.')
        if not value or value != value.strip() or value.startswith(('"', "'")):
            raise ValueError('Fill every worker value using literal, unquoted KEY=value syntax.')
        values[key] = value
    if set(values) != REQUIRED:
        raise ValueError('The existing database, Redis, private R2 and strict-free quota settings are all required.')
    try:
        database = urlsplit(values['DATABASE_URL'])
        redis = urlsplit(values['REDIS_URL'])
        r2 = urlsplit(values['R2_ENDPOINT_URL'])
        # Reading .port also rejects malformed ports without exposing the URL.
        ports = (database.port, redis.port, r2.port)
        if database.scheme not in {'postgresql', 'postgresql+psycopg'} or not database.hostname or not database.username or not database.password or not database.path.strip('/'):
            raise ValueError
        sslmode = parse_qs(database.query).get('sslmode', [])
        if len(sslmode) != 1 or sslmode[0] not in {'require', 'verify-ca', 'verify-full'} or database.fragment:
            raise ValueError
        if redis.scheme != 'rediss' or not redis.hostname or not redis.password or redis.query or redis.fragment:
            raise ValueError
        if redis.path and not re.fullmatch(r'/[0-9]+', redis.path):
            raise ValueError
        if r2.scheme != 'https' or not r2.hostname or r2.username or r2.password or r2.query or r2.fragment or r2.path not in {'', '/'} or ports[2] not in {None, 443}:
            raise ValueError
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', values['R2_BUCKET_NAME']):
            raise ValueError
        owner, project = (int(values[key]) for key in ('MEDIA_OWNER_MAX_BYTES', 'MEDIA_PROJECT_MAX_BYTES'))
        if not 0 < owner <= 1024**3 or not owner <= project <= 6 * 1024**3:
            raise ValueError
    except ValueError:
        raise ValueError('Use TLS PostgreSQL, TLS Redis and an HTTPS private R2 endpoint with valid settings.') from None
    return values


def validate_secret_file(path: Path) -> None:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ValueError('The worker environment must be a root-owned regular file with mode 0600 (not a symlink).')
    for parent in path.parents:
        metadata = parent.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o022:
            raise ValueError('The worker environment must be inside root-owned directories without group/world write access.')


def capture(command: list[str]) -> str:
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise ValueError('The required local Docker command failed; check Docker and the reviewed local image.') from None


def validate_image(metadata: dict) -> None:
    if metadata.get('Os') != 'linux' or metadata.get('Architecture') != 'arm64' or metadata.get('Config', {}).get('User') not in {'ziipa', '10001', '10001:10001'}:
        raise ValueError('Build the reviewed Linux ARM64 image with the unprivileged Ziipa user before starting.')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=Path('/etc/ziipa/render-worker.env'))
    args = parser.parse_args()
    try:
        if platform.system() != 'Linux' or platform.machine().lower() not in {'aarch64', 'arm64'}:
            raise ValueError('This package targets a native Ubuntu ARM64 Oracle A1 host; do not run an emulated production worker.')
        validate_secret_file(args.env_file)
        parse_environment(args.env_file.read_text(encoding='utf-8'))
        match = re.search(r'^MemTotal:\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.MULTILINE)
        if not match or int(match.group(1)) < 2 * 1024 * 1024:
            raise ValueError('Reserve at least 2 GiB host RAM for the 1 GiB worker plus Ubuntu/Docker; 4 GiB is recommended for builds.')
        if shutil.disk_usage('/var/lib/docker').free < 2 * 1024**3:
            raise ValueError('Keep at least 2 GiB free on the existing Docker/boot disk; do not add paid disks automatically.')
        version = capture(['/usr/bin/docker', 'compose', 'version', '--short'])
        match = re.match(r'^v?(\d+)\.(\d+)', version)
        if not match or tuple(map(int, match.groups())) < (2, 30):
            raise ValueError('Docker Compose 2.30+ is required to preserve literal secret values with raw env_file format.')
        metadata = json.loads(capture(['/usr/bin/docker', 'image', 'inspect', IMAGE]))
        if not isinstance(metadata, list) or len(metadata) != 1:
            raise ValueError('The reviewed local worker image is unavailable.')
        validate_image(metadata[0])
    except (ValueError, OSError):
        # Keep even malformed URL/JSON/library exceptions out of logs: the env
        # parser accepts secret input. Detailed errors are deliberately generic.
        print('Oracle worker preflight failed. Check host architecture/resources, Docker 2.30+, the local ARM64 image, and the root-only TLS environment using README.md. No providers were contacted.', file=sys.stderr)
        return 1
    print('Oracle worker local preflight passed. Runtime will verify migrations, TLS Redis and private R2 access.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
