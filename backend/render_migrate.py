"""Apply reviewed, versioned schema changes before serving traffic."""

from alembic import command
from alembic.config import Config
from app import engine


if __name__ == '__main__':
    command.upgrade(Config('alembic.ini'), 'head')
    engine.dispose()
    print('Ziipa database schema is ready.')
