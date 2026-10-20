"""Real cookie/bearer authorization and moderation boundaries on local services."""
from app import app, db, User
from test_api import client, register_creator, native_headers
from admin_services import bootstrap_owner


def owner_session(client):
    register_creator(client, 'operator@example.com')
    identifier = client.get('/api/me').json()['id']
    session = next(app.dependency_overrides[db]())
    bootstrap_owner(session, user_id=identifier, email='operator@example.com',
                    reason='Explicit isolated test owner assignment.', apply=True)
    session.commit()
    response = client.post('/api/mobile/auth/login', json={
        'email': 'operator@example.com', 'password': 'creator-test-pass-123'})
    assert response.status_code == 200
    return {'Authorization': 'Bearer ' + response.json()['access_token']}, identifier


def test_existing_cookie_and_bearer_use_current_database_roles(client):
    owner, identifier = owner_session(client)
    assert client.get('/api/me').json()['role'] == 'owner'
    assert client.get('/api/me', headers=owner).json()['is_admin'] is True
    member = native_headers(client, 'staff-candidate@example.com')
    user_id = client.get('/api/me', headers=member).json()['id']
    assert client.get('/api/admin/users', headers=member).status_code == 403
    decision = {'role': 'moderator', 'expected_version': 0,
                'reason': 'Assigned a scoped moderation role in an isolated test.'}
    assert client.patch(f'/api/admin/users/{user_id}/role', headers=owner, json=decision).status_code == 200
    assert client.get('/api/me', headers=member).json()['role'] == 'moderator'
    assert client.get('/api/admin/reports', headers=member).status_code == 200
    assert client.get('/api/admin/users', headers=member).status_code == 403
    decision.update(role='member', expected_version=1)
    assert client.patch(f'/api/admin/users/{user_id}/role', headers=owner, json=decision).status_code == 200
    assert client.get('/api/me', headers=member).json()['role'] == 'member'
    assert client.get('/api/admin/reports', headers=member).status_code == 403
    decision.update(role='member', expected_version=0)
    assert client.patch(f'/api/admin/users/{identifier}/role', headers=owner, json=decision).status_code == 403
    assert client.post('/api/account/delete', headers=owner,
                       json={'password': 'creator-test-pass-123', 'confirmation': 'DELETE'}).status_code == 409


def test_suspension_stops_existing_devices_and_both_login_routes(client):
    owner, _ = owner_session(client)
    member = native_headers(client, 'suspension@example.com')
    user_id = client.get('/api/me', headers=member).json()['id']
    credentials = {'email': 'suspension@example.com', 'password': 'native-password-123'}
    assert client.post('/api/auth/login', json=credentials).status_code == 200
    result = client.patch(f'/api/admin/users/{user_id}/status', headers=owner,
        json={'status': 'suspended', 'expected_version': 0, 'reason': 'Reviewed a safety issue in an isolated test.'})
    assert result.status_code == 200
    assert result.json()['status'] == 'suspended'
    assert client.get('/api/me').status_code in (401, 403)
    assert client.get('/api/me', headers=member).status_code in (401, 403)
    assert client.post('/api/auth/login', json=credentials).status_code == 403
    assert client.post('/api/mobile/auth/login', json=credentials).status_code == 403
    assert client.patch(f'/api/admin/users/{user_id}/status', headers=owner,
        json={'status': 'active', 'expected_version': 1, 'reason': 'The isolated safety issue has been resolved.'}).status_code == 200
    assert client.get('/api/me', headers=member).status_code == 401
    result = client.post('/api/mobile/auth/login', json=credentials)
    assert result.status_code == 200
    assert result.json()['user']['role'] == 'member'


def test_signup_and_maintenance_controls_apply_to_web_and_mobile(client):
    owner, _ = owner_session(client)
    member = native_headers(client, 'existing-member@example.com')
    settings = {'expected_version': 0, 'reason': 'Temporarily pause registration for the isolated test.',
                'maintenance_mode': False, 'signup_paused': True, 'banner': 'Registration maintenance'}
    assert client.put('/api/admin/settings', headers=owner, json=settings).status_code == 200
    registration = {'name': 'Not created', 'email': 'paused@example.com', 'password': 'long-enough-password-123'}
    assert client.post('/api/auth/register', json=registration).status_code == 503
    assert client.post('/api/mobile/auth/register', json={**registration,
        'accepted_policies': True, 'adult_confirmed': True, 'policy_version': '2026-08-31'}).status_code == 503
    session = next(app.dependency_overrides[db]())
    from sqlalchemy import select
    assert session.scalar(select(User.id).where(User.email == registration['email'])) is None
    public = client.get('/api/platform/status', headers={'Authorization': 'Bearer invalid'})
    assert public.status_code == 200
    assert set(public.json()) == {'maintenance_mode', 'signup_paused', 'banner', 'version'}
    settings.update(expected_version=1, maintenance_mode=True, signup_paused=False,
                    reason='Temporarily pause creator changes for the isolated test.')
    assert client.put('/api/admin/settings', headers=owner, json=settings).status_code == 200
    assert client.get('/api/me', headers=member).status_code == 200
    assert client.post('/api/creator/items', headers=member, json={'title': 'Blocked change'}).status_code == 503
    assert client.post('/api/account/privacy', headers=member, json={'profile_visibility': 'private'}).status_code == 200
    assert client.post('/api/creator/items', headers=owner, json={'title': 'Operator recovery'}).status_code == 201


def test_cross_origin_admin_patch_preflight_preserves_authentication(client):
    from app import TRUSTED_ORIGINS
    response = client.options('/api/admin/users/1/status', headers={
        'Origin': TRUSTED_ORIGINS[0], 'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'authorization,content-type,x-ziipa-user'})
    assert response.status_code == 200
    assert 'PATCH' in response.headers['access-control-allow-methods']
    assert client.patch('/api/admin/users/1/status', json={
        'status': 'suspended', 'expected_version': 0, 'reason': 'No authenticated authority.'}).status_code == 401
