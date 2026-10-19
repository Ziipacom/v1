"""Fresh/legacy migrations must work on SQLite before ALTER COLUMN support."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
from sqlalchemy import create_engine, event, inspect, text

import app
import render_migrate


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('publishing_migration_0002', ROOT / 'backend' / 'migrations' / 'versions' / '20260909_0002_live_publishing.py')
publishing_migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publishing_migration)


def no_sqlite_alter_column(connection, cursor, statement, parameters, context, executemany):
    if 'ALTER COLUMN' in statement.upper():
        raise AssertionError('Emulate SQLite versions without ALTER COLUMN support')


def test_fresh_all_migrations_do_not_require_modern_sqlite_alter_column():
    engine = create_engine('sqlite://')
    event.listen(engine, 'before_cursor_execute', no_sqlite_alter_column)
    try:
        render_migrate.upgrade_database(engine)
        render_migrate.upgrade_database(engine)
        render_migrate.ensure_schema_ready(engine)
        column = next(c for c in inspect(engine).get_columns('publishing_jobs') if c['name'] == 'provider_data')
        assert column['nullable'] is False
    finally:
        engine.dispose()


@pytest.mark.parametrize('column_exists', [False, True])
def test_legacy_sqlite_null_backfill_and_rebuild_preserve_rows_indexes_and_idempotence(monkeypatch, column_exists):
    engine = create_engine('sqlite://')
    event.listen(engine, 'before_cursor_execute', no_sqlite_alter_column)
    try:
        with engine.begin() as connection:
            extra = ', provider_data JSON NULL' if column_exists else ''
            connection.execute(text('CREATE TABLE publishing_jobs (id VARCHAR(36) PRIMARY KEY, keep TEXT NOT NULL' + extra + ')'))
            connection.execute(text('CREATE UNIQUE INDEX keep_receipt ON publishing_jobs (keep)'))
            connection.execute(text("INSERT INTO publishing_jobs(id, keep) VALUES ('receipt-before-upgrade', 'preserved')"))
            app.Base.metadata.create_all(connection)
            monkeypatch.setattr(publishing_migration, 'op', Operations(MigrationContext.configure(connection)))
            publishing_migration.upgrade()
            publishing_migration.upgrade()
            assert connection.execute(text('SELECT id, keep, provider_data FROM publishing_jobs')).one() == (
                'receipt-before-upgrade', 'preserved', '{}')
            column = next(c for c in inspect(connection).get_columns('publishing_jobs') if c['name'] == 'provider_data')
            assert column['nullable'] is False
            assert any(index['name'] == 'keep_receipt' and index['unique'] for index in inspect(connection).get_indexes('publishing_jobs'))
    finally:
        engine.dispose()


@pytest.mark.parametrize('nullable', [True, False])
def test_postgresql_keeps_in_place_nonnullable_upgrade_without_batch_rebuild(monkeypatch, nullable):
    calls = []
    bind = SimpleNamespace(dialect=SimpleNamespace(name='postgresql'))
    monkeypatch.setattr(publishing_migration.sa.Table, 'create', lambda table, bind, checkfirst: None)
    monkeypatch.setattr(publishing_migration.sa, 'inspect', lambda target: SimpleNamespace(
        get_columns=lambda table: [{'name': 'provider_data', 'nullable': nullable}]))
    monkeypatch.setattr(publishing_migration, 'op', SimpleNamespace(get_bind=lambda: bind,
        execute=lambda sql: calls.append(('backfill', str(sql))),
        alter_column=lambda table, name, **kwargs: calls.append(('alter', table, name, kwargs['nullable']))))
    publishing_migration.upgrade()
    assert calls[0][0] == 'backfill'
    assert calls[1:] == [('alter', 'publishing_jobs', 'provider_data', False)] if nullable else calls[1:] == []


def test_workflow_template_is_explicitly_unignored_and_contains_no_credentials():
    from importlib.util import module_from_spec, spec_from_file_location
    package = ROOT / 'deploy' / 'oracle-free'
    assert '!workflow.env.example' in (package / '.gitignore').read_text().splitlines()
    spec = spec_from_file_location('release_workflow_preflight', package / 'workflow-preflight.py')
    preflight = module_from_spec(spec); spec.loader.exec_module(preflight)
    values = preflight.parse_environment((package / 'workflow.env.example').read_text())
    assert all(values[key] == 'false' for key in ('PUSH_ENABLED', 'LIVE_RECORDINGS_ENABLED',
        'CREATION_CAMPAIGN_ENABLED', 'OS_CALENDAR_ENABLED'))
    assert all(not values[key] for key in preflight.PUSH_KEYS | {'LIVEPEER_API_KEY'})
