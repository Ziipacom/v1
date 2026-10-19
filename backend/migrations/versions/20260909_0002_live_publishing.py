"""Add owned live broadcasts, encrypted provider grants and delivery receipts."""
from alembic import op
import sqlalchemy as sa

revision = '20260909_0002'
down_revision = '20260901_0001'
branch_labels = None
depends_on = None


def upgrade():
    from live_api import LiveStream
    from social_publishing import PublishingGrant, PublishingJob
    bind = op.get_bind()
    for model in (LiveStream, PublishingGrant, PublishingJob):
        model.__table__.create(bind=bind, checkfirst=True)
    # Development installations may already have the first publishing prototype.
    columns = {c['name'] for c in sa.inspect(bind).get_columns('publishing_jobs')}
    if 'provider_data' not in columns:
        op.add_column('publishing_jobs', sa.Column('provider_data', sa.JSON(), nullable=True))
    op.execute(sa.text("UPDATE publishing_jobs SET provider_data = '{}' WHERE provider_data IS NULL"))
    provider_column = next(c for c in sa.inspect(bind).get_columns('publishing_jobs') if c['name'] == 'provider_data')
    # Fresh installations already create the current NOT NULL model. Do not
    # issue redundant ALTER COLUMN syntax unsupported by older SQLite runtimes.
    # Legacy SQLite prototypes need a scoped table rebuild; PostgreSQL keeps
    # its original in-place alteration and all existing data/constraints.
    if provider_column['nullable']:
        if bind.dialect.name == 'sqlite':
            with op.batch_alter_table('publishing_jobs') as batch:
                batch.alter_column('provider_data', existing_type=sa.JSON(), nullable=False)
        else:
            op.alter_column('publishing_jobs', 'provider_data', existing_type=sa.JSON(), nullable=False)


def downgrade():
    # Roll back application code without destroying authorizations or receipts.
    pass
