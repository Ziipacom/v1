"""Public link revocation, account isolation and bounded storage reads; no providers."""
from datetime import datetime, timedelta, timezone
import io
import json
from types import SimpleNamespace
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import app as core
from account_services import AccountState
from admin_services import AdminContentState, AdminUserState
from creator import CreatorItem, CreatorMedia, CreatorPreferences, ItemInput
import public_gallery as gallery
from storage_services import LocalStorage, R2Storage


@pytest.fixture
def context(monkeypatch, tmp_path):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    core.Base.metadata.create_all(engine)
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(connection, join_transaction_mode='create_savepoint')
        owner = core.User(name='Gallery owner', email='public-owner@example.test', password_hash='unused')
        other = core.User(name='Other owner', email='public-other@example.test', password_hash='unused')
        session.add_all((owner, other)); session.commit()
        provider = LocalStorage(); provider.root = tmp_path
        monkeypatch.setattr(gallery, 'storage', lambda: provider)
        monkeypatch.setattr(core.settings, 'public_app_url', 'https://ziipa.com')
        actor = {'user': owner}
        api = FastAPI(); api.include_router(gallery.owner_router); api.include_router(gallery.public_router)
        def user():
            if actor['user'] is None:
                raise HTTPException(401, 'Please sign in')
            return actor['user']
        api.dependency_overrides.update({core.db: lambda: session, core.current_user: user, core.guard: lambda: None})
        with TestClient(api) as client:
            yield SimpleNamespace(client=client, session=session, owner=owner, other=other, actor=actor,
                provider=provider, api=api)
        session.close(); transaction.rollback()
    engine.dispose()


def creation(ctx, owner=None, *, visibility='published', content=b'public-video-bytes', **changes):
    owner = owner or ctx.owner
    media = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=len(content))
    ctx.session.add(media); ctx.session.flush()
    ctx.provider.path(media.id).write_bytes(content)
    values = ItemInput(title='Public original', media_id=media.id, visibility=visibility, **changes).model_dump()
    item = CreatorItem(owner_id=owner.id, visibility=visibility, data=values)
    ctx.session.add(item); ctx.session.commit()
    return item, media


def reserve(ctx, slug='owner-gallery', enabled=True, revision=0):
    return ctx.client.post('/api/creator/gallery', json={'slug': slug, 'enabled': enabled, 'revision': revision})


def privacy(ctx, visibility, discoverable=True):
    row = ctx.session.get(AccountState, ctx.owner.id)
    if row is None:
        row = AccountState(owner_id=ctx.owner.id); ctx.session.add(row)
    row.privacy = {'profile_visibility': visibility, 'discoverable': discoverable}
    ctx.session.commit()


def test_owner_defaults_opt_in_normalization_and_public_origin(context):
    ctx = context
    original = ctx.client.get('/api/creator/gallery').json()
    assert original == {'slug': None, 'enabled': False, 'revision': 0, 'public_url': None,
                        'profile_public': True, 'pending_render_count': 0}
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 404
    result = reserve(ctx, ' Owner-Gallery ')
    assert result.status_code == 200 and result.json()['slug'] == 'owner-gallery'
    assert result.json()['public_url'] == 'https://ziipa.com/g/owner-gallery'
    assert result.json()['revision'] == 1
    assert ctx.client.get('/api/creator/gallery').json() == result.json()
    assert ctx.client.get('/api/public/galleries/owner-gallery').json()['items'] == []
    assert 'no-store' in result.headers['cache-control']


@pytest.mark.parametrize('slug', ['aa', 'a' * 41, '-invalid', 'invalid-', 'double--hyphen', 'a/b', 'café', 'api', 'ZIIPA'])
def test_invalid_or_reserved_slugs_are_not_claimed(context, slug):
    assert reserve(context, slug).status_code == 422
    assert context.session.scalar(select(gallery.PublicGallerySlug)) is None


