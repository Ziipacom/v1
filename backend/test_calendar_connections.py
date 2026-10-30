"""Calendar acceptance with synthetic users/events and mocked provider transport."""
import base64
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import uuid

from alembic import command
from alembic.config import Config
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app as main
import calendar_api
import calendar_connections as service
import calendar_connections_api as api
import calendar_services
import social_publishing as publishing

ROOT = api.PREFIX


def test_additive_migration_preserves_existing_account():
    engine = create_engine('sqlite://')
    added = {'calendar_connections', 'connected_calendar_events', 'calendar_exports', 'device_calendar_snapshots'}
    main.Base.metadata.create_all(engine, tables=[table for table in main.Base.metadata.sorted_tables if table.name not in added])
    with engine.begin() as connection:
        connection.execute(main.User.__table__.insert().values(
            name='Existing creator', email='migration@example.test', password_hash='unused'))
        config = Config(str(Path(__file__).with_name('alembic.ini')))
        config.set_main_option('script_location', str(Path(__file__).with_name('migrations')))
        config.attributes['connection'] = connection
        command.stamp(config, '20261029_0015')
        command.upgrade(config, 'head')
        assert added <= set(inspect(connection).get_table_names())
        assert connection.scalar(select(main.User.name).where(main.User.email == 'migration@example.test')) == 'Existing creator'
        assert connection.scalar(select(service.CalendarConnection.id)) is None
    engine.dispose()


