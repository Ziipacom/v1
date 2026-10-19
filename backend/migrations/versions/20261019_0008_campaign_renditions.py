"""Actual render canvases and exact per-destination campaign rendition lineage."""
from alembic import op
import sqlalchemy as sa

revision = '20261019_0008'
down_revision = '20261019_0007'
branch_labels = None
depends_on = None


def upgrade():
    additions = {
        'render_jobs': [sa.Column('output_width', sa.Integer(), nullable=True), sa.Column('output_height', sa.Integer(), nullable=True)],
        'creation_campaigns': [sa.Column('renditions', sa.JSON(), nullable=False, server_default=sa.text("'[\"original\"]'")),
            sa.Column('ziipa_rendition', sa.String(16), nullable=False, server_default='original'),
            sa.Column('render_jobs', sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
            sa.Column('artifacts', sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
            sa.Column('published_items', sa.JSON(), nullable=False, server_default=sa.text("'{}'"))],
        'campaign_deliveries': [sa.Column('rendition', sa.String(16), nullable=False, server_default='original'),
            sa.Column('published_item_id', sa.String(36), nullable=True)],
    }
    bind = op.get_bind()
    for table, columns in additions.items():
        names = {column['name'] for column in sa.inspect(bind).get_columns(table)}
        for column in columns:
            if column.name not in names:
                op.add_column(table, column)


def downgrade():
    # Keep variant approvals, source lineage and delivery receipts intact.
    pass
