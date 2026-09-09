"""Process probes remain independent of unavailable or sleeping data services."""
import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import httpx
import pytest
from fastapi import HTTPException
from redis.exceptions import RedisError

import app as application
import render_services as rendering


def request(path, headers=None):
    async def send():
        # Test per-request behavior without starting a development DB bootstrap.
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application.app),
            base_url='https://ziipa.test',
        ) as client:
            return await client.get(path, headers=headers)
    return asyncio.run(send())


def test_liveness_never_touches_database_redis_or_authentication(monkeypatch):
    class ForbiddenService:
        def __getattr__(self, name):
            raise AssertionError('Liveness attempted dependency access: ' + name)

    monkeypatch.setattr(application, 'engine', ForbiddenService())
    monkeypatch.setattr(application, 'cache', ForbiddenService())
    database_session = Mock(side_effect=AssertionError('Liveness opened a database session'))
    monkeypatch.setattr(application, 'SessionLocal', database_session)
    render_readiness = Mock(side_effect=AssertionError('Liveness checked render readiness'))
    monkeypatch.setattr(rendering, 'readiness', render_readiness)
    for headers in (None, {'Authorization': 'Bearer expired-test-token'},
                    {'Origin': 'https://untrusted.example'}):
        response = request('/api/livez', headers)
        assert response.status_code == 200
        assert response.json() == {'status': 'alive', 'scope': 'process'}
        assert response.headers['cache-control'] == 'private, no-store'
    database_session.assert_not_called()
    render_readiness.assert_not_called()


def test_deep_health_still_reports_dependency_outages_while_process_is_alive(monkeypatch):
    connect = Mock(side_effect=RuntimeError('Simulated database outage'))
    ping = Mock(side_effect=RedisError('Simulated session-store outage'))
    monkeypatch.setattr(application, 'engine', SimpleNamespace(connect=connect))
    monkeypatch.setattr(application, 'cache', SimpleNamespace(ping=ping))
    monkeypatch.setattr(rendering, 'readiness', Mock(side_effect=RedisError('Unavailable renderer')))
    assert request('/api/livez').status_code == 200
    connect.assert_not_called()
    ping.assert_not_called()
    response = request('/api/health')
    assert response.status_code == 503
    assert response.json()['database'] == 'unavailable'
    assert response.json()['redis'] == 'unavailable'
    connect.assert_called_once_with()
    ping.assert_called_once_with()


@pytest.fixture
def healthy_services(monkeypatch):
    connection = MagicMock()
    connect = Mock(return_value=connection)
    ping = Mock(return_value=True)
    monkeypatch.setattr(application, 'engine', SimpleNamespace(connect=connect))
    monkeypatch.setattr(application, 'cache', SimpleNamespace(ping=ping))
    monkeypatch.setattr(rendering.config, 'enabled', True)
    monkeypatch.setattr(rendering, 'runtime_paths', Mock(return_value=('ffmpeg', 'ffprobe', 'font')))
    return connect, ping


@pytest.mark.parametrize('heartbeat', ['matching', 'different_bucket', 'different_quota', 'missing'])
def test_health_only_reports_worker_for_the_apis_coordination_scope(monkeypatch, healthy_services, heartbeat):
    # Use the real coordination function: a live worker pointed at a different
    # bucket or quota must not make this API claim that rendering is available.
    monkeypatch.setattr(rendering.settings, 'media_storage_backend', 'r2')
    monkeypatch.setattr(rendering.settings, 'r2_bucket_name', 'health-check-owned-bucket')
    key = 'ziipa:render:worker:' + rendering.coordination_scope()
    monkeypatch.setattr(rendering, 'HEARTBEAT_KEY', key)
    worker_key = key
    with monkeypatch.context() as worker_settings:
        if heartbeat == 'different_bucket':
            worker_settings.setattr(rendering.settings, 'r2_bucket_name', 'another-worker-bucket')
        elif heartbeat == 'different_quota':
            worker_settings.setattr(rendering.quota_config, 'project_max_bytes', rendering.quota_config.project_max_bytes + 1)
        worker_key = 'ziipa:render:worker:' + rendering.coordination_scope()
    if heartbeat.startswith('different_'):
        assert worker_key != key
    values = {} if heartbeat == 'missing' else {worker_key: 'private-worker-heartbeat'}
    get = Mock(side_effect=values.get)
    monkeypatch.setattr(rendering, 'cache', SimpleNamespace(get=get))

    response = request('/api/health')
    assert response.status_code == 200
    assert response.json()['renderer'] == {
        'enabled': True, 'worker_ready': heartbeat == 'matching', 'can_render': heartbeat == 'matching',
    }
    assert response.headers['cache-control'] == 'private, no-store'
    get.assert_called_once_with(key)
    for sensitive in (key, worker_key, 'private-worker-heartbeat', 'health-check-owned-bucket', 'requirements'):
        assert sensitive not in response.text
    for call in healthy_services:
        call.assert_called_once_with()


@pytest.mark.parametrize('unavailable', ['disabled', 'missing_runtime', 'redis_down', 'unexpected_error'])
def test_optional_renderer_never_makes_healthy_api_unhealthy(monkeypatch, healthy_services, unavailable):
    monkeypatch.setattr(rendering, 'cache', SimpleNamespace(get=Mock(return_value='heartbeat')))
    if unavailable == 'disabled':
        monkeypatch.setattr(rendering.config, 'enabled', False)
    elif unavailable == 'missing_runtime':
        monkeypatch.setattr(rendering, 'runtime_paths', Mock(side_effect=HTTPException(503, 'private runtime path')))
    elif unavailable == 'redis_down':
        monkeypatch.setattr(rendering, 'cache', SimpleNamespace(get=Mock(side_effect=RedisError('private redis endpoint'))))
    else:
        monkeypatch.setattr(rendering, 'readiness', Mock(side_effect=RuntimeError('private configuration')))
    response = request('/api/health')
    assert response.status_code == 200
    assert response.json()['renderer'] == {
        'enabled': unavailable != 'disabled',
        'worker_ready': unavailable in ('disabled', 'missing_runtime'),
        'can_render': False,
    }
    assert 'private runtime' not in response.text
    assert 'private redis' not in response.text
    assert 'private configuration' not in response.text
