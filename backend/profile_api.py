"""Creator profiles, opt-in public import collections and consented media tags."""
from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import DateTime, ForeignKey, String, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard
import creator

router = APIRouter(prefix='/api/creator', dependencies=[Depends(current_user)])
PROVIDERS = frozenset(creator.PROVIDERS)
NO_STORE = {'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff'}


class ProfileMediaTag(Base):
    __tablename__ = 'profile_media_tags'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey('creator_items.id', ondelete='CASCADE'), primary_key=True)
    status: Mapped[str] = mapped_column(String(12), default='pending')
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def visible_owner(session, viewer, owner_id):
    owner = session.get(User, owner_id)
    prefs = creator.prefs_for(session, viewer)
    blocked = prefs['blocked_user_ids']
    reverse = creator.prefs_for(session, owner)['blocked_user_ids'] if owner else []
    if (not owner or not creator.account_allows_view(session, owner_id, viewer.id)
            or owner_id in blocked or viewer.id in reverse or owner.name in prefs['blocked_creators']):
        raise HTTPException(404, 'Creator profile not found.')
    return owner


def visible_item(session, viewer, row):
    if not row or row.visibility != 'published':
        return False
    from admin_services import AdminContentState
    moderation = session.get(AdminContentState, row.id, populate_existing=True)
    if moderation and moderation.hidden:
        return False
    if row.owner_id != viewer.id:
        try:
            visible_owner(session, viewer, row.owner_id)
        except HTTPException:
            return False
    prefs = creator.prefs_for(session, viewer)
    text = ' '.join(str(row.data.get(key, '')) for key in ('title', 'description', 'tags')).lower()
    return not any(word.strip() and word.lower() in text for word in prefs['muted_words'])


def artwork_shape(session, owner):
    profile = creator.profile_for(session, owner)
    for kind in ('avatar', 'cover'):
        if profile[kind + '_media_id']:
            profile[kind + '_url'] = f'/api/creator/profile-images/{owner.id}/{profile[kind + "_media_id"]}'
    return profile


def sharing(prefs):
    value = (prefs.data or {}) if prefs else {}
    return {'providers': [p for p in value.get('profile_networks', []) if p in PROVIDERS],
            'revision': value.get('profile_network_revision', 0)}


def network_collection(session, owner, *, private):
    from social_api import build_hub
    hub = build_hub(owner, session)
    shared = sharing(session.get(creator.CreatorPreferences, owner.id))['providers']
    providers = [row for row in hub['providers'] if private or row['provider'] in shared]
    allowed = {row['provider'] for row in providers if row.get('can_sync') and row.get('capabilities', {}).get('public_feed')}
    media = [row for row in hub['media'] if row.get('provider') in allowed][:180]
    if not private:
        public_fields = ('provider', 'name', 'status', 'handle', 'profile_url', 'auth_type', 'can_sync', 'audience',
            'capabilities', 'snapshot_expires_at', 'selected_import_target_id', 'import_targets')
        providers = [{key: row[key] for key in public_fields if key in row} for row in providers]
    # Never include followed people, invite URLs, credentials or private feed data.
    return {'providers': providers, 'media': media, 'people': [], 'invite_url': '',
            'notice': 'Imported public snapshots open at their original network. A linked public profile is not verified ownership.'}


def collection(session, viewer, owner, *, private=False):
    rows = session.scalars(select(creator.CreatorItem).where(creator.CreatorItem.owner_id == owner.id,
        creator.CreatorItem.visibility == 'published').order_by(creator.CreatorItem.created_at.desc()).limit(200))
    items = [creator.serialize_item(row, session, viewer_id=viewer.id) for row in rows if visible_item(session, viewer, row)]
    tagged, pending = [], []
    tags = session.scalars(select(ProfileMediaTag).where(ProfileMediaTag.owner_id == owner.id,
        ProfileMediaTag.status.in_(('accepted', 'pending') if private else ('accepted',)))
        .order_by(ProfileMediaTag.updated_at.desc()).limit(200))
    for tag in tags:
        row = session.get(creator.CreatorItem, tag.item_id)
        if not visible_item(session, viewer, row):
            continue
        item = creator.serialize_item(row, session, viewer_id=viewer.id)
        if tag.status == 'accepted':
            tagged.append({**item, 'profile_tag_revision': tag.revision})
        elif private:
            pending.append({'item': item, 'revision': tag.revision})
    from profile_follows import audience_counts, privacy_receipt, relationship
    return {'creator': {'id': owner.id, 'name': owner.name}, 'profile': artwork_shape(session, owner),
            'items': items, 'tagged': tagged, 'pending_tags': pending,
            'network': network_collection(session, owner, private=private),
            'sharing': sharing(session.get(creator.CreatorPreferences, owner.id)) if private else None,
            'saved_private': True, 'access': 'allowed', 'privacy': privacy_receipt(session, owner.id),
            'audience': audience_counts(session, owner.id), 'relationship': relationship(session, viewer.id, owner.id)}


