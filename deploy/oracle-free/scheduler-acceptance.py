"""Run synthetic scheduler acceptance under the exact Micro container limits.

No provider/network access, live environment files, Docker socket mounts, real
devices, migrations, service activation or production database operations.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import uuid

sys.dont_write_bytecode = True
PACKAGE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('ziipa_scheduler_acceptance_profiles', PACKAGE / 'scheduler-profiles.py')
profiles = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(profiles)


IMAGE = 'ziipa-scheduler:oracle-amd64'
BOUND_BYTES = 384 * 1024 * 1024
FIXED_FLAGS = ('RENDER_ENABLED', 'OS_WORKFLOW_ENABLED', 'CREATION_CAMPAIGN_ENABLED',
    'LIVE_RECORDINGS_ENABLED', 'TRANSCRIPTION_ENABLED', 'OS_AGENT_ENABLED',
    'OS_ASSISTANT_LOCAL_AI_ENABLED', 'SOCIAL_PUBLIC_SYNC_ENABLED', 'PUSH_EXPO_ENABLED')


def command(image, test_file, name=None, *, profile_name=profiles.DEFAULT_PROFILE):
    limits = profiles.profile(profile_name)
    memory_mib = limits['memory_limit_bytes'] // profiles.MIB
    script = """import json, os, pathlib, shutil, sys, time
