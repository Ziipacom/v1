"""Inference trust boundary and free deployment acceptance; no cloud calls."""
import asyncio
import importlib.util
import json
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import httpx
from pydantic import ValidationError
import pytest

import inference_gateway as gateway

KEY = 'local-test-key-which-is-not-a-real-credential-123456'
HEADERS = {'Authorization': 'Bearer ' + KEY}
BODY = {'messages': [{'role': 'user', 'content': 'Prepare a private project plan'}],
        'format': {'type': 'object', 'properties': {'reply': {'type': 'string'}}, 'required': ['reply']}}
PACKAGE = Path(__file__).resolve().parents[1] / 'deploy' / 'oracle-free'


@pytest.fixture
def app():
    return gateway.create_app(gateway.GatewaySettings(api_key=KEY))


@pytest.fixture
def preflight(monkeypatch):
    monkeypatch.syspath_prepend(str(PACKAGE))
    spec = importlib.util.spec_from_file_location('inference_package_preflight', PACKAGE / 'inference_preflight.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_gateway_key_is_mandatory_and_never_in_validation_or_representation(monkeypatch):
    monkeypatch.delenv('ZIIPA_INFERENCE_API_KEY', raising=False)
    with pytest.raises(ValidationError):
        gateway.create_app()
    with pytest.raises(ValidationError) as failure:
        gateway.GatewaySettings(api_key='do-not-print-this-key')
    assert 'do-not-print-this-key' not in str(failure.value)
    assert KEY not in repr(gateway.GatewaySettings(api_key=KEY))


@pytest.mark.parametrize('url', [
    'http://169.254.169.254', 'http://192.168.1.101:11434', 'https://ollama.com',
    'http://ollama:8080', 'http://secret@localhost:11434', 'http://localhost/api',
    'http://localhost:11434?model=cloud', 'http://localhost:bad',
])
def test_raw_model_cannot_be_redirected_to_external_or_metadata_servers(url):
    with pytest.raises(ValidationError):
        gateway.GatewaySettings(api_key=KEY, ollama_url=url)


@pytest.mark.parametrize('url', ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'http://ollama:11434'])
def test_model_transport_only_accepts_loopback_or_private_service(url):
    assert gateway.GatewaySettings(api_key=KEY, ollama_url=url).ollama_url == url


def test_public_process_health_does_not_reveal_model_and_other_routes_require_auth(app):
    client = TestClient(app)
    assert client.get('/livez').json() == {'status': 'ok'}
    app.state.gateway.request = AsyncMock()
    for url in ['/v1/health', '/v1/chat', '/docs', '/api/pull', '/api/chat']:
        response = client.get(url)
        assert response.status_code == 401 and KEY not in response.text
    assert not app.state.gateway.request.called
    assert client.get('/docs', headers=HEADERS).status_code == 404
    assert client.get('/openapi.json', headers=HEADERS).status_code == 404
    assert client.get('/v1/health', headers={'Authorization': 'Bearer wrong'}).status_code == 401
    response = client.get('/v1/health', headers=[('Authorization', 'Bearer ' + KEY), ('Authorization', 'Bearer ' + KEY)])
    assert response.status_code == 401


@pytest.mark.parametrize('models,available', [([], False),
    ([{'name': 'qwen3:1.7b', 'size': 1400000000}], True),
    ([{'name': 'different:latest', 'size': 1}], False),
    ([{'name': 'qwen3:1.7b', 'size': 0}], False),
])
def test_authenticated_readiness_requires_actual_pinned_model_inventory(app, models, available):
    app.state.gateway.request = AsyncMock(return_value={'models': models})
    response = TestClient(app).get('/v1/health', headers=HEADERS)
    assert response.json() == {'available': available, 'model': 'qwen3:1.7b'}
    assert response.headers['cache-control'] == 'no-store'


def test_private_readiness_degrades_without_leaking_upstream_error(app):
    app.state.gateway.request = AsyncMock(side_effect=httpx.ConnectError('private credential must not escape'))
    response = TestClient(app).get('/v1/health', headers=HEADERS)
    assert response.status_code == 200 and response.json()['available'] is False
    assert 'credential' not in response.text


