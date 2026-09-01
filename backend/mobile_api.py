"""Native sessions and account/safety controls shared by the mobile application."""
from datetime import datetime, timedelta, timezone
import hashlib
import secrets
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from redis.exceptions import RedisError
from sqlalchemy import ForeignKey, String, DateTime, select, delete, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column, Session

from app import Base, User, Waitlist, Register, Login, db, cache, passwords, DUMMY_HASH, current_user, guard, settings
from account_services import (AccountState, AccountToken, forget_session, remember_session,
                              revoke_user_sessions, send_verification, session_key, state_for)
import creator
from creator import CreatorItem, CreatorMedia, CreatorFeed, CreatorComment, CreatorPreferences, PendingUpload, PreferencesInput, prefs_for, assert_visible
from storage_services import LocalStorage, storage

router = APIRouter()
TOKEN_TTL = 7 * 24 * 3600
POLICY_VERSION = '2026-08-31'


class PolicyAcceptance(Base):
    __tablename__ = 'mobile_policy_acceptances'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), primary_key=True)
    version: Mapped[str] = mapped_column(String(30))
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class ContentReport(Base):
    __tablename__ = 'content_reports'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    reporter_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    target_owner_id: Mapped[int | None] = mapped_column(ForeignKey('users.id'), nullable=True)
    item_id: Mapped[str] = mapped_column(String(64))
    comment_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reason: Mapped[str] = mapped_column(String(30))
    details: Mapped[str] = mapped_column(String(2000))
    status: Mapped[str] = mapped_column(String(15), default='open')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class MediaDeletion(Base):
    __tablename__ = 'media_deletion_queue'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)


class NativeRegister(Register):
    accepted_policies: Literal[True]
    adult_confirmed: Literal[True]
    policy_version: Literal['2026-08-31']


class DeleteAccount(BaseModel):
    password: str = Field(min_length=1, max_length=128)
    confirmation: Literal['DELETE']


class ReportInput(BaseModel):
    item_id: str = Field(min_length=1, max_length=64)
    comment_id: str | None = Field(default=None, max_length=36)
    reason: Literal['harassment', 'sexual_content', 'violence', 'hate', 'spam', 'copyright', 'child_safety', 'other']
    details: str = Field(default='', max_length=2000)


class BlockInput(BaseModel):
    user_id: int = Field(gt=0)
    blocked: bool = True


class ResolveInput(BaseModel):
    action: Literal['remove', 'dismiss']


def native_session(user):
    token = secrets.token_urlsafe(32)
    remember_session(user.id, session_key('mobile_session:', token), TOKEN_TTL)
    return {'access_token': token, 'token_type': 'Bearer', 'expires_at': (datetime.now(timezone.utc) + timedelta(seconds=TOKEN_TTL)).isoformat(), 'user': {'id': user.id, 'name': user.name, 'email': user.email}}


@router.post('/api/mobile/auth/register', status_code=201, dependencies=[Depends(guard)])
def register_native(data: NativeRegister, session: Session = Depends(db)):
    user = User(name=data.name.strip(), email=str(data.email).lower(), password_hash=passwords.hash(data.password))
    session.add(user)
    try:
        session.flush()
        session.add(PolicyAcceptance(owner_id=user.id, version=POLICY_VERSION))
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, 'Unable to create an account. Try signing in.')
    send_verification(session, user)
    if settings.require_email_verification:
        return {'verification_required': True,
                'message': 'Check your email to verify the account, then sign in.'}
    return native_session(user)


@router.post('/api/mobile/auth/login', dependencies=[Depends(guard)])
def login_native(data: Login, session: Session = Depends(db)):
    user = session.scalar(select(User).where(User.email == str(data.email).lower()))
    valid = passwords.verify(data.password, user.password_hash if user else DUMMY_HASH)
    if not valid or not user:
        raise HTTPException(401, 'Email or password is incorrect')
    if settings.require_email_verification and not state_for(session, user).email_verified_at:
        raise HTTPException(403, 'Verify your email before signing in.')
    return native_session(user)


@router.post('/api/mobile/auth/logout', dependencies=[Depends(guard)])
def logout_native(request: Request):
    scheme, _, token = request.headers.get('authorization', '').partition(' ')
    if scheme.lower() != 'bearer' or not token:
        raise HTTPException(401, 'Mobile session required')
    key = session_key('mobile_session:', token)
    uid = cache.get(key)
    forget_session(int(uid) if uid else None, key)
    return {'ok': True}


@router.post('/api/safety/reports', status_code=201, dependencies=[Depends(guard)])
def report(data: ReportInput, user: User = Depends(current_user), session: Session = Depends(db)):
    assert_visible(data.item_id, session, user)
    item = session.get(CreatorItem, data.item_id)
    owner_id = item.owner_id if item else None
    if data.comment_id:
        comment = session.get(CreatorComment, data.comment_id)
        if not comment or comment.item_id != data.item_id:
            raise HTTPException(404, 'Comment not found')
        owner_id = comment.owner_id
    row = ContentReport(reporter_id=user.id, target_owner_id=owner_id, **data.model_dump())
    session.add(row)
    session.commit()
    return {'id': row.id, 'status': row.status}


