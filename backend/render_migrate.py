"""Apply reviewed schema changes once, even during overlapping API/worker deploys."""

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from pathlib import Path
from sqlalchemy import text
from app import engine


def migration_config():
    root = Path(__file__).resolve().parent
    configuration = Config(str(root / 'alembic.ini'))
    configuration.set_main_option('script_location', str(root / 'migrations'))
    return configuration


def upgrade_database(bind=engine):
    configuration = migration_config()
    with bind.begin() as connection:
        if connection.dialect.name == 'postgresql':
            connection.execute(text("SET LOCAL lock_timeout = '60s'"))
            # Transaction-scoped locks work with Neon/PgBouncer transaction
            # pooling; Alembic must use this SAME connection/transaction.
            connection.execute(text('SELECT pg_advisory_xact_lock(25413261051740161)'))
        configuration.attributes['connection'] = connection
        command.upgrade(configuration, 'head')


def ensure_schema_ready(bind=engine):
    expected = set(ScriptDirectory.from_config(migration_config()).get_heads())
    with bind.connect() as connection:
        current = set(MigrationContext.configure(connection).get_current_heads())
    if not expected or current != expected:
        raise RuntimeError('The Ziipa schema is not at this release revision. Run python render_migrate.py before starting this service.')


if __name__ == '__main__':
    try:
        upgrade_database()
        print('Ziipa database schema is ready.')
    finally:
        engine.dispose()
