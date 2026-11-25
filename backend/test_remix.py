"""Remix authority, idempotency, publication and migration tests, with no provider traffic."""
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
import uuid

from alembic import command
from alembic.script import ScriptDirectory
from fastapi import HTTPException, Response
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import sessionmaker

from app import Base, User
import creator
from creator import CreatorItem, CreatorMedia, CreatorPreferences, ItemInput
from account_services import AccountState
from admin_services import AdminContentState, AdminUserState, AdminSettings
from personal_media import OSAssetMetadata
from profile_follows import CreatorFollow
from render_services import RenderJob
import remix_api as api
import remix_services as remix
import render_migrate as migration


@pytest.fixture
def setup(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'remix.sqlite'), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    monkeypatch.setattr(api, 'readiness', lambda: {'can_remix': True})
    monkeypatch.setattr('render_services.readiness', lambda: {'can_remix': True})
    monkeypatch.setattr(api, 'notify_worker', lambda: None)
    monkeypatch.setattr('media_workflows.notify_workflows', lambda *args: None)
    with factory() as session:
        users = [User(name=name, email=name.lower() + '@example.test', password_hash='unused')
                 for name in ('Source', 'Response', 'Stranger')]
        session.add_all(users); session.flush()
        source_media = CreatorMedia(id=str(uuid.uuid4()), owner_id=users[0].id, content_type='video/mp4', size=100)
        response_media = CreatorMedia(id=str(uuid.uuid4()), owner_id=users[1].id, content_type='video/mp4', size=150)
        source = CreatorItem(id=str(uuid.uuid4()), owner_id=users[0].id, visibility='published',
            data=ItemInput(title='Original', media_id=source_media.id, trim_start=2, trim_end=10,
                           visibility='published').model_dump())
        session.add_all([source_media, response_media, source]); session.commit()
        yield session, users, source, response_media, factory
    engine.dispose()


def allow(setup, audience='everyone', modes=None):
    session, users, source, _, _ = setup
    api.set_policy(uuid.UUID(source.id), api.PolicyInput(revision=0, audience=audience,
                   modes=modes or list(remix.MODES)), users[0], session)


def request(setup, **overrides):
    return api.ProjectInput(**{'request_id': uuid.uuid4(), 'mode': 'stitch', 'source_start': 1,
        'source_seconds': 3, 'response_media_id': setup[3].id, 'title': 'Response',
        'rights_confirmed': True, **overrides})


def queue(setup, **overrides):
    session, users, source, _, _ = setup
    result = api.create_project(uuid.UUID(source.id), request(setup, **overrides), users[1], session)
    return session.get(remix.RemixProject, result['item_id']), session.get(RenderJob, result['job_id'])


def ready(setup, project, job):
    session = setup[0]
    session.add(CreatorMedia(id=job.output_media_id, owner_id=project.owner_id, content_type='video/mp4', size=300))
    job.status, job.output_sha256 = 'ready', 'a' * 64
    remix.record_remix_provenance(session, job, source_sha256='b' * 64, response_sha256='c' * 64)
    session.commit()


def test_default_deny_owner_policy_and_worker_gate(setup, monkeypatch):
    session, users, source, _, _ = setup
    assert remix.item_info(session, source, users[1].id)['allowed_modes'] == []
    assert remix.item_info(session, source, users[1].id)['policy'] is None
    assert remix.item_info(session, source, users[0].id)['policy']['revision'] == 0
    with pytest.raises(HTTPException) as error:
        queue(setup)
    assert error.value.status_code == 403
    allow(setup)
    monkeypatch.setattr(api, 'readiness', lambda: {'can_render': True, 'can_remix': False})
    with pytest.raises(HTTPException) as error:
        queue(setup)
    assert error.value.status_code == 503


def test_unpublished_source_cannot_start_a_remix_even_for_its_owner(setup):
    session, users, source, _, _ = setup
    source.visibility = 'draft'
    session.commit()
    assert remix.item_info(session, source, users[0].id)['allowed_modes'] == []
    source_media_id = source.data['media_id']
    with pytest.raises(HTTPException) as error:
        api.create_project(uuid.UUID(source.id), request(setup, response_media_id=source_media_id),
                           users[0], session)
    assert error.value.status_code == 403


def test_policy_requires_owner_revision_and_modes(setup):
    session, users, source, _, _ = setup
    with pytest.raises(HTTPException) as error:
        api.set_policy(uuid.UUID(source.id), api.PolicyInput(revision=0, audience='everyone', modes=['stitch']), users[1], session)
    assert error.value.status_code == 404
    allow(setup)
    with pytest.raises(HTTPException) as error:
        allow(setup)
    assert error.value.status_code == 409
    with pytest.raises(ValidationError):
        api.PolicyInput(revision=1, audience='everyone', modes=['stitch', 'stitch'])


