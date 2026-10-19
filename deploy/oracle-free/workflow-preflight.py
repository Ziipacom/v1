"""Offline optional workflow checks; never prints keys or contacts providers."""
from __future__ import annotations

import argparse
import base64
import importlib.util
from pathlib import Path
import re
import sys


PACKAGE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('ziipa_oracle_storage_preflight', PACKAGE / 'preflight.py')
storage_preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(storage_preflight)

FLAGS = frozenset({'OS_CALENDAR_ENABLED', 'CREATION_CAMPAIGN_ENABLED',
                   'LIVE_RECORDINGS_ENABLED', 'PUSH_ENABLED', 'SOCIAL_PUBLIC_SYNC_ENABLED'})
PUSH_KEYS = frozenset({'PUSH_ENCRYPTION_KEY', 'PUSH_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PUBLIC_KEY'})
OPTIONAL = PUSH_KEYS | {'PUSH_VAPID_SUBJECT', 'LIVEPEER_API_KEY'}


def decoded(value: str, length: int | None = None) -> bytes:
    if not re.fullmatch(r'[A-Za-z0-9_-]+={0,2}', value) or len(value) > 4096:
        raise ValueError('Use a bounded base64url key.')
    result = base64.b64decode(value.rstrip('=') + '=' * (-len(value.rstrip('=')) % 4), altchars=b'-_', validate=True)
    if length is not None and len(result) != length:
        raise ValueError('A workflow key has the wrong size.')
    return result


def parse_environment(contents: str) -> dict[str, str]:
    if len(contents.encode('utf-8')) > 16384 or '\x00' in contents:
        raise ValueError('The workflow settings file is invalid or too large.')
    values = {}
    for line in contents.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key not in FLAGS | OPTIONAL or key in values:
            raise ValueError('Use only unique supported workflow settings; other credentials are forbidden.')
        if value != value.strip() or value.startswith(('"', "'")) or any(ord(char) < 32 or ord(char) > 126 for char in value):
            raise ValueError('Use literal unquoted workflow values without control characters.')
        values[key] = value
    if not FLAGS <= values.keys() or any(values[key] not in {'true', 'false'} for key in FLAGS):
        raise ValueError('All workflow feature flags must be explicit lowercase true or false.')
    live_key = values.get('LIVEPEER_API_KEY', '')
    if live_key and not re.fullmatch(r'[A-Za-z0-9._~-]{20,256}', live_key):
        raise ValueError('The workflow provider key has invalid syntax.')
    if values['LIVE_RECORDINGS_ENABLED'] == 'true' and not live_key:
        raise ValueError('Recording imports require their separately approved workflow provider key.')
    push_present = any(values.get(key, '') for key in PUSH_KEYS)
    if values['PUSH_ENABLED'] == 'true' or push_present:
        try:
            decoded(values.get('PUSH_ENCRYPTION_KEY', ''), 32)
            point = decoded(values.get('PUSH_VAPID_PUBLIC_KEY', ''), 65)
            private = decoded(values.get('PUSH_VAPID_PRIVATE_KEY', ''))
            if point[0] != 4 or not 80 <= len(private) <= 512 or private[0] != 0x30:
                raise ValueError()
            if values.get('PUSH_VAPID_SUBJECT') != 'https://ziipa.com':
                raise ValueError()
        except (ValueError, IndexError):
            raise ValueError('Provide the complete dedicated Web Push keys and Ziipa contact, or leave push disabled and all keys empty.') from None
    elif values.get('PUSH_VAPID_SUBJECT', '') not in {'', 'https://ziipa.com'}:
        raise ValueError('Use the reviewed Ziipa Web Push contact.')
    # This stdlib-only check validates encoding/size. The application verifies
    # actual P256 DER/key-pair agreement before reporting Web Push ready.
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--storage-env-file', type=Path, default=Path('/etc/ziipa/render-worker.env'))
    parser.add_argument('--env-file', type=Path, default=Path('/etc/ziipa/workflow-worker.env'))
    args = parser.parse_args()
    try:
        try:
            args.env_file.lstat()
            has_optional_file = True
        except FileNotFoundError:
            has_optional_file = False
        if has_optional_file:
            storage_preflight.validate_secret_file(args.env_file)
            parse_environment(args.env_file.read_text(encoding='utf-8'))
        # Reuse the existing native ARM, root-only storage/TLS, Docker and image
        # checks without changing the renderer's eight-key permission boundary.
        storage_preflight.capture([sys.executable, str(PACKAGE / 'preflight.py'), '--env-file', str(args.storage_env_file)])
        match = re.search(r'^MemTotal:\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.MULTILINE)
        if not match or int(match.group(1)) < 3 * 1024 * 1024:
            raise ValueError('Reserve room for both bounded workers and the operating system.')
    except (ValueError, OSError, UnicodeError):
        print('Optional workflow preflight failed. Check native ARM resources, the reviewed image, both root-only settings files and explicit feature flags. No providers were contacted.', file=sys.stderr)
        return 1
    state = 'optional settings validated' if has_optional_file else 'new features disabled; no optional settings file'
    print(f'Optional workflow local preflight passed ({state}). Provider credentials and device delivery still require separate acceptance.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
