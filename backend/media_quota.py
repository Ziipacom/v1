"""Atomic database-ledger admission for uploads, reservations and rendered media.

This does not meter external/orphan storage objects or guarantee a provider bill.
Call lock_admission before reading totals and hold the transaction through commit.
"""
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import OperationalError

from app import User


class MediaQuotaSettings(BaseSettings):
    owner_max_bytes: int = Field(default=1024 ** 3, ge=1)
    project_max_bytes: int = Field(default=0, ge=0)
    model_config = SettingsConfigDict(env_prefix='MEDIA_', env_file='.env', extra='ignore')


config = MediaQuotaSettings()
PROJECT_LOCK = 0x5A495050414D4544


class MediaAdmissionError(HTTPException):
    """Safe user-facing admission error; never includes provider/database text."""


def lock_admission(session, owner_id: int, *, nowait=True, missing_ok=False):
    dialect = session.get_bind().dialect.name
    try:
        if dialect == 'postgresql':
            if not nowait:
                # Preserve a completed render through brief upload contention,
                # without blocking its worker forever behind a stalled writer.
                session.execute(text("SET LOCAL lock_timeout = '30s'"))
            # Always take the shared lock, even if this instance disables the
            # project cap. Lock order stays consistent across all media writers.
            if nowait:
                if not session.scalar(text('SELECT pg_try_advisory_xact_lock(:key)'), {'key': PROJECT_LOCK}):
                    raise MediaAdmissionError(409, 'Another media operation is in progress. Please retry shortly.')
            else:
                session.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': PROJECT_LOCK})
            owner = session.scalar(select(User).where(User.id == owner_id).with_for_update(nowait=nowait))
        elif dialect == 'sqlite':
            # SQLite ignores FOR UPDATE. A no-op write acquires its actual
            # transaction write lock, including across processes/connections.
            result = session.execute(update(User).where(User.id == owner_id).values(id=owner_id),
                                     execution_options={'synchronize_session': False})
            owner = session.get(User, owner_id) if result.rowcount == 1 else None
        else:
            raise MediaAdmissionError(503, 'Media admission requires a supported transactional database.')
        if not owner and not missing_ok:
            raise MediaAdmissionError(404, 'Your account is no longer available.')
        return owner
    except OperationalError as exc:
        session.rollback()
        raise MediaAdmissionError(409, 'Another media operation is in progress. Please retry shortly.') from exc


def usage(session, owner_id: int | None, *, exclude_reservation_id=None):
    # Lazy import avoids creator -> quota -> creator import initialization cycles.
    from creator import CreatorMedia, PendingUpload
    committed = select(func.coalesce(func.sum(CreatorMedia.size), 0))
    reserved = select(func.coalesce(func.sum(PendingUpload.size), 0)).where(
        PendingUpload.expires_at > datetime.now(timezone.utc))
    if owner_id is not None:
        committed = committed.where(CreatorMedia.owner_id == owner_id)
        reserved = reserved.where(PendingUpload.owner_id == owner_id)
    if exclude_reservation_id is not None:
        reserved = reserved.where(PendingUpload.id != exclude_reservation_id)
    return int(session.scalar(committed)) + int(session.scalar(reserved))


def available_bytes(session, owner_id: int, *, exclude_reservation_id=None):
    owner_remaining = config.owner_max_bytes - usage(session, owner_id, exclude_reservation_id=exclude_reservation_id)
    if owner_remaining < 0:
        raise MediaAdmissionError(413, 'Account media storage limit reached. This upload or export is not admitted.')
    if config.project_max_bytes:
        project_remaining = config.project_max_bytes - usage(session, None, exclude_reservation_id=exclude_reservation_id)
        if project_remaining < 0:
            raise MediaAdmissionError(413, 'Project media storage limit reached. Uploads and exports are paused until capacity is available.')
        return min(owner_remaining, project_remaining)
    return owner_remaining


def require_capacity(session, owner_id: int, size: int, *, exclude_reservation_id=None):
    if type(size) is not int or size <= 0:
        raise MediaAdmissionError(413, 'Media must have a positive verified byte size.')
    if size > available_bytes(session, owner_id, exclude_reservation_id=exclude_reservation_id):
        raise MediaAdmissionError(413, 'Media storage limit reached. This upload or export exceeds the available account or project capacity.')
