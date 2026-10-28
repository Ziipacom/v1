"""Storefronts, reviewed listings and verified cross-platform subscription snapshots."""
from alembic import op

revision = '20261028_0014'
down_revision = '20261027_0013'
branch_labels = None
depends_on = None


def upgrade():
    from marketplace import Storefront, StoreListing, StoreReport
    from commerce_billing import BillingAccount
    for model in (Storefront, StoreListing, StoreReport, BillingAccount):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    raise RuntimeError('Commerce downgrade requires reviewed archival of seller data and purchase mappings.')
