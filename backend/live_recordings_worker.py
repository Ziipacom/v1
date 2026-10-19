"""Serial durable recording imports; bounded private clips use the existing renderer."""
import asyncio
from datetime import timedelta
import hashlib
from pathlib import Path
import tempfile
import uuid

from fastapi import HTTPException
from sqlalchemy import func, or_, select

from app import User, cache
from creator import CreatorItem, CreatorMedia, ItemInput
import live_recordings as recordings
from live_recordings import LiveRecording
from live_recordings_download import RecordingDownloadError, download
from live_webhooks import lock_owner, recording_binding
from media_quota import lock_admission, require_capacity
from storage_services import LocalStorage, storage

_successful_scan = False


def heartbeat_key():
    from media_workflows import coordination_scope
    return 'ziipa:recording-worker:v1:' + coordination_scope()


def heartbeat(coordinator=None):
    # Only the process that actually scanned the recording queue may advertise
    # this capability. An enabled API or a different free-host workflow worker
    # is insufficient. Idle renewals use Redis only, without waking the DB.
    if recordings.config.live_recordings_enabled and _successful_scan:
        try:
            (coordinator or cache).set(heartbeat_key(), 'ready', ex=180)
        except Exception:
            pass


def worker_ready():
    if not recordings.config.live_recordings_enabled:
        return False
    try:
        return bool(cache.get(heartbeat_key()))
    except Exception:
        return False


def next_wakeup_at(session):
    if not recordings.config.live_recordings_enabled:
        return None
    return recordings.aware(session.scalar(select(func.min(LiveRecording.next_run)).where(
        LiveRecording.status.in_(('queued', 'processing')), LiveRecording.next_run.is_not(None))))


def claim(session):
    current = recordings.now()
    candidates = list(session.execute(select(LiveRecording.id, LiveRecording.owner_id).where(
        LiveRecording.status.in_(('queued', 'processing')), LiveRecording.next_run <= current,
        or_(LiveRecording.lease_until.is_(None), LiveRecording.lease_until <= current))
        .order_by(LiveRecording.next_run, LiveRecording.id).limit(10)))
    for identity, owner_id in candidates:
        if not lock_owner(session, owner_id):
            session.rollback(); continue
        row = session.scalar(select(LiveRecording).where(LiveRecording.id == identity).with_for_update(skip_locked=True)
            .execution_options(populate_existing=True))
        if not row or row.status not in ('queued', 'processing') or (row.lease_until and recordings.aware(row.lease_until) > current):
            session.rollback(); continue
        if not recordings.valid_authority(session, row):
            row.status = 'cancelled'; row.next_run = None; row.detail = 'Recording import consent or stream ownership changed.'
            row.revision += 1; session.commit(); continue
        if not row.media_id and row.attempts >= 5:
            row.status = 'failed'; row.next_run = None; row.detail = 'Recording import retry limit reached.'
            session.commit(); continue
        row.status = 'processing'; row.lease_token = str(uuid.uuid4())
        row.lease_until = current + timedelta(seconds=recordings.LEASE_SECONDS)
        row.next_run = row.lease_until; row.updated_at = current; row.revision += 1
        if not row.media_id:
            row.attempts += 1
        session.commit()
        return row.id, row.lease_token
    return None


def locked(session, identity, token, *, admission=False):
    seed = session.get(LiveRecording, identity)
    if not seed:
        return None
    owner = lock_admission(session, seed.owner_id, nowait=False, missing_ok=True) if admission else lock_owner(session, seed.owner_id)
    row = session.scalar(select(LiveRecording).where(LiveRecording.id == identity).with_for_update()
        .execution_options(populate_existing=True))
    if not owner or not row or row.status != 'processing' or row.lease_token != token or not recordings.valid_authority(session, row):
        return None
    return row


def validate_asset(asset, row, session_id, parent_id):
    if session_id != row.provider_session_id or parent_id != row.provider_stream_id:
        raise RecordingDownloadError('Provider recording ownership changed. Import was stopped.')
    if not isinstance(asset.get('status'), dict) or asset['status'].get('phase') != 'ready':
        raise RecordingDownloadError('The provider recording is not ready for import.')
    size = asset.get('size')
    if type(size) is not int or not 0 < size <= recordings.MAX_BYTES:
        raise RecordingDownloadError('Provider recording exceeds the 100 MiB limit or has no verified size.')
    if asset.get('type', 'video') != 'video':
        raise RecordingDownloadError('The recording asset is not video.')
    hashes = asset.get('hash') or []
    if not isinstance(hashes, list) or len(hashes) > 10:
        raise RecordingDownloadError('Provider recording digest is invalid.')
    return size


