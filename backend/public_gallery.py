"""Opt-in, revocable public galleries. No anonymous editor data or storage URLs."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import json
import re
import uuid
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, and_, cast, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import Base, User, current_user, db, guard, settings
from account_services import AccountState, PrivacyInput
from admin_services import AdminContentState, account_is_active
from creator import (ALLOWED_MEDIA, PROFILE_COVER_SAMPLES, CreatorItem, CreatorMedia, CreatorPreferences,
                     _profile_image_bytes, _profile_media, _profile_state)
from storage_services import LocalStorage, R2Storage, object_key, storage

owner_router = APIRouter(prefix='/api/creator/gallery', dependencies=[Depends(current_user)])
public_router = APIRouter(prefix='/api/public/galleries', dependencies=[Depends(guard)])
NO_STORE = {'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'}
MAX_MEDIA_BYTES = 100 * 1024 * 1024
MAX_RANGE_BYTES = 8 * 1024 * 1024
MAX_SLUGS_PER_OWNER = 10
SLUG_PATTERN = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*', re.ASCII)
RESERVED = frozenset(('admin', 'api', 'auth', 'account', 'accounts', 'blog', 'create', 'creator',
    'creators', 'dashboard', 'discover', 'explore', 'feed', 'g', 'gallery', 'galleries', 'help', 'inbox',
    'legal', 'login', 'logout', 'notifications', 'portal', 'privacy', 'profile', 'public', 'settings',
    'share', 'signup', 'studio', 'support', 'terms', 'wallet', 'www', 'ziipa'))


def now():
    return datetime.now(timezone.utc)


class PublicGallerySlug(Base):
    # Retain old names until account deletion: renaming must not let another
    # account impersonate a previously shared address.
    __tablename__ = 'public_gallery_slugs'
    slug: Mapped[str] = mapped_column(String(40), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PublicGallery(Base):
    __tablename__ = 'public_galleries'
    __table_args__ = (CheckConstraint('revision >= 1', name='ck_public_gallery_revision'),)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    slug: Mapped[str] = mapped_column(ForeignKey('public_gallery_slugs.slug'), unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


def normalize_slug(value):
    if not isinstance(value, str):
        raise ValueError('Choose a gallery address using letters, numbers and single hyphens.')
    value = value.strip().lower()
    if not 3 <= len(value) <= 40 or not SLUG_PATTERN.fullmatch(value) or value in RESERVED:
        raise ValueError('Use 3–40 letters, numbers and single hyphens; this address may be reserved.')
    return value


class GalleryInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    slug: str = Field(min_length=3, max_length=40)
    enabled: bool
    revision: int = Field(ge=0, le=2147483647)
    _slug = field_validator('slug', mode='before')(normalize_slug)


class GalleryRevision(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    revision: int = Field(ge=0, le=2147483647)


def public_profile(session, owner_id):
    state = session.get(AccountState, owner_id, populate_existing=True)
    try:
        return PrivacyInput(**(state.privacy or {})).profile_visibility == 'public' if state else True
    except (ValueError, TypeError):
        return False


def canonical_url(slug):
    origin = settings.public_app_url.rstrip('/')
    parsed = urlsplit(origin)
    if parsed.query or parsed.fragment or parsed.username or parsed.password or parsed.path not in ('', '/'):
        raise HTTPException(503, 'The public gallery origin is not configured.')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
        raise HTTPException(503, 'The public gallery origin is not configured.')
    return origin + '/g/' + slug


def gallery_settings(row, session, owner_id):
    return {'slug': row.slug if row else None, 'enabled': bool(row and row.enabled),
            'revision': row.revision if row else 0,
            'public_url': canonical_url(row.slug) if row and row.enabled else None,
            'profile_public': public_profile(session, owner_id),
            'pending_render_count': unavailable_count(session, owner_id)}


@owner_router.get('')
def get_settings(response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    response.headers.update(NO_STORE)
    return gallery_settings(session.get(PublicGallery, user.id), session, user.id)


@owner_router.post('', dependencies=[Depends(guard)])
def set_settings(data: GalleryInput, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    # Serialize a creator's first reservation and subsequent revisions, while
    # the slug primary key arbitrates claims by different accounts.
    if not session.scalar(select(User.id).where(User.id == user.id).with_for_update()):
        raise HTTPException(401, 'Please sign in')
    row = session.get(PublicGallery, user.id, populate_existing=True)
    if data.revision != (row.revision if row else 0):
        raise HTTPException(409, 'Gallery settings changed. Refresh before saving.')
    if data.enabled and not public_profile(session, user.id):
        raise HTTPException(409, 'Public gallery links require a public profile. Change profile privacy deliberately first.')
    # Validate the configured origin before committing an enabled public link.
    if data.enabled:
        canonical_url(data.slug)
    claim = session.get(PublicGallerySlug, data.slug)
    if claim and claim.owner_id != user.id:
        raise HTTPException(409, 'That gallery address is already reserved. Choose another.')
    if not claim:
        count = session.scalar(select(func.count()).select_from(PublicGallerySlug).where(PublicGallerySlug.owner_id == user.id))
        if count >= MAX_SLUGS_PER_OWNER:
            raise HTTPException(409, 'This account has reserved ten gallery addresses. Reuse one of your previous addresses.')
        session.add(PublicGallerySlug(slug=data.slug, owner_id=user.id))
    try:
        session.flush()
        if row is None:
            row = PublicGallery(owner_id=user.id, slug=data.slug, enabled=data.enabled)
            session.add(row)
        else:
            row.slug, row.enabled, row.revision, row.updated_at = data.slug, data.enabled, row.revision + 1, now()
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, 'That gallery address is already reserved. Choose another.') from None
    response.headers.update(NO_STORE)
    return gallery_settings(row, session, user.id)


@owner_router.post('/disable', dependencies=[Depends(guard)])
def disable(data: GalleryRevision, response: Response, user: User = Depends(current_user), session: Session = Depends(db)):
    # This exact consent-revocation route remains usable during maintenance.
    # It cannot reserve, enable or rename an address, or change profile privacy.
    if not session.scalar(select(User.id).where(User.id == user.id).with_for_update()):
        raise HTTPException(401, 'Please sign in')
    row = session.get(PublicGallery, user.id, populate_existing=True)
    if data.revision != (row.revision if row else 0):
        raise HTTPException(409, 'Gallery settings changed. Refresh before saving.')
    if row and row.enabled:
        row.enabled, row.revision, row.updated_at = False, row.revision + 1, now()
        session.commit()
    response.headers.update(NO_STORE)
    return gallery_settings(row, session, user.id)


def missing():
    raise HTTPException(404, 'Public gallery or creation not found.', headers=NO_STORE)


def available_gallery(slug, session):
    try:
        if normalize_slug(slug) != slug:
            missing()
    except ValueError:
        missing()
    row = session.scalar(select(PublicGallery).where(PublicGallery.slug == slug,
        PublicGallery.enabled.is_(True)).execution_options(populate_existing=True))
    if not row or not account_is_active(session, row.owner_id) or not public_profile(session, row.owner_id):
        missing()
    claim = session.get(PublicGallerySlug, slug)
    owner = session.get(User, row.owner_id)
    if not owner or not claim or claim.owner_id != row.owner_id:
        missing()
    return row, owner


def visible_items(owner_id):
    return (select(CreatorItem, CreatorMedia)
        .join(CreatorMedia, and_(CreatorMedia.id == CreatorItem.data['media_id'].as_string(), CreatorMedia.owner_id == owner_id))
        .outerjoin(AdminContentState, AdminContentState.item_id == CreatorItem.id)
        .where(CreatorItem.owner_id == owner_id, CreatorItem.visibility == 'published',
            or_(AdminContentState.item_id.is_(None), AdminContentState.hidden.is_(False)),
            CreatorMedia.content_type.in_(ALLOWED_MEDIA), CreatorMedia.size > 0, CreatorMedia.size <= MAX_MEDIA_BYTES))


def needs_finished_export():
    # ->> text comparisons work on PostgreSQL and SQLite JSON. Missing/null
    # additions keep old unedited posts eligible; malformed nonempty values
    # conservatively require a finished export rather than exposing outtakes.
    data = CreatorItem.data
    start = cast(data['trim_start'].as_string(), String)
    effect = data['visual_effect'].as_string()
    return or_(and_(start.is_not(None), start.not_in(('0', '0.0'))),
        data['trim_end'].as_string().is_not(None), data['timeline'].as_string().is_not(None),
        *[and_(data[key].as_string().is_not(None), data[key].as_string() != '[]')
          for key in ('captions', 'overlays')],
        data['soundtrack'].as_string().is_not(None),
        and_(effect.is_not(None), effect != 'none'))


def unavailable_count(session, owner_id):
    return session.scalar(select(func.count()).select_from(visible_items(owner_id).where(needs_finished_export()).subquery())) or 0


def iso(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat()


def projection(slug, owner, item, media):
    # Explicit whitelist: do not spread a CreatorItem or profile JSON record.
    raw = item.data if isinstance(item.data, dict) else {}
    url = f'/api/public/galleries/{slug}/items/{item.id}/media'
    image = media.content_type.startswith('image/')
    return {'id': item.id, 'title': str(raw.get('title', 'Untitled creation'))[:140],
        'description': str(raw.get('description', ''))[:3000],
        'category': raw.get('category') if raw.get('category') in ('video', 'music', 'games', 'live', 'nft', 'store') else 'video',
        'creator': owner.name, 'tags': [tag[:40] for tag in raw.get('tags', [])[:12] if isinstance(tag, str)] if isinstance(raw.get('tags'), list) else [],
        'cover': url if image else None, 'media_url': url,
        'content_type': media.content_type, 'demo': False, 'label': 'Public creation',
        'visibility': 'published', 'created_at': iso(item.created_at)}


def encode_cursor(item):
    return base64.urlsafe_b64encode(json.dumps([iso(item.created_at), item.id], separators=(',', ':')).encode()).decode().rstrip('=')


def decode_cursor(cursor):
    try:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,180}', cursor, re.ASCII):
            raise ValueError()
        values = json.loads(base64.b64decode(cursor + '=' * (-len(cursor) % 4), altchars=b'-_', validate=True))
        if not isinstance(values, list) or len(values) != 2 or not all(isinstance(v, str) for v in values):
            raise ValueError()
        moment = datetime.fromisoformat(values[0])
        identifier = str(uuid.UUID(values[1]))
        if moment.tzinfo is None or identifier != values[1]:
            raise ValueError()
        return moment, identifier
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeError):
        raise HTTPException(422, 'Invalid gallery page cursor.', headers=NO_STORE) from None


@public_router.get('/{slug}')
def gallery(slug: str, response: Response, limit: int = Query(default=24, ge=1, le=24),
            cursor: str | None = Query(default=None, max_length=180), session: Session = Depends(db)):
    row, owner = available_gallery(slug, session)
    query = visible_items(owner.id).where(~needs_finished_export())
    if cursor:
        moment, identifier = decode_cursor(cursor)
        query = query.where(or_(CreatorItem.created_at < moment,
            and_(CreatorItem.created_at == moment, CreatorItem.id < identifier)))
    entries = session.execute(query.order_by(CreatorItem.created_at.desc(), CreatorItem.id.desc()).limit(limit + 1)).all()
    current = entries[:limit]
    profile = _profile_state(session.get(CreatorPreferences, owner.id))
    artwork = {}
    for kind in ('avatar', 'cover'):
        identifier = profile[kind + '_media_id']
        try:
            if identifier:
                _profile_media(session, owner.id, identifier)
                artwork[kind] = f'/api/public/galleries/{slug}/artwork/{kind}/{identifier}'
        except HTTPException:
            pass
    response.headers.update(NO_STORE)
    # A validated selected bundled cover is already public artwork. Never use
    # it to mask an unavailable upload: uploaded cover identity stays current.
    selected_cover = profile['cover_sample'] if not profile['cover_media_id'] and profile['cover_sample'] in PROFILE_COVER_SAMPLES else None
    return {'slug': row.slug, 'name': owner.name, 'avatar_url': artwork.get('avatar'),
        'cover_url': artwork.get('cover') or selected_cover,
        'items': [projection(slug, owner, item, media) for item, media in current],
        'unavailable_count': unavailable_count(session, owner.id),
        'next_cursor': encode_cursor(current[-1][0]) if len(entries) > limit else None}


def gallery_item(slug, identifier, session):
    _, owner = available_gallery(slug, session)
    pair = session.execute(visible_items(owner.id).where(CreatorItem.id == str(identifier), ~needs_finished_export())).first()
    if not pair:
        missing()
    return owner, pair[0], pair[1]


@public_router.get('/{slug}/items/{item_id}')
def item(slug: str, item_id: uuid.UUID, response: Response, session: Session = Depends(db)):
    owner, creation, media = gallery_item(slug, item_id, session)
    response.headers.update(NO_STORE)
    return projection(slug, owner, creation, media)


def byte_range(value, size):
    if value is None:
        return 0, size - 1, False
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
    try:
        if not match or not (match[1] or match[2]) or len(value) > 80:
            raise ValueError()
        if match[1]:
            start = int(match[1]); end = min(int(match[2]), size - 1) if match[2] else size - 1
        else:
            count = int(match[2])
            if count <= 0:
                raise ValueError()
            start, end = max(0, size - count), size - 1
        if not 0 <= start <= end < size:
            raise ValueError()
        # A player can request subsequent ranges; never buffer a whole media file.
        return start, min(end, start + MAX_RANGE_BYTES - 1), True
    except (ValueError, TypeError):
        raise HTTPException(416, 'Requested media range is unavailable.', headers={**NO_STORE, 'Content-Range': f'bytes */{size}'}) from None


def media_response(request, media):
    provider = storage()
    headers = {**NO_STORE, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline'}
    if isinstance(provider, LocalStorage):
        raw = provider.path(media.id)
        path = raw.resolve()
        if raw.is_symlink() or path.parent != provider.root.resolve() or not path.is_file() or path.stat().st_size != media.size:
            missing()
        return FileResponse(path, media_type=media.content_type, headers=headers)
    if not isinstance(provider, R2Storage):
        raise HTTPException(503, 'Public media is temporarily unavailable.', headers=NO_STORE)
    start, end, partial = byte_range(request.headers.get('range'), media.size)
    expected = end - start + 1
    body = None
    try:
        key = object_key(media.owner_id, media.id)
        head = provider.client.head_object(Bucket=provider.bucket, Key=key)
        etag = head.get('ETag')
        if (head.get('ContentLength') != media.size or head.get('ContentType', '').split(';')[0] != media.content_type
                or not isinstance(etag, str) or not 2 <= len(etag) <= 128):
            raise ValueError()
        result = provider.client.get_object(Bucket=provider.bucket, Key=key, Range=f'bytes={start}-{end}', IfMatch=etag)
        body = result['Body']
        if (result.get('ContentLength') != expected or result.get('ETag') != etag
                or result.get('ContentType', '').split(';')[0] != media.content_type
                or result.get('ContentRange') != f'bytes {start}-{end}/{media.size}'):
            raise ValueError()
        first = body.read(min(65536, expected))
        if not first or len(first) > expected:
            raise ValueError()
    except Exception:
        if body is not None:
            body.close()
        raise HTTPException(503, 'Public media is temporarily unavailable.', headers=NO_STORE) from None
    headers['Content-Length'] = str(expected)
    if partial:
        headers['Content-Range'] = f'bytes {start}-{end}/{media.size}'
    def chunks():
        remaining = expected - len(first)
        try:
            yield first
            while remaining:
                chunk = body.read(min(65536, remaining))
                if not chunk or len(chunk) > remaining:
                    raise RuntimeError('Public media stream ended before its verified size.')
                remaining -= len(chunk)
                yield chunk
        finally:
            body.close()
    return StreamingResponse(chunks(), status_code=206 if partial else 200, media_type=media.content_type, headers=headers)


@public_router.get('/{slug}/items/{item_id}/media')
def read_public_media(slug: str, item_id: uuid.UUID, request: Request, session: Session = Depends(db)):
    _, _, media = gallery_item(slug, item_id, session)
    return media_response(request, media)


@public_router.get('/{slug}/artwork/{kind}/{media_id}')
def artwork(slug: str, kind: str, media_id: uuid.UUID, response: Response, session: Session = Depends(db)):
    _, owner = available_gallery(slug, session)
    if kind not in ('avatar', 'cover'):
        missing()
    profile = _profile_state(session.get(CreatorPreferences, owner.id))
    if profile[kind + '_media_id'] != str(media_id):
        missing()
    try:
        media = _profile_media(session, owner.id, media_id)
        body = _profile_image_bytes(media)
    except HTTPException:
        missing()
    return Response(body, media_type=media.content_type, headers=NO_STORE)


def export_gallery(session, owner_id):
    row = session.get(PublicGallery, owner_id)
    return {'settings': gallery_settings(row, session, owner_id),
        'reserved_slugs': list(session.scalars(select(PublicGallerySlug.slug).where(PublicGallerySlug.owner_id == owner_id).order_by(PublicGallerySlug.slug)))}


def delete_gallery(session, owner_id):
    session.execute(delete(PublicGallery).where(PublicGallery.owner_id == owner_id))
    session.execute(delete(PublicGallerySlug).where(PublicGallerySlug.owner_id == owner_id))
