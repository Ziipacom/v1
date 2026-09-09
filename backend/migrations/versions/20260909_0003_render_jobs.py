"""Add persistent, owner-scoped media render jobs."""
from alembic import op

revision = '20260909_0003'
down_revision = '20260909_0002'
branch_labels = None
depends_on = None


def upgrade():
    from render_services import RenderJob
    RenderJob.__table__.create(bind=op.get_bind(), checkfirst=True)
    from live_api import TwitchDestination
    TwitchDestination.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    # Preserve saved render receipts and media on an application rollback.
    pass
