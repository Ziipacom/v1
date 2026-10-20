"""Persisted, server-enforced administration with append-only decision receipts.

No role is inferred from email, signup order, a request header, or environment
configuration. The single owner is installed by an explicit operator command.
"""
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import (Boolean, CheckConstraint, DateTime, DDL, ForeignKey,
                        Integer, JSON, String, delete, event, func, or_, select, text)
from sqlalchemy.orm import Mapped, mapped_column

from app import Base, User


def now():
    return datetime.now(timezone.utc)


class AdminMutex(Base):
    __tablename__ = 'admin_mutex'
    __table_args__ = (CheckConstraint('id = 1', name='ck_admin_mutex_singleton'),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    nonce: Mapped[int] = mapped_column(Integer, default=0)


class AdminOwner(Base):
    __tablename__ = 'admin_owner'
    __table_args__ = (CheckConstraint('id = 1', name='ck_admin_owner_singleton'),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='RESTRICT'), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AdminUserState(Base):
    __tablename__ = 'admin_user_states'
    __table_args__ = (
        CheckConstraint("role IN ('member','admin','moderator')", name='ck_admin_user_role'),
        CheckConstraint("status IN ('active','suspended')", name='ck_admin_user_status'),
        CheckConstraint("role = 'member' OR status = 'active'", name='ck_admin_staff_active'),
        CheckConstraint('version >= 1', name='ck_admin_user_version'),
    )
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    role: Mapped[str] = mapped_column(String(16), default='member')
    status: Mapped[str] = mapped_column(String(16), default='active')
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AdminContentState(Base):
    __tablename__ = 'admin_content_states'
    __table_args__ = (CheckConstraint('version >= 1', name='ck_admin_content_version'),)
    item_id: Mapped[str] = mapped_column(ForeignKey('creator_items.id', ondelete='CASCADE'), primary_key=True)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    previous_visibility: Mapped[str] = mapped_column(String(12), default='published')
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AdminReportState(Base):
    __tablename__ = 'admin_report_states'
    __table_args__ = (CheckConstraint('version >= 1', name='ck_admin_report_version'),)
    report_id: Mapped[str] = mapped_column(ForeignKey('content_reports.id', ondelete='CASCADE'), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AdminCommentState(Base):
    __tablename__ = 'admin_comment_states'
    __table_args__ = (CheckConstraint('version >= 1', name='ck_admin_comment_version'),)
    comment_id: Mapped[str] = mapped_column(ForeignKey('creator_comments.id', ondelete='CASCADE'), primary_key=True)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AdminSettings(Base):
    __tablename__ = 'admin_settings'
    __table_args__ = (CheckConstraint('id = 1', name='ck_admin_settings_singleton'),
                     CheckConstraint('version >= 1', name='ck_admin_settings_version'))
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    maintenance_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    signup_paused: Mapped[bool] = mapped_column(Boolean, default=False)
    banner: Mapped[str] = mapped_column(String(500), default='')
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AdminAudit(Base):
    __tablename__ = 'admin_audit'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Intentionally no user FK: deletion does not erase administrative history.
    actor_id: Mapped[int] = mapped_column(Integer, index=True)
    action: Mapped[str] = mapped_column(String(40), index=True)
    target_type: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(String(500))
    before: Mapped[dict] = mapped_column(JSON)
    after: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


MODELS = (AdminMutex, AdminOwner, AdminUserState, AdminContentState,
          AdminReportState, AdminCommentState, AdminSettings, AdminAudit)


def _immutable(mapper, connection, target):
    raise ValueError('Owner identity and administrative audit receipts are immutable.')


def _immutable_pg_names(table, connection):
    # Literal DDL strings do not participate in SQLAlchemy's schema translation.
    # Resolve and quote the *connection's* effective schema for both objects,
    # otherwise isolated tenants/tests can accidentally bind public functions.
    schema = connection.schema_for_object(table)
    if schema is None:
        schema = connection.scalar(text('SELECT current_schema()'))
    if not schema:
        raise RuntimeError('An explicit effective schema is required for immutable administration records.')
    preparer = connection.dialect.identifier_preparer
    prefix = preparer.quote_schema(schema) + '.'
    name = table.name + '_immutable'
    return prefix + preparer.quote(table.name), prefix + preparer.quote(name), preparer.quote(name)


def _create_immutable_pg(table, connection, **kwargs):
    if connection.dialect.name != 'postgresql':
        return
    target, function, trigger = _immutable_pg_names(table, connection)
    connection.exec_driver_sql(
        f"CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ "
        "BEGIN RAISE EXCEPTION 'Immutable administrative record'; END; $$")
    connection.exec_driver_sql(
        f"CREATE TRIGGER {trigger} BEFORE UPDATE OR DELETE ON {target} "
        f"FOR EACH ROW EXECUTE FUNCTION {function}()")


def _drop_immutable_pg(table, connection, **kwargs):
    if connection.dialect.name == 'postgresql':
        _, function, _ = _immutable_pg_names(table, connection)
        connection.exec_driver_sql(f'DROP FUNCTION IF EXISTS {function}()')


for _model in (AdminOwner, AdminAudit):
    event.listen(_model, 'before_update', _immutable)
    event.listen(_model, 'before_delete', _immutable)
    _table = _model.__tablename__
    # ORM events alone do not protect against bulk UPDATE/DELETE. These triggers
    # are also installed by Base.create_all in isolated tests/development.
    for _verb in ('UPDATE', 'DELETE'):
        event.listen(_model.__table__, 'after_create', DDL(
            f"CREATE TRIGGER {_table}_deny_{_verb.lower()} BEFORE {_verb} ON {_table} "
            "BEGIN SELECT RAISE(ABORT, 'Immutable administrative record'); END"
        ).execute_if(dialect='sqlite'))
    event.listen(_model.__table__, 'after_create', _create_immutable_pg)
    event.listen(_model.__table__, 'after_drop', _drop_immutable_pg)


PERMISSIONS = {
    'member': (),
    'moderator': ('overview.read', 'content.read', 'content.moderate', 'reports.read', 'reports.triage'),
    'admin': ('overview.read', 'users.read', 'users.suspend', 'content.read', 'content.moderate',
              'reports.read', 'reports.triage', 'settings.read', 'settings.write', 'audit.read'),
    'owner': ('overview.read', 'users.read', 'users.suspend', 'roles.write', 'content.read',
              'content.moderate', 'reports.read', 'reports.triage', 'settings.read',
              'settings.write', 'audit.read'),
}


class Decision(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_version: int = Field(ge=0, le=2**31 - 1, strict=True)
    reason: str = Field(min_length=5, max_length=500)

    @field_validator('reason')
    @classmethod
    def reason_text(cls, value):
        value = value.strip()
        if len(value) < 5 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('Provide a plain-text reason of 5 to 500 characters.')
        return value


class RoleDecision(Decision):
    role: Literal['member', 'admin', 'moderator']


class StatusDecision(Decision):
    status: Literal['active', 'suspended']


class ContentDecision(Decision):
    hidden: bool = Field(strict=True)


class ReportDecision(Decision):
    status: Literal['open', 'reviewing', 'resolved', 'dismissed']


class SettingsDecision(Decision):
    maintenance_mode: bool = Field(strict=True)
    signup_paused: bool = Field(strict=True)
    banner: str = Field(max_length=500)

    @field_validator('banner')
    @classmethod
    def plain_banner(cls, value):
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('The banner must be plain text on one line.')
        return value.strip()


def uid(user):
    return user if isinstance(user, int) else user.id


def admin_role(session, user):
    identifier = uid(user)
    owner = session.get(AdminOwner, 1, populate_existing=True)
    if owner and owner.user_id == identifier:
        return 'owner'
    state = session.get(AdminUserState, identifier, populate_existing=True)
    return state.role if state and state.status == 'active' else 'member'


def enforce_account_active(session, user):
    state = session.get(AdminUserState, uid(user), populate_existing=True)
    if state and state.status != 'active':
        raise HTTPException(403, 'This account is suspended. Contact Ziipa support.')


def account_is_active(session, user_id):
    if session.scalar(select(User.id).where(User.id == user_id)) is None:
        return False
    state = session.get(AdminUserState, user_id, populate_existing=True)
    return state is None or state.status == 'active'


def revoke_sessions(user_id):
    from account_services import revoke_user_sessions
    revoke_user_sessions(user_id)


def require_permission(session, user, permission):
    enforce_account_active(session, user)
    role = admin_role(session, user)
    if permission not in PERMISSIONS[role]:
        raise HTTPException(403, 'This administrative action is not permitted for your role.')
    return role


def lock_administration(session):
    """Serialize authority changes, then re-read roles inside that transaction.

    PostgreSQL advisory locks avoid acquiring User locks in reverse order to the
    application's media workers. SQLite acquires its database write lock first.
    """
    if session.bind.dialect.name == 'postgresql':
        session.execute(text("SET LOCAL lock_timeout = '5s'"))
        session.execute(text('SELECT pg_advisory_xact_lock(2138791120)'))
    elif session.bind.dialect.name == 'sqlite':
        session.execute(text('INSERT OR IGNORE INTO admin_mutex (id, nonce) VALUES (1, 0)'))
        session.execute(text('UPDATE admin_mutex SET nonce = nonce WHERE id = 1'))
    else:
        raise HTTPException(503, 'Administrative writes require a supported transaction lock.')


def check_version(row, expected):
    if (row.version if row else 0) != expected:
        raise HTTPException(409, 'This record changed. Refresh it before submitting another decision.')


def decision_start(session, actor, permission):
    lock_administration(session)
    return require_permission(session, actor, permission)


def audit(session, actor, action, target_type, target_id, reason, before, after):
    session.add(AdminAudit(actor_id=uid(actor), action=action, target_type=target_type,
                           target_id=str(target_id), reason=reason, before=before, after=after))
    session.flush()


def stamp(value):
    return value.replace(tzinfo=timezone.utc).isoformat() if value and value.tzinfo is None else value.isoformat() if value else None


def user_json(session, user):
    state = session.get(AdminUserState, user.id)
    return {'id': user.id, 'name': user.name, 'email': user.email,
            'role': admin_role(session, user), 'status': state.status if state else 'active',
            'version': state.version if state else 0, 'created_at': stamp(user.created_at)}


def settings_json(session):
    row = session.get(AdminSettings, 1, populate_existing=True)
    return {'maintenance_mode': row.maintenance_mode if row else False,
            'signup_paused': row.signup_paused if row else False,
            'banner': row.banner if row else '', 'version': row.version if row else 0}


def require_registration_open(session):
    flags = settings_json(session)
    if flags['signup_paused'] or flags['maintenance_mode']:
        raise HTTPException(503, 'New registrations are temporarily paused. Please try again later.')


def require_mutations_open(session, user):
    enforce_account_active(session, user)
    if settings_json(session)['maintenance_mode'] and admin_role(session, user) == 'member':
        raise HTTPException(503, 'Ziipa is temporarily in maintenance mode. Please try again later.')


def enforce_content_visible(session, item, viewer_id=None):
    state = session.get(AdminContentState, item.id, populate_existing=True)
    if (item.visibility == 'hidden' or (state and state.hidden)) and item.owner_id != viewer_id:
        raise HTTPException(404, 'Content not found')


def comment_is_visible(session, comment_id):
    state = session.get(AdminCommentState, comment_id, populate_existing=True)
    return not (state and state.hidden)


def comment_json(session, row):
    state = session.get(AdminCommentState, row.id)
    return {'id': row.id, 'item_id': row.item_id, 'owner_id': row.owner_id,
            'body': row.body, 'hidden': bool(state and state.hidden),
            'version': state.version if state else 0, 'created_at': stamp(row.created_at)}


def content_json(session, item):
    state = session.get(AdminContentState, item.id)
    owner = session.get(User, item.owner_id)
    return {'id': item.id, 'title': str(item.data.get('title', ''))[:160],
            'category': str(item.data.get('category', ''))[:30], 'owner_id': item.owner_id,
            'owner_name': owner.name if owner else '', 'visibility': item.visibility,
            'hidden': item.visibility == 'hidden' or bool(state and state.hidden),
            'version': state.version if state else 0, 'created_at': stamp(item.created_at)}


def report_json(session, row):
    state = session.get(AdminReportState, row.id)
    return {'id': row.id, 'item_id': row.item_id, 'comment_id': row.comment_id,
            'target_owner_id': row.target_owner_id, 'reporter_id': row.reporter_id,
            'reason': row.reason, 'details': row.details, 'status': row.status,
            'version': state.version if state else 0, 'created_at': stamp(row.created_at)}


def ordinary_target(session, actor_role, target, *, roles=False):
    target_role = admin_role(session, target)
    if target_role == 'owner':
        raise HTTPException(403, 'The protected owner cannot be changed by the dashboard.')
    if not roles and target_role != 'member':
        raise HTTPException(403, 'Revoke a staff role before changing that account status.')
    if roles and actor_role != 'owner':
        raise HTTPException(403, 'Only the protected owner can manage staff roles.')


def change_role(session, actor, target_id, data):
    actor_role = decision_start(session, actor, 'roles.write')
    target = session.get(User, target_id)
    if not target:
        raise HTTPException(404, 'Account not found')
    ordinary_target(session, actor_role, target, roles=True)
    state = session.get(AdminUserState, target_id, populate_existing=True)
    check_version(state, data.expected_version)
    if state and state.status != 'active' and data.role != 'member':
        raise HTTPException(409, 'Reactivate the account before assigning a staff role.')
    before = {'role': state.role if state else 'member', 'version': state.version if state else 0}
    if state is None:
        state = AdminUserState(user_id=target_id, role=data.role, status='active', version=1)
        session.add(state)
    else:
        state.role, state.version, state.updated_at = data.role, state.version + 1, now()
    audit(session, actor, 'role.changed', 'user', target_id, data.reason, before,
          {'role': state.role, 'version': state.version})
    return user_json(session, target)


def change_status(session, actor, target_id, data):
    actor_role = decision_start(session, actor, 'users.suspend')
    target = session.scalar(select(User).where(User.id == target_id).with_for_update())
    if not target:
        raise HTTPException(404, 'Account not found')
    ordinary_target(session, actor_role, target)
    state = session.get(AdminUserState, target_id, populate_existing=True)
    check_version(state, data.expected_version)
    if state and state.status == 'suspended' and data.status == 'active':
        # A failed earlier Redis revoke must not resurrect an old session after
        # reactivation. Revoke successfully before the active state can commit.
        revoke_sessions(target_id)
    before = {'status': state.status if state else 'active', 'version': state.version if state else 0}
    if state is None:
        state = AdminUserState(user_id=target_id, role='member', status=data.status, version=1)
        session.add(state)
    else:
        state.status, state.version, state.updated_at = data.status, state.version + 1, now()
    if data.status == 'suspended':
        from notification_services import revoke_all_devices
        revoke_all_devices(session, target_id)
    audit(session, actor, 'account.' + data.status, 'user', target_id, data.reason, before,
          {'status': state.status, 'version': state.version})
    return user_json(session, target)


def _can_moderate_target(session, actor_role, owner_id):
    if owner_id is not None and actor_role != 'owner' and admin_role(session, owner_id) != 'member':
        raise HTTPException(403, 'Only the owner can moderate content belonging to staff.')


def change_content(session, actor, item_id, data):
    from creator import CreatorItem
    role = decision_start(session, actor, 'content.moderate')
    item = session.scalar(select(CreatorItem).where(CreatorItem.id == item_id).with_for_update())
    if not item or item.visibility not in ('published', 'hidden'):
        raise HTTPException(404, 'Published or moderated content not found')
    _can_moderate_target(session, role, item.owner_id)
    state = session.get(AdminContentState, item_id, populate_existing=True)
    check_version(state, data.expected_version)
    before = {'visibility': item.visibility, 'version': state.version if state else 0}
    if not data.hidden and (state is None or not state.hidden):
        raise HTTPException(409, 'Only content hidden through this dashboard can be restored.')
    if state is None:
        state = AdminContentState(item_id=item_id, hidden=data.hidden,
            previous_visibility=item.visibility, version=1)
        session.add(state)
    else:
        # Do not turn a legacy hidden row into a public item without a verified
        # prior visibility receipt. Repeated hide decisions preserve that receipt.
        if data.hidden and not state.hidden:
            state.previous_visibility = item.visibility
        state.hidden, state.version, state.updated_at = data.hidden, state.version + 1, now()
    if not data.hidden and state.previous_visibility != 'published':
        raise HTTPException(409, 'The original publication state cannot be safely restored.')
    item.visibility = 'hidden' if data.hidden else state.previous_visibility
    audit(session, actor, 'content.hidden' if data.hidden else 'content.restored', 'item',
          item_id, data.reason, before, {'visibility': item.visibility, 'version': state.version})
    return content_json(session, item)


def change_report(session, actor, report_id, data):
    from mobile_api import ContentReport
    role = decision_start(session, actor, 'reports.triage')
    row = session.scalar(select(ContentReport).where(ContentReport.id == report_id).with_for_update())
    if not row:
        raise HTTPException(404, 'Report not found')
    _can_moderate_target(session, role, row.target_owner_id)
    state = session.get(AdminReportState, report_id, populate_existing=True)
    check_version(state, data.expected_version)
    before = {'status': row.status, 'version': state.version if state else 0}
    if state is None:
        state = AdminReportState(report_id=report_id, version=1)
        session.add(state)
    else:
        state.version, state.updated_at = state.version + 1, now()
    row.status = data.status
    # Triage is not a media deletion, block, external takedown, or implicit hide.
    audit(session, actor, 'report.triaged', 'report', report_id, data.reason, before,
          {'status': row.status, 'version': state.version})
    return report_json(session, row)


def change_comment(session, actor, comment_id, data):
    from creator import CreatorComment, CreatorItem
    role = decision_start(session, actor, 'content.moderate')
    row = session.scalar(select(CreatorComment).where(CreatorComment.id == comment_id).with_for_update())
    if not row:
        raise HTTPException(404, 'Comment not found')
    parent = session.get(CreatorItem, row.item_id)
    # Comments under a private draft are not disclosed by an administrative list
    # or moderation call. Catalog demo comments have no persisted parent.
    if not parent or parent.visibility not in ('published', 'hidden'):
        raise HTTPException(404, 'Published comment not found')
    _can_moderate_target(session, role, row.owner_id)
    state = session.get(AdminCommentState, comment_id, populate_existing=True)
    check_version(state, data.expected_version)
    if not data.hidden and (not state or not state.hidden):
        raise HTTPException(409, 'This comment is not hidden by moderation.')
    before = {'hidden': bool(state and state.hidden), 'version': state.version if state else 0}
    if state is None:
        state = AdminCommentState(comment_id=comment_id, hidden=data.hidden, version=1)
        session.add(state)
    else:
        state.hidden, state.version, state.updated_at = data.hidden, state.version + 1, now()
    audit(session, actor, 'comment.hidden' if data.hidden else 'comment.restored', 'comment',
          comment_id, data.reason, before, {'hidden': state.hidden, 'version': state.version})
    return comment_json(session, row)


def change_settings(session, actor, data):
    decision_start(session, actor, 'settings.write')
    row = session.get(AdminSettings, 1, populate_existing=True)
    check_version(row, data.expected_version)
    before = settings_json(session)
    if row is None:
        row = AdminSettings(id=1, version=1)
        session.add(row)
    else:
        row.version, row.updated_at = row.version + 1, now()
    row.maintenance_mode, row.signup_paused, row.banner = data.maintenance_mode, data.signup_paused, data.banner
    session.flush()
    after = settings_json(session)
    audit(session, actor, 'settings.changed', 'settings', 1, data.reason, before, after)
    return after


def bootstrap_owner(session, *, user_id, email, reason, apply=False, allow_production=False, environment='development'):
    """Exact existing identity only; default path does not issue any write."""
    clean_reason = Decision(expected_version=0, reason=reason).reason
    if environment.lower() not in ('development', 'test') and apply and not allow_production:
        raise ValueError('Production bootstrap requires both --apply and --allow-production.')
    if apply:
        lock_administration(session)
    target = session.get(User, user_id)
    if not target or target.email.casefold() != email.strip().casefold():
        raise ValueError('The explicit existing account ID and email do not match.')
    if environment.lower() not in ('development', 'test'):
        from account_services import AccountState
        state = session.get(AccountState, user_id)
        if not state or not state.email_verified_at:
            raise ValueError('Production ownership requires an existing verified email address.')
    owner = session.get(AdminOwner, 1, populate_existing=True)
    if owner and owner.user_id != user_id:
        raise ValueError('A different protected owner already exists; ownership cannot be replaced.')
    enforce_account_active(session, target)
    result = {'user_id': target.id, 'identity_matched': True, 'already_owner': bool(owner),
              'dry_run': not apply, 'owner_created': False}
    if apply and owner is None:
        session.add(AdminOwner(id=1, user_id=target.id))
        audit(session, target, 'owner.bootstrapped', 'user', target.id, clean_reason,
              {'owner_present': False}, {'owner_present': True})
        result['owner_created'] = True
    return result


def protect_account_deletion(session, user):
    """Call before provider/media deletion. Does not commit or erase audit logs."""
    lock_administration(session)
    if admin_role(session, user) != 'member':
        raise HTTPException(409, 'Protected owner/staff accounts cannot be deleted. Revoke staff access first.')


def delete_admin_account_data(session, user_id):
    """Call after deletion authorization, before deleting items/reports/User."""
    from creator import CreatorItem, CreatorComment
    from mobile_api import ContentReport
    item_ids = select(CreatorItem.id).where(CreatorItem.owner_id == user_id)
    report_ids = select(ContentReport.id).where(or_(ContentReport.reporter_id == user_id,
        ContentReport.target_owner_id == user_id, ContentReport.item_id.in_(item_ids)))
    session.execute(delete(AdminReportState).where(AdminReportState.report_id.in_(report_ids)))
    comment_ids = select(CreatorComment.id).where(or_(CreatorComment.owner_id == user_id,
                                                     CreatorComment.item_id.in_(item_ids)))
    session.execute(delete(AdminCommentState).where(AdminCommentState.comment_id.in_(comment_ids)))
    session.execute(delete(AdminContentState).where(AdminContentState.item_id.in_(item_ids)))
    session.execute(delete(AdminUserState).where(AdminUserState.user_id == user_id))


def export_admin_account_data(session, user_id):
    state = session.get(AdminUserState, user_id)
    return {'role': admin_role(session, user_id), 'status': state.status if state else 'active'}
