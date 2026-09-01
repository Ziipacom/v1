"""Create the initial Ziipa schema on a new provider database."""
from alembic import op

from app import Base

revision = '20260901_0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    Base.metadata.create_all(bind=op.get_bind())


def downgrade():
    # Account and creator data must never be destroyed by an automated rollback.
    pass
