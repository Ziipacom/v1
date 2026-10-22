"""Creator tools, owned media, and truthful cross-network distribution state."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator, model_serializer
from sqlalchemy import ForeignKey, String, JSON, DateTime, select, func, delete, update, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, Session
from app import Base, User, db, current_user, guard, settings
from catalog import CATALOG
from storage_services import LocalStorage, object_key, storage
from media_quota import lock_admission, available_bytes, require_capacity, MediaAdmissionError
from timeline_edit import TimelineEdit, VisualEffect

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
PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
PROFILE_IMAGE_TYPES = ('image/jpeg', 'image/png', 'image/webp')
PROFILE_COVER_SAMPLES = ('/media/studio.jpg', '/media/dj.jpg', '/media/gaming.jpg',
                         '/media/ocean.jpg', '/media/sintel.png', '/brand/ziipa-background.png')


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
    status: Mapped[str] = mapped_column(String(24), default='linked')
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
    x: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    y: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    scale: float | None = Field(default=None, ge=0.5, le=2, allow_inf_nan=False)
    start: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)
    end: float | None = Field(default=None, gt=0, le=86400, allow_inf_nan=False)

    @field_validator('x', 'y', 'scale', 'start', 'end', mode='before')
    @classmethod
    def numeric_layout(cls, value):
        if value is not None and type(value) not in (int, float):
            raise ValueError('Overlay placement, size and times must be finite numbers')
        return value

    @model_validator(mode='after')
    def valid_layout(self):
        if (self.x is None) != (self.y is None):
            raise ValueError('Overlay x and y must be supplied together')
        if self.end is not None and self.end <= (self.start or 0):
            raise ValueError('Overlay end must follow start')
        return self

    @model_serializer(mode='wrap')
    def compatible_serialization(self, handler):
        # Missing/null additions must not change legacy editor snapshots/hashes.
        result = handler(self)
        return {key: value for key, value in result.items() if value is not None}


OVERLAY_LAYOUT = {'version': 1, 'coordinates': 'normalized_media_center',
                  'timing': 'output', 'interval': 'half_open',
                  'scale_min': 0.5, 'scale_max': 2, 'max_overlays': 8}


@router.get('/config')
def editor_configuration():
    """Save/preview support is independent of render-worker availability."""
    return {'overlay_layout': dict(OVERLAY_LAYOUT),
            'profile_images': {'version': 1, 'max_bytes': PROFILE_IMAGE_MAX_BYTES,
                               'content_types': list(PROFILE_IMAGE_TYPES),
                               'cover_samples': list(PROFILE_COVER_SAMPLES)}}


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
    timeline: TimelineEdit | None = None
    visual_effect: VisualEffect = 'none'
    captions: list[Caption] = Field(default_factory=list, max_length=100)
    caption_source_cues: list[Caption] | None = Field(default=None, max_length=100)
    price_cents: int | None = Field(default=None, ge=0, le=100000000)
    remix_of: str | None = Field(default=None, max_length=64)
    overlays: list[Overlay] = Field(default_factory=list, max_length=8)
    soundtrack: Soundtrack | None = None
    distribution_targets: list[SocialProvider] = Field(default_factory=list, max_length=6)
    @field_validator('caption_source_cues', mode='before')
    @classmethod
    def source_cue_numbers(cls, cues):
        if cues is not None:
            if not isinstance(cues, list):
                raise ValueError('Source captions must be a list')
            for cue in cues:
                if isinstance(cue, Caption):
                    continue
                if (not isinstance(cue, dict) or any(type(cue.get(k)) not in (int, float)
                        for k in ('start', 'end'))):
                    raise ValueError('Source caption timestamps must be finite numbers')
        return cues
    @model_validator(mode='after')
    def valid(self):
        if self.trim_end is not None and self.trim_end <= self.trim_start:
            raise ValueError('Trim end must follow start')
        if any(len(t) > 40 for t in self.tags):
            raise ValueError('Tags must be under 40 characters')
        if len(set(self.distribution_targets)) != len(self.distribution_targets):
            raise ValueError('Choose each distribution network once')
        previous_end = 0.0
        for cue in self.caption_source_cues or []:
            if (not math.isfinite(cue.start) or not math.isfinite(cue.end)
                    or not 0 <= cue.start < cue.end <= 90 or cue.start < previous_end):
                raise ValueError('Source caption cues must be ordered, nonoverlapping and within 90 seconds')
            previous_end = cue.end
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


class ProfileInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    avatar_media_id: uuid.UUID | None = None
    cover_media_id: uuid.UUID | None = None
    cover_sample: Literal['/media/studio.jpg', '/media/dj.jpg', '/media/gaming.jpg',
                          '/media/ocean.jpg', '/media/sintel.png', '/brand/ziipa-background.png'] | None = None

    @model_validator(mode='after')
    def one_cover(self):
        if self.cover_media_id is not None and self.cover_sample is not None:
            raise ValueError('Choose uploaded cover artwork or a bundled sample, not both')
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


def _locked_preferences(session, user):
    # Share the existing preferences/rewards lock order. PostgreSQL's advisory
    # lock serializes creation of a previously absent preferences row, too.
    from media_rewards import lock_user
    lock_user(session, user)
    if session.get_bind().dialect.name == 'sqlite':
        # FOR UPDATE is ignored by SQLite; take its real write lock instead.
        session.execute(update(User).where(User.id == user.id).values(id=user.id),
                        execution_options={'synchronize_session': False})
    return session.scalar(select(CreatorPreferences).where(CreatorPreferences.owner_id == user.id)
                          .with_for_update().execution_options(populate_existing=True))


def _profile_state(row):
    try:
        return ProfileInput.model_validate((row.data or {}).get('profile', {})).model_dump(mode='json') if row else ProfileInput().model_dump()
    except (ValidationError, TypeError):
        # Corrupt/legacy private metadata must never expose another account's
        # image or introduce an arbitrary URL through the read serializer.
        return ProfileInput().model_dump()


def _profile_media(session, owner_id, media_id):
    row = session.scalar(select(CreatorMedia).where(CreatorMedia.id == str(media_id),
                         CreatorMedia.owner_id == owner_id).execution_options(populate_existing=True))
    if not row:
        raise HTTPException(404, 'Your profile image was not found. Upload the image again.')
    if row.content_type not in PROFILE_IMAGE_TYPES:
        raise HTTPException(415, 'Profile images must be static JPEG, PNG or WebP files.')
    if not 0 < row.size <= PROFILE_IMAGE_MAX_BYTES:
        raise HTTPException(413, 'Profile images must be at most 10 MB.')
    return row


def _static_profile_image(content_type, data):
    if not valid_signature(content_type, data[:32]):
        return False
    if content_type == 'image/jpeg':
        return data.endswith(b'\xff\xd9')
    if content_type == 'image/png':
        offset, image_data, header = 8, False, False
        while offset + 12 <= len(data):
            length = int.from_bytes(data[offset:offset + 4], 'big')
            kind = data[offset + 4:offset + 8]
            stop = offset + 12 + length
            if stop > len(data) or kind == b'acTL':
                return False
            if offset == 8:
                header = kind == b'IHDR' and length == 13
            image_data = image_data or kind == b'IDAT'
            if kind == b'IEND':
                return header and image_data and length == 0 and stop == len(data)
            offset = stop
        return False
    if content_type == 'image/webp':
        if len(data) < 20 or int.from_bytes(data[4:8], 'little') + 8 != len(data):
            return False
        offset, image_data = 12, False
        while offset + 8 <= len(data):
            kind, length = data[offset:offset + 4], int.from_bytes(data[offset + 4:offset + 8], 'little')
            start, stop = offset + 8, offset + 8 + length
            if stop > len(data) or kind in (b'ANIM', b'ANMF'):
                return False
            if kind == b'VP8X' and (length < 10 or data[start] & 2):
                return False
            image_data = image_data or (kind in (b'VP8 ', b'VP8L') and length > 0)
            offset = stop + length % 2
        return image_data and offset == len(data)
    return False


def _profile_image_bytes(row):
    """Bounded private read; never return a signed URL or follow a redirect."""
    provider = storage()
    try:
        if isinstance(provider, LocalStorage):
            original = provider.path(row.id)
            path = original.resolve()
            if original.is_symlink() or path.parent != provider.root.resolve() or not path.is_file():
                raise HTTPException(409, 'Your profile image is unavailable. Upload it again.')
            with path.open('rb') as image:
                data = image.read(min(row.size, PROFILE_IMAGE_MAX_BYTES) + 1)
        else:
            result = provider.client.get_object(Bucket=provider.bucket, Key=object_key(row.owner_id, row.id),
                                                Range=f'bytes=0-{min(row.size, PROFILE_IMAGE_MAX_BYTES)}')
            body = result['Body']
            try:
                data = body.read(min(row.size, PROFILE_IMAGE_MAX_BYTES) + 1)
            finally:
                body.close()
            if result.get('ContentType', row.content_type).split(';')[0] != row.content_type:
                raise HTTPException(409, 'The stored profile image no longer matches its verified type.')
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, 'Private profile image storage is temporarily unavailable.') from exc
    if len(data) != row.size or len(data) > PROFILE_IMAGE_MAX_BYTES:
        raise HTTPException(409, 'The stored profile image no longer matches its verified size. Upload it again.')
    if not _static_profile_image(row.content_type, data):
        raise HTTPException(415, 'Choose a static JPEG, PNG or WebP profile image with matching file contents.')
    return data


def _profile_image_url(media_id):
    path = f'/api/creator/profile-images/{media_id}'
    return settings.api_public_origin.rstrip('/') + path if settings.api_public_origin else path


def profile_for(session, user):
    profile = _profile_state(session.get(CreatorPreferences, user.id))
    for field in ('avatar_media_id', 'cover_media_id'):
        if profile[field] is not None:
            try:
                _profile_media(session, user.id, profile[field])
            except HTTPException:
                profile[field] = None
    return {**profile,
            'avatar_url': _profile_image_url(profile['avatar_media_id']) if profile['avatar_media_id'] else None,
            'cover_url': _profile_image_url(profile['cover_media_id']) if profile['cover_media_id'] else profile['cover_sample']}


@router.get('/profile')
def get_profile(response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers['Cache-Control'] = 'private, no-store'
    return profile_for(session, user)


@router.post('/profile', dependencies=[Depends(guard)])
def save_profile(data: ProfileInput, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    row = _locked_preferences(session, user)
    previous = _profile_state(row)
    patch = data.model_dump(mode='json', exclude_unset=True)
    if patch.get('cover_media_id') is not None:
        patch['cover_sample'] = None
    if patch.get('cover_sample') is not None:
        patch['cover_media_id'] = None
    profile = ProfileInput.model_validate({**previous, **patch}).model_dump(mode='json')
    for field in ('avatar_media_id', 'cover_media_id'):
        if profile[field] is not None:
            media = _profile_media(session, user.id, profile[field])
            if field in patch:
                _profile_image_bytes(media)
    if row is None:
        row = CreatorPreferences(owner_id=user.id, data={})
        session.add(row)
    # Replacing artwork does not delete the prior owned file or any media used
    # by creations; the ordinary media ledger continues to count its storage.
    row.data = {**(row.data or {}), 'profile': profile}
    session.commit()
    response.headers['Cache-Control'] = 'private, no-store'
    return profile_for(session, user)


@router.get('/profile-images/{media_id}')
def read_profile_image(media_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    profile = _profile_state(session.get(CreatorPreferences, user.id))
    if str(media_id) not in (profile['avatar_media_id'], profile['cover_media_id']):
        raise HTTPException(404, 'Profile image not found')
    media = _profile_media(session, user.id, media_id)
    return Response(content=_profile_image_bytes(media), media_type=media.content_type,
                    headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
                             'Content-Disposition': 'inline'})


def serialize_item(item, session, *, viewer_id=None):
    owner = session.get(User, item.owner_id)
    media = session.get(CreatorMedia, item.data.get('media_id')) if item.data.get('media_id') else None
    media_url = globals()['media_url'](media.id) if media else None
    image = media and media.content_type.startswith('image/')
    distributions = session.scalars(select(CreatorDistribution).where(CreatorDistribution.item_id == item.id, CreatorDistribution.owner_id == item.owner_id)).all()
    # Raw recognition may include speech removed by a timeline cut. It is an
    # owner's editor track, never public feed or other-viewer metadata.
    data = {key: value for key, value in item.data.items() if key != 'caption_source_cues' or viewer_id == item.owner_id}
    return {**data, 'visibility': item.visibility, 'id': item.id, 'creator': owner.name, 'creator_id': owner.id, 'cover': media_url if image else '/brand/ziipa-background.png', 'media_url': None if image else media_url, 'content_type': media.content_type if media else None, 'demo': False, 'label': 'Post' if item.visibility == 'published' else ('Removed by moderation' if item.visibility == 'hidden' else 'Draft'), 'created_at': item.created_at.isoformat(), 'distribution': [serialize_distribution(d) for d in distributions]}


def serialize_distribution(row):
    return {'id': row.id, 'item_id': row.item_id, 'provider': row.provider, 'status': row.status, 'detail': row.detail, 'external_url': row.external_url, 'updated_at': row.updated_at.isoformat()}


def provider_connection(provider, user, session):
    return session.scalar(select(CreatorConnection).where(CreatorConnection.owner_id == user.id, CreatorConnection.provider == provider))


def connections_for(user, session):
    from social_api import providers_for
    return providers_for(user, session)


def assert_visible(item_id, session, user):
    if settings.enable_demo_catalog and any(i['id'] == item_id for i in CATALOG):
        return
    row = session.get(CreatorItem, item_id)
    prefs = prefs_for(session, user)
    if not row or row.owner_id in prefs['blocked_user_ids'] or (row.owner_id != user.id and (row.visibility != 'published' or not account_allows_view(session, row.owner_id))):
        raise HTTPException(404, 'Post not found')


def account_allows_view(session, owner_id: int) -> bool:
    from admin_services import account_is_active
    if not account_is_active(session, owner_id):
        return False
    from account_services import AccountState, PrivacyInput
    row = session.get(AccountState, owner_id)
    privacy = PrivacyInput(**(row.privacy or {})) if row else PrivacyInput()
    return privacy.profile_visibility != 'private'


def account_is_discoverable(session, owner_id: int) -> bool:
    from admin_services import account_is_active
    if not account_is_active(session, owner_id):
        return False
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
    return {'editor_capabilities': editor_configuration(), 'profile': profile_for(session, user), 'items': items, 'drafts': [serialize_item(i, session, viewer_id=user.id) for i in own], 'preferences': prefs, 'feeds': [{'id': f.id, **f.data} for f in feeds], 'community_feeds': [{'id': f.id, **f.data, 'owner_name': session.get(User, f.owner_id).name} for f in community_feeds if account_is_discoverable(session, f.owner_id)], 'connections': connections_for(user, session), 'distributions': [serialize_distribution(d) for d in distributions]}


def save_item(data, session, user, row=None):
    if row is not None and row.visibility == 'hidden':
        raise HTTPException(403, 'This post was removed by moderation. Contact support to appeal.')
    if row is not None:
        # Older clients do not know every studio field. Preserve omitted fields,
        # including complete caption arrays, while honoring explicit null/[]
        # for fields that permit clearing. Visibility in the column is canonical.
        merged = {**row.data, 'visibility': row.visibility,
                  **data.model_dump(include=data.model_fields_set)}
        if merged.get('media_id') != row.data.get('media_id'):
            merged['caption_source_cues'] = None
        try:
            data = ItemInput.model_validate(merged)
        except ValidationError as exc:
            issue = exc.errors(include_url=False, include_context=False, include_input=False)[0]
            raise HTTPException(422, f'The saved draft and these changes are invalid: {issue["msg"]}') from exc
    if data.media_id:
        media = session.get(CreatorMedia, data.media_id)
        if not media or media.owner_id != user.id:
            raise HTTPException(404, 'Your media file was not found')
        if data.timeline and not media.content_type.startswith(('video/', 'audio/')):
            raise HTTPException(422, 'A timeline requires an owned video or audio source.')
    elif data.timeline:
        raise HTTPException(422, 'Save an owned source file before saving timeline regions.')
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
    from media_workflows import notify_workflows
    notify_workflows(user.id)
    return serialize_item(row, session, viewer_id=user.id)


@router.post('/items', status_code=201, dependencies=[Depends(guard)])
def create_item(data: ItemInput, user: User = Depends(current_user), session: Session = Depends(db)):
    return save_item(data, session, user)


@router.post('/items/{item_id}', dependencies=[Depends(guard)])
def edit_item(item_id: str, data: ItemInput, user: User = Depends(current_user), session: Session = Depends(db)):
    # Serialize updates before merging so simultaneous clients cannot overwrite
    # one another's omitted fields with an earlier snapshot of the JSON record.
    row = session.scalar(select(CreatorItem).where(CreatorItem.id == item_id,
                         CreatorItem.owner_id == user.id).with_for_update())
    if not row:
        raise HTTPException(404, 'Draft not found')
    return save_item(data, session, user, row)


@router.get('/connections')
def list_connections(user: User = Depends(current_user), session: Session = Depends(db)):
    return connections_for(user, session)


@router.post('/connections/{provider}', dependencies=[Depends(guard)])
def change_connection(provider: SocialProvider, data: ConnectionInput, user: User = Depends(current_user), session: Session = Depends(db)):
    if data.action == 'disconnect':
        from social_api import disconnect_for
        return disconnect_for(provider, user, session)
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
        elif not connection or connection.status != 'connected' or connection.data.get('auth_type') != 'oauth':
            row.status, row.detail = 'connection_required', (f'Authorize {PROVIDERS[provider][0]} before automatic delivery. '
                                                          'A public profile link does not grant posting access. Use the share/export handoff in Ziipa meanwhile.')
        else:
            row.status, row.detail = 'provider_setup_required', 'The provider delivery adapter must be enabled and reviewed by the Ziipa operator.'
        row.updated_at = datetime.now(timezone.utc)
        results.append(row)
    session.commit()
    return [serialize_distribution(r) for r in results]


@router.post('/preferences', dependencies=[Depends(guard)])
def preferences(data: PreferencesInput, user: User = Depends(current_user), session: Session = Depends(db)):
    from media_rewards import sync_preferences_rewards
    row = _locked_preferences(session, user)
    previous = dict(row.data or {}) if row else {}
    if row is None:
        row = CreatorPreferences(owner_id=user.id)
        session.add(row)
    row.data = {**previous, **data.model_dump()}
    sync_preferences_rewards(session, user, previous, row.data)
    session.commit()
    return data.model_dump()


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
    from admin_services import account_is_active, comment_is_visible
    return [{'id': r.id, 'body': r.body, 'creator': session.get(User, r.owner_id).name, 'creator_id': r.owner_id} for r in rows if account_is_active(session, r.owner_id) and comment_is_visible(session, r.id) and r.owner_id not in prefs['blocked_user_ids'] and session.get(User, r.owner_id).name not in prefs['blocked_creators'] and not any(w.lower() in r.body.lower() for w in prefs['muted_words'] if w.strip())]


@router.post('/items/{item_id}/comments', dependencies=[Depends(guard)])
def add_comment(item_id: str, data: CommentInput, user: User = Depends(current_user), session: Session = Depends(db)):
    from media_rewards import lock_user, award_comment_reward
    lock_user(session, user)
    assert_visible(item_id, session, user)
    item = session.get(CreatorItem, item_id)
    if item and item.owner_id != user.id:
        owner_prefs = prefs_for(session, session.get(User, item.owner_id))
        if user.id in owner_prefs['blocked_user_ids'] or user.name in owner_prefs['blocked_creators']:
            raise HTTPException(403, 'You cannot comment on this creator’s posts.')
    row = CreatorComment(owner_id=user.id, item_id=item_id, body=data.body.strip())
    session.add(row)
    session.flush()
    award_comment_reward(session, user, item, row)
    session.commit()
    return {'id': row.id, 'body': row.body, 'creator': user.name, 'creator_id': user.id}


@router.post('/media', dependencies=[Depends(guard)])
async def upload(request: Request, user: User = Depends(current_user), session: Session = Depends(db)):
    if settings.media_storage_backend != 'local':
        raise HTTPException(409, 'Use the signed media upload flow for this environment.')
    content_type = request.headers.get('content-type', '').split(';')[0]
    if content_type not in ALLOWED_MEDIA:
        raise HTTPException(415, 'Choose a supported image, video, or audio creator file.')
    lock_admission(session, user.id)
    max_size = min(100 * 1024 * 1024, available_bytes(session, user.id))
    if max_size <= 0:
        raise HTTPException(413, 'Media storage limit reached. No upload capacity is available.')
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
                    raise HTTPException(413, 'File exceeds the 100 MB upload limit or available account/project storage capacity.')
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
    lock_admission(session, user.id)
    # Keep expired reservation IDs as cleanup anchors. The quota excludes them,
    # but deleting their rows here could orphan a failed copy's private target.
    require_capacity(session, user.id, data.size)
    media_id = str(uuid.uuid4())
    row = PendingUpload(id=media_id, owner_id=user.id, content_type=data.content_type,
                        size=data.size, filename=Path(data.filename).name[:180],
                        expires_at=datetime.now(timezone.utc) + timedelta(seconds=settings.r2_presign_ttl_seconds))
    session.add(row)
    session.commit()
    return {'id': media_id, 'mode': 'direct', **storage().presign_put(user.id, media_id, data.content_type, data.size)}


@router.post('/media/{media_id}/complete', dependencies=[Depends(guard)])
def complete_upload(media_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    # Reservation -> committed media must use the same lock as uploads/renders,
    # otherwise separate SUM queries could miss an in-flight conversion.
    lock_admission(session, user.id)
    row = session.get(PendingUpload, media_id)
    if not row or row.owner_id != user.id:
        raise HTTPException(404, 'Upload reservation not found.')
    expires = row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at.tzinfo is None else row.expires_at
    if expires < datetime.now(timezone.utc):
        storage().delete_pending(user.id, media_id)
        session.delete(row)
        session.commit()
        raise HTTPException(410, 'Upload reservation expired. Start the upload again.')
    verified = storage().inspect(user.id, media_id)
    if (verified.size != row.size or verified.content_type != row.content_type
            or not valid_signature(row.content_type, verified.header)):
        storage().delete_pending(user.id, media_id)
        session.delete(row)
        session.commit()
        raise HTTPException(415, 'Uploaded file does not match the reserved media type or size.')
    try:
        require_capacity(session, user.id, row.size, exclude_reservation_id=row.id)
    except MediaAdmissionError:
        # Caps may have been reduced since reservation. Do not promote the file;
        # retain the reservation if storage cleanup fails so deletion can retry.
        storage().delete_pending(user.id, media_id)
        session.delete(row)
        session.commit()
        raise
    storage().promote(user.id, media_id, verified)
    session.add(CreatorMedia(id=row.id, owner_id=row.owner_id, content_type=row.content_type, size=row.size))
    session.delete(row)
    session.commit()
    return {'id': media_id, 'url': media_url(media_id), 'content_type': verified.content_type}


@router.get('/media/{media_id}')
def read_media(media_id: str, user: User = Depends(current_user), session: Session = Depends(db)):
    row = session.get(CreatorMedia, media_id)
    if not row:
        raise HTTPException(404, 'Media not found')
    if row.owner_id != user.id:
        if row.owner_id in prefs_for(session, user)['blocked_user_ids']:
            raise HTTPException(404, 'Media not found')
        shared = session.scalar(select(CreatorItem.id).where(CreatorItem.owner_id == row.owner_id, CreatorItem.visibility == 'published', CreatorItem.data['media_id'].as_string() == media_id))
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
