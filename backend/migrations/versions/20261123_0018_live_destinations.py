"""Store consented live destination selections and provider cleanup receipts."""
from alembic import op

revision = '20261123_0018'
down_revision = '20261030_0016'
branch_labels = None
depends_on = None


def upgrade():
    from live_networks import NetworkDestination
    NetworkDestination.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    raise RuntimeError('Resolve active external broadcasts and archive their receipts before downgrading.')
