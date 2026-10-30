"""Private delegated calendar connections and event mirrors."""
from alembic import op

revision = '20261030_0016'
down_revision = '20261029_0015'
branch_labels = None
depends_on = None


def upgrade():
    from calendar_connections import CalendarConnection, ConnectedCalendarEvent, CalendarExport, DeviceCalendarSnapshot
    for model in (CalendarConnection, ConnectedCalendarEvent, CalendarExport, DeviceCalendarSnapshot):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    raise RuntimeError('Calendar disconnection and archival must be reviewed before removing private connections.')
