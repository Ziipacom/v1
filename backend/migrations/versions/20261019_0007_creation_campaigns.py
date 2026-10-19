"""Owner-reviewed campaign artifacts and durable destination delivery receipts."""
from alembic import op

revision = '20261019_0007'
down_revision = '20261013_0006'
branch_labels = None
depends_on = None


def upgrade():
    from creation_campaigns import CreationCampaign, CampaignDelivery
    for model in (CreationCampaign, CampaignDelivery):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    # Preserve approvals and delivery receipts; disable the worker to roll back.
    pass
