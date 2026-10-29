"""Ziipa-only follow relationships and follower-approved private profiles."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import DateTime, ForeignKey, String, case, delete, func, or_, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard
import creator

router = APIRouter(prefix='/api/creator', dependencies=[Depends(current_user)])


class CreatorFollow(Base):
    __tablename__ = 'creator_follows'
    follower_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    creator_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True, index=True)
    status: Mapped[str] = mapped_column(String(12), default='pending')
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def follow_target(session, viewer, owner_id):
    from admin_services import account_is_active
    owner = session.get(User, owner_id)
    if not owner or not account_is_active(session, owner_id):
        raise HTTPException(404, 'Creator not found.')
    mine, theirs = creator.prefs_for(session, viewer), creator.prefs_for(session, owner)
    if (owner_id in mine['blocked_user_ids'] or viewer.id in theirs['blocked_user_ids']
            or owner.name in mine['blocked_creators'] or viewer.name in theirs['blocked_creators']):
        raise HTTPException(404, 'Creator not found.')
    return owner


def follows(session, viewer_id, owner_id):
    return bool(session.scalar(select(CreatorFollow.follower_id).where(CreatorFollow.follower_id == viewer_id,
        CreatorFollow.creator_id == owner_id, CreatorFollow.status == 'accepted')))


def relationship(session, viewer_id, owner_id):
    row = session.get(CreatorFollow, (viewer_id, owner_id), populate_existing=True)
    return {'status': row.status if row else 'none', 'revision': row.revision if row else 0,
            'self': viewer_id == owner_id}


def audience_counts(session, owner_id):
    from admin_services import AdminUserState
    def count(field, other):
        return session.scalar(select(func.count()).select_from(CreatorFollow)
            .join(User, User.id == other).outerjoin(AdminUserState, AdminUserState.user_id == User.id)
            .where(field == owner_id, CreatorFollow.status == 'accepted',
                   or_(AdminUserState.status.is_(None), AdminUserState.status == 'active')))
    return {'provider': 'ziipa', 'name': 'Ziipa',
            'followers': count(CreatorFollow.creator_id, CreatorFollow.follower_id),
            'following': count(CreatorFollow.follower_id, CreatorFollow.creator_id),
            'updated_at': datetime.now(timezone.utc).isoformat()}


def privacy_receipt(session, owner_id):
    from account_services import AccountState, PrivacyInput
    state = session.get(AccountState, owner_id, populate_existing=True)
    prefs = session.get(creator.CreatorPreferences, owner_id, populate_existing=True)
    return {'visibility': PrivacyInput(**(state.privacy or {})).profile_visibility if state else 'public',
            'revision': (prefs.data or {}).get('profile_privacy_revision', 0) if prefs else 0}


class FollowRevision(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    revision: int = Field(ge=0)


@router.post('/profiles/{owner_id}/follow', dependencies=[Depends(guard)])
def follow(owner_id: int, data: FollowRevision, user: User = Depends(current_user), session: Session = Depends(db)):
    owner = follow_target(session, user, owner_id)
    if owner_id == user.id:
        raise HTTPException(422, 'You cannot follow yourself.')
    # Serialize both sides with block/privacy edits, always in the same order.
    for person in sorted((user, owner), key=lambda person: person.id):
        creator._locked_preferences(session, person)
    follow_target(session, user, owner_id)
    receipt = relationship(session, user.id, owner_id)
    if receipt['revision'] != data.revision:
        raise HTTPException(409, 'Follow status changed. Refresh before trying again.')
    if receipt['status'] in ('pending', 'accepted'):
        return receipt
    row = session.get(CreatorFollow, (user.id, owner_id))
    if row is None and session.scalar(select(func.count()).select_from(CreatorFollow).where(CreatorFollow.follower_id == user.id)) >= 1000:
        raise HTTPException(409, 'Your account has reached its follow limit.')
    status = 'pending' if privacy_receipt(session, owner_id)['visibility'] == 'private' else 'accepted'
    if row:
        row.status, row.revision, row.updated_at = status, row.revision + 1, datetime.now(timezone.utc)
    else:
        session.add(CreatorFollow(follower_id=user.id, creator_id=owner_id, status=status))
    session.commit()
    return relationship(session, user.id, owner_id)


@router.post('/profiles/{owner_id}/unfollow', dependencies=[Depends(guard)])
def unfollow(owner_id: int, data: FollowRevision, user: User = Depends(current_user), session: Session = Depends(db)):
    creator._locked_preferences(session, user)
    row = session.scalar(select(CreatorFollow).where(CreatorFollow.follower_id == user.id,
        CreatorFollow.creator_id == owner_id).with_for_update().execution_options(populate_existing=True))
    if not row:
        return relationship(session, user.id, owner_id)
    if row.revision != data.revision:
        raise HTTPException(409, 'Follow status changed. Refresh before trying again.')
    row.status, row.revision = 'cancelled', row.revision + 1
    row.updated_at = datetime.now(timezone.utc)
    session.commit()
    return relationship(session, user.id, owner_id)


@router.get('/profile/followers')
def follower_requests(response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers['Cache-Control'] = 'private, no-store'
    rows = session.scalars(select(CreatorFollow).where(CreatorFollow.creator_id == user.id,
        CreatorFollow.status.in_(('pending', 'accepted'))).order_by(
            case((CreatorFollow.status == 'pending', 0), else_=1), CreatorFollow.updated_at.desc()).limit(200))
    output = []
    for row in rows:
        try:
            follower = follow_target(session, user, row.follower_id)
        except HTTPException:
            continue
        output.append({'id': follower.id, 'name': follower.name, 'status': row.status, 'revision': row.revision})
    following = []
    for row in session.scalars(select(CreatorFollow).where(CreatorFollow.follower_id == user.id,
            CreatorFollow.status == 'accepted').order_by(CreatorFollow.updated_at.desc()).limit(200)):
        try:
            other = follow_target(session, user, row.creator_id)
        except HTTPException:
            continue
        following.append({'id': other.id, 'name': other.name, 'revision': row.revision})
    return {'followers': output, 'following': following, 'counts': audience_counts(session, user.id)}


class FollowerReview(FollowRevision):
    accepted: bool


@router.post('/profile/followers/{follower_id}', dependencies=[Depends(guard)])
def review_follower(follower_id: int, data: FollowerReview, user: User = Depends(current_user), session: Session = Depends(db)):
    creator._locked_preferences(session, user)
    row = session.scalar(select(CreatorFollow).where(CreatorFollow.creator_id == user.id,
        CreatorFollow.follower_id == follower_id).with_for_update().execution_options(populate_existing=True))
    if not row or row.status not in ('pending', 'accepted'):
        raise HTTPException(404, 'Follow request not found.')
    if row.revision != data.revision:
        raise HTTPException(409, 'Follow request changed. Refresh before reviewing it.')
    if data.accepted:
        follow_target(session, user, follower_id)
    row.status, row.revision = 'accepted' if data.accepted else 'declined', row.revision + 1
    row.updated_at = datetime.now(timezone.utc)
    session.commit()
    return {'status': row.status, 'revision': row.revision}


class PrivacyChange(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    private: bool
    expected_visibility: str = Field(pattern='^(public|members|private)$')
    revision: int = Field(ge=0)


@router.post('/profile/privacy', dependencies=[Depends(guard)])
async def change_privacy(data: PrivacyChange, user: User = Depends(current_user), session: Session = Depends(db)):
    from account_services import PrivacyInput, state_for
    prefs = creator._locked_preferences(session, user)
    current = privacy_receipt(session, user.id)
    if data.revision != current['revision'] or data.expected_visibility != current['visibility']:
        raise HTTPException(409, 'Profile privacy changed. Refresh before changing it.')
    state = state_for(session, user)
    fields = PrivacyInput(**(state.privacy or {})).model_dump()
    fields['profile_visibility'] = 'private' if data.private else 'public'
    if data.private:
        from live_api import end_live_for_privacy
        await end_live_for_privacy(user.id, session)
    if prefs is None:
        prefs = creator.CreatorPreferences(owner_id=user.id, data={}); session.add(prefs)
    prefs.data = {**(prefs.data or {}), 'profile_privacy_revision': current['revision'] + 1}
    state.privacy = fields
    session.commit()
    return privacy_receipt(session, user.id)


def revoke_blocked_follows(session, user, blocked_ids, blocked_names=()):
    blocked_ids = set(blocked_ids)
    if blocked_names:
        blocked_ids.update(session.scalars(select(User.id).where(User.name.in_(blocked_names))))
    if blocked_ids:
        session.execute(delete(CreatorFollow).where(or_(
            (CreatorFollow.creator_id == user.id) & CreatorFollow.follower_id.in_(blocked_ids),
            (CreatorFollow.follower_id == user.id) & CreatorFollow.creator_id.in_(blocked_ids))))


def export_follows(session, owner_id):
    rows = session.scalars(select(CreatorFollow).where(or_(CreatorFollow.creator_id == owner_id,
        CreatorFollow.follower_id == owner_id)))
    return [{'creator_id': row.creator_id, 'follower_id': row.follower_id, 'status': row.status,
             'revision': row.revision} for row in rows]


@router.get('/profile/audience')
def audience(response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    from social_api import providers_for
    response.headers['Cache-Control'] = 'private, no-store'
    return {'ziipa': audience_counts(session, user.id), 'networks': [
        {'provider': row['provider'], 'name': row['name'], 'counts': row.get('audience')}
        for row in providers_for(user, session) if row['status'] in ('connected', 'linked')]}
