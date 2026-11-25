import base64
import threading

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from redis.exceptions import RedisError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, guard
from creator import CreatorItem, ItemInput
from admin_services import AdminUserState
import title_api as titles


class Budget:
    def __init__(self): self.values = {}
    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values: return False
        self.values[key] = value
        return True
    def eval(self, script, count, key, value):
        if script == titles._RELEASE:
            if self.values.get(key) == value: self.values.pop(key)
            return 1
        self.values[key] = self.values.get(key, 0) + 1
        return self.values[key]


@pytest.fixture
def workspace(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        owner = User(name='Creator', email='titles@example.test', password_hash='unused')
        session.add(owner); session.commit()
        actor = {'user': owner}
        app = FastAPI(); app.include_router(titles.router)
        def signed_in():
            if actor['user'] is None: raise HTTPException(401, 'Please sign in')
            return actor['user']
        app.dependency_overrides.update({db: lambda: session, current_user: signed_in, guard: lambda: None})
        monkeypatch.setattr(titles.config, 'enabled', True)
        monkeypatch.setattr(titles, '_slot', threading.BoundedSemaphore(1))
        monkeypatch.setattr(titles, 'cache', Budget())
        calls = []
        def bridge(image=None):
            calls.append(image)
            return {'model': titles.MODEL, 'available': True, 'metadata_version': 2,
                    'title': 'A Shepherd in Spectacles', 'description': 'A German shepherd wearing green glasses looks toward the camera.'}
        monkeypatch.setattr(titles, '_bridge', bridge)
        with TestClient(app) as client: yield client, session, owner, actor, calls
    engine.dispose()


def request(**changes):
    return {'image': base64.b64encode(b'\xff\xd8\xffsynthetic-image\xff\xd9').decode(), 'consent': True, **changes}


def test_title_required_on_api_for_both_save_modes():
    for visibility in ('draft', 'published'):
        for value in ('', ' ', '\t\n', '\u00a0'):
            with pytest.raises(ValidationError): ItemInput(title=value, visibility=visibility)


def test_opt_in_preview_is_only_a_proposal_not_a_save(workspace):
    client, session, owner, actor, calls = workspace
    result = client.post('/api/editor/title/suggest', json=request())
    assert result.status_code == 200, result.text
    assert result.json() == {'title': 'A Shepherd in Spectacles',
                            'description': 'A German shepherd wearing green glasses looks toward the camera.', 'review_required': True}
    assert calls == [request()['image']]
    assert session.query(CreatorItem).count() == 0
    actor['user'] = None
    assert client.post('/api/editor/title/suggest', json=request()).status_code == 401
    assert len(calls) == 1


@pytest.mark.parametrize('changes', [{'consent': False}, {'consent': 1}, {'consent': 'true'}, {'image': 'bad'},
    {'url': 'https://private.test'}, {'filename': 'IMG_3432'}, {'image': 'A' * 196609}])
def test_invalid_private_input_never_reaches_provider_or_echoes_bytes(workspace, changes):
    client, _, _, _, calls = workspace
    response = client.post('/api/editor/title/suggest', json=request(**changes))
    assert response.status_code in (400, 413)
    assert 'synthetic-image' not in response.text and request()['image'] not in response.text
    assert calls == []


def test_free_budget_and_disabled_mode_fail_closed(workspace, monkeypatch):
    client, _, _, _, calls = workspace
    for _ in range(4): assert client.post('/api/editor/title/suggest', json=request()).status_code == 200
    assert client.post('/api/editor/title/suggest', json=request()).status_code == 429
    assert len(calls) == 4
    monkeypatch.setattr(titles.config, 'enabled', False)
    assert client.get('/api/editor/title/config').json()['available'] is False
    assert client.post('/api/editor/title/suggest', json=request()).status_code == 503
    assert len(calls) == 4


def test_provider_failure_and_redis_failure_do_not_invent_titles(workspace, monkeypatch):
    client, *_ = workspace
    monkeypatch.setattr(titles, '_bridge', lambda *args: {'model': titles.MODEL, 'title': ''})
    assert client.post('/api/editor/title/suggest', json=request()).status_code == 503
    def unavailable(*args, **kwargs): raise RedisError('offline')
    monkeypatch.setattr(titles.cache, 'set', unavailable)
    assert client.post('/api/editor/title/suggest', json=request()).status_code == 503


def test_suspended_creator_cannot_request_a_title(workspace):
    client, session, owner, _, calls = workspace
    session.add(AdminUserState(user_id=owner.id, status='suspended')); session.commit()
    assert client.post('/api/editor/title/suggest', json=request()).status_code == 403
    assert calls == []


@pytest.mark.parametrize('description', [None, '', ' ', 'x' * 601, 'line\nbreak', '<a>link</a>', 'https://example.test'])
def test_invalid_generated_descriptions_fail_without_mutating_a_creation(workspace, monkeypatch, description):
    client, session, *_ = workspace
    monkeypatch.setattr(titles, '_bridge', lambda *args: {'model': titles.MODEL, 'title': 'A scene', 'description': description})
    assert client.post('/api/editor/title/suggest', json=request()).status_code == 503
    assert session.query(CreatorItem).count() == 0


def test_combined_autofill_is_not_enabled_against_an_old_title_only_worker(workspace, monkeypatch):
    client, *_ = workspace
    assert client.get('/api/editor/title/config').json()['metadata_version'] == 2
    assert client.get('/api/editor/title/config').json()['available'] is True
    monkeypatch.setattr(titles, '_bridge', lambda *args: {'model': titles.MODEL, 'available': True})
    assert client.get('/api/editor/title/config').json()['available'] is False
