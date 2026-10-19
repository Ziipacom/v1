"""Private creator calendar and durable reminder receipts."""
from alembic import op

revision = '20261019_0009'
down_revision = '20261019_0008'
branch_labels = None
depends_on = None


def upgrade():
    from calendar_services import CalendarEvent, CalendarOccurrence
    for model in (CalendarEvent, CalendarOccurrence):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    # Preserve private plans/reminder receipts. Disable calendar scheduling to roll back.
    pass
