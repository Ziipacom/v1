"""Run synthetic scheduler acceptance under the exact Micro container limits.

No provider/network access, live environment files, Docker socket mounts, real
devices, migrations, service activation or production database operations.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import re
import subprocess
import sys
import uuid


IMAGE = 'ziipa-scheduler:oracle-amd64'
BOUND_BYTES = 384 * 1024 * 1024
FIXED_FLAGS = ('RENDER_ENABLED', 'OS_WORKFLOW_ENABLED', 'CREATION_CAMPAIGN_ENABLED',
    'LIVE_RECORDINGS_ENABLED', 'TRANSCRIPTION_ENABLED', 'OS_AGENT_ENABLED',
    'OS_ASSISTANT_LOCAL_AI_ENABLED', 'SOCIAL_PUBLIC_SYNC_ENABLED', 'PUSH_EXPO_ENABLED')


def command(image, test_file, name=None):
    script = """import json, pathlib, shutil, sys, time
started=time.monotonic()
root=pathlib.Path('/sys/fs/cgroup')
assert (root/'memory.max').read_text().strip()=='402653184'
assert (root/'memory.swap.max').read_text().strip()=='0'
quota,period=map(int,(root/'cpu.max').read_text().split())
assert quota/period<=0.125
assert shutil.which('ffmpeg') is None and shutil.which('node') is None
assert not pathlib.Path('/app/.env').exists()
import scheduler_worker
scheduler_worker.validate_runtime()
import pytest
code=pytest.main(['/acceptance/test_scheduler_worker.py','-q','--tb=short','-p','no:cacheprovider','--basetemp=/tmp/pytest'])
peak=int((root/'memory.peak').read_text())
print(json.dumps({'acceptance':'limited_calendar_push','memory_peak_bytes':peak,'memory_limit_bytes':402653184,'elapsed_seconds':round(time.monotonic()-started,2)}))
assert peak<350*1024*1024, 'Insufficient container memory headroom'
sys.exit(code)
"""
    result = ['docker', 'run', '--rm', '--pull=never', '--platform=linux/amd64',
        '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true', '--cpus=0.125', '--memory=384m',
        '--memory-swap=384m', '--pids-limit=48', '--shm-size=8m', '--ulimit=core=0',
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default=IMAGE)
    parser.add_argument('--desktop-review', action='store_true',
        help='Allow a local Docker Desktop rehearsal; NEVER counts as native Oracle acceptance.')
    args = parser.parse_args()
    if not re.fullmatch(r'ziipa-scheduler:[A-Za-z0-9_.-]{1,100}', args.image):
        raise SystemExit('Use an existing explicitly named Ziipa scheduler image; no image pulls are performed.')
    if not args.desktop_review and (platform.system() != 'Linux' or platform.machine().lower() not in {'x86_64', 'amd64'}):
        raise SystemExit('Native Linux AMD64 acceptance is required; --desktop-review is rehearsal only.')
    test_file = Path(__file__).resolve().parents[2] / 'backend' / 'test_scheduler_worker.py'
    if not test_file.is_file() or test_file.is_symlink():
        raise SystemExit('The reviewed synthetic acceptance test file is missing.')
    name = 'ziipa-micro-acceptance-' + uuid.uuid4().hex
    try:
        # Run the immutable ID, not the mutable alias. Retagging during the test
        # cannot make the operator record a different, untested image afterward.
        identifier = immutable_image(args.image)
        result = subprocess.run(command(identifier, str(test_file.resolve()), name), timeout=180, check=False)
    except (OSError, subprocess.SubprocessError, ValueError):
        # Remove only this invocation's random-named synthetic container. A timed
        # out docker client otherwise does not necessarily stop its guest.
        try:
            subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=20, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        raise SystemExit('Limited scheduler acceptance failed or exceeded 180 seconds. No service was started.') from None
    if result.returncode:
        return 1
    print(json.dumps({'accepted_image_id': identifier, 'native_acceptance': not args.desktop_review}))
    print('Desktop rehearsal only; Oracle native host/OS headroom and opted-in device delivery remain unverified.'
          if args.desktop_review else 'Native limited scheduler acceptance passed; no real provider/device notification was sent.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
