"""Private Remix projects and revisioned owner-controlled source permissions."""
from alembic import op
from sqlalchemy import inspect

revision = '20261125_0020'
down_revision = '20261125_0019'
branch_labels = None
depends_on = None


def upgrade():
    from remix_services import RemixPolicy, RemixProject
    for model in (RemixPolicy, RemixProject):
        model.__table__.create(op.get_bind(), checkfirst=True)
    indexes = {entry['name'] for entry in inspect(op.get_bind()).get_indexes('render_jobs')}
    if 'ix_render_jobs_output_media_id' not in indexes:
        op.create_index('ix_render_jobs_output_media_id', 'render_jobs', ['output_media_id'], unique=False)


def downgrade():
    raise RuntimeError('Preserve Remix attribution and rights receipts before a reviewed downgrade.')
