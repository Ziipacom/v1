"""Opt-in owner-bound public gallery addresses and retained slug reservations."""
from alembic import op

revision = '20261027_0013'
down_revision = '20261020_0012'
branch_labels = None
depends_on = None


def upgrade():
    from public_gallery import PublicGallery, PublicGallerySlug
    for model in (PublicGallerySlug, PublicGallery):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    raise RuntimeError('Public gallery downgrade requires reviewed archival of owner consent and address reservations.')