@router.get('/profile/collections')
def owned_collections(response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers.update(NO_STORE)
    return collection(session, user, user, private=True)


@router.get('/profiles/{owner_id}')
def visitor_profile(owner_id: int, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers.update(NO_STORE)
    from profile_follows import follow_target, privacy_receipt, relationship
    owner = follow_target(session, user, owner_id)
    if not creator.account_allows_view(session, owner_id, user.id):
        empty = {'avatar_media_id': None, 'avatar_url': None, 'cover_media_id': None, 'cover_url': None, 'cover_sample': None}
        return {'creator': {'id': owner.id, 'name': owner.name}, 'profile': empty, 'items': [], 'tagged': [], 'pending_tags': [],
                'network': {'providers': [], 'media': [], 'people': [], 'invite_url': '', 'notice': ''}, 'sharing': None,
                'saved_private': True, 'access': 'followers_only', 'privacy': privacy_receipt(session, owner_id),
                'audience': None, 'relationship': relationship(session, user.id, owner_id)}
    return collection(session, user, owner)


@router.get('/profile-images/{owner_id}/{media_id}')
def visitor_artwork(owner_id: int, media_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    owner = visible_owner(session, user, owner_id)
    profile = creator.profile_for(session, owner)
    if str(media_id) not in (profile['avatar_media_id'], profile['cover_media_id']):
        raise HTTPException(404, 'Profile image not found.')
    media = creator._profile_media(session, owner.id, media_id)
    return Response(creator._profile_image_bytes(media), media_type=media.content_type, headers=NO_STORE)


class SharingInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    providers: list[str] = Field(max_length=6)
    revision: int = Field(ge=0)


@router.post('/profile/network-sharing', dependencies=[Depends(guard)])
def update_sharing(data: SharingInput, user: User = Depends(current_user), session: Session = Depends(db)):
    if len(set(data.providers)) != len(data.providers) or any(p not in PROVIDERS for p in data.providers):
        raise HTTPException(422, 'Select supported networks once each.')
    row = creator._locked_preferences(session, user)
    previous = sharing(row)
    if data.revision != previous['revision']:
        raise HTTPException(409, 'Profile sharing changed. Refresh before saving.')
    adding = set(data.providers) - set(previous['providers'])
    if adding:
        from social_api import providers_for
        eligible = {row['provider'] for row in providers_for(user, session)
                    if row.get('can_sync') and row.get('capabilities', {}).get('public_feed')}
        if not adding <= eligible:
            raise HTTPException(409, 'Connect a supported public import source before sharing its posts.')
    if row is None:
        row = creator.CreatorPreferences(owner_id=user.id, data={}); session.add(row)
    row.data = {**(row.data or {}), 'profile_networks': data.providers,
                'profile_network_revision': previous['revision'] + 1}
    session.commit()
    return sharing(row)


class TagRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    item_id: uuid.UUID


@router.post('/profiles/{owner_id}/tags', dependencies=[Depends(guard)])
def request_tag(owner_id: int, data: TagRequest, user: User = Depends(current_user), session: Session = Depends(db)):
    visible_owner(session, user, owner_id)
    row = session.get(creator.CreatorItem, str(data.item_id))
    if not row or row.owner_id != user.id or not visible_item(session, user, row):
        raise HTTPException(404, 'Your published creation was not found.')
    creator._locked_preferences(session, session.get(User, owner_id))
    existing = session.get(ProfileMediaTag, (owner_id, row.id))
    if existing:
        return {'status': existing.status, 'revision': existing.revision}
    count = session.scalar(select(func.count()).select_from(ProfileMediaTag).where(ProfileMediaTag.owner_id == owner_id))
    if count >= 200:
        raise HTTPException(409, 'This profile has reached its media-tag limit.')
    tag = ProfileMediaTag(owner_id=owner_id, item_id=row.id, status='pending')
    session.add(tag); session.commit()
    return {'status': tag.status, 'revision': tag.revision}


class TagReview(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    accepted: bool
    revision: int = Field(ge=1)


@router.post('/profile/tags/{item_id}', dependencies=[Depends(guard)])
def review_tag(item_id: uuid.UUID, data: TagReview, user: User = Depends(current_user), session: Session = Depends(db)):
    creator._locked_preferences(session, user)
    row = session.scalar(select(ProfileMediaTag).where(ProfileMediaTag.owner_id == user.id,
        ProfileMediaTag.item_id == str(item_id)).with_for_update().execution_options(populate_existing=True))
    if not row:
        raise HTTPException(404, 'Media tag not found.')
    if row.revision != data.revision:
        raise HTTPException(409, 'This media tag changed. Refresh before reviewing it.')
    if data.accepted and not visible_item(session, user, session.get(creator.CreatorItem, row.item_id)):
        raise HTTPException(404, 'The tagged creation is no longer available.')
    row.status = 'accepted' if data.accepted else 'dismissed'
    row.revision += 1
    row.updated_at = datetime.now(timezone.utc)
    session.commit()
    return {'status': row.status, 'revision': row.revision}


@router.get('/items/{item_id}')
def get_post(item_id: uuid.UUID, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    row = session.get(creator.CreatorItem, str(item_id))
    if not row or (row.owner_id != user.id and not visible_item(session, user, row)):
        raise HTTPException(404, 'Creation not found.')
    response.headers.update(NO_STORE)
    return creator.serialize_item(row, session, viewer_id=user.id)


def export_profile_tags(session, owner_id):
    return [{'item_id': tag.item_id, 'status': tag.status, 'revision': tag.revision}
            for tag in session.scalars(select(ProfileMediaTag).where(ProfileMediaTag.owner_id == owner_id))]
