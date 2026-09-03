"""Creator tools, owned media, and truthful cross-network distribution state."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import ForeignKey, String, JSON, DateTime, select, func, delete, UniqueConstraint
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Mapped, mapped_column, Session
from app import Base, User, db, current_user, guard, settings
from catalog import CATALOG
from storage_services import LocalStorage, storage

router = APIRouter(prefix='/api/creator', dependencies=[Depends(current_user)])
MEDIA_ROOT = Path(settings.uploads_dir).expanduser().resolve()
Category = Literal['video', 'music', 'games', 'live', 'nft', 'store']
SocialProvider = Literal['bluesky', 'facebook', 'instagram', 'tiktok', 'twitch', 'youtube']
PROVIDERS = {
    'bluesky': ('Bluesky / AT Protocol', 'Posts and portable identity'),
    'facebook': ('Facebook', 'Pages, video and Reels'),
    'instagram': ('Instagram', 'Professional account posts and Reels'),
    'tiktok': ('TikTok', 'Video and photo publishing'),
    'twitch': ('Twitch', 'Live broadcasting and channel library'),
    'youtube': ('YouTube', 'Videos, Shorts and live streams'),
}


class CreatorItem(Base):
    __tablename__ = 'creator_items'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    data: Mapped[dict] = mapped_column(JSON)
    visibility: Mapped[str] = mapped_column(String(12), default='draft')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CreatorMedia(Base):
    __tablename__ = 'creator_media'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    content_type: Mapped[str] = mapped_column(String(50))
    size: Mapped[int]


class PendingUpload(Base):
    __tablename__ = 'pending_uploads'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    content_type: Mapped[str] = mapped_column(String(50))
    size: Mapped[int]
    filename: Mapped[str] = mapped_column(String(180))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CreatorConnection(Base):
    __tablename__ = 'creator_connections'
    __table_args__ = (UniqueConstraint('owner_id', 'provider'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(24), default='connected')
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CreatorDistribution(Base):
    __tablename__ = 'creator_distributions'
    __table_args__ = (UniqueConstraint('owner_id', 'item_id', 'provider'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(30))
    detail: Mapped[str] = mapped_column(String(300), default='')
    external_url: Mapped[str] = mapped_column(String(500), default='')
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CreatorPreferences(Base):
    __tablename__ = 'creator_preferences'
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)


class CreatorFeed(Base):
    __tablename__ = 'creator_feeds'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    data: Mapped[dict] = mapped_column(JSON)


class CreatorComment(Base):
    __tablename__ = 'creator_comments'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    item_id: Mapped[str] = mapped_column(String(64), index=True)
    body: Mapped[str] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Caption(BaseModel):
    start: float = Field(ge=0, le=86400)
    end: float = Field(gt=0, le=86400)
    text: str = Field(min_length=1, max_length=250)
    @model_validator(mode='after')
    def ordered(self):
        if self.end <= self.start:
            raise ValueError('Caption end must follow start')
        return self


class Overlay(BaseModel):
    id: str = Field(min_length=1, max_length=36)
    text: str = Field(min_length=1, max_length=120, pattern=r'.*\S.*')
    position: Literal['top', 'center', 'bottom'] = 'center'
    theme: Literal['light', 'dark', 'purple', 'lime'] = 'dark'


class Soundtrack(BaseModel):
    media_id: str | None = Field(default=None, max_length=36)
    name: str = Field(min_length=1, max_length=180, pattern=r'.*\S.*')
    volume: float = Field(default=0.7, ge=0, le=1)
    start: float = Field(default=0, ge=0, le=86400)


class ItemInput(BaseModel):
    title: str = Field(min_length=1, max_length=140, pattern=r'.*\S.*')
    description: str = Field(default='', max_length=3000)
    category: Category = 'video'
    tags: list[str] = Field(default_factory=list, max_length=12)
    city: str = Field(default='', max_length=80)
    media_id: str | None = Field(default=None, max_length=36)
    visibility: Literal['draft', 'published'] = 'draft'
    trim_start: float = Field(default=0, ge=0, le=86400)
    trim_end: float | None = Field(default=None, gt=0, le=86400)
    captions: list[Caption] = Field(default_factory=list, max_length=100)
    price_cents: int | None = Field(default=None, ge=0, le=100000000)
    remix_of: str | None = Field(default=None, max_length=64)
    overlays: list[Overlay] = Field(default_factory=list, max_length=8)
    soundtrack: Soundtrack | None = None
    distribution_targets: list[SocialProvider] = Field(default_factory=list, max_length=6)
    @model_validator(mode='after')
    def valid(self):
        if self.trim_end is not None and self.trim_end <= self.trim_start:
            raise ValueError('Trim end must follow start')
        if any(len(t) > 40 for t in self.tags):
            raise ValueError('Tags must be under 40 characters')
        if len(set(self.distribution_targets)) != len(self.distribution_targets):
            raise ValueError('Choose each distribution network once')
        return self


class PreferencesInput(BaseModel):
    saved: list[str] = Field(default_factory=list, max_length=500)
    liked: list[str] = Field(default_factory=list, max_length=500)
    muted_words: list[str] = Field(default_factory=list, max_length=50)
    blocked_creators: list[str] = Field(default_factory=list, max_length=100)
    blocked_user_ids: list[int] = Field(default_factory=list, max_length=100)
    show_demos: bool = True
    @model_validator(mode='after')
    def bounded(self):
        if any(len(x) > 140 for values in (self.saved, self.liked, self.muted_words, self.blocked_creators) for x in values):
            raise ValueError('Preference entries are too long')
        return self


class FeedInput(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r'.*\S.*')
    category: Literal['all', 'video', 'music', 'games', 'live', 'nft', 'store'] = 'all'
    tag: str = Field(default='', max_length=40)
    city: str = Field(default='', max_length=80)
    creator: str = Field(default='', max_length=100)
    shared: bool = False


class CommentInput(BaseModel):
    body: str = Field(min_length=1, max_length=1000, pattern=r'.*\S.*')


class ConnectionInput(BaseModel):
    action: Literal['connect', 'disconnect']


class DistributionInput(BaseModel):
    providers: list[SocialProvider] = Field(min_length=1, max_length=6)
    @model_validator(mode='after')
    def unique(self):
        if len(set(self.providers)) != len(self.providers):
            raise ValueError('Choose each distribution network once')
        return self


class UploadReservation(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    content_type: str = Field(min_length=3, max_length=50)
    size: int = Field(gt=0, le=100 * 1024 * 1024)


ALLOWED_MEDIA = {'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'}


def valid_signature(content_type: str, header: bytes) -> bool:
    signatures = {
        'video/mp4': header[4:8] == b'ftyp', 'video/webm': header.startswith(b'\x1aE\xdf\xa3'),
        'image/png': header.startswith(b'\x89PNG\r\n\x1a\n'), 'image/jpeg': header.startswith(b'\xff\xd8\xff'),
        'image/webp': header[:4] == b'RIFF' and header[8:12] == b'WEBP',
        'audio/wav': header[:4] == b'RIFF' and header[8:12] == b'WAVE',
        'audio/mpeg': header[:3] == b'ID3' or (len(header) >= 2 and header[0] == 255 and header[1] & 224 == 224),
        'video/quicktime': header[4:8] == b'ftyp', 'audio/mp4': header[4:8] == b'ftyp',
        'audio/aac': len(header) >= 2 and header[0] == 255 and header[1] & 246 == 240,
        'audio/flac': header.startswith(b'fLaC'), 'audio/ogg': header.startswith(b'OggS'),
        'image/gif': header.startswith((b'GIF87a', b'GIF89a')),
        'image/heic': header[4:8] == b'ftyp' and header[8:12] in {b'heic', b'heix', b'hevc', b'hevx'},
        'image/heif': header[4:8] == b'ftyp' and header[8:12] in {b'mif1', b'msf1', b'heic', b'heif'},
    }
    return bool(signatures.get(content_type))


def media_url(media_id: str) -> str:
    path = f'/api/creator/media/{media_id}'
    return settings.api_public_origin.rstrip('/') + path if settings.api_public_origin else path


def prefs_for(session, user):
    row = session.get(CreatorPreferences, user.id)
    return PreferencesInput(**row.data).model_dump() if row else PreferencesInput().model_dump()


def serialize_item(item, session):
    owner = session.get(User, item.owner_id)
    media = session.get(CreatorMedia, item.data.get('media_id')) if item.data.get('media_id') else None
    media_url = globals()['media_url'](media.id) if media else None
    image = media and media.content_type.startswith('image/')
    distributions = session.scalars(select(CreatorDistribution).where(CreatorDistribution.item_id == item.id, CreatorDistribution.owner_id == item.owner_id)).all()
    return {**item.data, 'visibility': item.visibility, 'id': item.id, 'creator': owner.name, 'creator_id': owner.id, 'cover': media_url if image else '/brand/ziipa-background.png', 'media_url': None if image else media_url, 'content_type': media.content_type if media else None, 'demo': False, 'label': 'Post' if item.visibility == 'published' else ('Removed by moderation' if item.visibility == 'hidden' else 'Draft'), 'created_at': item.created_at.isoformat(), 'distribution': [serialize_distribution(d) for d in distributions]}


def serialize_distribution(row):
    return {'id': row.id, 'item_id': row.item_id, 'provider': row.provider, 'status': row.status, 'detail': row.detail, 'external_url': row.external_url, 'updated_at': row.updated_at.isoformat()}


def provider_connection(provider, user, session):
    return session.scalar(select(CreatorConnection).where(CreatorConnection.owner_id == user.id, CreatorConnection.provider == provider))


def connections_for(user, session):
    rows = {r.provider: r for r in session.scalars(select(CreatorConnection).where(CreatorConnection.owner_id == user.id)).all()}
    result = []
    for provider, (name, capability) in PROVIDERS.items():
        row = rows.get(provider)
        configured = bool(getattr(settings, f'social_{provider}_client_id', ''))
        result.append({'provider': provider, 'name': name, 'capability': capability, 'status': row.status if row else 'disconnected', 'handle': row.data.get('handle', '') if row else '', 'configured': configured})
    return result


def assert_visible(item_id, session, user):
    if settings.enable_demo_catalog and any(i['id'] == item_id for i in CATALOG):
        return
    row = session.get(CreatorItem, item_id)
    prefs = prefs_for(session, user)
    if not row or row.owner_id in prefs['blocked_user_ids'] or (row.owner_id != user.id and (row.visibility != 'published' or not account_allows_view(session, row.owner_id))):
        raise HTTPException(404, 'Post not found')


def account_allows_view(session, owner_id: int) -> bool:
    from account_services import AccountState, PrivacyInput
    row = session.get(AccountState, owner_id)
    privacy = PrivacyInput(**(row.privacy or {})) if row else PrivacyInput()
    return privacy.profile_visibility != 'private'


def account_is_discoverable(session, owner_id: int) -> bool:
    from account_services import AccountState, PrivacyInput
    row = session.get(AccountState, owner_id)
    privacy = PrivacyInput(**(row.privacy or {})) if row else PrivacyInput()
    return privacy.profile_visibility != 'private' and privacy.discoverable


@router.get('/bootstrap')
def bootstrap(user: User = Depends(current_user), session: Session = Depends(db)):
    prefs = prefs_for(session, user)
    published = session.scalars(select(CreatorItem).where(CreatorItem.visibility == 'published').order_by(CreatorItem.created_at.desc()).limit(200)).all()
    published = [i for i in published if i.owner_id == user.id or account_is_discoverable(session, i.owner_id)]
    items = [serialize_item(i, session) for i in published] + (CATALOG if settings.enable_demo_catalog and prefs['show_demos'] else [])
    items = [i for i in items if i.get('creator_id') not in prefs['blocked_user_ids'] and i['creator'] not in prefs['blocked_creators'] and not any(w.lower() in (i['title'] + ' ' + i['description'] + ' ' + ' '.join(i['tags'])).lower() for w in prefs['muted_words'] if w.strip())]
    own = session.scalars(select(CreatorItem).where(CreatorItem.owner_id == user.id).order_by(CreatorItem.created_at.desc())).all()
    feeds = session.scalars(select(CreatorFeed).where(CreatorFeed.owner_id == user.id)).all()
    community_feeds = session.scalars(select(CreatorFeed).where(CreatorFeed.data['shared'].as_boolean() == True).limit(100)).all()
    distributions = session.scalars(select(CreatorDistribution).where(CreatorDistribution.owner_id == user.id).order_by(CreatorDistribution.updated_at.desc()).limit(200)).all()
    return {'items': items, 'drafts': [serialize_item(i, session) for i in own], 'preferences': prefs, 'feeds': [{'id': f.id, **f.data} for f in feeds], 'community_feeds': [{'id': f.id, **f.data, 'owner_name': session.get(User, f.owner_id).name} for f in community_feeds], 'connections': connections_for(user, session), 'distributions': [serialize_distribution(d) for d in distributions]}


def save_item(data, session, user, row=None):
    if row is not None and row.visibility == 'hidden':
        raise HTTPException(403, 'This post was removed by moderation. Contact support to appeal.')
    if data.media_id:
        media = session.get(CreatorMedia, data.media_id)
        if not media or media.owner_id != user.id:
            raise HTTPException(404, 'Your media file was not found')
    if data.soundtrack and data.soundtrack.media_id:
        soundtrack = session.get(CreatorMedia, data.soundtrack.media_id)
        if not soundtrack or soundtrack.owner_id != user.id or not soundtrack.content_type.startswith('audio/'):
            raise HTTPException(404, 'Your soundtrack file was not found')
    if data.visibility == 'published':
        if data.category in ('live', 'nft'):
            raise HTTPException(409, 'Broadcasting and minting are not connected; save this as a draft.')
        if not data.media_id:
            raise HTTPException(422, 'Upload media before publishing.')
    if data.remix_of:
        assert_visible(data.remix_of, session, user)
    if row is None:
        row = CreatorItem(owner_id=user.id)
        session.add(row)
    row.data = data.model_dump()
    row.visibility = data.visibility
    session.commit()
    session.refresh(row)
    return serialize_item(row, session)


@router.post('/items', status_code=201, dependencies=[Depends(guard)])
def create_item(data: ItemInput, user: User = Depends(current_user), session: Session = Depends(db)):
    return save_item(data, session, user)


@router.post('/items/{item_id}', dependencies=[Depends(guard)])
def edit_item(item_id: str, data: ItemInput, user: User = Depends(current_user), session: Session = Depends(db)):
    row = session.get(CreatorItem, item_id)
    if not row or row.owner_id != user.id:
        raise HTTPException(404, 'Draft not found')
    return save_item(data, session, user, row)


@router.get('/connections')
def list_connections(user: User = Depends(current_user), session: Session = Depends(db)):
    return connections_for(user, session)


@router.post('/connections/{provider}', dependencies=[Depends(guard)])
def change_connection(provider: SocialProvider, data: ConnectionInput, user: User = Depends(current_user), session: Session = Depends(db)):
    row = provider_connection(provider, user, session)
    if data.action == 'disconnect':
        if row:
            session.delete(row)
            session.commit()
        return next(c for c in connections_for(user, session) if c['provider'] == provider)
    if not getattr(settings, f'social_{provider}_client_id', ''):
        raise HTTPException(409, f'{PROVIDERS[provider][0]} requires an approved developer app and OAuth credentials on this Ziipa environment.')
    raise HTTPException(501, f'{PROVIDERS[provider][0]} OAuth callback setup is required before accounts can be connected.')


@router.post('/items/{item_id}/distribute', dependencies=[Depends(guard)])
def distribute_item(item_id: str, data: DistributionInput, user: User = Depends(current_user), session: Session = Depends(db)):
    item = session.get(CreatorItem, item_id)
    if not item or item.owner_id != user.id:
        raise HTTPException(404, 'Creation not found')
    if item.visibility != 'published' or not item.data.get('media_id'):
        raise HTTPException(409, 'Publish the media on Ziipa before distributing it.')
    results = []
    for provider in data.providers:
        row = session.scalar(select(CreatorDistribution).where(CreatorDistribution.owner_id == user.id, CreatorDistribution.item_id == item.id, CreatorDistribution.provider == provider))
        if row is None:
            row = CreatorDistribution(owner_id=user.id, item_id=item.id, provider=provider, status='connection_required')
            session.add(row)
        connection = provider_connection(provider, user, session)
        if provider == 'twitch' and item.data.get('category') != 'live':
            row.status, row.detail = 'unsupported_media', 'Twitch distribution is available for a configured live broadcast.'
        elif not connection:
            row.status, row.detail = 'connection_required', f'Connect {PROVIDERS[provider][0]} before delivery.'
        else:
            row.status, row.detail = 'provider_setup_required', 'The provider delivery adapter must be enabled and reviewed by the Ziipa operator.'
        row.updated_at = datetime.now(timezone.utc)
        results.append(row)
    session.commit()
    return [serialize_distribution(r) for r in results]


@router.post('/preferences', dependencies=[Depends(guard)])
def preferences(data: PreferencesInput, user: User = Depends(current_user), session: Session = Depends(db)):
    row = session.get(CreatorPreferences, user.id)
    if row is None:
        row = CreatorPreferences(owner_id=user.id)
        session.add(row)
    row.data = data.model_dump()
    session.commit()
    return row.data


@router.post('/feeds', status_code=201, dependencies=[Depends(guard)])
def create_feed(data: FeedInput, user: User = Depends(current_user), session: Session = Depends(db)):
    count = session.scalar(select(func.count()).select_from(CreatorFeed).where(CreatorFeed.owner_id == user.id))
    if count >= 50:
        raise HTTPException(409, 'You can save up to 50 feeds in this local version.')
    row = CreatorFeed(owner_id=user.id, data=data.model_dump())
    session.add(row)
    session.commit()
    return {'id': row.id, **row.data}


@router.get('/items/{item_id}/comments')
def comments(item_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    assert_visible(item_id, session, user)
    rows = session.scalars(select(CreatorComment).where(CreatorComment.item_id == item_id).order_by(CreatorComment.created_at.desc()).limit(100)).all()
    prefs = prefs_for(session, user)
    return [{'id': r.id, 'body': r.body, 'creator': session.get(User, r.owner_id).name, 'creator_id': r.owner_id} for r in rows if r.owner_id not in prefs['blocked_user_ids'] and session.get(User, r.owner_id).name not in prefs['blocked_creators'] and not any(w.lower() in r.body.lower() for w in prefs['muted_words'] if w.strip())]


@router.post('/items/{item_id}/comments', dependencies=[Depends(guard)])
def add_comment(item_id: str, data: CommentInput, user: User = Depends(current_user), session: Session = Depends(db)):
    assert_visible(item_id, session, user)
    item = session.get(CreatorItem, item_id)
    if item and item.owner_id != user.id:
        owner_prefs = prefs_for(session, session.get(User, item.owner_id))
        if user.id in owner_prefs['blocked_user_ids'] or user.name in owner_prefs['blocked_creators']:
            raise HTTPException(403, 'You cannot comment on this creator’s posts.')
    row = CreatorComment(owner_id=user.id, item_id=item_id, body=data.body.strip())
    session.add(row)
    session.commit()
    return {'id': row.id, 'body': row.body, 'creator': user.name, 'creator_id': user.id}


@router.post('/media', dependencies=[Depends(guard)])
async def upload(request: Request, user: User = Depends(current_user), session: Session = Depends(db)):
    if settings.media_storage_backend != 'local':
        raise HTTPException(409, 'Use the signed media upload flow for this environment.')
    content_type = request.headers.get('content-type', '').split(';')[0]
    if content_type not in ALLOWED_MEDIA:
        raise HTTPException(415, 'Choose a supported image, video, or audio creator file.')
    # Serialize uploads per owner so concurrent requests cannot bypass the storage quota.
    try:
        session.execute(select(User).where(User.id == user.id).with_for_update(nowait=True))
    except OperationalError:
        session.rollback()
        raise HTTPException(409, 'Another upload is in progress. Please wait for it to finish.')
    used = session.scalar(select(func.coalesce(func.sum(CreatorMedia.size), 0)).where(CreatorMedia.owner_id == user.id))
    max_size = min(100 * 1024 * 1024, 1024 * 1024 * 1024 - used)
    if max_size <= 0:
        raise HTTPException(413, 'Local storage limit reached (1 GB per account).')
    media_id = str(uuid.uuid4())
    MEDIA_ROOT.mkdir(exist_ok=True)
    path = MEDIA_ROOT / media_id
    size = 0
    header = b''
    try:
        with path.open('xb') as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > max_size:
                    raise HTTPException(413, 'File too large. Limit: 100 MB per upload and 1 GB per account.')
                header = (header + chunk)[:32]
                output.write(chunk)
        if not size or not valid_signature(content_type, header):
            raise HTTPException(415, 'File contents do not match the selected media type.')
        session.add(CreatorMedia(id=media_id, owner_id=user.id, content_type=content_type, size=size))
        session.commit()
    except BaseException:
        path.unlink(missing_ok=True)
        session.rollback()
        raise
    return {'id': media_id, 'url': media_url(media_id), 'content_type': content_type}


@router.post('/media/presign', dependencies=[Depends(guard)])
def presign_upload(data: UploadReservation, user: User = Depends(current_user), session: Session = Depends(db)):
    if settings.media_storage_backend != 'r2':
        return {'mode': 'api', 'url': media_url(''), 'method': 'POST', 'headers': {'Content-Type': data.content_type}}
    if data.content_type not in ALLOWED_MEDIA:
        raise HTTPException(415, 'Choose a supported image, video, or audio creator file.')
    session.execute(delete(PendingUpload).where(PendingUpload.expires_at < datetime.now(timezone.utc)))
    try:
        session.execute(select(User).where(User.id == user.id).with_for_update(nowait=True))
    except OperationalError:
        session.rollback()
        raise HTTPException(409, 'Another upload is in progress. Please wait for it to finish.')
    used = session.scalar(select(func.coalesce(func.sum(CreatorMedia.size), 0)).where(CreatorMedia.owner_id == user.id))
    reserved = session.scalar(select(func.coalesce(func.sum(PendingUpload.size), 0)).where(PendingUpload.owner_id == user.id))
    if used + reserved + data.size > 1024 * 1024 * 1024:
        raise HTTPException(413, 'Storage limit reached (1 GB per account).')
    media_id = str(uuid.uuid4())
    row = PendingUpload(id=media_id, owner_id=user.id, content_type=data.content_type,
                        size=data.size, filename=Path(data.filename).name[:180],
                        expires_at=datetime.now(timezone.utc) + timedelta(seconds=settings.r2_presign_ttl_seconds))
    session.add(row)
    session.commit()
    return {'id': media_id, 'mode': 'direct', **storage().presign_put(user.id, media_id, data.content_type, data.size)}


@router.post('/media/{media_id}/complete', dependencies=[Depends(guard)])
def complete_upload(media_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    row = session.get(PendingUpload, media_id)
    if not row or row.owner_id != user.id:
        raise HTTPException(404, 'Upload reservation not found.')
    expires = row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at.tzinfo is None else row.expires_at
    if expires < datetime.now(timezone.utc):
        session.delete(row)
        session.commit()
        raise HTTPException(410, 'Upload reservation expired. Start the upload again.')
    size, content_type, header = storage().inspect(user.id, media_id)
    if size != row.size or content_type != row.content_type or not valid_signature(row.content_type, header):
        storage().delete_pending(user.id, media_id)
        session.delete(row)
        session.commit()
        raise HTTPException(415, 'Uploaded file does not match the reserved media type or size.')
    storage().promote(user.id, media_id)
    session.add(CreatorMedia(id=row.id, owner_id=row.owner_id, content_type=row.content_type, size=row.size))
    session.delete(row)
    session.commit()
    return {'id': media_id, 'url': media_url(media_id), 'content_type': content_type}


@router.get('/media/{media_id}')
def read_media(media_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    row = session.get(CreatorMedia, media_id)
    if not row:
        raise HTTPException(404, 'Media not found')
    if row.owner_id != user.id:
        if row.owner_id in prefs_for(session, user)['blocked_user_ids']:
            raise HTTPException(404, 'Media not found')
        shared = session.scalar(select(CreatorItem.id).where(CreatorItem.visibility == 'published', CreatorItem.data['media_id'].as_string() == media_id))
        if not shared:
            raise HTTPException(404, 'Media not found')
        if not account_allows_view(session, row.owner_id):
            raise HTTPException(404, 'Media not found')
    provider = storage()
    if isinstance(provider, LocalStorage):
        path = MEDIA_ROOT / row.id
        if not path.is_file():
            raise HTTPException(404, 'Media file unavailable')
        return FileResponse(path, media_type=row.content_type, headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})
    return RedirectResponse(provider.read_url(row.owner_id, row.id), status_code=307,
                            headers={'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer'})