def test_client_cannot_choose_model_options_tools_streams_or_schema_urls(app):
    client = TestClient(app)
    for extra in [{'model': 'cloud-model'}, {'options': {'num_ctx': 1000000}},
                  {'tools': [{'shell': 'anything'}]}, {'stream': True}]:
        assert client.post('/v1/chat', headers=HEADERS, json={**BODY, **extra}).status_code == 422
    bad = {**BODY, 'format': {'type': 'object', '$ref': 'https://private.example/metadata'}}
    response = client.post('/v1/chat', headers=HEADERS, json=bad)
    assert response.status_code == 422 and 'private.example' not in response.text
    assert client.post('/v1/chat', headers=HEADERS, json={**BODY, 'messages': [{'role': 'tool', 'content': 'execute'}]}).status_code == 422


def test_gateway_accepts_production_action_terminal_object_grammar(app, preflight):
    spec = importlib.util.spec_from_file_location('inference_grammar_acceptance', PACKAGE / 'inference_acceptance.py')
    acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)
    app.state.gateway.request = AsyncMock(return_value={'model': 'qwen3:1.7b', 'done': True,
        'message': {'content': '{"decision":"done","detail":"No effects required","tool":null,"arguments":{}}'}})
    response = TestClient(app).post('/v1/chat', headers=HEADERS, json={**BODY, 'format': acceptance.SCHEMA})
    assert response.status_code == 200 and response.json()['result']['tool'] is None
    assert app.state.gateway.request.call_args.args[1]['format'] == acceptance.SCHEMA
    for union in [[{'type': 'string'}], [], [{'type': 'object'}] * 9]:
        response = TestClient(app).post('/v1/chat', headers=HEADERS, json={**BODY, 'format': {'oneOf': union}})
        assert response.status_code == 422


def test_context_and_body_are_bounded_before_model_request(app):
    client = TestClient(app)
    app.state.gateway.request = AsyncMock()
    assert client.post('/v1/chat', headers=HEADERS, json={**BODY, 'messages': [
        {'role': 'user', 'content': 'a' * 10000}, {'role': 'user', 'content': 'a' * 10000}]}).status_code == 422
    assert client.post('/v1/chat', headers={**HEADERS, 'Content-Type': 'application/json'}, content=b'a' * 32769).status_code == 413
    assert client.post('/v1/chat', headers={**HEADERS, 'Content-Type': 'text/plain'}, content='{}').status_code == 415
    assert not app.state.gateway.request.called


def test_chunked_body_limit_applies_without_content_length(app):
    async def exercise():
        async def chunks():
            for _ in range(4):
                yield b'a' * 10000
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://gateway') as client:
            return await client.post('/v1/chat', headers={**HEADERS, 'Content-Type': 'application/json'}, content=chunks())
    assert asyncio.run(exercise()).status_code == 413


def test_only_bounded_json_plan_returns_and_no_prompt_is_logged(app, capsys):
    app.state.gateway.request = AsyncMock(return_value={'model': 'qwen3:1.7b', 'done': True,
                                                      'message': {'content': '{"reply":"Use a draft project"}'}})
    response = TestClient(app).post('/v1/chat', headers=HEADERS, json=BODY)
    assert response.json() == {'result': {'reply': 'Use a draft project'}, 'model': 'qwen3:1.7b'}
    _, sent = app.state.gateway.request.call_args.args
    assert sent['stream'] is False and sent['think'] is False
    assert sent['model'] == 'qwen3:1.7b' and sent['options'] == {'temperature': 0.2, 'num_ctx': 6144, 'num_predict': 650}
    captured = capsys.readouterr()
    assert KEY not in captured.out + captured.err and BODY['messages'][0]['content'] not in captured.out + captured.err


