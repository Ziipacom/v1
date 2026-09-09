"""Hosted startup must not bypass migrations with implicit table creation."""
import asyncio
from unittest.mock import Mock

import pytest

import app as application


@pytest.mark.parametrize('environment', ['demo', 'production', 'staging'])
def test_hosted_startup_does_not_create_unversioned_tables(monkeypatch, environment):
    create_tables = Mock()
    close_cache = Mock()
    dispose_engine = Mock()
    monkeypatch.setattr(application.settings, 'environment', environment)
    monkeypatch.setattr(application.Base.metadata, 'create_all', create_tables)
    monkeypatch.setattr(application.cache, 'close', close_cache)
    monkeypatch.setattr(application.engine, 'dispose', dispose_engine)

    async def run():
        with pytest.raises(RuntimeError, match='shutdown'):
            async with application.lifespan(application.app):
                raise RuntimeError('shutdown')

    asyncio.run(run())
    create_tables.assert_not_called()
    close_cache.assert_called_once()
    dispose_engine.assert_called_once()
