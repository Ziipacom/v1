"""Add private media organization, Assistant and durable background workflows."""
from alembic import op

revision = '20261012_0004'
down_revision = '20260909_0003'
branch_labels = None
depends_on = None


def upgrade():
    from personal_media import OSProject, OSAssetMetadata, OSMemory, OSGoal, OSRevenueEntry, OSActivity
    from media_workflows import OsWorkflow, OsWorkflowRun
    from assistant_api import AssistantMessage, AssistantAction, AssistantPermission
    for model in (OSProject, OSAssetMetadata, OSMemory, OSGoal, OSRevenueEntry, OSActivity,
                  OsWorkflow, OsWorkflowRun, AssistantMessage, AssistantAction, AssistantPermission):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    # Preserve private libraries, memory and execution receipts on app rollback.
    pass
