"""Fixed Micro resource profiles and protected native acceptance receipts.

No arbitrary memory overrides, network access, credentials or service actions.
Compatible with Ubuntu22.04's Python3.10 as well as the scheduler image runtime.
"""
from __future__ import annotations

import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import stat
import tempfile


MIB = 1024 * 1024
DEFAULT_PROFILE = 'standard384'
PROFILES = {
    'standard384': {'memory_limit_bytes': 384 * MIB, 'required_available_bytes': 512 * MIB,
        'minimum_total_bytes': 768 * MIB, 'os_reserve_bytes': 128 * MIB,
        'memory_peak_limit_bytes': 350 * MIB, 'cpu_quota': 12500, 'cpu_period': 100000,
        'swap_limit_bytes': 0, 'pids_limit': 48, 'tmpfs_bytes': 32 * MIB},
    'compact256': {'memory_limit_bytes': 256 * MIB, 'required_available_bytes': 384 * MIB,
        'minimum_total_bytes': 768 * MIB, 'os_reserve_bytes': 128 * MIB,
        'memory_peak_limit_bytes': 224 * MIB, 'cpu_quota': 12000, 'cpu_period': 100000,
        'swap_limit_bytes': 0, 'pids_limit': 48, 'tmpfs_bytes': 32 * MIB},
}
CONFIG = Path('/etc/ziipa')
PACKAGE = Path(__file__).resolve().parent
TEST_FILE = PACKAGE.parents[1] / 'backend' / 'test_scheduler_worker.py'
LOCK_FILE = Path('/run/ziipa-scheduler-worker.lock')


def profile(name=DEFAULT_PROFILE):
    if not isinstance(name, str) or name not in PROFILES:
        raise ValueError('Choose one reviewed fixed scheduler resource profile.')
    return dict(PROFILES[name])


def receipt_path(name):
    profile(name)
    return CONFIG / ('scheduler-native-' + name + '.json')


def test_sha256(path=TEST_FILE):
    """Bounded streaming digest; no Python3.11-only hashlib.file_digest."""
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_size > 1024 * 1024:
        raise ValueError('The reviewed scheduler acceptance tests must be a bounded regular file.')
    result, total = hashlib.sha256(), 0
    with path.open('rb') as stream:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > 1024 * 1024:
                raise ValueError('The acceptance test file exceeds its reviewed bound.')
            result.update(chunk)
    return result.hexdigest()


def receipt_payload(name, image_id, test_hash):
    if (not isinstance(image_id, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id)
            or not isinstance(test_hash, str) or not re.fullmatch(r'[0-9a-f]{64}', test_hash)):
        raise ValueError('Require the exact tested immutable image and acceptance-source hash.')
    return {'schema': 2, 'profile': name, 'image_id': image_id,
        'resource_limits': profile(name), 'acceptance_test_sha256': test_hash,
        'profile_source_sha256': source_sha256(name),
        'native_acceptance': True}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def source_sha256(name):
    """Bind the reviewed host profile separately from its immutable runtime image."""
    profile(name)
    names = ['scheduler-profiles.py', 'scheduler-preflight.py', 'scheduler-acceptance.py']
    if name == 'compact256':
        names += ['scheduler-compact-compose.json', 'ziipa-scheduler-compact-worker.service']
    else:
        names += ['scheduler-compose.json', 'ziipa-scheduler-worker.service']
    return hashlib.sha256(canonical({value: test_sha256(PACKAGE / value) for value in names}).encode('ascii')).hexdigest()


def validate_receipt(value, name, image_id, test_hash):
    expected = receipt_payload(name, image_id, test_hash)
    # Canonical JSON also rejects booleans substituted for numeric limits.
    if not isinstance(value, dict) or canonical(value) != canonical(expected):
        raise ValueError('The native receipt does not bind this exact image, profile, limits and test source.')
    return value


def protected(path, *, directory=False, mode=None):
    value = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (not kind(value.st_mode) or value.st_uid != 0 or value.st_gid != 0
            or stat.S_IMODE(value.st_mode) & 0o022
            or mode is not None and stat.S_IMODE(value.st_mode) != mode):
        raise ValueError('Require protected root-owned regular paths without symlinks or peer writes.')
    for parent in path.parents:
        value = parent.lstat()
        if (not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_gid != 0
                or stat.S_IMODE(value.st_mode) & 0o022):
            raise ValueError('Require protected root-owned parent directories.')


def read_receipt(name, image_id, test_hash):
    path = receipt_path(name)
    protected(path, mode=0o600)
    with path.open('rb') as stream:
        raw = stream.read(4097)
    if len(raw) > 4096:
        raise ValueError('The protected native acceptance receipt is oversized.')
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError('The protected native acceptance receipt is malformed.') from None
    return validate_receipt(value, name, image_id, test_hash)


def prepare_record(name):
    """Check only before testing; never accept an existing receipt as a replay."""
    if not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise ValueError('Recording native acceptance requires root on the approved native host.')
    path = receipt_path(name)
    protected(CONFIG.parent, directory=True)
    if os.path.lexists(CONFIG):
        protected(CONFIG, directory=True)
    if os.path.lexists(path):
        raise ValueError('A native receipt already exists. Preserve it; do not overwrite or replay acceptance.')


def write_receipt(name, image_id, test_hash):
    """Called only after the selected native test passes; atomic create-only."""
    prepare_record(name)
    if not os.path.lexists(CONFIG):
        CONFIG.mkdir(mode=0o700)
    protected(CONFIG, directory=True)
    target = receipt_path(name)
    raw = (canonical(receipt_payload(name, image_id, test_hash)) + '\n').encode('ascii')
    descriptor, temporary = tempfile.mkstemp(prefix='.scheduler-acceptance-', dir=CONFIG)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), 0o600)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target, follow_symlinks=False)
        folder = os.open(CONFIG, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(folder)
        finally:
            os.close(folder)
    finally:
        os.unlink(temporary)
    return target


@contextmanager
def native_lock():
    """Same advisory lock as both systemd units; hold throughout native testing."""
    import fcntl
    if os.geteuid() != 0:
        raise ValueError('A production native acceptance lock requires root.')
    protected(LOCK_FILE.parent, directory=True)
    descriptor = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        value = os.fstat(descriptor)
        if (not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or value.st_gid != 0
                or stat.S_IMODE(value.st_mode) != 0o600):
            raise ValueError('The shared scheduler lock must remain root:root0600 and regular.')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)
