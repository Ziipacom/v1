"""Durable opt-in autonomous task policies, leases and execution receipts."""
from alembic import op

revision = '20261013_0006'
down_revision = '20261012_0005'
branch_labels = None
depends_on = None


def upgrade():
    from agent_api import AgentPolicy, AgentTask, AgentStep
    for model in (AgentPolicy, AgentTask, AgentStep):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    # Preserve task receipts; disabling the runtime is the reversible rollback.
    pass
