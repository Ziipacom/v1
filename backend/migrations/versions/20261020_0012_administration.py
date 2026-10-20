"""One protected owner, scoped staff, reversible moderation and decision audit."""
from alembic import op

revision = '20261020_0012'
down_revision = '20261019_0011'
branch_labels = None
depends_on = None


def upgrade():
    from admin_services import MODELS
    for model in MODELS:
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    # Silently dropping the immutable owner/audit tables would erase security
    # history. A deliberate operator-reviewed archival migration is required.
    raise RuntimeError('Administration downgrade is blocked to preserve owner identity and audit history.')
