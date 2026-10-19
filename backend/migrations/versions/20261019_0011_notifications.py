"""Opt-in encrypted push devices and durable generic notification outbox."""
from alembic import op

revision = '20261019_0011'
down_revision = '20261019_0010'
branch_labels = None
depends_on = None


def upgrade():
    from notification_services import NotificationPreference, PushDevice, NotificationEvent, NotificationDelivery
    for model in (NotificationPreference, PushDevice, NotificationEvent, NotificationDelivery):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    from notification_services import NotificationPreference, PushDevice, NotificationEvent, NotificationDelivery
    for model in (NotificationDelivery, NotificationEvent, PushDevice, NotificationPreference):
        model.__table__.drop(bind=op.get_bind(), checkfirst=True)
