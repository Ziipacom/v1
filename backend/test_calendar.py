"""Private calendar acceptance. Isolated SQL, controlled clock, no provider writes."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app as main
import calendar_api as api
import calendar_services as service
import calendar_worker as worker
import personal_media
import live_api as live
from account_services import AccountState
from creation_campaigns import CreationCampaign

REAL_READ_PROVIDER_STREAM = live.read_provider_stream

NOW = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)
PREFIX = '/api/os/calendar'


@pytest.fixture
def harness(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    main.Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as session:
        owner = main.User(name='Calendar owner', email='calendar-owner@example.test', password_hash='unused')
        stranger = main.User(name='Other owner', email='calendar-other@example.test', password_hash='unused')
        session.add_all([owner, stranger]); session.commit()
        chosen = {'user': owner}
        app = FastAPI()
        app.include_router(api.router)
        app.dependency_overrides[main.current_user] = lambda: chosen['user']
        app.dependency_overrides[main.guard] = lambda: None
        def database():
            with factory() as request_session:
                yield request_session
        app.dependency_overrides[main.db] = database
        monkeypatch.setattr(api, 'notify', lambda: None)
        monkeypatch.setattr(service, 'now', lambda: NOW)
        monkeypatch.setattr(service.config, 'enabled', True)
        monkeypatch.setattr(live, 'configured', lambda: False)
        async def forbidden(*args, **kwargs):
            pytest.fail('Unexpected provider request from calendar')
        monkeypatch.setattr(live, 'read_provider_stream', forbidden)
        monkeypatch.setattr(live, 'provider_request', forbidden)
        with TestClient(app) as client:
            yield SimpleNamespace(factory=factory, session=session, owner=owner, stranger=stranger,
                                  chosen=chosen, client=client)
    engine.dispose()


def payload(**changes):
    return {'request_id': str(uuid.uuid4()), 'title': 'Prepare a creator session', 'kind': 'reminder',
            'timezone': 'America/New_York', 'starts_local': '2026-10-19T08:15:00', **changes}


def create(h, **changes):
    response = h.client.post(PREFIX + '/events', json=payload(**changes))
    assert response.status_code == 201, response.text
    assert response.headers['cache-control'] == 'private, no-store'
    return response.json()


def detail(h, event):
    return h.client.get(PREFIX + '/events/' + event['id']).json()


def action(h, event, name, revision=None):
    return h.client.post(PREFIX + '/events/' + event['id'] + '/' + name,
                         json={'revision': revision if revision is not None else event['revision']})


def stream(h, owner=None, **changes):
    row = live.LiveStream(owner_id=(owner or h.owner).id, request_id=str(uuid.uuid4()), title='Owned live plan',
                          provider_id=str(uuid.uuid4()), status='ready', **changes)
    h.session.add(row); h.session.commit()
    return row


@pytest.mark.parametrize('changes', [
    {'timezone': 'Invalid/Timezone'}, {'starts_local': '2026-10-19T12:00:00Z'},
    {'starts_local': '2026-10-19T12:00:00.123'}, {'starts_local': '9999-12-31T23:00:00'},
    {'starts_local': '2026-03-08T02:30:00'}, {'duration_minutes': True},
    {'recurrence': {'frequency': 'weekly', 'weekdays': [True]}},
    {'recurrence': {'frequency': 'weekly', 'weekdays': ['1']}},
    {'recurrence': {'frequency': 'weekly', 'weekdays': [1, 1]}},
    {'recurrence': {'frequency': 'daily', 'count': 53}},
    {'recurrence': {'frequency': 'none', 'count': 2}},
    {'recurrence': {'frequency': 'daily', 'weekdays': [2]}},
    {'stream_id': str(uuid.uuid4())}, {'title': '\x00\x01'}, {'unknown': 'field'},
])
def test_invalid_wall_time_bounds_and_strict_inputs(changes):
    with pytest.raises(ValidationError):
        service.CreateEvent(**payload(**changes))


def test_fall_fold_is_explicit_and_daily_keeps_local_time():
    first = service.CreateEvent(**payload(starts_local='2026-11-01T01:30:00', fold='earlier'))
    second = first.model_copy(update={'fold': 'later'})
    assert service.schedule(first) == [datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc)]
    assert service.schedule(second) == [datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc)]
    recurring = service.CreateEvent(**payload(starts_local='2026-10-31T08:00:00',
        recurrence={'frequency': 'daily', 'count': 3}))
    assert [instant.hour for instant in service.schedule(recurring)] == [12, 13, 13]


def test_recurring_gap_skipped_without_consuming_actual_count():
    data = service.CreateEvent(**payload(starts_local='2026-03-07T02:30:00',
        recurrence={'frequency': 'daily', 'count': 3}))
    assert [instant.isoformat() for instant in service.schedule(data)] == [
        '2026-03-07T07:30:00+00:00', '2026-03-09T06:30:00+00:00', '2026-03-10T06:30:00+00:00']


def test_weekly_interval_multiple_days_and_inclusive_end():
    data = service.CreateEvent(**payload(recurrence={'frequency': 'weekly', 'interval': 2,
        'weekdays': [0, 2], 'count': 52, 'until': '2026-11-02'}))
    assert [instant.date().isoformat() for instant in service.schedule(data)] == ['2026-10-19', '2026-10-21', '2026-11-02']
    long = service.CreateEvent(**payload(recurrence={'frequency': 'weekly', 'interval': 12, 'count': 52}))
    with pytest.raises(HTTPException) as error:
        service.schedule(long)
    assert error.value.status_code == 422


def test_owner_idempotency_conflict_and_foreign_access(harness):
    h = harness
    data = payload()
    first = h.client.post(PREFIX + '/events', json=data)
    assert first.status_code == 201
    result = first.json()
    assert h.client.post(PREFIX + '/events', json=data).json()['id'] == result['id']
    assert h.client.post(PREFIX + '/events', json={**data, 'title': 'Different'}).status_code == 409
    assert h.session.scalar(select(func.count()).select_from(service.CalendarEvent)) == 1
    h.chosen['user'] = h.stranger
    assert h.client.get(PREFIX + '/events').json()['events'] == []
    assert h.client.get(PREFIX + '/events/' + result['id']).status_code == 404
    assert action(h, result, 'preflight').status_code == 404
    assert h.client.delete(PREFIX + '/events/' + result['id'], params={'revision': 1}).status_code == 404
    foreign = stream(h, owner=h.stranger)
    h.chosen['user'] = h.owner
    assert h.client.post(PREFIX + '/events', json=payload(kind='stream', stream_id=foreign.id)).status_code == 404


def test_initial_date_and_owner_history_limits(harness, monkeypatch):
    h = harness
    assert h.client.post(PREFIX + '/events', json=payload(starts_local='2026-10-01T08:00:00')).status_code == 422
    assert h.client.post(PREFIX + '/events', json=payload(starts_local='2028-10-01T08:00:00')).status_code == 422
    monkeypatch.setattr(service, 'MAX_EVENTS', 1)
    create(h)
    assert h.client.post(PREFIX + '/events', json=payload()).status_code == 409
    monkeypatch.setattr(service, 'MAX_EVENTS', 100)
    monkeypatch.setattr(service, 'MAX_HISTORY', 1)
    assert h.client.post(PREFIX + '/events', json=payload(recurrence={'frequency': 'daily', 'count': 2})).status_code == 409
    assert h.session.scalar(select(func.count()).select_from(service.CalendarEvent)) == 1


def test_reminder_is_durable_once_and_ack_uses_occurrence_revision(harness):
    h = harness
    event = create(h)
    assert worker.next_wakeup_at(h.session) == NOW
    assert worker.tick(h.factory, now=NOW) == 1
    assert worker.tick(h.factory, now=NOW) == 0
    receipt = detail(h, event)
    occurrence = receipt['occurrences'][0]
    assert occurrence['status'] == 'reminder_ready' and occurrence['revision'] == 2
    assert receipt['revision'] == 1
    assert receipt['automatic_broadcast'] is False and receipt['automatic_campaign_delivery'] is False
    assert worker.next_wakeup_at(h.session) is None
    assert h.session.scalar(select(func.count()).select_from(personal_media.OSActivity)
        .where(personal_media.OSActivity.kind == 'calendar_reminder')) == 1
    url = PREFIX + '/occurrences/' + occurrence['id'] + '/acknowledge'
    assert h.client.post(url, json={'revision': receipt['revision']}).status_code == 409
    acknowledged = h.client.post(url, json={'revision': occurrence['revision']}).json()
    assert acknowledged['occurrences'][0]['status'] == 'acknowledged'
    assert 'not inferred' in acknowledged['occurrences'][0]['detail']
    h.chosen['user'] = h.stranger
    assert h.client.post(url, json={'revision': 3}).status_code == 404


def test_pause_resume_skips_past_window_and_cancel_is_terminal(harness):
    h = harness
    event = create(h)
    paused = action(h, event, 'pause').json()
    assert paused['status'] == 'paused' and paused['next_reminder_at'] is None
    assert action(h, event, 'resume').status_code == 409
    assert worker.tick(h.factory, now=NOW) == 0
    assert worker.next_wakeup_at(h.session) is None
    resumed = action(h, paused, 'resume').json()
    assert resumed['revision'] == 3
    assert worker.tick(h.factory, now=NOW + timedelta(hours=2)) == 1
    assert detail(h, event)['occurrences'][0]['status'] == 'missed'
    cancelled = action(h, resumed, 'cancel').json()
    assert cancelled['status'] == 'cancelled'
    assert action(h, cancelled, 'resume').status_code == 409


def test_cancel_pending_and_ready_reminders_does_not_touch_live(harness):
    h = harness
    saved = stream(h, publish_enabled=True)
    event = create(h, kind='stream', stream_id=saved.id, recurrence={'frequency': 'daily', 'count': 2})
    worker.tick(h.factory, now=NOW)
    cancelled = action(h, event, 'cancel').json()
    assert {item['status'] for item in cancelled['occurrences']} == {'cancelled'}
    assert worker.tick(h.factory, now=NOW + timedelta(days=1)) == 0
    h.session.refresh(saved)
    assert saved.publish_enabled is True and saved.status == 'ready'
    assert 'BEGIN:VEVENT' not in h.client.get(PREFIX + '/export.ics').text


def test_edit_preserves_receipts_replaces_undelivered_and_rejects_stale(harness):
    h = harness
    event = create(h, recurrence={'frequency': 'daily', 'count': 2})
    worker.tick(h.factory, now=NOW)
    data = payload(title='Revised plan', starts_local='2026-10-20T08:00:00')
    data.pop('request_id'); data['revision'] = 1
    response = h.client.put(PREFIX + '/events/' + event['id'], json=data)
    assert response.status_code == 200, response.text
    revised = response.json()
    assert revised['revision'] == 2 and len(revised['occurrences']) == 2
    assert {(item['event_revision'], item['status']) for item in revised['occurrences']} == {(1, 'reminder_ready'), (2, 'scheduled')}
    assert h.client.put(PREFIX + '/events/' + event['id'], json=data).status_code == 409


def test_crash_before_atomic_commit_rolls_back_and_recovers(harness, monkeypatch):
    h = harness
    event = create(h)
    real_activity = personal_media.record_activity
    def fail(session, *args, **kwargs):
        real_activity(session, *args, **kwargs)
        session.flush()
        raise RuntimeError('simulated crash before commit')
    monkeypatch.setattr(personal_media, 'record_activity', fail)
    with pytest.raises(RuntimeError, match='simulated crash'):
        worker.tick(h.factory, now=NOW)
    assert detail(h, event)['occurrences'][0]['status'] == 'scheduled'
    assert h.session.scalar(select(func.count()).select_from(personal_media.OSActivity)
        .where(personal_media.OSActivity.kind == 'calendar_reminder')) == 0
    monkeypatch.setattr(personal_media, 'record_activity', real_activity)
    assert worker.tick(h.factory, now=NOW) == 1
    assert worker.tick(h.factory, now=NOW) == 0


def test_worker_disabled_is_noop_without_opening_database(monkeypatch):
    monkeypatch.setattr(service.config, 'enabled', False)
    def forbidden():
        pytest.fail('Disabled calendar queried database')
    assert worker.tick(forbidden) == 0
    assert worker.next_wakeup_at(None) is None


def test_worker_concurrent_instances_deliver_only_once(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'calendar-concurrency.db'), connect_args={'timeout': 10})
    main.Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    monkeypatch.setattr(service.config, 'enabled', True)
    with factory() as session:
        owner = main.User(name='Concurrent', email='calendar-concurrent@example.test', password_hash='unused')
        session.add(owner); session.flush()
        fields = service.CreateEvent(**payload())
        event = service.CalendarEvent(owner_id=owner.id, request_id=str(uuid.uuid4()), request_hash='a' * 64,
            data=api.fields_json(fields))
        session.add(event); session.flush()
        service.add_occurrences(session, event, fields, service.schedule(fields)); session.commit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        counts = list(pool.map(lambda _: worker.tick(factory, now=NOW), range(2)))
    assert sum(counts) == 1
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(personal_media.OSActivity)
            .where(personal_media.OSActivity.kind == 'calendar_reminder')) == 1
    engine.dispose()


def test_reminder_rechecks_privacy_and_deleted_link_without_provider(harness):
    h = harness
    saved = stream(h)
    event = create(h, kind='stream', stream_id=saved.id)
    h.session.add(AccountState(owner_id=h.owner.id, privacy={'profile_visibility': 'private'}))
    h.session.delete(saved); h.session.commit()
    assert worker.tick(h.factory, now=NOW) == 1
    checks = {value['id']: value for value in detail(h, event)['occurrences'][0]['checklist']['checks']}
    assert checks['profile']['status'] == 'needs_action' and checks['broadcast']['status'] == 'needs_action'
    result = action(h, event, 'preflight').json()['preflight']
    assert result['status'] == 'needs_setup' and result['provider_verified'] is False


def test_preflight_uses_only_provider_get_and_discards_private_raw_data(harness, monkeypatch):
    h = harness
    saved = stream(h, publish_enabled=True)
    event = create(h, kind='stream', stream_id=saved.id)
    monkeypatch.setattr(live, 'configured', lambda: True)
    calls = []
    async def read(method, path, *args, **kwargs):
        calls.append((method, path))
        assert method == 'GET' and path == '/stream/' + saved.provider_id
        return {'id': saved.provider_id, 'isActive': False, 'suspended': False,
                'playbackPolicy': {'type': 'public'}, 'streamKey': 'never-expose-calendar-key',
                'playbackId': 'never-expose-playback-id'}
    # Exercise the real validation adapter, while mocking its transport boundary.
    monkeypatch.setattr(live, 'read_provider_stream', REAL_READ_PROVIDER_STREAM)
    monkeypatch.setattr(live, 'provider_request', read)
    result = action(h, event, 'preflight')
    assert result.status_code == 200, result.text
    preflight = result.json()['preflight']
    assert preflight['provider_verified'] is True and preflight['provider_active'] is False
    assert preflight['requires_explicit_start'] is True and preflight['automatic_broadcast'] is False
    assert len(calls) == 1
    assert action(h, event, 'preflight').status_code == 200 and len(calls) == 1
    second = create(h, kind='stream', stream_id=saved.id)
    assert action(h, second, 'preflight').status_code == 429
    assert 'never-expose' not in result.text + h.client.get(PREFIX + '/export.ics').text
    h.session.expire_all()
    assert 'never-expose' not in json.dumps(h.session.get(service.CalendarEvent, event['id']).preflight)
    h.session.refresh(saved)
    assert saved.status == 'ready' and saved.checked_at is None and saved.publish_enabled is True
    monkeypatch.setattr(service, 'now', lambda: NOW + timedelta(seconds=21))
    expired = detail(h, event)['preflight']
    assert expired['status'] == 'unknown' and expired['provider_verified'] is False


@pytest.mark.parametrize('expires_at', [None, 'not-a-time', '2026-10-19T12:00:20', '2026-10-19T12:00:00Z'])
def test_preflight_malformed_or_missing_expiry_fails_closed(expires_at, monkeypatch):
    monkeypatch.setattr(service, 'now', lambda: NOW)
    saved = {'status': 'verified', 'provider_verified': True, 'provider_active': True,
             'expires_at': expires_at, 'checks': [{'id': 'provider', 'status': 'ready'}]}
    result = service.safe_preflight(saved)
    assert result['provider_verified'] is False and result['provider_active'] is False
    assert result['checks'][0]['status'] == 'unknown'
    assert saved['provider_verified'] is True


def test_preflight_provider_failure_never_reuses_old_live_status(harness, monkeypatch):
    h = harness
    saved = stream(h, publish_enabled=True)
    event = create(h, kind='stream', stream_id=saved.id)
    monkeypatch.setattr(live, 'configured', lambda: True)
    async def unavailable(*args):
        raise HTTPException(503, 'untrusted-provider-secret-error')
    monkeypatch.setattr(live, 'read_provider_stream', unavailable)
    response = action(h, event, 'preflight')
    assert response.status_code == 200
    assert response.json()['preflight']['status'] == 'unknown'
    assert response.json()['preflight']['provider_active'] is False
    assert 'untrusted-provider' not in response.text


def test_preflight_private_profile_cannot_claim_public_live(harness, monkeypatch):
    h = harness
    saved = stream(h, publish_enabled=True)
    event = create(h, kind='stream', stream_id=saved.id)
    h.session.add(AccountState(owner_id=h.owner.id, privacy={'profile_visibility': 'private'})); h.session.commit()
    monkeypatch.setattr(live, 'configured', lambda: True)
    async def active(*args):
        return {'isActive': True, 'suspended': False, 'playbackPolicy': {'type': 'public'}}
    monkeypatch.setattr(live, 'read_provider_stream', active)
    result = action(h, event, 'preflight').json()['preflight']
    assert result['provider_verified'] is True and result['provider_active'] is False
    assert next(check for check in result['checks'] if check['id'] == 'profile')['status'] == 'needs_action'


def test_campaign_link_is_read_only_and_does_not_imply_approval(harness):
    h = harness
    campaign = CreationCampaign(owner_id=h.owner.id, request_id=str(uuid.uuid4()), request_hash='x' * 64,
        item_id=str(uuid.uuid4()), name='Unreviewed campaign', title='Draft', status='draft', review_hash='x' * 64)
    h.session.add(campaign); h.session.commit()
    event = create(h, kind='campaign', campaign_id=campaign.id)
    assert worker.tick(h.factory, now=NOW) == 1
    checks = detail(h, event)['occurrences'][0]['checklist']['checks']
    assert next(check for check in checks if check['id'] == 'approval')['status'] == 'needs_action'
    assert action(h, event, 'preflight').json()['preflight']['provider_verified'] is False
    h.session.refresh(campaign)
    assert campaign.status == 'draft' and campaign.approved_hash == '' and campaign.schedule_at is None
    assert h.client.get(PREFIX + '/events').json()['campaigns'][0]['read_only'] is True
    h.chosen['user'] = h.stranger
    assert h.client.post(PREFIX + '/events', json=payload(kind='campaign', campaign_id=campaign.id)).status_code == 404


def test_ics_private_utc_escaping_folding_and_account_delete_transaction(harness):
    h = harness
    own = create(h, title='🎥' * 80, notes='Line one\r\nATTENDEE:mailto:someone@example.test; x,y\\z')
    h.chosen['user'] = h.stranger
    other = create(h, title='Private other owner')
    h.chosen['user'] = h.owner
    response = h.client.get(PREFIX + '/export.ics')
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['content-type'].startswith('text/calendar')
    assert 'CLASS:PRIVATE' in response.text and 'DTSTART:20261019T121500Z' in response.text
    assert 'Private other owner' not in response.text
    assert '\r\nATTENDEE:' not in response.text and '\\nATTENDEE:' in response.text
    assert '\\;' in response.text and '\\,' in response.text and '\\\\z' in response.text
    assert all(len(line.encode('utf-8')) <= 75 for line in response.text.split('\r\n'))
    exported = service.export_calendar_data(h.session, h.owner.id)
    assert [event['id'] for event in exported['events']] == [own['id']]
    service.delete_calendar_data(h.session, h.owner.id)
    h.session.rollback()
    assert h.session.get(service.CalendarEvent, own['id']) is not None
    service.delete_calendar_data(h.session, h.owner.id); h.session.commit()
    assert h.session.get(service.CalendarEvent, own['id']) is None
    assert h.session.get(service.CalendarEvent, other['id']) is not None
    assert h.session.scalar(select(func.count()).select_from(service.CalendarOccurrence)) == 1


def test_cancelled_series_does_not_export_acknowledged_history_as_confirmed(harness):
    h = harness
    event = create(h, recurrence={'frequency': 'daily', 'count': 3})
    assert worker.tick(h.factory, now=NOW) == 1
    occurrence = detail(h, event)['occurrences'][0]
    acknowledged = h.client.post(PREFIX + '/occurrences/' + occurrence['id'] + '/acknowledge',
                                  json={'revision': occurrence['revision']})
    assert acknowledged.status_code == 200
    assert action(h, event, 'cancel').status_code == 200
    retained = detail(h, event)
    assert retained['occurrences'][0]['status'] == 'acknowledged'
    response = h.client.get(PREFIX + '/export.ics')
    assert response.status_code == 200 and 'BEGIN:VEVENT' not in response.text


def test_ics_export_is_bounded_without_silent_truncation_and_supports_private_ranges(harness, monkeypatch):
    h = harness
    monkeypatch.setattr(service, 'MAX_ICS_OCCURRENCES', 2)
    repeated = create(h, recurrence={'frequency': 'daily', 'count': 3})
    assert h.client.get(PREFIX + '/export.ics').status_code == 413
    response = h.client.get(PREFIX + '/export.ics', params={
        'starts_after': '2026-10-20T00:00:00Z', 'starts_before': '2026-10-22T00:00:00Z'})
    assert response.status_code == 200 and response.text.count('BEGIN:VEVENT') == 2
    single = create(h, title='Export only this event')
    response = h.client.get(PREFIX + '/export.ics', params={'event_id': single['id']})
    assert response.status_code == 200 and response.text.count('BEGIN:VEVENT') == 1
    assert 'Export only this event' in response.text
    for filters in ({'starts_after': '2026-10-20T00:00:00'},
                    {'starts_after': '2026-10-22T00:00:00Z', 'starts_before': '2026-10-20T00:00:00Z'}):
        assert h.client.get(PREFIX + '/export.ics', params=filters).status_code == 422
    h.chosen['user'] = h.stranger
    assert h.client.get(PREFIX + '/export.ics', params={'event_id': repeated['id']}).status_code == 404