@router.post('/api/safety/block', dependencies=[Depends(guard)])
def block(data: BlockInput, user: User = Depends(current_user), session: Session = Depends(db)):
    if data.user_id == user.id or not session.get(User, data.user_id):
        raise HTTPException(422, 'Choose another existing creator')
    prefs = prefs_for(session, user)
    ids = set(prefs['blocked_user_ids'])
    if data.blocked:
        ids.add(data.user_id)
    else:
        ids.discard(data.user_id)
    prefs['blocked_user_ids'] = sorted(ids)
    validated = PreferencesInput(**prefs)
    return creator.preferences(validated, user, session)


def moderator(user: User = Depends(current_user)):
    allowed = {x.strip().lower() for x in settings.moderator_emails.split(',') if x.strip()}
    if user.email not in allowed:
        raise HTTPException(403, 'Moderator access required')
    return user


@router.get('/api/moderation/reports')
def reports(user: User = Depends(moderator), session: Session = Depends(db)):
    rows = session.scalars(select(ContentReport).where(ContentReport.status == 'open').order_by(ContentReport.created_at).limit(100)).all()
    result = []
    for r in rows:
        item = session.get(CreatorItem, r.item_id)
        comment = session.get(CreatorComment, r.comment_id) if r.comment_id else None
        result.append({'id': r.id, 'item_id': r.item_id, 'comment_id': r.comment_id, 'reason': r.reason, 'details': r.details, 'created_at': r.created_at.isoformat(), 'item': creator.serialize_item(item, session) if item else None, 'comment_body': comment.body if comment else None})
    return result


@router.post('/api/moderation/reports/{report_id}', dependencies=[Depends(guard)])
def resolve(report_id: str, data: ResolveInput, user: User = Depends(moderator), session: Session = Depends(db)):
    row = session.get(ContentReport, report_id)
    if not row or row.status != 'open':
        raise HTTPException(404, 'Open report not found')
    if data.action == 'remove':
        if row.comment_id:
            comment = session.get(CreatorComment, row.comment_id)
            if comment:
                session.delete(comment)
        else:
            item = session.get(CreatorItem, row.item_id)
            if not item:
                raise HTTPException(409, 'This demo or removed item has no published record. Dismiss the report instead.')
            item.visibility = 'hidden'
        row.status = 'removed'
    else:
        row.status = 'dismissed'
    session.commit()
    return {'ok': True, 'status': row.status}


def drain_media_deletions(session):
    """Retryable cleanup; only UUID files immediately inside the media root are eligible."""
    provider = storage()
    if not isinstance(provider, LocalStorage):
        return
    root = creator.MEDIA_ROOT.resolve()
    for row in session.scalars(select(MediaDeletion).limit(500)).all():
        try:
            safe_id = str(uuid.UUID(row.id))
            path = (root / safe_id).resolve()
            if path.parent != root:
                continue
            path.unlink(missing_ok=True)
        except (OSError, ValueError):
            continue
        session.delete(row)
    session.commit()


@router.post('/api/account/delete', dependencies=[Depends(guard)])
def delete_account(data: DeleteAccount, user: User = Depends(current_user), session: Session = Depends(db)):
    if not passwords.verify(data.password, user.password_hash):
        raise HTTPException(401, 'Password is incorrect')
    # Lock the account against uploads while removing dependent data.
    session.execute(select(User).where(User.id == user.id).with_for_update())
    item_ids = list(session.scalars(select(CreatorItem.id).where(CreatorItem.owner_id == user.id)))
    media_ids = list(session.scalars(select(CreatorMedia.id).where(CreatorMedia.owner_id == user.id)))
    provider = storage()
    if not isinstance(provider, LocalStorage):
        try:
            for media_id in media_ids:
                provider.delete(user.id, media_id)
            for upload_id in session.scalars(select(PendingUpload.id).where(PendingUpload.owner_id == user.id)):
                provider.delete_pending(user.id, upload_id)
        except Exception as exc:
            raise HTTPException(503, 'Private media cleanup is temporarily unavailable. Account deletion was not started.') from exc
    for media_id in media_ids:
        if isinstance(provider, LocalStorage):
            session.merge(MediaDeletion(id=media_id))
    session.execute(delete(ContentReport).where(or_(ContentReport.reporter_id == user.id, ContentReport.target_owner_id == user.id, ContentReport.item_id.in_(item_ids))))
    session.execute(delete(CreatorComment).where(or_(CreatorComment.owner_id == user.id, CreatorComment.item_id.in_(item_ids))))
    session.execute(delete(creator.CreatorDistribution).where(creator.CreatorDistribution.owner_id == user.id))
    session.execute(delete(creator.CreatorConnection).where(creator.CreatorConnection.owner_id == user.id))
    for model in (CreatorItem, CreatorMedia, CreatorFeed, CreatorPreferences, PendingUpload, PolicyAcceptance, AccountState, AccountToken):
        session.execute(delete(model).where(model.owner_id == user.id))
    session.execute(delete(Waitlist).where(Waitlist.email == user.email))
    session.delete(user)
    session.commit()
    revoke_user_sessions(user.id)
    drain_media_deletions(session)
    pending = bool(session.scalar(select(MediaDeletion.id).where(MediaDeletion.id.in_(media_ids)).limit(1)))
    return {'ok': True, 'pending_media_cleanup': pending}