def test_followers_only_and_mutual_blocks(setup):
    session, users, source, _, _ = setup
    allow(setup, audience='followers')
    with pytest.raises(HTTPException):
        queue(setup)
    follow = CreatorFollow(follower_id=users[1].id, creator_id=users[0].id, status='pending')
    session.add(follow); session.commit()
    assert remix.permitted_modes(session, source, users[1].id) == []
    follow.status = 'accepted'; session.commit()
    project, job = queue(setup)
    assert remix.current_source_fingerprint(session, job) == job.input_fingerprint
    session.add(CreatorPreferences(owner_id=users[0].id, data={'blocked_user_ids': [users[1].id]})); session.commit()
    assert remix.current_source_fingerprint(session, job) is None
    with pytest.raises(HTTPException):
        api.get_item(uuid.UUID(source.id), Response(), users[1], session)


def test_queue_snapshot_private_trim_relative_and_idempotent(setup):
    session, users, source, _, _ = setup
    allow(setup)
    data = request(setup)
    first = api.create_project(uuid.UUID(source.id), data, users[1], session)
    again = api.create_project(uuid.UUID(source.id), data, users[1], session)
    assert first == again
    job = session.get(RenderJob, first['job_id'])
    assert job.snapshot['schema'] == 4 and job.snapshot['remix']['source_start'] == 3
    assert job.snapshot['remix']['source_seconds'] == 3
    item = session.get(CreatorItem, first['item_id'])
    assert item.visibility == 'draft' and item.data['remix_of'] == source.id
    assert len(session.scalars(select(RenderJob)).all()) == 1
    with pytest.raises(HTTPException) as error:
        api.create_project(uuid.UUID(source.id), data.model_copy(update={'title': 'Changed'}), users[1], session)
    assert error.value.status_code == 409


def test_concurrent_same_request_commits_one_project_and_render(setup):
    session, users, source, _, factory = setup
    allow(setup)
    owner_id, source_id, data = users[1].id, source.id, request(setup)
    session.commit()
    def submit(_):
        with factory() as other:
            return api.create_project(uuid.UUID(source_id), data, other.get(User, owner_id), other)
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(submit, range(2)))
    assert receipts[0] == receipts[1]
    assert len(session.scalars(select(remix.RemixProject)).all()) == 1
    assert len(session.scalars(select(RenderJob)).all()) == 1


def test_http_contract_auth_validation_and_private_owner_policy(setup):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import current_user, db, guard
    session, users, source, _, _ = setup
    app = FastAPI(); app.include_router(api.router)
    app.dependency_overrides[db] = lambda: session
    app.dependency_overrides[guard] = lambda: None
    with TestClient(app) as client:
        assert client.get('/api/remix/items/' + source.id).status_code == 401
        app.dependency_overrides[current_user] = lambda: users[0]
        owner = client.get('/api/remix/items/' + source.id)
        assert owner.status_code == 200 and owner.json()['policy']['revision'] == 0
        assert owner.headers['Cache-Control'] == 'private, no-store'
        app.dependency_overrides[current_user] = lambda: users[1]
        assert client.get('/api/remix/items/' + source.id).json()['policy'] is None
        invalid = request(setup).model_dump(mode='json'); invalid['rights_confirmed'] = False
        assert client.post('/api/remix/items/' + source.id + '/projects', json=invalid).status_code == 422
        assert client.post('/api/remix/items/' + source.id + '/projects', json=request(setup).model_dump(mode='json')).status_code == 403


@pytest.mark.parametrize('values', [dict(source_seconds=6), dict(source_start=88, source_seconds=5),
    dict(source_start=float('nan')), dict(rights_confirmed=False), dict(source_seconds=1.00001)])
def test_reject_bad_request_bounds(setup, values):
    with pytest.raises(ValidationError):
        request(setup, **values)


def test_trim_end_and_wrong_response_owner_fail_closed(setup):
    session, users, _, response, _ = setup
    allow(setup)
    with pytest.raises(HTTPException) as error:
        queue(setup, source_start=6, source_seconds=3)
    assert error.value.status_code == 422
    response.owner_id = users[2].id; session.commit()
    with pytest.raises(HTTPException) as error:
        queue(setup)
    assert error.value.status_code == 404


@pytest.mark.parametrize('change', [dict(overlays=[{'id': 'x', 'text': 'hidden region', 'position': 'center', 'theme': 'purple'}]),
                                  dict(captions=[{'start': 2, 'end': 3, 'text': 'caption'}]),
                                  dict(visual_effect='grayscale')])
