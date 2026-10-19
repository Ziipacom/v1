"""Signed live callback receipts and opt-in private recording automation."""
from alembic import op

revision = '20261019_0010'
down_revision = '20261019_0009'
branch_labels = None
depends_on = None


def upgrade():
    from live_recordings import RecordingAutomation, LiveRecording, LiveWebhookReceipt
    for model in (RecordingAutomation, LiveRecording, LiveWebhookReceipt):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    # Preserve creator consent and durable recording receipts. Disable the worker.
    pass