started=time.monotonic()
root=pathlib.Path('/sys/fs/cgroup')
assert (root/'memory.max').read_text().strip()=='__MEMORY_BYTES__'
assert (root/'memory.swap.max').read_text().strip()=='0'
quota,period=map(int,(root/'cpu.max').read_text().split())
assert quota==__CPU_QUOTA__ and period==100000
assert (root/'pids.max').read_text().strip()=='48'
assert os.statvfs('/tmp').f_blocks*os.statvfs('/tmp').f_frsize==33554432
assert shutil.which('ffmpeg') is None and shutil.which('node') is None
assert not pathlib.Path('/app/.env').exists()
import scheduler_worker
scheduler_worker.validate_runtime()
import pytest
code=pytest.main(['/acceptance/test_scheduler_worker.py','-q','--tb=short','-p','no:cacheprovider','--basetemp=/tmp/pytest'])
peak=int((root/'memory.peak').read_text())
print(json.dumps({'acceptance':'limited_calendar_push','profile':'__PROFILE__','memory_peak_bytes':peak,'memory_limit_bytes':__MEMORY_BYTES__,'elapsed_seconds':round(time.monotonic()-started,2)}))
assert peak<__PEAK_BYTES__, 'Insufficient container memory headroom'
sys.exit(code)
"""
    script = script.replace('__MEMORY_BYTES__', str(limits['memory_limit_bytes'])).replace(
        '__PEAK_BYTES__', str(limits['memory_peak_limit_bytes'])).replace('__PROFILE__', profile_name).replace(
        '__CPU_QUOTA__', str(limits['cpu_quota']))
    result = ['docker', 'run', '--rm', '--pull=never', '--platform=linux/amd64',
        '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true', '--cpus=' + str(limits['cpu_quota'] / limits['cpu_period']), '--memory=' + str(memory_mib) + 'm',
        '--memory-swap=' + str(memory_mib) + 'm', '--pids-limit=48', '--shm-size=8m', '--ulimit=core=0',
        '--ulimit=nofile=128:128', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=33554432,mode=1777',
        '--mount', f'type=bind,src={test_file},dst=/acceptance/test_scheduler_worker.py,readonly',
        '--env=DATABASE_URL=sqlite://', '--env=REDIS_URL=redis://127.0.0.1:1/0',
        '--env=ENVIRONMENT=test', '--env=ENABLE_DEMO_CATALOG=false', '--env=WEB3_ENABLE_LOCAL=false',
        '--env=SCHEDULER_ENABLED=true', '--env=OS_CALENDAR_ENABLED=true', '--env=PUSH_ENABLED=false',
        '--env=PYTEST_DISABLE_PLUGIN_AUTOLOAD=1', '--env=PYTHONPATH=/app', '--env=UPLOADS_DIR=/tmp/unused']
    result.extend('--env=' + flag + '=false' for flag in FIXED_FLAGS)
    if name:
        result.extend(['--name', name, '--label=ziipa.purpose=micro-offline-acceptance'])
    result.extend([image, 'python', '-c', script])
    return result


def immutable_image(image):
    result = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
        capture_output=True, text=True, timeout=20, check=True)
    identifier = result.stdout.strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', identifier):
        raise ValueError('The local scheduler image ID is invalid.')
    return identifier


def native_capacity(name):
    limits = profiles.profile(name)
    memory = dict((key, int(value) * 1024) for key, value in re.findall(
        r'^(MemTotal|MemAvailable):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.MULTILINE))
    if (memory.get('MemTotal', 0) < limits['minimum_total_bytes']
            or memory.get('MemAvailable', 0) < limits['required_available_bytes']):
        raise ValueError('Insufficient native host memory for this fixed profile and its OS reserve.')


def refuse_worker_activity():
    for unit in ('ziipa-scheduler-worker.service', 'ziipa-scheduler-compact-worker.service',
                 'ziipa-workflow-worker.service', 'ziipa-render-worker.service',
                 'ziipa-agent-worker.service', 'ziipa-agent-worker-small.service'):
        active = subprocess.run(['/usr/bin/systemctl', 'is-active', unit],
            capture_output=True, text=True, timeout=10, check=False)
        if active.returncode not in (3, 4) or active.stdout.strip() not in ('inactive', 'failed', 'unknown'):
            raise ValueError('Keep every Ziipa worker unit inactive during native acceptance, including restart backoff.')
    result = subprocess.run(['docker', 'ps', '--format', '{{.Names}}'],
        capture_output=True, text=True, timeout=20, check=True)
    if any(term in result.stdout for term in ('scheduler-worker', 'workflow-worker', 'render-worker', 'agent-worker')):
        raise ValueError('Keep every Ziipa worker container stopped during native acceptance.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default=IMAGE)
    parser.add_argument('--profile', choices=tuple(profiles.PROFILES), default=profiles.DEFAULT_PROFILE)
    parser.add_argument('--record-native-receipt', action='store_true',
        help='Root-only, create-only protected profile receipt after this real native test passes.')
    parser.add_argument('--desktop-review', action='store_true',
        help='Allow a local Docker Desktop rehearsal; NEVER counts as native Oracle acceptance.')
    args = parser.parse_args()
    if not re.fullmatch(r'ziipa-scheduler:[A-Za-z0-9_.-]{1,100}', args.image):
        raise SystemExit('Use an existing explicitly named Ziipa scheduler image; no image pulls are performed.')
    if not args.desktop_review and (platform.system() != 'Linux' or platform.machine().lower() not in {'x86_64', 'amd64'}):
        raise SystemExit('Native Linux AMD64 acceptance is required; --desktop-review is rehearsal only.')
    if args.desktop_review and args.record_native_receipt:
        raise SystemExit('A Desktop rehearsal can never create a native acceptance receipt.')
    test_file = Path(__file__).resolve().parents[2] / 'backend' / 'test_scheduler_worker.py'
    if not test_file.is_file() or test_file.is_symlink():
        raise SystemExit('The reviewed synthetic acceptance test file is missing.')
    name = 'ziipa-micro-acceptance-' + uuid.uuid4().hex
    lease = ExitStack()
    try:
        if not args.desktop_review:
            # Public CI may run without root and produces no protected receipt.
            # Root production acceptance shares the exact systemd lock, so a
            # concurrent service start cannot race the idle/resource checks.
            if os.geteuid() == 0:
                lease.enter_context(profiles.native_lock())
            native_capacity(args.profile)
            refuse_worker_activity()
        if args.record_native_receipt:
            profiles.prepare_record(args.profile)
        test_hash = profiles.test_sha256(test_file)
        profile_hash = profiles.source_sha256(args.profile)
        # Run the immutable ID, not the mutable alias. Retagging during the test
        # cannot make the operator record a different, untested image afterward.
        identifier = immutable_image(args.image)
        result = subprocess.run(command(identifier, str(test_file.resolve()), name,
            profile_name=args.profile), timeout=180, check=False)
    except (OSError, subprocess.SubprocessError, ValueError):
        # Remove only this invocation's random-named synthetic container. A timed
        # out docker client otherwise does not necessarily stop its guest.
        try:
            subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=20, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        lease.close()
        raise SystemExit('Limited scheduler acceptance failed or exceeded 180 seconds. No service was started.') from None
    if result.returncode:
        lease.close()
        return 1
    try:
        if profiles.test_sha256(test_file) != test_hash or profiles.source_sha256(args.profile) != profile_hash:
            raise ValueError('The acceptance test source changed while testing.')
        if args.record_native_receipt:
            profiles.write_receipt(args.profile, identifier, test_hash)
    except (OSError, ValueError):
        lease.close()
        raise SystemExit('Acceptance receipt was not written. Preserve existing receipts and re-review the exact source.') from None
    lease.close()
    print(json.dumps({'accepted_image_id': identifier, 'profile': args.profile,
        'native_acceptance': not args.desktop_review, 'native_receipt_written': args.record_native_receipt,
        'resource_limits': profiles.profile(args.profile), 'acceptance_test_sha256': test_hash,
        'profile_source_sha256': profile_hash}))
    print('Desktop rehearsal only; Oracle native host/OS headroom and opted-in device delivery remain unverified.'
          if args.desktop_review else 'Native limited scheduler acceptance passed; no real provider/device notification was sent.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
