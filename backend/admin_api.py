"""Administrative summaries and explicit, versioned decisions; no secret export."""
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app import User, current_user, db, guard
import admin_services as service


def private_response(response: Response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'


router = APIRouter(prefix='/api/admin', dependencies=[Depends(current_user), Depends(private_response)])
platform_router = APIRouter(prefix='/api/platform', dependencies=[Depends(private_response)])


@platform_router.get('/status')
def platform_status(session: Session = Depends(db)):
    return service.settings_json(session)


def page_result(session, query, serialize, page, page_size):
    total = session.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    rows = session.scalars(query.offset((page - 1) * page_size).limit(page_size))
    return {'items': [serialize(row) for row in rows], 'total': total, 'page': page, 'page_size': page_size}


def search_pattern(value):
    return '%' + value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


@router.get('/me')
def me(user: User = Depends(current_user), session: Session = Depends(db)):
    service.enforce_account_active(session, user)
    role = service.admin_role(session, user)
    return {'user_id': user.id, 'role': role, 'permissions': list(service.PERMISSIONS[role]), 'owner_protected': True}


@router.get('/overview')
def overview(user: User = Depends(current_user), session: Session = Depends(db)):
    from creator import CreatorItem
    from mobile_api import ContentReport
    role = service.require_permission(session, user, 'overview.read')
    count = lambda model, *terms: session.scalar(select(func.count()).select_from(model).where(*terms))
    users = count(User) if role in ('owner', 'admin') else None
    suspended = count(service.AdminUserState, service.AdminUserState.status == 'suspended') if users is not None else None
    return {'role': role, 'users': users, 'suspended_users': suspended,
            'active_users': users - suspended if users is not None else None,
            'published_content': count(CreatorItem, CreatorItem.visibility == 'published'),
            'hidden_content': count(CreatorItem, CreatorItem.visibility == 'hidden'),
            'open_reports': count(ContentReport, ContentReport.status.in_(('open', 'reviewing')))}


@router.get('/users')
def users(q: str = Query(default='', max_length=80), page: int = Query(default=1, ge=1, le=100000),
          page_size: int = Query(default=25, ge=1, le=100),
          user: User = Depends(current_user), session: Session = Depends(db)):
    service.require_permission(session, user, 'users.read')
    query = select(User).order_by(User.id)
    if q.strip():
        pattern = search_pattern(q.strip())
        query = query.where(or_(User.name.ilike(pattern, escape='\\'), User.email.ilike(pattern, escape='\\')))
    return page_result(session, query, lambda row: service.user_json(session, row), page, page_size)


@router.patch('/users/{user_id}/role', dependencies=[Depends(guard)])
def role(user_id: int, data: service.RoleDecision, user: User = Depends(current_user), session: Session = Depends(db)):
    result = service.change_role(session, user, user_id, data)
    session.commit()
    return result


@router.patch('/users/{user_id}/status', dependencies=[Depends(guard)])
def status(user_id: int, data: service.StatusDecision, user: User = Depends(current_user), session: Session = Depends(db)):
    result = service.change_status(session, user, user_id, data)
    session.commit()
    if data.status == 'suspended':
        try:
            service.revoke_sessions(user_id)
        except HTTPException:
            # Suspension and device revocation already committed. Central SQL
            # checks deny old sessions; reactivation requires a successful purge.
            result['session_revocation_pending'] = True
    return result


@router.get('/content')
def content(q: str = Query(default='', max_length=80),
            visibility: Literal['all', 'published', 'hidden'] = 'all',
            page: int = Query(default=1, ge=1, le=100000), page_size: int = Query(default=25, ge=1, le=100),
            user: User = Depends(current_user), session: Session = Depends(db)):
    from creator import CreatorItem
    service.require_permission(session, user, 'content.read')
    query = select(CreatorItem).where(CreatorItem.visibility.in_(('published', 'hidden')))
    if visibility != 'all':
        query = query.where(CreatorItem.visibility == visibility)
    if q.strip():
        query = query.where(CreatorItem.data['title'].as_string().ilike(search_pattern(q.strip()), escape='\\'))
    query = query.order_by(CreatorItem.created_at.desc(), CreatorItem.id)
    return page_result(session, query, lambda row: service.content_json(session, row), page, page_size)


@router.patch('/content/{item_id}/visibility', dependencies=[Depends(guard)])
def visibility(item_id: uuid.UUID, data: service.ContentDecision,
               user: User = Depends(current_user), session: Session = Depends(db)):
    result = service.change_content(session, user, str(item_id), data)
    session.commit()
    return result


@router.get('/reports')
def reports(status: Literal['open', 'reviewing', 'resolved', 'dismissed', 'all'] = 'open',
            page: int = Query(default=1, ge=1, le=100000), page_size: int = Query(default=25, ge=1, le=100),
            user: User = Depends(current_user), session: Session = Depends(db)):
    from mobile_api import ContentReport
    service.require_permission(session, user, 'reports.read')
    query = select(ContentReport).order_by(ContentReport.created_at.desc(), ContentReport.id)
    if status != 'all':
        query = query.where(ContentReport.status == status)
    return page_result(session, query, lambda row: service.report_json(session, row), page, page_size)


@router.patch('/reports/{report_id}', dependencies=[Depends(guard)])
def report(report_id: uuid.UUID, data: service.ReportDecision,
           user: User = Depends(current_user), session: Session = Depends(db)):
    result = service.change_report(session, user, str(report_id), data)
    session.commit()
    return result


@router.get('/comments')
def comments(item_id: uuid.UUID | None = None, comment_id: uuid.UUID | None = None,
             page: int = Query(default=1, ge=1, le=100000), page_size: int = Query(default=25, ge=1, le=100),
             user: User = Depends(current_user), session: Session = Depends(db)):
    from creator import CreatorComment, CreatorItem
    service.require_permission(session, user, 'content.read')
    query = select(CreatorComment).join(CreatorItem, CreatorComment.item_id == CreatorItem.id).where(
        CreatorItem.visibility.in_(('published', 'hidden')))
    if item_id is not None:
        query = query.where(CreatorComment.item_id == str(item_id))
    if comment_id is not None:
        query = query.where(CreatorComment.id == str(comment_id))
    query = query.order_by(CreatorComment.created_at.desc(), CreatorComment.id)
    return page_result(session, query, lambda row: service.comment_json(session, row), page, page_size)


@router.patch('/comments/{comment_id}/visibility', dependencies=[Depends(guard)])
def comment_visibility(comment_id: uuid.UUID, data: service.ContentDecision,
                       user: User = Depends(current_user), session: Session = Depends(db)):
    result = service.change_comment(session, user, str(comment_id), data)
    session.commit()
    return result


@router.get('/settings')
def settings(user: User = Depends(current_user), session: Session = Depends(db)):
    service.require_permission(session, user, 'settings.read')
    return service.settings_json(session)


@router.put('/settings', dependencies=[Depends(guard)])
def set_settings(data: service.SettingsDecision, user: User = Depends(current_user), session: Session = Depends(db)):
    result = service.change_settings(session, user, data)
    session.commit()
    return result


@router.get('/audit')
def audit(page: int = Query(default=1, ge=1, le=100000), page_size: int = Query(default=25, ge=1, le=100),
          user: User = Depends(current_user), session: Session = Depends(db)):
    service.require_permission(session, user, 'audit.read')
    query = select(service.AdminAudit).order_by(service.AdminAudit.id.desc())
    return page_result(session, query, lambda row: {
        'id': row.id, 'actor_id': row.actor_id, 'action': row.action,
        'target_type': row.target_type, 'target_id': row.target_id, 'reason': row.reason,
        'before': row.before, 'after': row.after, 'created_at': service.stamp(row.created_at),
    }, page, page_size)
