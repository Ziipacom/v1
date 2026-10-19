"""Independent workflow deployment contract: no provisioning or credential reads."""
import json
from pathlib import Path


PACKAGE = Path(__file__).resolve().parents[1] / 'deploy' / 'oracle-free'


def test_workflow_service_is_bounded_private_and_uses_existing_reviewed_image():
    manifest = json.loads((PACKAGE / 'workflow-compose.json').read_text())
    renderer = json.loads((PACKAGE / 'compose.json').read_text())
    assert manifest['name'] != renderer['name']
    assert set(manifest['services']) == {'workflow-worker'}
    service = manifest['services']['workflow-worker']
    assert service['image'] == renderer['services']['render-worker']['image']
    assert service['platform'] == 'linux/arm64' and service['pull_policy'] == 'never'
    assert service['command'] == ['python', 'workflow_worker.py']
    # Storage credentials keep their existing boundary; optional provider/push
    # settings belong only to the separately preflighted workflow container.
    assert service['env_file'][:1] == renderer['services']['render-worker']['env_file']
    assert service['env_file'][1:] == [
        {'path': '/etc/ziipa/workflow-worker.env', 'required': False, 'format': 'raw'}]
    assert all(value['path'] != '/etc/ziipa/workflow-worker.env'
               for value in renderer['services']['render-worker']['env_file'])
    assert service['user'] == '10001:10001' and service['read_only'] is True
    assert service['cap_drop'] == ['ALL'] and service['security_opt'] == ['no-new-privileges:true']
    assert not set(service) & {'ports', 'expose', 'volumes', 'privileged', 'network_mode', 'build'}
    assert service['cpus'] == '0.25' and service['mem_limit'] == service['memswap_limit'] == '512m'
    assert service['pids_limit'] <= 64
    assert 'size=134217728' in service['tmpfs'][0] and 'noexec' in service['tmpfs'][0]
    assert 'nosuid' in service['tmpfs'][0] and 'nodev' in service['tmpfs'][0]


def test_workflow_settings_contain_only_operational_flags_and_no_secret_grants():
    service = json.loads((PACKAGE / 'workflow-compose.json').read_text())['services']['workflow-worker']
    environment = service['environment']
    assert environment['ENVIRONMENT'] == 'production'
    assert environment['MEDIA_STORAGE_BACKEND'] == 'r2'
    assert environment['OS_WORKFLOW_ENABLED'] == environment['RENDER_ENABLED'] == 'true'
    assert int(environment['OS_WORKFLOW_POLL_SECONDS']) == 60
    assert environment['WEB3_ENABLE_LOCAL'] == environment['ENABLE_DEMO_CATALOG'] == 'false'
    assert environment['OS_ASSISTANT_LOCAL_AI_ENABLED'] == 'false'
    assert not any(part in name for name in environment for part in ('SECRET', 'PASSWORD', 'TOKEN', 'KEY'))
    assert not any('${' in value for value in environment.values())


def test_workflow_unit_supervision_cannot_start_or_stop_the_render_project():
    unit = (PACKAGE / 'ziipa-workflow-worker.service').read_text()
    assert '/usr/bin/python3 /opt/ziipa/deploy/oracle-free/workflow-preflight.py' in unit
    assert '-f workflow-compose.json up --no-build --pull never' in unit
    assert '--exit-code-from workflow-worker' in unit
    assert '-f workflow-compose.json stop --timeout 300 workflow-worker' in unit
    assert '-f compose.json' not in unit and 'EnvironmentFile=' not in unit
    assert 'StartLimitBurst=3' in unit and 'RestartSec=60' in unit and 'TimeoutStopSec=330' in unit
    assert 'UMask=0077' in unit