def test_unique_claim_revision_disable_rename_and_retained_old_address(context):
    ctx = context
    assert reserve(ctx).status_code == 200
    assert reserve(ctx, enabled=False).status_code == 409  # stale revision
    ctx.actor['user'] = ctx.other
    assert reserve(ctx).status_code == 409
    ctx.actor['user'] = ctx.owner
    off = reserve(ctx, enabled=False, revision=1).json()
    assert off['slug'] == 'owner-gallery' and off['public_url'] is None
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 404
    assert reserve(ctx, 'new-gallery', revision=2).status_code == 200
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 404
    ctx.actor['user'] = ctx.other
    assert reserve(ctx, 'owner-gallery').status_code == 409
    assert ctx.client.get('/api/creator/gallery').json()['slug'] is None
    # Constraint proof, independent from the sequential API precheck.
    with pytest.raises(IntegrityError):
        with ctx.session.begin_nested():
            ctx.session.add(gallery.PublicGallerySlug(slug='new-gallery', owner_id=ctx.other.id))
            ctx.session.flush()


@pytest.mark.parametrize('visibility', ['members', 'private'])
def test_nonpublic_profiles_cannot_enable_and_revoke_all_public_routes(context, visibility):
    ctx = context
    item, media = creation(ctx)
    privacy(ctx, visibility)
    assert reserve(ctx).status_code == 409
    assert reserve(ctx, enabled=False).status_code == 200
    privacy(ctx, 'public', discoverable=False)
    assert reserve(ctx, revision=1).status_code == 200
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 200
    privacy(ctx, visibility)
    for suffix in ('', f'/items/{item.id}', f'/items/{item.id}/media', f'/artwork/avatar/{media.id}'):
        assert ctx.client.get('/api/public/galleries/owner-gallery' + suffix).status_code == 404
    assert ctx.client.get('/api/creator/gallery').json()['profile_public'] is False


def test_whitelist_no_private_metadata_drafts_foreign_media_or_moderation(context):
    ctx = context
    public, media = creation(ctx)
    public.data = {**public.data, 'caption_source_cues': [{'start': 0, 'end': 1, 'text': 'SECRET_RAW_SPEECH'}],
        'private_note': 'SECRET_NOTE', 'storage_url': 'https://secret.invalid/file',
        'distribution_targets': ['youtube']}
    draft, _ = creation(ctx, visibility='draft')
    hidden, _ = creation(ctx)
    ctx.session.add(AdminContentState(item_id=hidden.id, hidden=True))
    foreign, foreign_media = creation(ctx, ctx.other)
    borrowed = CreatorItem(owner_id=ctx.owner.id, visibility='published', data={**public.data, 'media_id': foreign_media.id})
    ctx.session.add(borrowed); ctx.session.commit()
    assert reserve(ctx).status_code == 200
    result = ctx.client.get('/api/public/galleries/owner-gallery')
    rows = result.json()['items']
    assert [row['id'] for row in rows] == [public.id]
    assert set(rows[0]) == {'id', 'title', 'description', 'category', 'creator', 'tags', 'cover', 'media_url',
        'content_type', 'demo', 'label', 'visibility', 'created_at'}
    assert 'SECRET' not in result.text and 'secret.invalid' not in result.text
    assert 'caption_source_cues' not in result.text and 'distribution' not in result.text
    assert rows[0]['cover'] is None
    path = f'/api/public/galleries/owner-gallery/items/{public.id}/media'
    assert rows[0]['media_url'] == path
    assert ctx.client.get(path).content == b'public-video-bytes'
    for row in (draft, hidden, foreign, borrowed):
        assert ctx.client.get(f'/api/public/galleries/owner-gallery/items/{row.id}/media').status_code == 404


@pytest.mark.parametrize('edit', [
    {'trim_start': 1}, {'trim_end': 4}, {'timeline': {'version': 1, 'clips': [{'id': 'cut', 'start': 0, 'end': 1}]}},
    {'captions': [{'start': 0, 'end': 1, 'text': 'Only this part is approved'}]},
    {'overlays': [{'id': 'layer', 'text': 'Edit', 'position': 'top'}]},
    {'soundtrack': {'name': 'Private audio', 'media_id': str(uuid.uuid4())}}, {'visual_effect': 'mono'},
])
def test_edits_never_fall_back_to_uncut_original_or_trigger_rendering(context, edit):
    ctx = context
    item, _ = creation(ctx, **edit)
    assert reserve(ctx).json()['pending_render_count'] == 1
    result = ctx.client.get('/api/public/galleries/owner-gallery').json()
    assert result['items'] == [] and result['unavailable_count'] == 1
    assert ctx.client.get(f'/api/public/galleries/owner-gallery/items/{item.id}').status_code == 404
    assert ctx.client.get(f'/api/public/galleries/owner-gallery/items/{item.id}/media').status_code == 404
    from render_services import RenderJob
    assert ctx.session.scalar(select(RenderJob)) is None