@pytest.mark.parametrize('upstream', [
    {'model': 'wrong', 'done': True, 'message': {'content': '{}'}},
    {'model': 'qwen3:1.7b', 'done': False, 'message': {'content': '{}'}},
    {'model': 'qwen3:1.7b', 'done': True, 'message': {'content': '[]'}},
    {'model': 'qwen3:1.7b', 'done': True, 'message': {'content': 'private-data-not-json'}},
    {'model': 'qwen3:1.7b', 'done': True, 'message': {'content': 'a' * 16001}},
])
def test_invalid_or_unfinished_inference_never_escapes_or_executes(app, upstream):
    app.state.gateway.request = AsyncMock(return_value=upstream)
    response = TestClient(app).post('/v1/chat', headers=HEADERS, json=BODY)
    assert response.status_code == 502 and 'private-data' not in response.text
    assert app.state.gateway.slot.acquire(blocking=False)  # Every failure releases the only slot.
    app.state.gateway.slot.release()


def test_private_model_timeout_is_bounded_and_does_not_expose_exception(app):
    app.state.gateway.request = AsyncMock(side_effect=TimeoutError('private-model-address'))
    response = TestClient(app).post('/v1/chat', headers=HEADERS, json=BODY)
    assert response.status_code == 503 and 'private-model-address' not in response.text


def test_busy_gateway_and_minute_budget_do_not_queue_unlimited_model_work(app):
    app.state.gateway.request = AsyncMock(return_value={'model': 'qwen3:1.7b', 'done': True, 'message': {'content': '{}'}})
    client = TestClient(app)
    app.state.gateway.slot.acquire()
    assert client.post('/v1/chat', headers=HEADERS, json=BODY).status_code == 503
    assert not app.state.gateway.request.called
    app.state.gateway.slot.release()
    for _ in range(12):
        assert client.post('/v1/chat', headers=HEADERS, json=BODY).status_code == 200
    response = client.post('/v1/chat', headers=HEADERS, json=BODY)
    assert response.status_code == 429 and response.headers['retry-after'] == '60'
    assert app.state.gateway.request.call_count == 12


def test_transport_does_not_follow_redirects_and_caps_upstream_bytes(monkeypatch):
    real_client = httpx.AsyncClient
    seen = []
    def client(**kwargs):
        seen.append(kwargs)
        return real_client(**kwargs, transport=httpx.MockTransport(lambda _request: httpx.Response(302, headers={'Location': 'http://169.254.169.254'})))
    monkeypatch.setattr(gateway.httpx, 'AsyncClient', client)
    instance = gateway.Gateway(gateway.GatewaySettings(api_key=KEY))
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(instance.request('/api/tags'))
    assert seen[0]['trust_env'] is False and seen[0]['follow_redirects'] is False
    def oversized(**kwargs):
        return real_client(**kwargs, transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=b'a' * 32769)))
    monkeypatch.setattr(gateway.httpx, 'AsyncClient', oversized)
    with pytest.raises(ValueError):
        asyncio.run(instance.request('/api/tags'))


