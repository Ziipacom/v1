"""Cookie account switches must not apply a stale Studio action to another user."""
from test_api import client, register_creator
from app import settings


def test_cookie_account_switch_rejects_stale_read_write_and_logout(client):
    register_creator(client, 'portal-first@example.com')
    first = client.get('/api/me').json()['id']
    headers = {'X-Ziipa-User': str(first)}
    assert client.get('/api/creator/bootstrap', headers=headers).status_code == 200
    assert client.post('/api/auth/logout', headers=headers).status_code == 200
    register_creator(client, 'portal-second@example.com')
    second = client.get('/api/me').json()['id']
    assert second != first
    assert client.get('/api/creator/bootstrap', headers=headers).status_code == 401
    assert client.post('/api/creator/items', json={'title': 'Wrong account draft'}, headers=headers).status_code == 401
    assert client.post('/api/auth/logout', headers=headers).status_code == 401
    assert client.get('/api/me').json()['id'] == second
    assert client.get('/api/creator/bootstrap').json()['drafts'] == []
    assert client.post('/api/creator/items', json={'title':'Correct account'}, headers={'X-Ziipa-User':str(second)}).status_code == 201


def test_expected_user_header_does_not_authenticate_a_request(client):
    assert client.get('/api/me', headers={'X-Ziipa-User':'1'}).status_code == 401
    register_creator(client)
    for value in ('bad', '0', '-1', '999999999'):
        assert client.get('/api/me', headers={'X-Ziipa-User':value}).status_code == 401


def test_unsigned_proxy_headers_cannot_bypass_rate_limits(client, monkeypatch):
    monkeypatch.setattr(settings, 'ziipa_proxy_secret', 's' * 40)
    for index in range(15):
        assert client.post('/api/waitlist', json={'name':'Test','email':'proxy@example.com'}, headers={
            'x-ziipa-client-ip': f'192.0.2.{index + 1}', 'x-ziipa-proxy-secret': 'wrong'
        }).status_code == 200
    assert client.post('/api/waitlist', json={'name':'Test','email':'proxy@example.com'}, headers={
        'x-ziipa-client-ip':'192.0.2.99', 'x-ziipa-proxy-secret':'wrong'
    }).status_code == 429
    assert client.post('/api/waitlist', json={'name':'Test','email':'proxy@example.com'}, headers={
        'x-ziipa-client-ip':'192.0.2.99', 'x-ziipa-proxy-secret':'s' * 40
    }).status_code == 200
    assert client.post('/api/waitlist', json={'name':'Test','email':'proxy@example.com'}, headers={
        'x-ziipa-client-ip':'not-an-ip', 'x-ziipa-proxy-secret':'s' * 40
    }).status_code == 400


def test_wallet_challenge_names_the_trusted_portal_not_the_mobile_preview(client, monkeypatch):
    import web3_services
    monkeypatch.setattr(web3_services.config, 'web3_public_origin', 'https://app.ziipa.com')
    register_creator(client)
    data = {'chain_id':84532, 'address':'0x0000000000000000000000000000000000000001'}
    result = client.post('/api/web3/challenge', json=data, headers={'Origin':'http://localhost:5178'})
    assert result.status_code == 200
    assert result.json()['message'].startswith('localhost:5178 wants you to sign in')
    assert 'URI: http://localhost:5178\n' in result.json()['message']
    assert client.post('/api/web3/challenge', json=data, headers={'Origin':'https://evil.test'}).status_code == 403
    native = client.post('/api/web3/challenge', json=data)
    assert 'URI: https://app.ziipa.com\n' in native.json()['message']
