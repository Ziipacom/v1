"""Authenticated notification preferences and credential-safe registration."""
import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import User, current_user, db, guard
import notification_services as service
from notification_services import NotificationDelivery, NotificationPreference, PushDevice


def private_response(response: Response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'


router = APIRouter(prefix='/api/notifications', dependencies=[Depends(current_user), Depends(private_response)])


def notify():
    from media_workflows import notify_workflows
    notify_workflows()


@router.get('/config')
def get_config():
    from notification_worker import provider_readiness
    configured = service.capabilities()
    ready = provider_readiness()
    return {key: configured[key] for key in ('enabled', 'vapid_public_key')} | ready | {
        'readiness_protocol': 2,
        'worker_ready': any(ready.values()),
        'web_configured': configured['web_ready'], 'expo_configured': configured['expo_ready'],
        'categories': list(service.CATEGORIES),
        'notice': 'Provider readiness requires a running worker with matching encryption/provider configuration. Native delivery also requires its enhanced-security Expo sender token. Configuration and provider acceptance do not prove device display. Existing activity stays in Ziipa when push is unavailable.'}


@router.get('/preferences')
def get_preferences(user: User = Depends(current_user), session: Session = Depends(db)):
    return service.preference_receipt(session.get(NotificationPreference, user.id))


@router.put('/preferences', dependencies=[Depends(guard)])
def set_preferences(data: service.PreferenceInput, user: User = Depends(current_user), session: Session = Depends(db)):
    service.owner_lock(session, user.id)
    row = session.get(NotificationPreference, user.id)
    if data.revision != (row.revision if row else 1):
        raise HTTPException(409, 'Notification settings changed. Reload before saving.')
    if row is None:
        row = NotificationPreference(owner_id=user.id, revision=1)
        session.add(row)
    row.enabled, row.categories = data.enabled, list(data.categories)
    row.revision += 1; row.updated_at = service.now()
    # Consent changes must also invalidate work already leased but not handed off.
    condition = NotificationDelivery.category.not_in(data.categories) if data.enabled else True
    session.execute(update(NotificationDelivery).where(NotificationDelivery.owner_id == user.id,
        NotificationDelivery.status.in_(service.ACTIVE), condition).values(status='revoked',
        detail='Notification category consent was disabled.', next_run=None, lease_token='', lease_until=None,
        updated_at=service.now()))
    session.commit(); notify()
    return service.preference_receipt(row)


@router.get('/devices')
def list_devices(user: User = Depends(current_user), session: Session = Depends(db)):
    return [service.device_receipt(row) for row in session.scalars(select(PushDevice).where(
        PushDevice.owner_id == user.id).order_by(PushDevice.last_registered_at.desc()).limit(100))]


@router.post('/devices', status_code=201, dependencies=[Depends(guard)])
async def add_device(request: Request, user: User = Depends(current_user), session: Session = Depends(db)):
    # Manually bounded parsing avoids FastAPI's validation errors echoing a push
    # token/subscription in its response (hide_input_in_errors alone is not enough).
    body = bytearray()
    try:
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 8192:
                    raise HTTPException(413, 'Device registration is too large.')
    except TimeoutError:
        raise HTTPException(408, 'Device registration body timed out.') from None
    try:
        data = service.DeviceInput.model_validate(json.loads(body))
    except Exception:
        raise HTTPException(422, 'Use a valid explicitly opted-in device registration. Credentials are not echoed.') from None
    session_key = service.session_for_request(request)
    def persist():
        row = service.register_device(session, user.id, data, session_key)
        session.commit()
        return service.device_receipt(row)
    receipt = await run_in_threadpool(persist)
    notify()
    return receipt


@router.delete('/devices/{device_id}', dependencies=[Depends(guard)])
def delete_device(device_id: uuid.UUID, revision: int = Query(ge=1), user: User = Depends(current_user), session: Session = Depends(db)):
    service.owner_lock(session, user.id)
    row = session.scalar(select(PushDevice).where(PushDevice.id == str(device_id), PushDevice.owner_id == user.id).with_for_update())
    if not row:
        raise HTTPException(404, 'Device not found.')
    if revision != row.revision:
        raise HTTPException(409, 'Device registration changed. Reload before revoking it.')
    if row.status != 'revoked':
        service.revoke_device(session, row)
    session.commit(); notify()
    return {'revoked': True}


@router.post('/devices/revoke-current', dependencies=[Depends(guard)])
def revoke_current(request: Request, user: User = Depends(current_user), session: Session = Depends(db)):
    service.owner_lock(session, user.id)
    service.revoke_session_devices(session, user.id, service.session_for_request(request))
    session.commit(); notify()
    return {'revoked': True}


@router.get('/deliveries')
def list_deliveries(user: User = Depends(current_user), session: Session = Depends(db)):
    return [service.delivery_receipt(row) for row in session.scalars(select(NotificationDelivery).where(
        NotificationDelivery.owner_id == user.id).order_by(NotificationDelivery.created_at.desc()).limit(100))]


@router.post('/deliveries/{delivery_id}/opened', dependencies=[Depends(guard)])
def mark_opened(delivery_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    service.owner_lock(session, user.id)
    row = session.scalar(select(NotificationDelivery).where(NotificationDelivery.id == str(delivery_id),
        NotificationDelivery.owner_id == user.id).with_for_update())
    if not row:
        raise HTTPException(404, 'Notification receipt not found.')
    if row.opened_at is None:
        row.opened_at = service.now()
        session.commit()
    return service.delivery_receipt(row)
