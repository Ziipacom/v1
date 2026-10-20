"""Isolated encrypted SoundCloud authorization; no audio storage or imports."""
from alembic import op

revision = '20261020_0013'
down_revision = '20261020_0012'
branch_labels = None
depends_on = None


def upgrade():
    from soundcloud import SoundCloudConnection
    SoundCloudConnection.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    from soundcloud import SoundCloudConnection
    SoundCloudConnection.__table__.drop(bind=op.get_bind(), checkfirst=True)