def test_generation_has_a_total_deadline_even_when_upstream_slowly_streams(monkeypatch):
    real_client = httpx.AsyncClient
    class SlowBytes(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(0.05)
            yield b'{}'
    def delayed(**kwargs):
        return real_client(**kwargs, transport=httpx.MockTransport(lambda _request: httpx.Response(200, stream=SlowBytes())))
    monkeypatch.setattr(gateway.httpx, 'AsyncClient', delayed)
    instance = gateway.Gateway(gateway.GatewaySettings(api_key=KEY))
    with pytest.raises(TimeoutError):
        asyncio.run(instance.request('/api/chat', payload={}, timeout=0.005))


def test_authenticated_slow_body_is_bounded_before_parsing(monkeypatch):
    monkeypatch.setattr(gateway, 'BODY_TIMEOUT_SECONDS', 0.005)
    messages = []
    async def receive():
        await asyncio.sleep(0.05)
        return {'type': 'http.request', 'body': b'', 'more_body': True}
    async def send(value):
        messages.append(value)
    handler = AsyncMock()
    boundary = gateway.PrivateBoundary(handler, KEY)
    asyncio.run(boundary({'type': 'http', 'path': '/v1/chat', 'method': 'POST',
                          'headers': [(b'authorization', ('Bearer ' + KEY).encode()), (b'content-type', b'application/json')]}, receive, send))
    assert messages[0]['status'] == 408 and not handler.called


def test_deployment_secret_file_excludes_database_social_and_wallet_credentials(preflight):
    contents = 'ZIIPA_INFERENCE_API_KEY=' + KEY + '\nZIIPA_INFERENCE_MODEL=qwen3:1.7b'
    assert set(preflight.parse_environment(contents)) == preflight.KEYS
    for extra in ['DATABASE_URL', 'PUBLISHING_TOKEN_KEY', 'PRIVATE_KEY', 'ZIIPA_INFERENCE_OLLAMA_URL']:
        with pytest.raises(ValueError) as failure:
            preflight.parse_environment(contents + '\n' + extra + '=do-not-print')
        assert 'do-not-print' not in str(failure.value)
    with pytest.raises(ValueError):
        preflight.parse_environment((PACKAGE / 'inference-gateway.env.example').read_text())


def test_combined_host_cannot_silently_oversubscribe_existing_4gb_free_worker(preflight):
    preflight.validate_resources('MemTotal: 8000000 kB', 7 * 1024**3, 2)
    for ram, disk, cpus in [('MemTotal: 4000000 kB', 7 * 1024**3, 2),
                             ('MemTotal: 8000000 kB', 7 * 1024**3, 1),
                             ('MemTotal: 8000000 kB', 2 * 1024**3, 2)]:
        with pytest.raises(ValueError):
            preflight.validate_resources(ram, disk, cpus)
    preflight.validate_resources('MemTotal: 4000000 kB', 7 * 1024**3, 1, small_host=True)
    with pytest.raises(ValueError):
        preflight.validate_resources('MemTotal: 2000000 kB', 7 * 1024**3, 1, small_host=True)


def test_inference_compose_never_exposes_raw_model_or_provider_credentials():
    package = json.loads((PACKAGE / 'inference-compose.json').read_text())
    ollama, service = (package['services'][key] for key in ['ollama', 'inference-gateway'])
    assert set(package['services']) == {'ollama', 'inference-gateway'}
    assert not any(key in ollama for key in ['ports', 'expose', 'network_mode', 'env_file'])
    assert ollama['networks'] == ['model-private'] and package['networks']['model-private']['internal'] is True
    assert ollama['volumes'] == ['ollama_models:/models:ro']
    assert ollama['environment']['OLLAMA_NO_CLOUD'] == '1'
    assert service['ports'] == ['127.0.0.1:8089:8089'] and service['env_file'][0]['format'] == 'raw'
    for item in [ollama, service]:
        assert item['read_only'] and item['user'] == '10001:10001' and item['cap_drop'] == ['ALL']
        assert item['memswap_limit'] == item['mem_limit'] and item['pull_policy'] == 'never'
        assert item['restart'] == 'no' and item['security_opt'] == ['no-new-privileges:true']
    unit = (PACKAGE / 'ziipa-inference.service').read_text()
    assert 'inference_preflight.py' in unit and '--no-build --pull never' in unit
    assert 'EnvironmentFile=' not in unit and 'StartLimitBurst=3' in unit
    tunnel = json.loads((PACKAGE / 'inference-tunnel-compose.json').read_text())['services']['inference-tunnel']
    assert '--token-file' in tunnel['command'] and '--token' not in tunnel['command']
    assert tunnel['networks'] == ['gateway-egress'] and 'ports' not in tunnel
    assert tunnel['volumes'][0]['read_only'] and not tunnel['volumes'][0]['bind']['create_host_path']
    assert tunnel['cap_drop'] == ['ALL'] and tunnel['security_opt'] == ['no-new-privileges:true']
    assert 'Conflicts=ziipa-inference.service' in (PACKAGE / 'ziipa-inference-tunnel.service').read_text()


def test_small_host_profile_keeps_all_container_memory_below_3gb_without_weakening_default():
    overlay = json.loads((PACKAGE / 'inference-small-compose.json').read_text())['services']
    assert overlay['ollama']['mem_limit'] == overlay['ollama']['memswap_limit'] == '1024m'
    settings = overlay['inference-gateway']['environment']
    assert settings['ZIIPA_INFERENCE_MODEL'] == 'qwen3:0.6b'
    assert settings['ZIIPA_INFERENCE_CONTEXT_TOKENS'] == '4096' and settings['ZIIPA_INFERENCE_OUTPUT_TOKENS'] == '450'
    assert overlay['inference-gateway']['mem_limit'] == '128m'
    # Existing render1024 +workflows512 +agent256 +gateway128 +tunnel128 MiB.
    assert 1024 + 1024 + 512 + 256 + 128 + 128 == 3 * 1024
    unit = (PACKAGE / 'ziipa-inference-small-tunnel.service').read_text()
    assert 'inference_preflight.py --small-host --tunnel' in unit
    assert '-f inference-small-compose.json' in unit and 'Conflicts=' in unit


def test_native_acceptance_requires_typed_sequential_actions_and_terminal_no_effects(preflight, monkeypatch):
    spec = importlib.util.spec_from_file_location('inference_package_acceptance', PACKAGE / 'inference_acceptance.py')
    acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)
    results = iter([
        {'available': True, 'model': 'qwen3:0.6b'},
        {'model': 'qwen3:0.6b', 'result': {'decision': 'action', 'detail': 'Project required', 'tool': 'project.create', 'arguments': {'name': 'Inference Acceptance'}}},
        {'model': 'qwen3:0.6b', 'result': {'decision': 'action', 'detail': 'Goal required', 'tool': 'goal.create', 'arguments': {
            'title': acceptance.GOAL_TITLE, 'project_id': acceptance.PROJECT_ID,
            'steps': [{'id': 'step-' + str(index + 1), 'title': title, 'completed': False}
                      for index, title in enumerate(acceptance.STEP_TITLES)]}}},
        {'model': 'qwen3:0.6b', 'result': {'decision': 'done', 'detail': 'Owned changes completed', 'tool': None, 'arguments': {}}},
        {'model': 'qwen3:0.6b', 'result': {'decision': 'blocked', 'detail': 'Unsupported effects', 'tool': None, 'arguments': {}}},
    ])
    calls = []
    def request(key, path, payload=None):
        calls.append((key, path, payload)); return next(results)
    monkeypatch.setattr(acceptance, 'request', request)
    assert len(acceptance.exercise(KEY, 'qwen3:0.6b')) == 4
    assert all(path in {'/v1/health', '/v1/chat'} for _, path, _ in calls)
    project_context = calls[2][2]['messages'][-1]['content']
    assert '"request": {"name": "Inference Acceptance"}' in project_context
    assert '"result": {"project_id": "' + acceptance.PROJECT_ID + '"}' in project_context
    goal_context = calls[3][2]['messages'][-1]['content']
    assert '"checklist_titles": ["Record footage", "Edit clips", "Review captions"]' in goal_context and acceptance.GOAL_ID in goal_context
    assert '"execution_status": "completed"' in goal_context
    assert calls[2][2]['format']['oneOf'][0]['properties']['tool']['enum'][0] == 'goal.create'
    assert acceptance.PROJECT_ID not in calls[4][2]['messages'][-1]['content']
    assert '"completed_steps": []' in calls[4][2]['messages'][-1]['content']
    # Teaching examples may appear earlier, but actual task IDs never match them.
    assert '33333333-3333-4333-8333-333333333333' not in project_context
    assert acceptance.PROJECT_ID not in calls[2][2]['messages'][1]['content']
    assert calls[2][2]['format']['oneOf'][0]['properties']['decision']['const'] == 'action'
    assert calls[2][2]['format']['oneOf'][1]['properties']['tool']['type'] == 'null'
    with pytest.raises(ValueError):
        acceptance.validate_plan({'decision': 'done', 'detail': 'Finished', 'tool': 'project.create', 'arguments': {}}, 'done')
    with pytest.raises(ValueError):
        acceptance.validate_plan({'decision': 'action', 'detail': 'Try a project', 'tool': 'project.create', 'arguments': {'name': 'Unexpected'}}, 'project.create')


