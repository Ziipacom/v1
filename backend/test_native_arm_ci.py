"""Keep native CI acceptance free, isolated, and independent of cloud credentials."""
from pathlib import Path
import shlex

import pytest
import yaml


WORKFLOW = Path(__file__).resolve().parents[1] / '.github' / 'workflows' / 'ci.yml'
DOCUMENT = yaml.safe_load(WORKFLOW.read_text(encoding='utf-8'))
JOB = DOCUMENT['jobs']['native-arm-worker']
IMAGE = 'ziipa-native-arm-ci'
RUNTIME_STEPS = [step for step in JOB['steps'] if 'docker run ' in step.get('run', '')]


def runtime_command(step):
    """Parse Docker's arguments separately from the shell's log/skip checks."""
    script = step['run'].replace('\\\n', ' ')
    line = next(line for line in script.splitlines() if line.strip().startswith('docker run '))
    tokens = shlex.split(line)
    tokens = tokens[:tokens.index('|')] if '|' in tokens else tokens
    image_index = tokens.index(IMAGE)
    options = {}
    position = 2
    while position < image_index:
        key = tokens[position]
        assert key.startswith('-'), f'Unexpected Docker argument: {key}'
        if key in {'--rm', '--read-only'}:
            options.setdefault(key, []).append(True)
            position += 1
        else:
            options.setdefault(key, []).append(tokens[position + 1])
            position += 2
    return options, tokens[image_index + 1:]


def test_native_arm_job_is_public_only_and_has_no_write_or_persistent_credentials():
    condition = JOB['if']
    assert "github.event.repository.visibility == 'public'" in condition
    assert 'github.event.repository.private == false' in condition
    assert '&&' in condition and '||' not in condition
    assert JOB['runs-on'] == 'ubuntu-24.04-arm'
    assert 0 < JOB['timeout-minutes'] <= 30
    assert JOB['permissions'] == {'contents': 'read'}
    assert 'environment' not in JOB and 'services' not in JOB
    checkout, = [step for step in JOB['steps'] if step.get('uses', '').startswith('actions/checkout@')]
    assert checkout['with']['persist-credentials'] is False
    serialized = yaml.safe_dump(JOB)
    assert 'secrets.' not in serialized and 'id-token' not in serialized
    assert 'setup-qemu' not in serialized and 'self-hosted' not in serialized
    assert 'continue-on-error' not in serialized


@pytest.mark.parametrize('step', RUNTIME_STEPS, ids=lambda step: step['name'])
def test_native_runtime_cannot_reach_providers_or_host_credentials(step):
    options, command = runtime_command(step)
    required = {'--rm': [True], '--network': ['none'], '--read-only': [True],
                '--user': ['10001:10001'], '--cap-drop': ['ALL'],
                '--security-opt': ['no-new-privileges']}
    for key, value in required.items():
        assert options[key] == value
    assert set(options) == set(required) | {
        '--cpus', '--memory', '--memory-swap', '--pids-limit', '--tmpfs', '--mount', '-e'}
    assert options['--memory'] == options['--memory-swap']  # No swap above the cap.
    for mount in options['--mount']:
        fields = dict(part.split('=', 1) if '=' in part else (part, True) for part in mount.split(','))
        assert fields['type'] == 'bind' and fields['readonly'] is True
        assert set(fields) == {'type', 'source', 'target', 'readonly'}
        if fields['target'] == '/deploy/oracle-free':
            assert fields['source'] == '$PWD/deploy/oracle-free'
        else:
            name = fields['target'].removeprefix('/app/')
            assert name.startswith('test_') and name.endswith('.py') and '/' not in name
            assert fields['source'] == '$PWD/backend/' + name
    environment = dict(value.split('=', 1) for value in options['-e'])
    assert environment.pop('DATABASE_URL') == 'sqlite://'
    assert environment.pop('REDIS_URL') == 'redis://127.0.0.1:6379/0'
    assert environment.pop('ENVIRONMENT') == 'test'
    assert set(environment) <= {'ZIIPA_RENDER_RESOURCE_TEST', 'ZIIPA_ORACLE_WORKFLOW_RESOURCE_TEST'}
    assert all(value == '1' for value in environment.values())
    assert command[:3] == ['python', '-m', 'pytest']
    assert '--basetemp=/tmp/acceptance' in command and 'no:cacheprovider' in command
    assert 'set -euo pipefail' in step['run']
    assert "! grep -Eq '[0-9]+ skipped'" in step['run']
    assert 0 < step['timeout-minutes'] <= 10


def test_native_acceptance_requires_both_real_resource_checks_and_protocol_suite():
    assert len(RUNTIME_STEPS) == 3
    parsed = [runtime_command(step) for step in RUNTIME_STEPS]
    render_options, render_command = parsed[0]
    assert render_options['--cpus'] == ['1']
    assert render_options['--memory'] == ['1g']
    assert render_options['--pids-limit'] == ['128']
    assert render_options['--tmpfs'] == ['/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777']
    assert 'ZIIPA_RENDER_RESOURCE_TEST=1' in render_options['-e']
    assert 'test_rendering.py' in render_command and '-k' not in render_command
    for options, _ in parsed[1:]:
        assert options['--cpus'] == ['0.25']
        assert options['--memory'] == ['512m']
        assert options['--pids-limit'] == ['64']
        assert options['--tmpfs'] == ['/tmp:rw,noexec,nosuid,nodev,size=134217728,mode=1777']
    import_options, import_command = parsed[1]
    assert 'ZIIPA_ORACLE_WORKFLOW_RESOURCE_TEST=1' in import_options['-e']
    assert 'test_oracle_deployment.py' in import_command
    assert import_command[import_command.index('-k') + 1] == 'maximum_recording_import'
    _, protocol_command = parsed[2]
    assert {'test_live_recordings.py', 'test_notifications.py',
            'test_notification_integration.py', 'test_recording_readiness.py'} <= set(protocol_command)
    assert '-k' not in protocol_command


def test_native_image_is_built_from_the_production_dockerfile_without_emulation():
    build, = [step for step in JOB['steps'] if 'docker build ' in step.get('run', '')]
    script = build['run']
    assert '$(uname -m)' in script and 'aarch64|arm64' in script
    assert '--platform linux/arm64' in script
    assert '--file backend/Dockerfile backend' in script
    assert 'org.opencontainers.image.revision=$GITHUB_SHA' in script
    assert "--format '{{.Architecture}}'" in script and '= arm64' in script
    assert 0 < build['timeout-minutes'] <= 15