def import_source(session_factory, identity, token, *, fetch=download):
    from render_services import _probe, _store_output, config as render_config
    with session_factory() as session:
        row = locked(session, identity, token)
        if not row or row.media_id:
            return
        descriptor = (row.provider_asset_id, row.provider_session_id, row.provider_stream_id, row.owner_id)
        # Fail before downloading if even the declared provider size cannot fit.
        session.commit()
    asset, provider_session, parent = asyncio.run(recording_binding(descriptor[0]))
    with session_factory() as session:
        row = locked(session, identity, token, admission=True)
        if not row:
            return
        expected_size = validate_asset(asset, row, provider_session, parent)
        require_capacity(session, row.owner_id, expected_size)
        session.commit()
    root = Path(render_config.work_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='recording-', dir=root) as temporary:
        path = Path(temporary) / 'source.mp4'
        size, digest = fetch(asset.get('downloadUrl'), path)
        if size != expected_size:
            raise RecordingDownloadError('Downloaded recording size changed from the verified provider asset.')
        for value in asset.get('hash') or []:
            if isinstance(value, dict) and value.get('algorithm') == 'sha256' and value.get('hash') != digest:
                raise RecordingDownloadError('Downloaded recording did not match its provider digest.')
        duration, streams = _probe(path, 'video/mp4')
        video = next((value for value in streams if value.get('codec_type') == 'video'), None)
        if not 0.1 <= duration <= recordings.MAX_DURATION or not video or not 2 <= int(video.get('width', 0)) <= 4096 or not 2 <= int(video.get('height', 0)) <= 4096:
            raise RecordingDownloadError('Recording duration or dimensions exceed the bounded import limits.')
        fresh, fresh_session, fresh_parent = asyncio.run(recording_binding(descriptor[0]))
        with session_factory() as session:
            row = locked(session, identity, token, admission=True)
            if not row or row.media_id:
                return
            # Do not resurrect a deleted/revoked provider asset from an old event.
            if (validate_asset(fresh, row, fresh_session, fresh_parent) != size
                    or fresh.get('downloadUrl') != asset.get('downloadUrl') or fresh.get('hash') != asset.get('hash')):
                raise RecordingDownloadError('Provider recording changed during download.')
            require_capacity(session, row.owner_id, size)
            backend = storage()
            if session.get(CreatorMedia, row.reserved_media_id):
                raise RecordingDownloadError('Recording reservation conflicts with catalogued media.')
            # Stable reserved UUID supports crash recovery. No catalogued original
            # is overwritten; a failed final DB commit can leave only this key.
            backend.delete(row.owner_id, row.reserved_media_id)
            _store_output(backend, row.owner_id, row.reserved_media_id, path)
            session.add(CreatorMedia(id=row.reserved_media_id, owner_id=row.owner_id, content_type='video/mp4', size=size))
            source = CreatorItem(id=str(uuid.uuid4()), owner_id=row.owner_id, visibility='draft', data=ItemInput(
                title=row.title, description='Private recording imported from your explicitly opted-in Livepeer broadcast.',
                category='video', visibility='draft', media_id=row.reserved_media_id).model_dump(mode='json'))
            session.add(source)
            row.item_id, row.media_id, row.duration, row.size, row.sha256 = source.id, row.reserved_media_id, duration, size, digest
            clips = []
            for index in range(row.policy['clip_count']):
                start = float(index * row.policy['clip_seconds'])
                end = min(duration, start + row.policy['clip_seconds'])
                if end - start < 0.1:
                    break
                item = CreatorItem(id=str(uuid.uuid4()), owner_id=row.owner_id, visibility='draft', data=ItemInput(
                    title=(row.title[:80] + f' — excerpt {index + 1}'), description='Private sequential excerpt; review the timing and rights before publishing.',
                    category='video', media_id=row.media_id, visibility='draft', trim_start=start, trim_end=end).model_dump(mode='json'))
                session.add(item)
                clips.append({'item_id': item.id, 'render_id': None, 'start': start, 'end': end, 'rendition': row.policy['rendition']})
            row.clips = clips; row.updated_at = recordings.now()
            row.detail = 'Recording imported privately; bounded excerpt drafts are waiting for the existing render worker.'
            session.commit()