@pytest.mark.parametrize('flaw', ['unlinked', 'wrong_project', 'completed_step', 'missing_step', 'duplicate_step', 'changed_title'])
def test_native_acceptance_rejects_wrong_goal_scope_or_invented_progress(preflight, flaw):
    spec = importlib.util.spec_from_file_location('inference_goal_acceptance', PACKAGE / 'inference_acceptance.py')
    acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)
    plan = {'decision': 'action', 'detail': 'Create linked goal', 'tool': 'goal.create', 'arguments': {
        'title': acceptance.GOAL_TITLE, 'project_id': acceptance.PROJECT_ID,
        'steps': [{'id': 'step-' + str(index + 1), 'title': title, 'completed': False}
                  for index, title in enumerate(acceptance.STEP_TITLES)]}}
    arguments = plan['arguments']
    if flaw == 'unlinked': arguments['project_id'] = None
    elif flaw == 'wrong_project': arguments['project_id'] = acceptance.GOAL_ID
    elif flaw == 'completed_step': arguments['steps'][0]['completed'] = True
    elif flaw == 'missing_step': arguments['steps'].pop()
    elif flaw == 'duplicate_step': arguments['steps'][1]['id'] = 'step-1'
    elif flaw == 'changed_title': arguments['steps'][1]['title'] = 'Unexpected request'
    with pytest.raises(ValueError):
        acceptance.validate_plan(plan, 'goal.create')