def test_complex_source_requires_baked_output(setup, change):
    session, _, source, _, _ = setup
    source.data = {**source.data, **change}; session.commit()
    with pytest.raises(HTTPException):
        allow(setup)


@pytest.mark.parametrize('revocation', ['policy', 'trim', 'unpublish', 'suspend', 'moderate', 'expired', 'private'])
def test_revocation_invalidates_processing_apply_and_publication(setup, revocation):
    session, users, source, _, factory = setup
    allow(setup)
    project, job = queue(setup)
    ready(setup, project, job)
    # A separate transaction also proves stale ORM caches are not authority.
    session.commit()
    with factory() as other:
        parent = other.get(CreatorItem, source.id)
        if revocation == 'policy':
            policy = other.get(remix.RemixPolicy, source.id); policy.revision += 1; policy.audience = 'disabled'
        elif revocation == 'trim':
            parent.data = {**parent.data, 'trim_start': 4}
        elif revocation == 'unpublish':
            parent.visibility = 'draft'
        elif revocation == 'suspend':
            other.add(AdminUserState(user_id=users[0].id, status='suspended'))
        elif revocation == 'moderate':
            other.add(AdminContentState(item_id=source.id, hidden=True))
        elif revocation == 'expired':
            other.add(OSAssetMetadata(owner_id=users[0].id, item_id=source.id,
                rights={'basis': 'permission', 'expires_at': (remix.now() - timedelta(seconds=1)).isoformat()}))
        elif revocation == 'private':
            other.add(AccountState(owner_id=users[0].id, privacy={'profile_visibility': 'private'}))
        other.commit()
    assert remix.current_source_fingerprint(session, job) is None
    assert remix.project_receipt(session, project)['status'] == 'stale'
    with pytest.raises(HTTPException):
        api.apply_project(uuid.UUID(project.item_id), users[1], session)


def test_apply_idempotent_private_provenance_and_cannot_strip_lineage(setup):
    session, users, source, _, _ = setup
    allow(setup)
    project, job = queue(setup)
    with pytest.raises(HTTPException):
        api.apply_project(uuid.UUID(project.item_id), users[1], session)
    ready(setup, project, job)
    result = api.apply_project(uuid.UUID(project.item_id), users[1], session)
    assert result['visibility'] == 'draft' and result['media_id'] == job.output_media_id
    assert api.apply_project(uuid.UUID(project.item_id), users[1], session)['id'] == result['id']
    assert remix.project_receipt(session, project)['status'] == 'applied'
    item = session.get(CreatorItem, project.item_id)
    remix.enforce_remix_publication(session, item)
    with pytest.raises(HTTPException):
        creator.save_item(ItemInput(title='No attribution', remix_of=None), session, users[1], item)
    with pytest.raises(HTTPException):
        creator.save_item(ItemInput(title='Disguised copy', media_id=job.output_media_id), session, users[1])
    assert project.source_sha256 == 'b' * 64 and project.result_sha256 == 'a' * 64
    project.parent_id = str(uuid.uuid4())
    with pytest.raises(ValueError):
        session.flush()
    session.rollback()


def test_legacy_attribution_editable_but_new_forgery_rejected(setup):
    session, users, source, response, _ = setup
    legacy = CreatorItem(owner_id=users[1].id, visibility='draft',
                        data=ItemInput(title='Legacy', media_id=response.id, remix_of=source.id).model_dump())
    session.add(legacy); session.commit()
    source.visibility = 'draft'; session.commit()
    result = creator.save_item(ItemInput(title='Renamed legacy'), session, users[1], legacy)
    assert result['title'] == 'Renamed legacy' and result['remix_of'] == source.id
    with pytest.raises(HTTPException):
        creator.save_item(ItemInput(title='Forged', media_id=response.id, remix_of=source.id), session, users[1])


def test_hidden_attribution_and_children_are_not_disclosed(setup):
    session, users, source, _, _ = setup
    allow(setup)
    project, job = queue(setup); ready(setup, project, job)
    api.apply_project(uuid.UUID(project.item_id), users[1], session)
    item = session.get(CreatorItem, project.item_id)
    item.visibility = 'published'; session.commit()
    assert remix.item_info(session, source, users[2].id)['children'][0]['id'] == item.id
    source.visibility = 'draft'; session.commit()
    info = remix.item_info(session, item, users[1].id)
    assert info['attribution'] == {'parent': None, 'root': None}
    assert not remix.remix_is_visible(session, item, users[2].id)
    with pytest.raises(HTTPException):
        remix.assert_external_export_allowed(session, item.id)


