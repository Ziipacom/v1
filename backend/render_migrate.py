"""Create the initial Ziipa schema during a Render pre-deploy step.

This is intentionally idempotent for the first release. Replace it with
reviewed versioned migrations before making incompatible schema changes.
"""

from app import Base, engine


if __name__ == '__main__':
    Base.metadata.create_all(engine)
    engine.dispose()
    print('Ziipa database schema is ready.')