def test_suspension_deleted_owner_and_hidden_visibility_revoke_access(context):
    ctx = context
    item, media = creation(ctx)
    reserve(ctx)
    ctx.session.add(AdminUserState(user_id=ctx.owner.id, role='member', status='suspended'))
    ctx.session.commit()
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 404
    ctx.session.get(AdminUserState, ctx.owner.id).status = 'active'
    item.visibility = 'hidden'; ctx.session.commit()
    assert ctx.client.get(f'/api/public/galleries/owner-gallery/items/{item.id}/media').status_code == 404
    ctx.session.delete(ctx.owner); ctx.session.commit()
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 404


def test_pagination_has_no_duplicates_and_rejects_bad_cursors(context):
    ctx = context
    expected = set()
    for index in range(29):
        item, _ = creation(ctx)
        item.created_at = datetime(2026, 10, 27, tzinfo=timezone.utc) + timedelta(seconds=index // 3)
        expected.add(item.id)
    ctx.session.commit(); reserve(ctx)
    result = ctx.client.get('/api/public/galleries/owner-gallery?limit=24').json()
    assert len(result['items']) == 24 and result['next_cursor']
    next_page = ctx.client.get('/api/public/galleries/owner-gallery', params={'cursor': result['next_cursor']}).json()
    assert len(next_page['items']) == 5 and next_page['next_cursor'] is None
    assert {row['id'] for row in result['items']} | {row['id'] for row in next_page['items']} == expected
    assert not ({row['id'] for row in result['items']} & {row['id'] for row in next_page['items']})
    assert ctx.client.get('/api/public/galleries/owner-gallery?limit=25').status_code == 422
    assert ctx.client.get('/api/public/galleries/owner-gallery?cursor=../../bad').status_code == 422


def test_only_current_owned_profile_artwork_is_exposed(context, monkeypatch):
    ctx = context
    _, current = creation(ctx)
    _, old = creation(ctx)
    _, foreign = creation(ctx, ctx.other)
    for media in (current, old, foreign): media.content_type = 'image/png'
    prefs = CreatorPreferences(owner_id=ctx.owner.id, data={'profile': {'avatar_media_id': current.id,
        'cover_media_id': None, 'cover_sample': '/media/studio.jpg'}, 'private_preferences': 'DO_NOT_EXPOSE'})
    ctx.session.add(prefs); ctx.session.commit()
    reserve(ctx)
    monkeypatch.setattr(gallery, '_profile_image_bytes', lambda media: b'verified-image')
    result = ctx.client.get('/api/public/galleries/owner-gallery').json()
    assert result['avatar_url'] == f'/api/public/galleries/owner-gallery/artwork/avatar/{current.id}'
    assert result['cover_url'] == '/media/studio.jpg'
    assert ctx.client.get(result['avatar_url']).content == b'verified-image'
    for identifier in (old.id, foreign.id):
        assert ctx.client.get(f'/api/public/galleries/owner-gallery/artwork/avatar/{identifier}').status_code == 404
    prefs.data = {**prefs.data, 'profile': {'avatar_media_id': old.id}}; ctx.session.commit()
    assert ctx.client.get(result['avatar_url']).status_code == 404


@pytest.mark.parametrize('sample', gallery.PROFILE_COVER_SAMPLES)
def test_only_validated_current_bundled_cover_is_returned(context, sample):
    ctx = context
    prefs = CreatorPreferences(owner_id=ctx.owner.id, data={'profile': {'cover_sample': sample}})
    ctx.session.add(prefs); ctx.session.commit(); reserve(ctx)
    result = ctx.client.get('/api/public/galleries/owner-gallery').json()
    assert result['cover_url'] == sample and result['avatar_url'] is None
    # Legacy or corrupt preference JSON cannot introduce an external image,
    # arbitrary local asset or stale bundled fallback alongside an upload.
    for profile in ({'cover_sample': 'https://untrusted.invalid/image.png'},
                    {'cover_sample': '/media/private.png'},
                    {'cover_sample': sample, 'cover_media_id': str(uuid.uuid4())}):
        prefs.data = {'profile': profile}; ctx.session.commit()
        assert ctx.client.get('/api/public/galleries/owner-gallery').json()['cover_url'] is None
    prefs.data = {'profile': {'cover_media_id': str(uuid.uuid4())}}; ctx.session.commit()
    assert ctx.client.get('/api/public/galleries/owner-gallery').json()['cover_url'] is None


class ClosedBody(io.BytesIO):
    was_closed = False
    def close(self):
        self.was_closed = True
        super().close()


def test_r2_gateway_has_bounded_ranges_no_signed_redirect_and_closes_body(context, monkeypatch):
    ctx = context
    item, media = creation(ctx, content=b'0123456789')
    reserve(ctx)
    body = ClosedBody(b'2345')
    calls = []
    provider = object.__new__(R2Storage); provider.bucket = 'private-fixture'
    provider.client = SimpleNamespace(
        head_object=lambda **kwargs: {'ContentLength': 10, 'ContentType': 'video/mp4', 'ETag': '"stable"'},
        get_object=lambda **kwargs: calls.append(kwargs) or {'Body': body, 'ContentLength': 4,
            'ContentType': 'video/mp4', 'ETag': '"stable"', 'ContentRange': 'bytes 2-5/10'})
    monkeypatch.setattr(gallery, 'storage', lambda: provider)
    response = ctx.client.get(f'/api/public/galleries/owner-gallery/items/{item.id}/media', headers={'Range': 'bytes=2-5'})
    assert response.status_code == 206 and response.content == b'2345'
    assert response.headers['content-range'] == 'bytes 2-5/10'
    assert 'location' not in response.headers and 'no-store' in response.headers['cache-control']
    assert calls[0]['IfMatch'] == '"stable"' and calls[0]['Range'] == 'bytes=2-5' and body.was_closed
    assert gallery.byte_range('bytes=0-', 100 * 1024 * 1024)[1] == gallery.MAX_RANGE_BYTES - 1
    for value in ('bytes=20-', 'bytes=2-1', 'bytes=0-2,4-8', 'bytes=-0'):
        assert ctx.client.get(f'/api/public/galleries/owner-gallery/items/{item.id}/media', headers={'Range': value}).status_code == 416
    reserve(ctx, enabled=False, revision=1)
    assert ctx.client.get(f'/api/public/galleries/owner-gallery/items/{item.id}/media').status_code == 404
    assert len(calls) == 1


def test_export_delete_and_unauthenticated_owner_settings(context):
    ctx = context
    reserve(ctx)
    exported = gallery.export_gallery(ctx.session, ctx.owner.id)
    assert exported['settings']['slug'] == 'owner-gallery' and exported['reserved_slugs'] == ['owner-gallery']
    assert gallery.export_gallery(ctx.session, ctx.other.id)['reserved_slugs'] == []
    ctx.actor['user'] = None
    assert ctx.client.get('/api/creator/gallery').status_code == 401
    assert reserve(ctx, 'unauthorized').status_code == 401
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 200
    gallery.delete_gallery(ctx.session, ctx.owner.id); ctx.session.commit()
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 404
    assert ctx.session.scalar(select(gallery.PublicGallerySlug)) is None


def test_real_auth_maintenance_allows_only_explicit_gallery_revocation(context, monkeypatch):
    import hashlib
    from admin_services import AdminSettings
    ctx = context
    reserve(ctx)
    ctx.session.add(AdminSettings(id=1, maintenance_mode=True)); ctx.session.commit()
    session_key = 'session:' + hashlib.sha256(b'gallery-test-session').hexdigest()
    monkeypatch.setattr(core, 'cache', SimpleNamespace(get=lambda key: str(ctx.owner.id) if key == session_key else None))
    original = dict(core.app.dependency_overrides)
    core.app.dependency_overrides.update({core.db: lambda: ctx.session, core.guard: lambda: None})
    # No TestClient lifespan: production/local databases and workers are untouched.
    client = TestClient(core.app)
    client.cookies.set('ziipa_session', 'gallery-test-session')
    try:
        assert client.post('/api/creator/gallery', json={'slug': 'renamed-gallery', 'enabled': False, 'revision': 1}).status_code == 503
        assert client.post('/api/creator/gallery/disable', json={'revision': 1, 'slug': 'renamed-gallery'}).status_code == 422
        assert client.post('/api/creator/gallery/disable', json={'revision': 0}).status_code == 409
        assert ctx.session.get(gallery.PublicGallery, ctx.owner.id).enabled
        revoked = client.post('/api/creator/gallery/disable', json={'revision': 1})
        assert revoked.status_code == 200 and revoked.json()['enabled'] is False
        assert revoked.json()['slug'] == 'owner-gallery' and revoked.json()['revision'] == 2
        assert client.post('/api/creator/gallery/disable', json={'revision': 2}).json()['revision'] == 2
        assert client.post('/api/creator/gallery', json={'slug': 'owner-gallery', 'enabled': True, 'revision': 2}).status_code == 503
        assert client.get('/api/public/galleries/owner-gallery').status_code == 404
        client.cookies.clear()
        assert client.post('/api/creator/gallery/disable', json={'revision': 2}).status_code == 401
    finally:
        client.close()
        core.app.dependency_overrides.clear(); core.app.dependency_overrides.update(original)


def test_public_guard_remains_rate_limited_fail_closed(context, monkeypatch):
    from redis.exceptions import ConnectionError
    ctx = context
    reserve(ctx)
    ctx.api.dependency_overrides.pop(core.guard)
    monkeypatch.setattr(core, 'cache', SimpleNamespace(eval=lambda *args: 16))
    assert ctx.client.get('/api/public/galleries/owner-gallery').status_code == 429
    def unavailable(*args):
        raise ConnectionError('private diagnostic not exposed')
    monkeypatch.setattr(core, 'cache', SimpleNamespace(eval=unavailable))
    failed = ctx.client.get('/api/public/galleries/owner-gallery')
    assert failed.status_code == 503 and 'private diagnostic' not in failed.text


def test_fresh_repeated_gallery_migration_has_unique_owner_and_slug(tmp_path):
    from sqlalchemy import inspect, text
    import render_migrate
    engine = create_engine('sqlite:///' + str(tmp_path / 'gallery-migration.sqlite'))
    try:
        render_migrate.upgrade_database(engine)
        render_migrate.upgrade_database(engine)
        render_migrate.ensure_schema_ready(engine)
        with engine.connect() as connection:
            assert connection.scalar(text('SELECT version_num FROM alembic_version')) == '20261027_0013'
            assert connection.scalar(text('SELECT COUNT(*) FROM public_galleries')) == 0
            assert connection.scalar(text('SELECT COUNT(*) FROM public_gallery_slugs')) == 0
        constraints = inspect(engine).get_unique_constraints('public_galleries')
        assert any(row['column_names'] == ['slug'] for row in constraints)
    finally:
        engine.dispose()


def test_actual_postgresql_predicate_handles_legacy_null_empty_and_edited_rows():
    from sqlalchemy import text
    if core.engine.dialect.name != 'postgresql' or core.engine.url.host not in ('127.0.0.1', 'localhost', '::1'):
        pytest.skip('Local PostgreSQL rollback schema only; no hosted account database.')
    with core.engine.connect() as connection:
        transaction = connection.begin()
        schema = 'ziipa_public_gallery_' + uuid.uuid4().hex
        try:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
            connection = connection.execution_options(schema_translate_map={None: schema})
            core.Base.metadata.create_all(connection)
            session = Session(connection, join_transaction_mode='create_savepoint')
            owner = core.User(name='Synthetic PG owner', email='pg-gallery@example.test', password_hash='unused')
            session.add(owner); session.flush()
            media = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner.id, content_type='video/mp4', size=20)
            session.add(media); session.flush()
            minimal = {'title': 'Legacy original', 'media_id': media.id}
            unedited = [minimal, {**minimal, 'trim_start': 0, 'trim_end': None, 'timeline': None,
                'captions': [], 'overlays': [], 'soundtrack': None, 'visual_effect': 'none'},
                ItemInput(title='Current original', media_id=media.id).model_dump()]
            edited = [{**minimal, 'trim_end': 1}, {**minimal, 'captions': [{'start': 0, 'end': 1, 'text': 'Cut'}]},
                      {**minimal, 'timeline': {'version': 1, 'clips': [{'id': 'a', 'start': 0, 'end': 1}]}},
                      {**minimal, 'soundtrack': {'name': 'Music'}}, {**minimal, 'visual_effect': 'mono'}]
            for values in unedited + edited:
                session.add(CreatorItem(owner_id=owner.id, visibility='published', data=values))
            session.flush()
            visible = session.execute(gallery.visible_items(owner.id).where(~gallery.needs_finished_export())).all()
            assert len(visible) == len(unedited)
            assert gallery.unavailable_count(session, owner.id) == len(edited)
            session.close()
        finally:
            transaction.rollback()
