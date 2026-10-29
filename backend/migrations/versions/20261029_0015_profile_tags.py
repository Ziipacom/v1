"""Owner-approved media tags and follow relationships; sharing stays in preferences."""
from alembic import op

revision = '20261029_0015'
down_revision = '20261028_0014'
branch_labels = None
depends_on = None


def upgrade():
    from profile_api import ProfileMediaTag
    from profile_follows import CreatorFollow
    ProfileMediaTag.__table__.create(bind=op.get_bind(), checkfirst=True)
    CreatorFollow.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    raise RuntimeError('Profile downgrade requires reviewed archival of tag consent and follow approvals.')
