"""Transaction-only calendar reminder delivery. No camera or provider calls."""
from sqlalchemy import func, select

from app import User
import calendar_services as service
from calendar_services import CalendarEvent, CalendarOccurrence


def tick(session_factory, now=None):
    if not service.config.enabled:
        return 0
    current = service.aware(now or service.now())
    with session_factory() as session:
        candidates = list(session.execute(select(CalendarOccurrence.id, CalendarOccurrence.owner_id, CalendarOccurrence.event_id)
            .join(CalendarEvent, CalendarEvent.id == CalendarOccurrence.event_id)
            .where(CalendarEvent.owner_id == CalendarOccurrence.owner_id, CalendarEvent.status == 'active',
                CalendarOccurrence.status == 'scheduled', CalendarOccurrence.remind_at <= current)
            .order_by(CalendarOccurrence.remind_at, CalendarOccurrence.id).limit(50)))
    completed = 0
    for occurrence_id, owner_id, event_id in candidates:
        with session_factory() as session:
            # Same lock order as owner edits/cancellation/deletion. One atomic
            # transaction contains receipt + activity. Crashes before commit
            # roll both back, so recovery can safely repeat without duplicate delivery.
            if not service.lock_owner(session, owner_id, skip=True):
                continue
            event = session.scalar(select(CalendarEvent).where(CalendarEvent.id == event_id,
                CalendarEvent.owner_id == owner_id).with_for_update(skip_locked=True).execution_options(populate_existing=True))
            occurrence = session.scalar(select(CalendarOccurrence).where(CalendarOccurrence.id == occurrence_id,
                CalendarOccurrence.owner_id == owner_id).with_for_update(skip_locked=True).execution_options(populate_existing=True))
            if not event or not occurrence or event.status != 'active' or occurrence.status != 'scheduled' or service.aware(occurrence.remind_at) > current:
                continue
            if service.aware(occurrence.ends_at) <= current:
                occurrence.status = 'missed'
                occurrence.detail = 'The planned event window passed while this reminder was unavailable or paused. No action was performed.'
            else:
                occurrence.status = 'reminder_ready'
                occurrence.detail = 'Private reminder ready in Ziipa. Open Studio and explicitly review/start any broadcast or campaign yourself.'
                # Re-read current privacy, ownership and authorizations locally;
                # readiness remains unverified until an explicit preflight GET.
                occurrence.checklist = service.checklist(session, event)
                occurrence.delivered_at = current
                from notification_services import enqueue_notification
                enqueue_notification(session, owner_id, 'calendar', occurrence.id,
                                     expires_at=service.aware(occurrence.ends_at))
            occurrence.revision += 1
            occurrence.updated_at = current
            from personal_media import record_activity
            record_activity(session, owner_id, 'calendar_reminder', occurrence.detail, status=occurrence.status,
                            details={'source': 'private_calendar'})
            session.commit()
            completed += 1
    return completed


def next_wakeup_at(session):
    if not service.config.enabled:
        return None
    value = session.scalar(select(func.min(CalendarOccurrence.remind_at)).join(CalendarEvent,
        CalendarEvent.id == CalendarOccurrence.event_id).where(CalendarEvent.owner_id == CalendarOccurrence.owner_id,
            CalendarEvent.status == 'active', CalendarOccurrence.status == 'scheduled'))
    return service.aware(value)
