"""Isolated role/transaction/migration tests; no provider or real account access."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app as main
import admin_api as api
import admin_services as service
from creator import CreatorItem, CreatorComment
from mobile_api import ContentReport
from notification_services import PushDevice, NotificationDelivery, NotificationEvent

PREFIX = '/api/admin'
WHY = 'Reviewed according to the community policy.'


def create_database(url='sqlite://', **options):
    engine = create_engine(url, **options)
    @event.listens_for(engine, 'connect')
    def foreign_keys(connection, record):
        connection.execute('PRAGMA foreign_keys=ON')
    main.Base.metadata.create_all(engine)
    return engine, sessionmaker(engine)


@pytest.fixture
def harness(monkeypatch):
    engine, factory = create_database(poolclass=StaticPool, connect_args={'check_same_thread': False})
    with factory() as session:
        users = [main.User(name=name, email=name + '@example.test', password_hash='private-never-export')
                 for name in ('owner', 'admin', 'moderator', 'member', 'other')]
        session.add_all(users); session.flush()
        owner, admin, moderator, member, other = users
        service.bootstrap_owner(session, user_id=owner.id, email=owner.email, reason=WHY, apply=True)
        session.add_all([service.AdminUserState(user_id=admin.id, role='admin', status='active'),
                         service.AdminUserState(user_id=moderator.id, role='moderator', status='active')])
        session.commit()
        for user in users:
            session.refresh(user)
        chosen = {'user': owner}
        test_app = FastAPI()
        test_app.include_router(api.router)
        test_app.include_router(api.platform_router)
        test_app.dependency_overrides[main.current_user] = lambda: chosen['user']
        test_app.dependency_overrides[main.guard] = lambda: None
        def db():
            with factory() as request_session:
                yield request_session
        test_app.dependency_overrides[main.db] = db
        revoked = []
        monkeypatch.setattr(service, 'revoke_sessions', lambda user_id: revoked.append(user_id))
        with TestClient(test_app, raise_server_exceptions=False) as client:
            yield SimpleNamespace(engine=engine, factory=factory, session=session, owner=owner,
                admin=admin, moderator=moderator, member=member, other=other,
                users=users, chosen=chosen, client=client, revoked=revoked, app=test_app)
    engine.dispose()


def decision(**updates):
    return {'expected_version': 0, 'reason': WHY, **updates}


def item(h, owner=None, visibility='published'):
    row = CreatorItem(owner_id=(owner or h.member).id, visibility=visibility,
        data={'title': 'A public film', 'category': 'video', 'media_id': 'private-media-id',
              'storage_secret': 'do-not-serialize', 'caption': 'do-not-export'})
    h.session.add(row); h.session.commit()
    return row


def report(h, content):
    row = ContentReport(reporter_id=h.other.id, target_owner_id=content.owner_id,
        item_id=content.id, reason='spam', details='Repeated unwanted advertisement.')
    h.session.add(row); h.session.commit()
    return row


def count(h, model):
    with h.factory() as session:
        return session.scalar(select(func.count()).select_from(model))


@pytest.mark.parametrize('role', ['member', 'moderator', 'admin', 'owner'])
def test_role_permission_matrix_no_email_header_or_signup_escalation(harness, role):
    h = harness; h.chosen['user'] = getattr(h, role)
    result = h.client.get(PREFIX + '/me', headers={'X-Admin-Role': 'owner', 'X-Role': 'owner'})
    assert result.status_code == 200
    assert result.json()['role'] == role
    assert result.json()['permissions'] == list(service.PERMISSIONS[role])
    assert result.headers['cache-control'] == 'private, no-store'
    for route, permission in (('overview', 'overview.read'), ('users', 'users.read'),
        ('content', 'content.read'), ('reports', 'reports.read'),
        ('settings', 'settings.read'), ('audit', 'audit.read')):
        assert h.client.get(PREFIX + '/' + route).status_code == (200 if permission in service.PERMISSIONS[role] else 403)
    if role != 'owner':
        result = h.client.patch(PREFIX + f'/users/{h.other.id}/role', json=decision(role='admin'))
        assert result.status_code == 403


def test_missing_auth_is_not_administrator(harness):
    h = harness
    h.app.dependency_overrides[main.current_user] = lambda: (_ for _ in ()).throw(HTTPException(401, 'Sign in'))
    assert h.client.get(PREFIX + '/me').status_code == 401
    assert h.client.get(PREFIX + '/users').status_code == 401


def test_owner_grants_revokes_roles_with_versions_and_cannot_replace_owner(harness):
    h = harness
    path = PREFIX + f'/users/{h.member.id}/role'
    result = h.client.patch(path, json=decision(role='admin'))
    assert result.status_code == 200
    assert (result.json()['role'], result.json()['version']) == ('admin', 1)
    assert h.client.patch(path, json=decision(role='moderator')).status_code == 409
    result = h.client.patch(path, json=decision(role='moderator', expected_version=1))
    assert result.json()['role'] == 'moderator'
    assert h.client.patch(path, json=decision(role='member', expected_version=2)).json()['role'] == 'member'
    assert h.client.patch(PREFIX + f'/users/{h.owner.id}/role', json=decision(role='member')).status_code == 403
    assert h.client.patch(path, json=decision(role='owner', expected_version=3)).status_code == 422
    assert count(h, service.AdminAudit) == 4  # Bootstrap plus three decisions.
    h.chosen['user'] = h.admin
    assert h.client.patch(PREFIX + f'/users/{h.moderator.id}/status',
                          json=decision(status='suspended', expected_version=1)).status_code == 403


@pytest.mark.parametrize('changes', [
    {'reason': ' ' * 10}, {'reason': 'four'}, {'reason': 'bad\nreason'},
    {'expected_version': True}, {'expected_version': '0'}, {'expected_version': -1},
    {'role': 'owner'}, {'password_hash': 'x'}, {'user_id': 1},
])
def test_strict_decision_inputs(harness, changes):
    assert harness.client.patch(PREFIX + f'/users/{harness.member.id}/role',
        json=decision(role='admin', **{k:v for k,v in changes.items() if k != 'role'})
        if 'role' not in changes else decision(**changes)).status_code == 422


def test_search_pagination_literal_wildcards_and_no_secret_export(harness):
    h = harness
    rows = h.client.get(PREFIX + '/users?page_size=2&page=2').json()
    assert rows['total'] == 5 and rows['page'] == 2 and len(rows['items']) == 2
    assert h.client.get(PREFIX + '/users?q=member').json()['total'] == 1
    assert h.client.get(PREFIX + '/users?q=%25').json()['total'] == 0
    assert h.client.get(PREFIX + '/users?page_size=101').status_code == 422
    for route in ('users', 'audit'):
        raw = h.client.get(PREFIX + '/' + route).text
        assert 'password_hash' not in raw and 'private-never-export' not in raw
    public, private = item(h), item(h, visibility='draft')
    raw = h.client.get(PREFIX + '/content').text
    assert public.id in raw and private.id not in raw
    assert 'do-not-serialize' not in raw and 'private-media-id' not in raw and 'media_url' not in raw
    h.chosen['user'] = h.moderator
    assert h.client.get(PREFIX + '/overview').json()['users'] is None


def test_suspend_authoritative_revoke_devices_and_no_reactivation_with_redis_failure(harness, monkeypatch):
    h = harness
    device = PushDevice(id=str(uuid.uuid4()), owner_id=h.member.id, provider='web',
        session_key='not-real-session', fingerprint='private-hash', endpoint_cipher='private-cipher',
        installation_id=str(uuid.uuid4()), label='Test device', status='active', revision=1)
    h.session.add(device); h.session.commit()
    def unavailable(_):
        raise HTTPException(503, 'Session service unavailable')
    monkeypatch.setattr(service, 'revoke_sessions', unavailable)
    path = PREFIX + f'/users/{h.member.id}/status'
    result = h.client.patch(path, json=decision(status='suspended'))
    assert result.status_code == 200 and result.json()['session_revocation_pending'] is True
    with h.factory() as session:
        assert service.account_is_active(session, h.member.id) is False
        assert service.account_is_active(session, 99999) is False
        revoked = session.get(PushDevice, device.id)
        assert revoked.status == 'revoked' and revoked.endpoint_cipher == ''
        with pytest.raises(HTTPException):
            service.enforce_account_active(session, h.member)
    assert h.client.patch(path, json=decision(status='active', expected_version=1)).status_code == 503
    assert count(h, service.AdminAudit) == 2
    h.chosen['user'] = h.member
    assert h.client.get(PREFIX + '/me').status_code == 403
    h.chosen['user'] = h.owner
    assert h.client.patch(PREFIX + f'/users/{h.member.id}/role',
                          json=decision(role='admin', expected_version=1)).status_code == 409
    monkeypatch.setattr(service, 'revoke_sessions', lambda uid: None)
    result = h.client.patch(path, json=decision(status='active', expected_version=1))
    assert result.status_code == 200 and result.json()['status'] == 'active'
    assert h.client.patch(PREFIX + f'/users/{h.owner.id}/status', json=decision(status='suspended')).status_code == 403


def test_hide_restore_and_report_triage_are_audited_non_destructive(harness):
    h = harness; content = item(h); complaint = report(h, content)
    h.chosen['user'] = h.moderator
    route = PREFIX + f'/content/{content.id}/visibility'
    assert h.client.patch(route, json=decision(hidden=True)).json()['hidden'] is True
    with h.factory() as session:
        stored = session.get(CreatorItem, content.id)
        assert stored.visibility == 'hidden'
        service.enforce_content_visible(session, stored, viewer_id=h.member.id)
        with pytest.raises(HTTPException):
            service.enforce_content_visible(session, stored, viewer_id=h.other.id)
    assert h.client.patch(route, json=decision(hidden=False)).status_code == 409
    restored = h.client.patch(route, json=decision(hidden=False, expected_version=1)).json()
    assert restored['visibility'] == 'published' and restored['version'] == 2
    triage = PREFIX + f'/reports/{complaint.id}'
    assert h.client.patch(triage, json=decision(status='reviewing')).json()['status'] == 'reviewing'
    assert h.client.patch(triage, json=decision(status='resolved')).status_code == 409
    assert h.client.patch(triage, json=decision(status='resolved', expected_version=1)).json()['status'] == 'resolved'
    assert count(h, CreatorItem) == 1 and count(h, ContentReport) == 1
    with h.factory() as session:
        assert session.get(CreatorItem, content.id).visibility == 'published'
    staff_item = item(h, owner=h.admin)
    assert h.client.patch(PREFIX + f'/content/{staff_item.id}/visibility', json=decision(hidden=True)).status_code == 403
    assert count(h, service.AdminAudit) == 5


def test_private_and_legacy_hidden_content_cannot_be_accidentally_published(harness):
    h = harness
    for visibility in ('draft', 'hidden'):
        content = item(h, visibility=visibility)
        assert h.client.patch(PREFIX + f'/content/{content.id}/visibility',
                              json=decision(hidden=False)).status_code in (404, 409)
    assert count(h, service.AdminAudit) == 1


def test_settings_atomic_versions_safe_fields_and_gates(harness):
    h = harness; h.chosen['user'] = h.admin
    initial = h.client.get(PREFIX + '/settings').json()
    assert initial == {'maintenance_mode': False, 'signup_paused': False, 'banner': '', 'version': 0}
    changes = decision(maintenance_mode=True, signup_paused=True, banner='Scheduled maintenance.')
    assert h.client.put(PREFIX + '/settings', json={**changes, 'api_key': 'forbidden'}).status_code == 422
    assert h.client.put(PREFIX + '/settings', json=changes).json()['version'] == 1
    assert h.client.put(PREFIX + '/settings', json=changes).status_code == 409
    with h.factory() as session:
        with pytest.raises(HTTPException):
            service.require_registration_open(session)
        with pytest.raises(HTTPException):
            service.require_mutations_open(session, h.member)
        service.require_mutations_open(session, h.owner)
    h.chosen['user'] = h.moderator
    assert h.client.put(PREFIX + '/settings', json={**changes, 'expected_version': 1}).status_code == 403


def test_public_platform_status_only_publishes_safe_flags(harness):
    h = harness
    h.app.dependency_overrides[main.current_user] = lambda: (_ for _ in ()).throw(HTTPException(401, 'Sign in'))
    result = h.client.get('/api/platform/status')
    assert result.status_code == 200
    assert result.headers['cache-control'] == 'private, no-store'
    assert result.json() == {'maintenance_mode': False, 'signup_paused': False, 'banner': '', 'version': 0}


def test_comments_hide_restore_preserve_body_and_report_independence(harness):
    h = harness; content = item(h)
    comment = CreatorComment(owner_id=h.other.id, item_id=content.id, body='Example reported comment')
    h.session.add(comment); h.session.commit()
    h.chosen['user'] = h.moderator
    path = PREFIX + f'/comments/{comment.id}/visibility'
    assert h.client.get(PREFIX + f'/comments?comment_id={comment.id}').json()['items'][0]['body'] == comment.body
    assert h.client.patch(path, json=decision(hidden=True)).json()['hidden'] is True
    with h.factory() as session:
        assert not service.comment_is_visible(session, comment.id)
        assert session.get(CreatorComment, comment.id).body == comment.body
    assert h.client.patch(path, json=decision(hidden=False)).status_code == 409
    assert h.client.patch(path, json=decision(hidden=False, expected_version=1)).json()['hidden'] is False
    assert count(h, CreatorComment) == 1
    private = item(h, visibility='draft')
    secret = CreatorComment(owner_id=h.member.id, item_id=private.id, body='Private draft comment')
    h.session.add(secret); h.session.commit()
    assert h.client.get(PREFIX + f'/comments?comment_id={secret.id}').json()['items'] == []
    assert h.client.patch(PREFIX + f'/comments/{secret.id}/visibility', json=decision(hidden=True)).status_code == 404


def test_security_helpers_refresh_cached_administration_state(harness):
    h = harness; content = item(h)
    h.client.patch(PREFIX + f'/users/{h.member.id}/status', json=decision(status='suspended'))
    h.client.patch(PREFIX + f'/content/{content.id}/visibility', json=decision(hidden=True))
    with h.factory() as session:
        assert service.account_is_active(session, h.member.id) is False
        cached = session.get(service.AdminContentState, content.id)
        with pytest.raises(HTTPException):
            service.enforce_content_visible(session, content)
        h.client.patch(PREFIX + f'/users/{h.member.id}/status', json=decision(status='active', expected_version=1))
        h.client.patch(PREFIX + f'/content/{content.id}/visibility', json=decision(hidden=False, expected_version=1))
        assert service.account_is_active(session, h.member.id) is True
        service.enforce_content_visible(session, content)
        assert cached.hidden is False


def test_failed_audit_rolls_back_decision(harness, monkeypatch):
    h = harness
    def fail(*args, **kwargs):
        raise RuntimeError('simulated append failure')
    monkeypatch.setattr(service, 'audit', fail)
    result = h.client.patch(PREFIX + f'/users/{h.member.id}/role', json=decision(role='admin'))
    assert result.status_code == 500
    with h.factory() as session:
        assert service.admin_role(session, h.member) == 'member'
        assert session.get(service.AdminUserState, h.member.id) is None
    assert count(h, service.AdminAudit) == 1


def test_owner_and_audit_database_immutability_bulk_sql_and_fk(harness):
    h = harness
    for statement in ("UPDATE admin_owner SET user_id = 2 WHERE id=1",
                      "DELETE FROM admin_owner",
                      "UPDATE admin_audit SET reason = 'replacement'",
                      "DELETE FROM admin_audit"):
        with h.factory() as session:
            with pytest.raises(DBAPIError):
                session.execute(text(statement))
            session.rollback()
    with h.factory() as session:
        with pytest.raises(IntegrityError):
            session.add(service.AdminOwner(id=2, user_id=h.other.id)); session.flush()
        session.rollback()
        with pytest.raises(IntegrityError):
            session.execute(text('DELETE FROM users WHERE id=:id'), {'id': h.owner.id})
        session.rollback()
    assert count(h, service.AdminOwner) == 1 and count(h, service.AdminAudit) == 1


def test_owner_bootstrap_identity_production_guard_dry_run_and_immutability(tmp_path):
    engine, factory = create_database('sqlite:///' + str(tmp_path / 'bootstrap.db'))
    with factory() as session:
        first = main.User(name='First signup', email='first@example.test', password_hash='unused')
        chosen = main.User(name='Chosen account', email='chosen@example.test', password_hash='unused')
        session.add_all([first, chosen]); session.commit()
        assert service.admin_role(session, first) == 'member'
        args = dict(user_id=chosen.id, email=chosen.email, reason=WHY, environment='production')
        with pytest.raises(ValueError, match='verified email'):
            service.bootstrap_owner(session, **args)
        from account_services import AccountState
        session.add(AccountState(owner_id=chosen.id, email_verified_at=service.now()))
        session.commit()
        assert service.bootstrap_owner(session, **args)['dry_run'] is True
        assert session.scalar(select(func.count()).select_from(service.AdminMutex)) == 0
        assert session.scalar(select(func.count()).select_from(service.AdminOwner)) == 0
        with pytest.raises(ValueError):
            service.bootstrap_owner(session, **{**args, 'email': first.email})
        with pytest.raises(ValueError):
            service.bootstrap_owner(session, **args, apply=True)
        service.bootstrap_owner(session, **args, apply=True, allow_production=True); session.commit()
        assert service.bootstrap_owner(session, **args, apply=True, allow_production=True)['already_owner']
        with pytest.raises(ValueError):
            service.bootstrap_owner(session, user_id=first.id, email=first.email, reason=WHY, apply=True)
        session.rollback()
        assert session.scalar(select(func.count()).select_from(service.AdminAudit)) == 1
    engine.dispose()


def test_bootstrap_cli_dry_run_and_explicit_production_apply(tmp_path, monkeypatch, capsys):
    import bootstrap_owner
    engine, factory = create_database('sqlite:///' + str(tmp_path / 'bootstrap-cli.db'))
    with factory() as session:
        owner = main.User(name='Existing account', email='existing@example.test', password_hash='never-output')
        session.add(owner); session.commit()
        owner_id = owner.id
        from account_services import AccountState
        session.add(AccountState(owner_id=owner_id, email_verified_at=service.now()))
        session.commit()
    monkeypatch.setattr(main, 'SessionLocal', factory)
    monkeypatch.setattr(main.settings, 'environment', 'production')
    args = ['--user-id', str(owner_id), '--email', 'existing@example.test', '--reason', WHY]
    assert bootstrap_owner.main(args) == 0
    with factory() as session:
        assert session.get(service.AdminOwner, 1) is None
    assert bootstrap_owner.main(args + ['--apply']) == 1
    assert bootstrap_owner.main(args + ['--apply', '--allow-production']) == 0
    output = capsys.readouterr().out
    assert 'existing@example.test' not in output and 'never-output' not in output
    with factory() as session:
        assert session.get(service.AdminOwner, 1).user_id == owner_id
    engine.dispose()


def test_concurrent_owner_bootstrap_and_role_versions(tmp_path):
    engine, factory = create_database('sqlite:///' + str(tmp_path / 'race.db'),
        connect_args={'timeout': 10, 'check_same_thread': False})
    with factory() as session:
        users = [main.User(name=str(i), email=f'{i}@example.test', password_hash='unused') for i in range(3)]
        session.add_all(users); session.commit()
        ids = [user.id for user in users]
    def bootstrap(index):
        with factory() as session:
            try:
                service.bootstrap_owner(session, user_id=ids[index], email=f'{index}@example.test', reason=WHY, apply=True)
                session.commit(); return True
            except ValueError:
                session.rollback(); return False
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(bootstrap, (0, 1))) == [False, True]
    with factory() as session:
        owner_id = session.get(service.AdminOwner, 1).user_id
    def grant(role):
        with factory() as session:
            try:
                result = service.change_role(session, session.get(main.User, owner_id), ids[2],
                    service.RoleDecision(**decision(role=role)))
                session.commit(); return result['version']
            except HTTPException as exc:
                session.rollback(); return exc.status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(grant, ('admin', 'moderator'))) == [1, 409]
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(service.AdminOwner)) == 1
        assert session.scalar(select(func.count()).select_from(service.AdminAudit)) == 2
    engine.dispose()


def test_deletion_preserves_audit_and_protected_owner(harness):
    h = harness; content = item(h); complaint = report(h, content)
    h.client.patch(PREFIX + f'/content/{content.id}/visibility', json=decision(hidden=True))
    h.client.patch(PREFIX + f'/reports/{complaint.id}', json=decision(status='dismissed'))
    with h.factory() as session:
        for user in (h.owner, h.admin, h.moderator):
            with pytest.raises(HTTPException):
                service.protect_account_deletion(session, user)
            session.rollback()
        service.protect_account_deletion(session, h.member)
        service.delete_admin_account_data(session, h.member.id); session.commit()
        assert session.get(service.AdminContentState, content.id) is None
        assert session.get(service.AdminReportState, complaint.id) is None
        assert session.scalar(select(func.count()).select_from(service.AdminAudit)) == 3


def test_fresh_and_repeated_migration_installs_guards_without_assigning_owner(tmp_path):
    import render_migrate
    engine = create_engine('sqlite:///' + str(tmp_path / 'migration.db'))
    render_migrate.upgrade_database(engine)
    render_migrate.upgrade_database(engine)
    with engine.connect() as connection:
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == '20261020_0013'
        assert connection.scalar(text('SELECT COUNT(*) FROM admin_owner')) == 0
        triggers = set(connection.scalars(text("SELECT name FROM sqlite_master WHERE type='trigger'")))
        assert {'admin_owner_deny_update', 'admin_owner_deny_delete',
                'admin_audit_deny_update', 'admin_audit_deny_delete'} <= triggers
    path = Path(__file__).parent / 'migrations/versions/20261020_0012_administration.py'
    spec = importlib.util.spec_from_file_location('admin_migration_test', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    with pytest.raises(RuntimeError, match='preserve'):
        module.downgrade()
    engine.dispose()


def test_postgresql_immutable_ddl_qualifies_translated_table_and_function():
    from sqlalchemy.dialects import postgresql
    statements = []
    connection = SimpleNamespace(dialect=postgresql.dialect(),
        schema_for_object=lambda table: 'test"tenant',
        scalar=lambda statement: pytest.fail('Translated schema must not fall back to search_path'),
        exec_driver_sql=statements.append)
    service._create_immutable_pg(service.AdminAudit.__table__, connection)
    service._drop_immutable_pg(service.AdminAudit.__table__, connection)
    assert statements == [
        'CREATE FUNCTION "test""tenant".admin_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ '
        "BEGIN RAISE EXCEPTION 'Immutable administrative record'; END; $$",
        'CREATE TRIGGER admin_audit_immutable BEFORE UPDATE OR DELETE ON "test""tenant".admin_audit '
        'FOR EACH ROW EXECUTE FUNCTION "test""tenant".admin_audit_immutable()',
        'DROP FUNCTION IF EXISTS "test""tenant".admin_audit_immutable()',
    ]


def test_postgresql_immutable_ddl_resolves_untranslated_current_schema():
    from sqlalchemy.dialects import postgresql
    statements = []; queries = []
    connection = SimpleNamespace(dialect=postgresql.dialect(),
        schema_for_object=lambda table: None,
        scalar=lambda statement: queries.append(str(statement)) or 'public',
        exec_driver_sql=statements.append)
    service._create_immutable_pg(service.AdminOwner.__table__, connection)
    assert queries == ['SELECT current_schema()']
    assert statements[0].startswith('CREATE FUNCTION public.admin_owner_immutable()')
    assert 'ON public.admin_owner ' in statements[1]
    assert 'FUNCTION public.admin_owner_immutable()' in statements[1]
