"""Process probes remain independent of unavailable or sleeping data services."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
from redis.exceptions import RedisError

import app as application


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
    for headers in (None, {'Authorization': 'Bearer expired-test-token'},
                    {'Origin': 'https://untrusted.example'}):
        response = request('/api/livez', headers)
        assert response.status_code == 200
        assert response.json() == {'status': 'alive', 'scope': 'process'}
        assert response.headers['cache-control'] == 'private, no-store'
    database_session.assert_not_called()


def test_deep_health_still_reports_dependency_outages_while_process_is_alive(monkeypatch):
    connect = Mock(side_effect=RuntimeError('Simulated database outage'))
    ping = Mock(side_effect=RedisError('Simulated session-store outage'))
    monkeypatch.setattr(application, 'engine', SimpleNamespace(connect=connect))
    monkeypatch.setattr(application, 'cache', SimpleNamespace(ping=ping))
    assert request('/api/livez').status_code == 200
    connect.assert_not_called()
    ping.assert_not_called()
    response = request('/api/health')
    assert response.status_code == 503
    assert response.json()['database'] == 'unavailable'
    assert response.json()['redis'] == 'unavailable'
    connect.assert_called_once_with()
    ping.assert_called_once_with()
