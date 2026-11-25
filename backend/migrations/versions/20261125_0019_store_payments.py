"""Sandbox seller connections and verified merchandise order receipts."""
from alembic import op

revision = '20261125_0019'
down_revision = '20261123_0018'
branch_labels = None
depends_on = None


def upgrade():
    from marketplace_payments import SellerPaymentAccount, MarketOrder
    from marketplace_paypal import PayPalSellerAccount
    for model in (SellerPaymentAccount, PayPalSellerAccount, MarketOrder):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    raise RuntimeError('Archive seller and order receipts before a reviewed commerce downgrade.')
