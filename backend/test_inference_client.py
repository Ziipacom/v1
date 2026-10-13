"""Host boundaries, structured responses and failure handling; no live model."""
import json
import httpx
import pytest
import assistant_api as assistant


@pytest.mark.parametrize('url,host', [
    ('http://model.ziipa.com', 'model.ziipa.com'),
    ('https://elsewhere.example', 'model.ziipa.com'),
    ('https://key@model.ziipa.com', 'model.ziipa.com'),
    ('https://model.ziipa.com/api', 'model.ziipa.com'),
    ('https://model.ziipa.com?key=x', 'model.ziipa.com'),
    ('https://model.ziipa.com#fragment', 'model.ziipa.com'),
])
def test_gateway_origin_is_explicit_https_without_credentials(url, host):
    with pytest.raises(ValueError):
        assistant.AssistantSettings(inference_url=url, inference_host=host, inference_key='a' * 40)


def test_gateway_requires_secret_and_does_not_display_it():
    with pytest.raises(ValueError):
        assistant.AssistantSettings(inference_url='https://model.ziipa.com', inference_host='model.ziipa.com')
    settings = assistant.AssistantSettings(inference_url='http://127.0.0.1:8089/', inference_key='a' * 40)
    assert settings.inference_url == 'http://127.0.0.1:8089'
    assert 'a' * 40 not in repr(settings)


def install_client(monkeypatch, handler, **settings):
    config = assistant.AssistantSettings(local_ai_enabled=True, **settings)
    monkeypatch.setattr(assistant, 'config', config)
    original = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(assistant.httpx, 'Client', lambda **kwargs: original(transport=transport, **kwargs))
    return config


def test_authenticated_gateway_replies_are_structured_and_model_matched(monkeypatch):
    requests = []
    def handler(request):
        requests.append(request)
        assert request.headers['Authorization'] == 'Bearer ' + 'b' * 40
        if request.url.path == '/v1/health':
            return httpx.Response(200, json={'available': True, 'model': 'qwen3:1.7b'})
        payload = json.loads(request.content)
        assert set(payload) == {'messages', 'format'}  # Caller cannot choose models or runtime options.
        return httpx.Response(200, json={'model': 'qwen3:1.7b', 'result': {'reply': 'Ready'}})
    install_client(monkeypatch, handler, inference_url='https://model.ziipa.com',
                   inference_host='model.ziipa.com', inference_key='b' * 40)
    assert assistant.inference_status() == {'mode': 'hosted_ai', 'available': True, 'model': 'qwen3:1.7b'}
    assert assistant.infer_json([{'role': 'user', 'content': 'Plan a clip'}], {'type': 'object'}) == {'reply': 'Ready'}
    assert requests[-1].url.path == '/v1/chat'


def test_gateway_redirect_is_not_followed_and_falls_back_to_guided(monkeypatch):
    urls = []
    def handler(request):
        urls.append(str(request.url))
        return httpx.Response(302, headers={'Location': 'https://other.example/v1/health'})
    install_client(monkeypatch, handler, inference_url='https://model.ziipa.com',
                   inference_host='model.ziipa.com', inference_key='b' * 40)
    assert assistant.inference_status()['mode'] == 'guided'
    assert urls == ['https://model.ziipa.com/v1/health']


@pytest.mark.parametrize('result', [['not an object'], 'invalid JSON', {'result': {}, 'model': 'different'}])
def test_untrusted_gateway_results_fail_closed(monkeypatch, result):
    def handler(request):
        if request.url.path == '/v1/health':
            return httpx.Response(200, json={'available': True, 'model': 'qwen3:1.7b'})
        return httpx.Response(200, json=result)
    install_client(monkeypatch, handler, inference_url='http://127.0.0.1:8089', inference_key='b' * 40)
    assert assistant.infer_json([{'role': 'user', 'content': 'Hello'}], {'type': 'object'}) is None


def test_local_model_receives_fixed_no_cloud_options_and_bad_output_is_rejected(monkeypatch):
    def handler(request):
        if request.url.path == '/api/tags':
            return httpx.Response(200, json={'models': [{'name': 'qwen3:1.7b'}]})
        payload = json.loads(request.content)
        assert payload['model'] == 'qwen3:1.7b'
        assert payload['stream'] is False and payload['think'] is False
        assert payload['options']['num_predict'] <= 650
        return httpx.Response(200, json={'message': {'content': 'not json'}})
    install_client(monkeypatch, handler)
    assert assistant.inference_status()['mode'] == 'local_ai'
    assert assistant.infer_json([{'role': 'user', 'content': 'Hello'}], {'type': 'object'}) is None


def test_oversized_context_never_calls_inference(monkeypatch):
    paths = []
    def handler(request):
        paths.append(request.url.path)
        return httpx.Response(200, json={'models': [{'name': 'qwen3:1.7b'}]})
    install_client(monkeypatch, handler)
    assert assistant.infer_json([{'role': 'user', 'content': 'x' * 24001}], {'type': 'object'}) is None
    assert '/api/chat' not in paths


def test_unicode_context_budget_preserves_valid_json_and_recent_items():
    value = {'projects': [{'name': '最新'}] + [{'name': '創作' * 120} for _ in range(20)],
             'goals': [{'title': '目標' * 120} for _ in range(20)]}
    compact = assistant.bounded_context(value, 3000)
    assert len(compact.encode('utf-8')) <= 3000
    decoded = json.loads(compact)
    assert decoded['projects'][0]['name'] == '最新'
