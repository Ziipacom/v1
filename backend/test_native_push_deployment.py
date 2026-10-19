"""Optional Expo deployment gates. No real credentials or provider requests."""
import base64
import importlib.util
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
import pytest

import app  # Register shared API models before notification modules.
from notification_services import NotificationSettings

PACKAGE = Path(__file__).resolve().parents[1] / 'deploy' / 'oracle-free'


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, PACKAGE / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


workflow = load('workflow-preflight.py', 'native_push_workflow_preflight')
storage = load('preflight.py', 'native_push_storage_preflight')


def values(**changes):
    encode = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip('=')
    key = ec.generate_private_key(ec.SECP256R1())
    result = {name: 'false' for name in workflow.FLAGS}
    result.update(PUSH_ENABLED='true', PUSH_ENCRYPTION_KEY=encode(b'x' * 32),
        PUSH_VAPID_PRIVATE_KEY=encode(key.private_bytes(serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption())),
        PUSH_VAPID_PUBLIC_KEY=encode(key.public_key().public_bytes(serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint)), PUSH_VAPID_SUBJECT='https://ziipa.com')
    result.update(changes)
    return '\n'.join(f'{name}={value}' for name, value in result.items())


def test_old_workflow_file_and_application_default_keep_native_disabled():
    previous = workflow.parse_environment(values())
    assert previous.get('PUSH_EXPO_ENABLED', 'false') == 'false'
    assert previous.get('PUSH_EXPO_ACCESS_TOKEN', '') == ''
    assert NotificationSettings.model_fields['expo_enabled'].default is False
    example = workflow.parse_environment((PACKAGE / 'workflow.env.example').read_text())
    assert example['PUSH_EXPO_ENABLED'] == 'false' and not example['PUSH_EXPO_ACCESS_TOKEN']


def test_explicit_native_opt_in_requires_approved_token_and_all_existing_push_keys():
    result = workflow.parse_environment(values(PUSH_EXPO_ENABLED='true',
        PUSH_EXPO_ACCESS_TOKEN='synthetic-owner-approved-token-' + 'x' * 32))
    assert result['PUSH_EXPO_ENABLED'] == 'true'
    assert not {'LIVE_WEBHOOK_ID', 'LIVE_WEBHOOK_SECRET', 'PUBLISHING_ENCRYPTION_KEY'} & result.keys()


@pytest.mark.parametrize('changes', [
    {'PUSH_EXPO_ENABLED': 'true'}, {'PUSH_EXPO_ENABLED': 'True'},
    {'PUSH_EXPO_ENABLED': 'true', 'PUSH_ENABLED': 'false', 'PUSH_EXPO_ACCESS_TOKEN': 'x' * 40},
    {'PUSH_EXPO_ENABLED': 'true', 'PUSH_EXPO_ACCESS_TOKEN': 'x' * 40, 'PUSH_ENCRYPTION_KEY': ''},
    {'PUSH_EXPO_ENABLED': 'true', 'PUSH_EXPO_ACCESS_TOKEN': 'short'},
    {'PUSH_EXPO_ENABLED': 'true', 'PUSH_EXPO_ACCESS_TOKEN': 'x' * 513},
    {'PUSH_EXPO_ENABLED': 'true', 'PUSH_EXPO_ACCESS_TOKEN': 'invalid bearer token with whitespace'},
    {'PUSH_EXPO_ENABLED': 'false', 'PUSH_EXPO_ACCESS_TOKEN': 'x' * 40},
])
def test_native_activation_fails_closed_without_returning_credential_values(changes):
    with pytest.raises(ValueError) as error:
        workflow.parse_environment(values(**changes))
    assert all(value not in str(error.value) for name, value in changes.items()
        if name == 'PUSH_EXPO_ACCESS_TOKEN' and value)


@pytest.mark.parametrize('name', ['LIVE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'PUBLISHING_TWITCH_CLIENT_SECRET',
    'OS_ASSISTANT_INFERENCE_KEY', 'WEB3_PRIVATE_KEY'])
def test_optional_native_route_never_broadens_other_worker_secret_grants(name):
    with pytest.raises(ValueError):
        workflow.parse_environment(values() + '\n' + name + '=fixture-only-not-permitted')
    with pytest.raises(ValueError):
        storage.parse_environment('PUSH_EXPO_ACCESS_TOKEN=fixture-only-not-permitted')


def test_compose_does_not_shadow_the_optional_native_flag_and_keeps_storage_separate():
    manifest = json.loads((PACKAGE / 'workflow-compose.json').read_text())['services']['workflow-worker']
    assert 'PUSH_EXPO_ENABLED' not in manifest['environment']
    assert not any('EXPO_ACCESS_TOKEN' in value for value in manifest['environment'])
    assert manifest['env_file'][1]['path'] == '/etc/ziipa/workflow-worker.env'
    renderer = json.loads((PACKAGE / 'compose.json').read_text())['services']['render-worker']
    assert renderer['env_file'] == [{'path': '/etc/ziipa/render-worker.env', 'required': True, 'format': 'raw'}]