@pytest.fixture
def h(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    main.Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as session:
        users = [main.User(name=name, email=name + '@example.test', password_hash='unused') for name in ('calendar-one', 'calendar-two')]
        session.add_all(users); session.commit()
        actor = {'user': users[0]}
        app = FastAPI(); app.include_router(api.router); app.include_router(calendar_api.router)
        app.dependency_overrides[main.current_user] = lambda: actor['user']
        app.dependency_overrides[main.guard] = lambda: None
        def database():
            with factory() as db:
                yield db
        app.dependency_overrides[main.db] = database
        monkeypatch.setattr(publishing, 'current_user', lambda request, db: actor['user'])
        monkeypatch.setattr(service.config, 'enabled', True)
        for provider in ('google', 'microsoft'):
            monkeypatch.setattr(service.config, provider + '_client_id', 'synthetic-client')
            monkeypatch.setattr(service.config, provider + '_client_secret', 'synthetic-secret')
            monkeypatch.setattr(service.config, provider + '_public_approved', False)
        monkeypatch.setattr(publishing.config, 'api_origin', 'https://ziipa.example.test')
        monkeypatch.setattr(publishing.config, 'approved_origins', 'https://ziipa.example.test')
        monkeypatch.setattr(publishing.config, 'encryption_key', base64.b64encode(b't' * 32).decode())
        calls = []
        response = {'handler': lambda request: httpx.Response(200, json={'items': []})}
        def handler(request):
            calls.append(request)
            return response['handler'](request)
        monkeypatch.setattr(service, 'client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        with TestClient(app) as client:
            yield SimpleNamespace(client=client, factory=factory, session=session, user=users[0], other=users[1], actor=actor,
                                  response=response, calls=calls)
    engine.dispose()


def connection(h, provider='google'):
    cipher = service.encrypted(h.user.id, provider, {'access_token': 'synthetic-access', 'refresh_token': 'synthetic-refresh',
        'scope': ' '.join(service.SCOPES[provider]), 'expires_in': 3600})
    row = service.CalendarConnection(owner_id=h.user.id, provider=provider, token_cipher=cipher,
        calendar_id='chosen-calendar', calendar_name='Private studio calendar')
    h.session.add(row); h.session.commit()
    return row.id


def google_event(event_id='event-one', **changes):
    return {'id': event_id, 'summary': 'Private pitch', 'description': 'Review owned media', 'etag': '"v1"',
        'start': {'dateTime': '2026-11-06T08:00:00Z'}, 'end': {'dateTime': '2026-11-06T09:00:00Z'}, **changes}


def device_payload(**changes):
    return {'device_key': str(uuid.uuid4()), 'calendar_name': 'Phone calendar', 'events': [{
        'id': 'a' * 64, 'title': 'Private event', 'notes': 'Local note', 'starts_at': '2026-11-06T08:00:00Z',
        'ends_at': '2026-11-06T09:00:00Z'}], **changes}


def test_readiness_never_claims_configured_without_credentials(h, monkeypatch):
    monkeypatch.setattr(service.config, 'google_client_secret', '')
    data = h.client.get(ROOT).json()
    assert not data['providers'][0]['ready']
    assert data['automatic_sync'] is False
    assert h.client.post(ROOT + '/oauth/google/start').status_code == 503
    assert not h.calls


def test_native_oauth_requires_portal_not_a_bearer_handoff(h):
    result = h.client.post(ROOT + '/oauth/google/start', headers={'Authorization': 'Bearer synthetic-native'}).json()
    assert result['status'] == 'browser_sign_in_required'
    assert result['auth_url'] is None
    assert result['portal_url'] == 'https://ziipa.example.test/studio/?view=calendar'
    assert not h.calls


def test_provider_setup_does_not_imply_public_authorization_approval(h, monkeypatch):
    providers = {item['provider']: item for item in h.client.get(ROOT).json()['providers']}
    assert all(item['ready'] and item['testing_only'] for item in providers.values())
    monkeypatch.setattr(service.config, 'microsoft_public_approved', True)
    providers = {item['provider']: item for item in h.client.get(ROOT).json()['providers']}
    assert providers['google']['testing_only']
    assert not providers['microsoft']['testing_only']
    assert not h.calls


def test_oauth_browser_binding_replay_and_changed_account(h):
    h.client.cookies.set('ziipa_session', 'synthetic-session')
    start = h.client.post(ROOT + '/oauth/google/start')
    assert start.status_code == 200
    url = start.json()['auth_url'].replace('https://ziipa.example.test', '')
    assert 'synthetic-secret' not in start.text
    # Secure binding cookies are sent only to HTTPS; use the test browser's
    # secure origin, rather than loosening the production cookie attributes.
    h.client.base_url = 'https://ziipa.example.test'
    cookie = next(value for name, value in start.cookies.items() if name == 'ziipa_calendar_google')
    h.client.cookies.set('ziipa_calendar_google', cookie)
    approved = h.client.get(url, follow_redirects=False)
    assert approved.status_code == 302
    assert approved.headers['location'].startswith('https://accounts.google.com/o/oauth2/v2/auth?')
    assert 'code_challenge_method=S256' in approved.headers['location']
    assert h.client.get(url, follow_redirects=False).status_code == 400
    again = h.client.post(ROOT + '/oauth/google/start').json()['auth_url'].replace('https://ziipa.example.test', '')
    h.actor['user'] = h.other
    assert h.client.get(again, follow_redirects=False).status_code == 401
    assert not h.calls


def test_sync_is_private_bounded_and_removes_missing_events_only_after_success(h):
    row_id = connection(h)
    h.response['handler'] = lambda request: httpx.Response(200, json={'items': [google_event()]})
    result = h.client.post(ROOT + '/' + row_id + '/sync')
    assert result.status_code == 200, result.text
    assert result.json()['imported'] == 1
    assert all(call.method == 'GET' for call in h.calls)
    data = h.client.get(ROOT)
    assert data.headers['cache-control'] == 'private, no-store'
    assert data.json()['events'][0]['title'] == 'Private pitch'
    assert 'synthetic-access' not in data.text and 'synthetic-refresh' not in data.text
    assert h.client.get('/api/os/calendar/events').json()['connected_events'][0]['title'] == 'Private pitch'
    h.actor['user'] = h.other
    assert h.client.get(ROOT).json()['events'] == []
    assert h.client.post(ROOT + '/' + row_id + '/sync').status_code == 404
    h.actor['user'] = h.user
    h.response['handler'] = lambda request: httpx.Response(503, json={'error': 'synthetic-provider-failure'})
    assert h.client.post(ROOT + '/' + row_id + '/sync').status_code == 502
    assert len(h.client.get(ROOT).json()['events']) == 1
    h.response['handler'] = lambda request: httpx.Response(200, json={'items': []})
    assert h.client.post(ROOT + '/' + row_id + '/sync').json()['imported'] == 0
    assert h.client.get(ROOT).json()['events'] == []


def test_calendar_selection_validates_provider_and_does_not_retain_old_mirrors(h):
    row_id = connection(h)
    h.response['handler'] = lambda request: httpx.Response(200, json={'items': [{'id': 'verified', 'summary': 'Studio', 'accessRole': 'writer'}]})
    assert h.client.post(ROOT + '/' + row_id + '/select', json={'calendar_id': 'forged'}).status_code == 422
    assert h.client.post(ROOT + '/' + row_id + '/select', json={'calendar_id': 'verified'}).json()['calendar_name'] == 'Studio'


def test_event_edit_rejects_guests_and_stale_etag(h):
    row_id = connection(h)
    h.response['handler'] = lambda request: httpx.Response(200, json={'items': [google_event()]})
    h.client.post(ROOT + '/' + row_id + '/sync')
    event = h.client.get(ROOT).json()['events'][0]
    body = {name: event[name] for name in ('title', 'notes', 'starts_at', 'ends_at', 'revision')}
    edit = ROOT + '/' + row_id + '/events/' + event['id'] + '/edit'
    h.response['handler'] = lambda request: httpx.Response(200, json=google_event(attendees=[{'email': 'not-transmitted@example.test'}]))
    assert h.client.post(edit, json=body).status_code == 409
    assert all(call.method != 'PATCH' for call in h.calls)
    h.response['handler'] = lambda request: httpx.Response(200, json=google_event(etag='"v2"'))
    assert h.client.post(edit, json=body).status_code == 409
    h.response['handler'] = lambda request: httpx.Response(200, json=google_event(etag='"v1"' if request.method == 'GET' else '"v2"'))
    assert h.client.post(edit, json={**body, 'title': 'Reviewed pitch'}).status_code == 200
    patch = next(call for call in h.calls if call.method == 'PATCH')
    assert patch.headers['if-match'] == '"v1"'
    assert patch.url.params['sendUpdates'] == 'none'
    assert 'attendees' not in patch.content.decode()
    assert h.client.get(ROOT).json()['events'][0]['title'] == 'Reviewed pitch'


def test_device_snapshot_replaces_only_own_data_and_account_delete_erases_it(h):
    payload = device_payload()
    result = h.client.post(ROOT + '/device/snapshot', json=payload)
    assert result.status_code == 200, result.text
    assert h.client.post(ROOT + '/device/snapshot', json=payload).json()['count'] == 1
    snapshots = h.client.get(ROOT).json()['device_snapshots']
    assert len(snapshots) == 1
    h.actor['user'] = h.other
    assert h.client.get(ROOT).json()['device_snapshots'] == []
    assert h.client.post(ROOT + '/device/' + snapshots[0]['id'] + '/disconnect').status_code == 404
    h.actor['user'] = h.user
    with h.factory() as db:
        calendar_services.delete_calendar_data(db, h.user.id); db.commit()
    assert h.client.get(ROOT).json()['device_snapshots'] == []
    assert not h.calls


@pytest.mark.parametrize('change', [{'events': [{'id': 'bad'}]}, {'extra': True}])
def test_device_snapshot_rejects_unbounded_or_unrecognized_fields(h, change):
    assert h.client.post(ROOT + '/device/snapshot', json={**device_payload(), **change}).status_code == 422


def test_microsoft_next_link_cannot_exfiltrate_access_token(h):
    row_id = connection(h, 'microsoft')
    h.response['handler'] = lambda request: httpx.Response(200, json={'value': [], '@odata.nextLink': 'https://evil.example.test/steal'})
    assert h.client.post(ROOT + '/' + row_id + '/sync').status_code == 502
    assert len(h.calls) == 1
    assert h.calls[0].url.host == 'graph.microsoft.com'


def test_refresh_preserves_missing_scope_and_encrypted_owner_binding(h):
    row_id = connection(h)
    row = h.session.get(service.CalendarConnection, row_id)
    assert 'synthetic-access' not in row.token_cipher
    with pytest.raises(HTTPException):
        publishing.decrypt_tokens(SimpleNamespace(owner_id=h.other.id, provider='calendar:google', token_cipher=row.token_cipher))
    cipher = service.encrypted(h.user.id, 'google', {'access_token': 'refreshed', 'expires_in': 3600}, {
        'scope': sorted(service.SCOPES['google']), 'refresh_token': 'synthetic-refresh'})
    result = publishing.decrypt_tokens(SimpleNamespace(owner_id=h.user.id, provider='calendar:google', token_cipher=cipher))
    assert result['access_token'] == 'refreshed'
    assert result['refresh_token'] == 'synthetic-refresh'


def test_disconnect_still_works_when_provider_is_disabled(h, monkeypatch):
    row_id = connection(h)
    monkeypatch.setattr(service.config, 'enabled', False)
    assert h.client.post(ROOT + '/' + row_id + '/disconnect').status_code == 200
    assert h.client.get(ROOT).json()['connections'] == []
    assert not h.calls


def test_export_is_owner_scoped_guest_free_and_idempotent(h):
    from datetime import timedelta
    import json
    row_id = connection(h)
    start = service.now() + timedelta(days=1)
    event = calendar_services.CalendarEvent(owner_id=h.user.id, request_id=str(uuid.uuid4()), request_hash='a' * 64,
        data={'title': 'Owned release', 'notes': 'Owned production plan'}, revision=1, status='active')
    h.session.add(event); h.session.flush()
    occurrence = calendar_services.CalendarOccurrence(event_id=event.id, owner_id=h.user.id, event_revision=1,
        starts_at=start, ends_at=start + timedelta(hours=1), remind_at=start - timedelta(minutes=15))
    h.session.add(occurrence); h.session.commit()
    def handler(request):
        assert request.method == 'POST'
        body = json.loads(request.content)
        assert 'attendees' not in body
        assert 'eventId=' + event.id in body['description']
        assert request.url.params['sendUpdates'] == 'none'
        return httpx.Response(200, json={'id': body['id'], 'etag': '"created"'})
    h.response['handler'] = handler
    body = {'occurrence_id': occurrence.id}
    h.actor['user'] = h.other
    assert h.client.post(ROOT + '/' + row_id + '/export', json=body).status_code == 404
    h.actor['user'] = h.user
    first = h.client.post(ROOT + '/' + row_id + '/export', json=body)
    assert first.status_code == 200, first.text
    assert first.json()['already_exported'] is False
    assert h.client.post(ROOT + '/' + row_id + '/export', json=body).json()['already_exported'] is True
    assert len(h.calls) == 1


def test_oauth_callback_saves_encrypted_grant_without_reading_any_events(h):
    from urllib.parse import urlsplit, parse_qs
    h.client.base_url = 'https://ziipa.example.test'
    h.client.cookies.set('ziipa_session', 'synthetic-session')
    start = h.client.post(ROOT + '/oauth/google/start')
    authorize = start.json()['auth_url']
    redirect = h.client.get(authorize, follow_redirects=False)
    assert redirect.status_code == 302
    state = parse_qs(urlsplit(redirect.headers['location']).query)['state'][0]
    h.response['handler'] = lambda request: httpx.Response(200, json={'access_token': 'new-synthetic-access',
        'refresh_token': 'new-synthetic-refresh', 'expires_in': 3600, 'scope': ' '.join(service.SCOPES['google'])})
    saved = h.client.get(ROOT + '/oauth/google/callback', params={'state': state, 'code': 'synthetic-code'})
    assert saved.status_code == 200, saved.text
    assert 'No events were read or written yet' in saved.text
    assert 'new-synthetic-access' not in saved.text
    rows = h.client.get(ROOT).json()['connections']
    assert len(rows) == 1 and not rows[0]['selected']
    with h.factory() as db:
        grant = db.get(service.CalendarConnection, rows[0]['id'])
        assert grant.token_cipher.startswith('v1.') and 'new-synthetic-access' not in grant.token_cipher
    assert h.client.get(ROOT + '/oauth/google/callback', params={'state': state, 'code': 'synthetic-code'}).status_code == 400
    assert len(h.calls) == 1 and h.calls[0].url == service.token_url('google')