def test_deleted_parent_retains_identity_and_invalidates_child(setup):
    session, users, source, _, _ = setup
    allow(setup)
    project, job = queue(setup)
    parent_id = source.id
    session.delete(source); session.commit()
    session.refresh(project)
    assert project.parent_id == project.root_id == parent_id
    assert remix.current_source_fingerprint(session, job) is None
    with pytest.raises(HTTPException):
        api.get_project(uuid.UUID(project.item_id), Response(), users[2], session)


def test_viewer_must_see_source_even_when_remixer_still_can(setup):
    session, users, source, _, _ = setup
    allow(setup)
    project, job = queue(setup); ready(setup, project, job)
    api.apply_project(uuid.UUID(project.item_id), users[1], session)
    item = session.get(CreatorItem, project.item_id)
    item.visibility = 'published'
    session.add(AccountState(owner_id=users[0].id, privacy={'profile_visibility': 'private'}))
    session.add(CreatorFollow(follower_id=users[1].id, creator_id=users[0].id, status='accepted'))
    session.commit()
    remix.enforce_remix_publication(session, item)
    assert remix.remix_is_visible(session, item, users[1].id)
    assert not remix.remix_is_visible(session, item, users[2].id)
    with pytest.raises(HTTPException):
        api.get_item(uuid.UUID(item.id), Response(), users[2], session)
    with pytest.raises(HTTPException):
        creator.read_media(job.output_media_id, users[2], session)


def test_maintenance_does_not_hide_readable_remix(setup):
    session, users, _, _, _ = setup
    allow(setup)
    project, job = queue(setup); ready(setup, project, job)
    api.apply_project(uuid.UUID(project.item_id), users[1], session)
    item = session.get(CreatorItem, project.item_id)
    item.visibility = 'published'
    session.add(AdminSettings(id=1, maintenance_mode=True)); session.commit()
    assert remix.remix_is_visible(session, item, users[2].id)
    with pytest.raises(HTTPException):
        remix.enforce_remix_publication(session, item)


def test_fractional_trim_rounding_never_exposes_pretrim_media(setup):
    session, _, source, _, _ = setup
    source.data = {**source.data, 'trim_start': 2.0004, 'trim_end': 5.0004}; session.commit()
    allow(setup)
    project, job = queue(setup, source_start=0, source_seconds=2)
    assert job.snapshot['remix']['source_start'] == 2.001
    with pytest.raises(HTTPException) as error:
        queue(setup, source_start=0, source_seconds=3)
    assert error.value.status_code == 422


def test_quota_queue_limit_and_missing_applied_output(setup):
    session, users, _, _, _ = setup
    allow(setup)
    one, job = queue(setup)
    queue(setup)
    with pytest.raises(HTTPException) as error:
        queue(setup)
    assert error.value.status_code == 429
    ready(setup, one, job)
    api.apply_project(uuid.UUID(one.item_id), users[1], session)
    session.delete(session.get(CreatorMedia, job.output_media_id)); session.commit()
    with pytest.raises(HTTPException):
        remix.enforce_remix_publication(session, session.get(CreatorItem, one.item_id))


def test_deleting_project_does_not_release_output_for_external_use(setup):
    session, users, _, _, _ = setup
    allow(setup)
    project, job = queue(setup); ready(setup, project, job)
    api.apply_project(uuid.UUID(project.item_id), users[1], session)
    session.delete(session.get(CreatorItem, project.item_id)); session.commit()
    assert remix.is_derived_media(session, job.output_media_id)


def test_remix_migration_successor_idempotent_and_keeps_parent_tombstones(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'migration.sqlite'))
    tables = {remix.RemixPolicy.__tablename__, remix.RemixProject.__tablename__}
    Base.metadata.create_all(engine, tables=[t for t in Base.metadata.sorted_tables if t.name not in tables])
    config = migration.migration_config()
    with engine.begin() as connection:
        config.attributes['connection'] = connection; command.stamp(config, '20261125_0019')
    scripts = ScriptDirectory.from_config(config)
    assert scripts.get_revision('20261125_0020').down_revision == '20261125_0019'
    migration.upgrade_database(engine); migration.upgrade_database(engine)
    assert tables.issubset(inspect(engine).get_table_names())
    assert 'ix_render_jobs_output_media_id' in {i['name'] for i in inspect(engine).get_indexes('render_jobs')}
    refs = {fk['constrained_columns'][0] for fk in inspect(engine).get_foreign_keys('remix_projects')}
    assert 'parent_id' not in refs and 'root_id' not in refs
    engine.dispose()
