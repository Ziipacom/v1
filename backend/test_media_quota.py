"""Isolated quota/cleanup/race tests. No provider or user-owned storage is touched."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import threading
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app import Base, User
import creator
from creator import CreatorMedia, CreatorItem, PendingUpload
import media_quota as quota
import render_services as render
from storage_services import LocalStorage, VerifiedUpload


@pytest.fixture
def quota_db(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'quota.sqlite'),
                           connect_args={'check_same_thread': False, 'timeout': 3})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    backend = LocalStorage()
    backend.root = tmp_path / 'media'
    backend.root.mkdir()
    monkeypatch.setattr(render, 'storage', lambda: backend)
    monkeypatch.setattr(render.config, 'work_dir', str(tmp_path / 'work'))
    monkeypatch.setattr(quota.config, 'owner_max_bytes', 1000)
    monkeypatch.setattr(quota.config, 'project_max_bytes', 0)
    monkeypatch.setattr(creator, 'MEDIA_ROOT', backend.root)
    with factory() as session:
        owners = [User(name='Quota test', email=f'quota-{i}@example.test', password_hash='unused') for i in range(2)]
        session.add_all(owners); session.commit()
        owner_ids = [owner.id for owner in owners]
    yield factory, owner_ids, backend
    engine.dispose()


def media(session, owner_id, size, kind='video/mp4'):
    row = CreatorMedia(id=str(uuid.uuid4()), owner_id=owner_id, size=size, content_type=kind)
    session.add(row)
    return row


def pending(session, owner_id, size, *, expired=False):
    row = PendingUpload(id=str(uuid.uuid4()), owner_id=owner_id, size=size, content_type='image/png', filename='test.png',
                        expires_at=datetime.now(timezone.utc) + timedelta(minutes=-1 if expired else 10))
    session.add(row)
    return row


def render_job(session, owner_id, source, *, audio=None):
    data = {'title': 'Quota test', 'media_id': source.id, 'trim_start': 0, 'trim_end': 1,
            'soundtrack': {'media_id': audio.id, 'name': 'Owned audio', 'volume': 0.5, 'start': 0} if audio else None}
    item = CreatorItem(owner_id=owner_id, data=data, visibility='draft')
    session.add(item); session.flush()
    job = render.RenderJob(owner_id=owner_id, item_id=item.id,
                           input_fingerprint=render.input_fingerprint(session, item), snapshot=render.input_snapshot(session, item))
    session.add(job); session.commit()
    return job


def fake_renderer(monkeypatch, *, size=40, barrier=None):
    def create(snapshot, work):
        if barrier:
            barrier.wait(timeout=5)
        path = work / 'output.mp4'
        path.write_bytes(b'R' * size)
        return path, 1.0
    monkeypatch.setattr(render, 'render_files', create)


def test_quota_counts_all_owned_media_and_active_reservations_without_double_counting_completion(quota_db):
    factory, (owner, other), _ = quota_db
    with factory() as session:
        media(session, owner, 100)
        media(session, owner, 80, 'audio/wav')
        media(session, owner, 30, 'image/png')
        media(session, other, 700)
        reservation = pending(session, owner, 40)
        pending(session, owner, 500, expired=True)
        session.commit()
        quota.lock_admission(session, owner)
        assert quota.usage(session, owner) == 250
        assert quota.usage(session, None) == 950
        assert quota.available_bytes(session, owner) == 750
        assert quota.available_bytes(session, owner, exclude_reservation_id=reservation.id) == 790
        quota.require_capacity(session, owner, 40, exclude_reservation_id=reservation.id)


def test_render_quota_rejection_removes_old_reserved_output_and_never_writes_new_bytes(quota_db, monkeypatch):
    factory, (owner, _), backend = quota_db
    monkeypatch.setattr(quota.config, 'owner_max_bytes', 250)
    with factory() as session:
        source = media(session, owner, 100)
        audio = media(session, owner, 100, 'audio/wav')
        pending(session, owner, 30)
        session.flush()
        backend.path(source.id).write_bytes(bytes(100))
        backend.path(audio.id).write_bytes(bytes(100))
        job = render_job(session, owner, source, audio=audio)
        output_id, job_id = job.output_media_id, job.id
        backend.path(output_id).write_bytes(b'old failed attempt')
        claim = render.claim_job(session)
        source_id = source.id
    fake_renderer(monkeypatch, size=40)
    monkeypatch.setattr(render, '_store_output', lambda *_: pytest.fail('Over-quota output must not reach storage'))
    render.process_job(factory, *claim)
    with factory() as session:
        job = session.get(render.RenderJob, job_id)
        assert job.status == 'failed' and 'storage limit' in job.detail.lower()
        assert session.get(CreatorMedia, output_id) is None
        assert quota.usage(session, owner) == 230
    assert not backend.path(output_id).exists()
    assert backend.path(source_id).read_bytes() == bytes(100)
    assert not list((backend.root.parent / 'work').iterdir())


def test_project_cap_counts_other_owners_and_rejects_render(quota_db, monkeypatch):
    factory, (owner, other), backend = quota_db
    monkeypatch.setattr(quota.config, 'project_max_bytes', 250)
    with factory() as session:
        source = media(session, owner, 100)
        media(session, other, 130)
        session.flush(); backend.path(source.id).write_bytes(bytes(100))
        job = render_job(session, owner, source)
        job_id, output_id = job.id, job.output_media_id
        claim = render.claim_job(session)
    fake_renderer(monkeypatch, size=40)
    render.process_job(factory, *claim)
    with factory() as session:
        assert session.get(render.RenderJob, job_id).status == 'failed'
        assert session.get(CreatorMedia, output_id) is None
        assert quota.usage(session, None) == 230


def test_two_simultaneous_sqlite_render_commits_cannot_exceed_project_cap(quota_db, monkeypatch):
    factory, owners, backend = quota_db
    monkeypatch.setattr(quota.config, 'project_max_bytes', 250)
    claims, job_ids = [], []
    for owner in owners:
        with factory() as session:
            source = media(session, owner, 100)
            session.flush(); backend.path(source.id).write_bytes(bytes(100))
            job = render_job(session, owner, source)
            job_ids.append(job.id)
            claims.append(render.claim_job(session))
    fake_renderer(monkeypatch, size=40, barrier=threading.Barrier(2))
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(render.process_job, factory, *claim) for claim in claims]
        for future in futures:
            future.result(timeout=10)
    with factory() as session:
        assert sorted(session.get(render.RenderJob, job_id).status for job_id in job_ids) == ['failed', 'ready']
        assert quota.usage(session, None) == 240
        assert session.scalar(select(func.count()).select_from(CreatorMedia)) == 3


def test_quota_cleanup_failure_keeps_failed_job_for_later_cleanup(quota_db, monkeypatch):
    factory, (owner, _), backend = quota_db
    monkeypatch.setattr(quota.config, 'owner_max_bytes', 100)
    with factory() as session:
        source = media(session, owner, 100)
        session.flush(); backend.path(source.id).write_bytes(bytes(100))
        job = render_job(session, owner, source)
        job_id, output_id = job.id, job.output_media_id
        claim = render.claim_job(session)
    fake_renderer(monkeypatch)
    monkeypatch.setattr(backend, 'delete', lambda *_: (_ for _ in ()).throw(OSError('Deliberate storage failure')))
    render.process_job(factory, *claim)
    with factory() as session:
        job = session.get(render.RenderJob, job_id)
        assert job.status == 'failed' and 'cleanup will be retried' in job.detail
        assert session.get(CreatorMedia, output_id) is None


def test_local_stream_respects_project_remaining_bytes_and_removes_rejected_file(quota_db, monkeypatch):
    factory, (owner, other), backend = quota_db
    monkeypatch.setattr(creator.settings, 'media_storage_backend', 'local')
    monkeypatch.setattr(quota.config, 'project_max_bytes', 150)
    with factory() as session:
        media(session, other, 140); session.commit()
        class Upload:
            headers = {'content-type': 'image/png'}
            async def stream(self):
                yield b'\x89PNG\r\n\x1a\n'
                yield bytes(20)
        with pytest.raises(HTTPException) as error:
            asyncio.run(creator.upload(Upload(), session.get(User, owner), session))
        assert error.value.status_code == 413
        assert quota.usage(session, None) == 140
    assert not list(backend.root.iterdir())


def test_completion_rechecks_lowered_cap_before_promotion_and_cleans_pending(quota_db, monkeypatch):
    factory, (owner, _), _backend = quota_db
    actions = []
    class Storage:
        def inspect(self, *_): return VerifiedUpload(40, 'image/png', b'\x89PNG\r\n\x1a\n', '"test-etag"')
        def delete_pending(self, *_): actions.append('delete-pending')
        def promote(self, *_): pytest.fail('Over-quota upload must not be promoted')
    monkeypatch.setattr(creator, 'storage', lambda: Storage())
    monkeypatch.setattr(quota.config, 'owner_max_bytes', 120)
    with factory() as session:
        media(session, owner, 100)
        reservation = pending(session, owner, 40)
        session.commit()
        reservation_id = reservation.id
        with pytest.raises(HTTPException) as error:
            creator.complete_upload(reservation_id, session.get(User, owner), session)
        assert error.value.status_code == 413
        assert actions == ['delete-pending']
        assert session.get(PendingUpload, reservation_id) is None
        assert session.get(CreatorMedia, reservation_id) is None


def test_completion_does_not_double_count_its_reservation(quota_db, monkeypatch):
    factory, (owner, _), _backend = quota_db
    class Storage:
        def inspect(self, *_): return VerifiedUpload(40, 'image/png', b'\x89PNG\r\n\x1a\n', '"test-etag"')
        def promote(self, *_): pass
    monkeypatch.setattr(creator, 'storage', lambda: Storage())
    monkeypatch.setattr(quota.config, 'owner_max_bytes', 140)
    with factory() as session:
        media(session, owner, 100)
        reservation = pending(session, owner, 40)
        session.commit()
        result = creator.complete_upload(reservation.id, session.get(User, owner), session)
        assert result['id'] == reservation.id
        assert quota.usage(session, owner) == 140


def test_sqlite_real_write_lock_serializes_reservation_against_render_commit(quota_db, monkeypatch):
    factory, (owner, _), backend = quota_db
    monkeypatch.setattr(quota.config, 'owner_max_bytes', 150)
    monkeypatch.setattr(creator.settings, 'media_storage_backend', 'r2')
    class Storage:
        def presign_put(self, *_): return {'url': 'https://test.invalid/upload', 'method': 'PUT', 'headers': {}}
    monkeypatch.setattr(creator, 'storage', lambda: Storage())
    with factory() as session:
        source = media(session, owner, 100)
        session.flush(); backend.path(source.id).write_bytes(bytes(100))
        job = render_job(session, owner, source)
        claim = render.claim_job(session)
    locked, waiting = threading.Event(), threading.Event()
    original_store = render._store_output
    def store(*args):
        locked.set()
        assert waiting.wait(timeout=5)
        original_store(*args)
    monkeypatch.setattr(render, '_store_output', store)
    fake_renderer(monkeypatch, size=40)
    def reserve():
        assert locked.wait(timeout=5)
        with factory() as session:
            waiting.set()
            with pytest.raises(HTTPException) as error:
                creator.presign_upload(creator.UploadReservation(filename='test.png',content_type='image/png',size=20),session.get(User, owner),session)
            assert error.value.status_code in (409, 413)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(render.process_job, factory, *claim)
        b = pool.submit(reserve)
        a.result(timeout=10); b.result(timeout=10)
    with factory() as session:
        assert quota.usage(session, owner) == 140
        assert session.scalar(select(func.count()).select_from(PendingUpload)) == 0


def test_unknown_database_fails_closed_without_reading_capacity():
    class Unsupported:
        def get_bind(self):
            return type('Bind', (), {'dialect': type('Dialect', (), {'name': 'unknown'})()})()
    with pytest.raises(HTTPException) as error:
        quota.lock_admission(Unsupported(), 1)
    assert error.value.status_code == 503