def advance_clips(session_factory, identity, token):
    from render_api import RenderInput, queue_render
    from render_services import RenderJob, receipt as render_receipt
    with session_factory() as session:
        row = locked(session, identity, token)
        if not row or not row.media_id:
            return
        source = session.get(CreatorItem, row.item_id)
        if not source or source.owner_id != row.owner_id or source.visibility != 'draft' or source.data.get('media_id') != row.media_id:
            raise RecordingDownloadError('The private source was removed or changed. Automation stopped.')
        clips = list(row.clips)
        for index, clip in enumerate(clips):
            item = session.get(CreatorItem, clip['item_id'])
            if not item or item.owner_id != row.owner_id or item.visibility != 'draft' or item.data.get('media_id') != row.media_id:
                raise RecordingDownloadError('A private clip was removed or published manually; automation stopped without overwriting it.')
            if not clip.get('render_id'):
                try:
                    result = queue_render(RenderInput(item_id=item.id, rendition=clip['rendition']), session.get(User, row.owner_id), session)
                except HTTPException as exc:
                    if exc.status_code in (429, 503):
                        session.rollback(); break  # Durable retry, never bypass existing render limits.
                    raise
                row = locked(session, identity, token)
                if not row:
                    return
                clips = list(row.clips)
                clips[index] = {**clips[index], 'render_id': result['id']}
                row.clips = clips
                session.commit()
                row = locked(session, identity, token)
                if not row:
                    return
        row = locked(session, identity, token)
        if not row:
            return
        statuses = []
        for clip in row.clips:
            job = session.get(RenderJob, clip.get('render_id')) if clip.get('render_id') else None
            statuses.append(render_receipt(job, session)['status'] if job else 'pending')
        terminal = bool(statuses and all(value in ('ready', 'failed', 'cancelled', 'stale') for value in statuses))
        if terminal:
            row.status = 'ready'
            row.detail = ('Private recording and all excerpt exports are ready for review; nothing was published.' if all(value == 'ready' for value in statuses)
                          else 'Private recording is saved. Some excerpt renders need review or manual retry; nothing was published.')
            row.next_run = None
            from notification_services import enqueue_notification
            enqueue_notification(session, row.owner_id, category='recordings', event_id=row.id)
        else:
            row.next_run = recordings.now() + timedelta(seconds=60)
        row.lease_token = ''; row.lease_until = None; row.revision += 1; row.updated_at = recordings.now()
        session.commit()


def tick(session_factory, *, fetch=download):
    global _successful_scan
    _successful_scan = False
    if not recordings.config.live_recordings_enabled:
        return False
    with session_factory() as session:
        claimed = claim(session)
    _successful_scan = True
    if not claimed:
        return False
    identity, token = claimed
    try:
        import_source(session_factory, identity, token, fetch=fetch)
        advance_clips(session_factory, identity, token)
    except Exception as exc:
        # Never propagate provider bodies/URLs, private paths or transport locals
        # into API receipts or telemetry. The durable reserved key permits retry.
        detail = str(exc)[:350] if isinstance(exc, RecordingDownloadError) else 'Private recording preparation could not complete. Check worker, storage and provider readiness before an explicit retry.'
        with session_factory() as session:
            row = locked(session, identity, token)
            if row:
                if not session.get(CreatorMedia, row.reserved_media_id):
                    try:
                        storage().delete(row.owner_id, row.reserved_media_id)
                    except Exception:
                        detail = 'Unfinished private storage cleanup is pending. Retry this import or cancel it; no public media was created.'
                row.status = 'blocked' if isinstance(exc, (RecordingDownloadError, HTTPException)) else 'failed'
                row.detail = detail; row.next_run = None; row.lease_token = ''; row.lease_until = None
                row.revision += 1; row.updated_at = recordings.now(); session.commit()
    return True
