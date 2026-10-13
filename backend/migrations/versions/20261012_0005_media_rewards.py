"""Add bounded interaction points and funded testnet reward distributions."""
from alembic import op

revision = '20261012_0005'
down_revision = '20261012_0004'
branch_labels = None
depends_on = None


def upgrade():
    from media_rewards import RewardState, RewardProgram, RewardInteraction, RewardLedger
    from rewards_redemption import RewardBatch, RewardAllocation, RewardTransaction
    for model in (RewardState, RewardProgram, RewardInteraction, RewardLedger,
                  RewardBatch, RewardAllocation, RewardTransaction):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    # Never discard earned receipts or irreversible published proof snapshots.
    pass
