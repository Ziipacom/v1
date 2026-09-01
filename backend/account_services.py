"""Email verification, password recovery, privacy, and session revocation."""
from datetime import datetime, timedelta, timezone
import hashlib
import secrets
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from redis.exceptions import RedisError
from sqlalchemy import ForeignKey, String, DateTime, JSON, select, delete
from sqlalchemy.orm import Mapped, mapped_column, Session

from app import Base, User, cache, current_user, db, guard, passwords, settings

router = APIRouter()


class AccountState(Base):
    __tablename__ = 'account_state'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), primary_key=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    privacy: Mapped[dict] = mapped_column(JSON, default=dict)


class AccountToken(Base):
    __tablename__ = 'account_tokens'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    purpose: Mapped[str] = mapped_column(String(20), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class EmailInput(BaseModel):
    email: EmailStr


class TokenInput(BaseModel):
    token: str = Field(min_length=32, max_length=256)


class ResetInput(TokenInput):
    password: str = Field(min_length=12, max_length=128)


class PrivacyInput(BaseModel):
    profile_visibility: str = Field(default='public', pattern='^(public|members|private)$')
    discoverable: bool = True
    personalized_feeds: bool = True
    marketing_emails: bool = False


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def state_for(session: Session, user: User) -> AccountState:
    row = session.get(AccountState, user.id)
    if not row:
        row = AccountState(owner_id=user.id, privacy=PrivacyInput().model_dump())
        session.add(row)
        session.flush()
    return row


def send_email(to: str, subject: str, text: str) -> None:
    if not settings.resend_api_key:
        # Local/demo mode intentionally does not log the secret link or token.
        return
    try:
        response = httpx.post(
            'https://api.resend.com/emails',
            headers={'Authorization': f'Bearer {settings.resend_api_key}'},
            json={'from': settings.email_from, 'to': [to], 'subject': subject, 'text': text},
            timeout=15, follow_redirects=False,
        )
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(503, 'Email delivery is temporarily unavailable. Please try again.') from exc


def issue_token(session: Session, user: User, purpose: str) -> str:
    session.execute(delete(AccountToken).where(AccountToken.owner_id == user.id, AccountToken.purpose == purpose, AccountToken.used_at.is_(None)))
    raw = secrets.token_urlsafe(48)
    session.add(AccountToken(owner_id=user.id, purpose=purpose, token_hash=token_hash(raw),
                             expires_at=datetime.now(timezone.utc) + timedelta(minutes=30 if purpose == 'password_reset' else 24 * 60)))
    session.commit()
    return raw


def send_verification(session: Session, user: User) -> None:
    raw = issue_token(session, user, 'email_verify')
    link = settings.public_app_url.rstrip('/') + '/verify-email?token=' + raw
    send_email(user.email, 'Verify your Ziipa email', f'Verify your Ziipa account: {link}\n\nThis link expires in 24 hours.')


def session_key(prefix: str, raw: str) -> str:
    return prefix + hashlib.sha256(raw.encode()).hexdigest()


def remember_session(user_id: int, key: str, ttl: int) -> None:
    try:
        pipe = cache.pipeline()
        pipe.setex(key, ttl, str(user_id))
        pipe.sadd(f'user_sessions:{user_id}', key)
        pipe.expire(f'user_sessions:{user_id}', max(ttl, 7 * 24 * 3600))
        pipe.execute()
    except RedisError as exc:
        raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.') from exc


def forget_session(user_id: int | None, key: str) -> None:
    try:
        pipe = cache.pipeline().delete(key)
        if user_id:
            pipe.srem(f'user_sessions:{user_id}', key)
        pipe.execute()
    except RedisError as exc:
        raise HTTPException(503, 'Could not revoke this session. Try again.') from exc


def revoke_user_sessions(user_id: int) -> None:
    try:
        index = f'user_sessions:{user_id}'
        keys = list(cache.smembers(index))
        if keys:
            cache.delete(*keys)
        cache.delete(index)
    except RedisError as exc:
        raise HTTPException(503, 'Could not revoke account sessions. Try again.') from exc


@router.post('/api/auth/verify-email', dependencies=[Depends(guard)])
def verify_email(data: TokenInput, session: Session = Depends(db)):
    row = session.scalar(select(AccountToken).where(AccountToken.token_hash == token_hash(data.token), AccountToken.purpose == 'email_verify'))
    now = datetime.now(timezone.utc)
    if not row or row.used_at or row.expires_at.replace(tzinfo=timezone.utc) < now:
        raise HTTPException(400, 'Verification link is invalid or expired.')
    user = session.get(User, row.owner_id)
    state_for(session, user).email_verified_at = now
    row.used_at = now
    session.commit()
    return {'ok': True}


@router.post('/api/auth/resend-verification', dependencies=[Depends(guard)])
def resend_verification(data: EmailInput, session: Session = Depends(db)):
    user = session.scalar(select(User).where(User.email == str(data.email).lower()))
    if user and not state_for(session, user).email_verified_at:
        send_verification(session, user)
    return {'message': 'If that account needs verification, a new link has been sent.'}


@router.post('/api/auth/forgot-password', dependencies=[Depends(guard)])
def forgot_password(data: EmailInput, session: Session = Depends(db)):
    user = session.scalar(select(User).where(User.email == str(data.email).lower()))
    if user:
        raw = issue_token(session, user, 'password_reset')
        link = settings.public_app_url.rstrip('/') + '/reset-password?token=' + raw
        send_email(user.email, 'Reset your Ziipa password', f'Reset your Ziipa password: {link}\n\nThis link expires in 30 minutes.')
    return {'message': 'If an account exists, a password reset link has been sent.'}


@router.post('/api/auth/reset-password', dependencies=[Depends(guard)])
def reset_password(data: ResetInput, session: Session = Depends(db)):
    row = session.scalar(select(AccountToken).where(AccountToken.token_hash == token_hash(data.token), AccountToken.purpose == 'password_reset'))
    now = datetime.now(timezone.utc)
    if not row or row.used_at or row.expires_at.replace(tzinfo=timezone.utc) < now:
        raise HTTPException(400, 'Password reset link is invalid or expired.')
    user = session.get(User, row.owner_id)
    user.password_hash = passwords.hash(data.password)
    row.used_at = now
    session.commit()
    revoke_user_sessions(user.id)
    return {'ok': True}


@router.get('/api/account/privacy')
def get_privacy(user: User = Depends(current_user), session: Session = Depends(db)):
    row = state_for(session, user)
    session.commit()
    return PrivacyInput(**(row.privacy or {})).model_dump()


@router.post('/api/account/privacy', dependencies=[Depends(guard)])
def update_privacy(data: PrivacyInput, user: User = Depends(current_user), session: Session = Depends(db)):
    state_for(session, user).privacy = data.model_dump()
    session.commit()
    return data.model_dump()


@router.get('/api/account/export')
def export_account(user: User = Depends(current_user), session: Session = Depends(db)):
    from creator import CreatorComment, CreatorFeed, CreatorItem, CreatorPreferences
    state = state_for(session, user)
    return {
        'exported_at': datetime.now(timezone.utc).isoformat(),
        'account': {'id': user.id, 'name': user.name, 'email': user.email, 'created_at': user.created_at.isoformat(),
                    'email_verified': bool(state.email_verified_at), 'privacy': PrivacyInput(**(state.privacy or {})).model_dump()},
        'posts': [r.data | {'id': r.id, 'visibility': r.visibility} for r in session.scalars(select(CreatorItem).where(CreatorItem.owner_id == user.id))],
        'feeds': [r.data | {'id': r.id} for r in session.scalars(select(CreatorFeed).where(CreatorFeed.owner_id == user.id))],
        'preferences': (session.get(CreatorPreferences, user.id).data if session.get(CreatorPreferences, user.id) else {}),
        'comments': [{'id': r.id, 'item_id': r.item_id, 'body': r.body, 'created_at': r.created_at.isoformat()} for r in session.scalars(select(CreatorComment).where(CreatorComment.owner_id == user.id))],
    }