def test_agent_preflight_requires_selected_model_and_exact_matching_gateway_key(preflight):
    spec = importlib.util.spec_from_file_location('inference_agent_preflight', PACKAGE / 'agent_preflight.py')
    agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
    def environment(key=KEY, model='qwen3:1.7b'):
        return 'OS_ASSISTANT_INFERENCE_KEY=' + key + '\nOS_ASSISTANT_MODEL=' + model
    def gateway_environment(key=KEY, model='qwen3:1.7b'):
        return 'ZIIPA_INFERENCE_API_KEY=' + key + '\nZIIPA_INFERENCE_MODEL=' + model
    agent.validate_pair(environment(), gateway_environment())
    agent.validate_pair(environment(model='qwen3:0.6b'), gateway_environment(model='qwen3:0.6b'), small_host=True)
    for private, upstream, small in [
        (environment(key='not-the-matching-private-key-but-valid-12345'), gateway_environment(), False),
        (environment(model='qwen3:0.6b'), gateway_environment(), False),
        (environment(), gateway_environment(), True),
        (environment(), gateway_environment() + '\nDATABASE_URL=must-not-be-copied', False),
    ]:
        with pytest.raises(ValueError) as failure:
            agent.validate_pair(private, upstream, small)
        assert KEY not in str(failure.value) and 'must-not-be-copied' not in str(failure.value)
    for extra in ['DATABASE_URL', 'OS_ASSISTANT_INFERENCE_URL', 'PUBLISHING_TOKEN_KEY']:
        with pytest.raises(ValueError):
            agent.parse_environment(environment() + '\n' + extra + '=unsupported')


def test_agent_preflight_protects_both_files_and_never_prints_secret_failure(preflight, monkeypatch, capsys):
    spec = importlib.util.spec_from_file_location('inference_agent_preflight_failure', PACKAGE / 'agent_preflight.py')
    agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
    monkeypatch.setattr(agent.sys, 'argv', ['agent_preflight.py'])
    monkeypatch.setattr(agent, 'validate_secret_file', lambda _path: (_ for _ in ()).throw(ValueError('do-not-print-secret')))
    assert agent.main() == 1
    output = capsys.readouterr()
    assert 'do-not-print-secret' not in output.out + output.err
    for unit, arguments in [('ziipa-agent-worker.service', 'agent_preflight.py\n'),
                            ('ziipa-agent-worker-small.service', 'agent_preflight.py --small-host\n')]:
        assert 'ExecStartPre=/usr/bin/python3 /opt/ziipa/deploy/oracle-free/' + arguments in (PACKAGE / unit).read_text()
