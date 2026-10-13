"""Verify real Studio mutations, rather than a client-supplied earning event."""
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import Base, User, current_user, db, guard
from creator import CreatorItem, CreatorMedia, CreatorPreferences, router as creator_router
import media_rewards as rewards


@pytest.fixture
def studio(monkeypatch):
    monkeypatch.setattr(rewards.config, 'rewards_enabled', True)
    database = create_engine('sqlite://', poolclass=StaticPool,
                             connect_args={'check_same_thread': False})
    Base.metadata.create_all(database)
    with Session(database) as session:
        author = User(name='Author', email='hook-author@example.test', password_hash='unused')
        viewer = User(name='Viewer', email='hook-viewer@example.test', password_hash='unused')
        session.add_all([author, viewer]); session.flush()
        source = CreatorMedia(id=str(uuid.uuid4()), owner_id=author.id, content_type='video/mp4', size=100)
        post = CreatorItem(owner_id=author.id, visibility='published',
                           data={'title': 'Uploaded clip', 'media_id': source.id})
        session.add_all([source, post]); session.commit()
        actor = {'user': viewer}
        app = FastAPI(); app.include_router(creator_router); app.include_router(rewards.router)
        app.dependency_overrides.update({current_user: lambda: actor['user'],
                                        db: lambda: session, guard: lambda: None})
        with TestClient(app) as client:
            yield client, session, author, viewer, post, actor
    database.dispose()


def test_preferences_endpoint_awards_once_then_reverses_without_refarming(studio):
    client, session, _, viewer, post, _ = studio
    for _ in range(2):
        assert client.post('/api/creator/preferences', json={'liked': [post.id], 'saved': [post.id]}).status_code == 200
    assert session.get(CreatorPreferences, viewer.id).data['liked'] == [post.id]
    assert client.get('/api/rewards/wallet').json()['balance'] == 3
    assert client.post('/api/creator/preferences', json={'liked': [], 'saved': []}).status_code == 200
    assert client.get('/api/rewards/wallet').json()['balance'] == 0
    assert client.post('/api/creator/preferences', json={'liked': [post.id], 'saved': [post.id]}).status_code == 200
    assert client.get('/api/rewards/wallet').json()['balance'] == 0


def test_comment_endpoint_requires_qualified_other_creator_source(studio):
    client, session, author, viewer, post, actor = studio
    assert client.post(f'/api/creator/items/{post.id}/comments', json={'body': 'Wow'}).status_code == 200
    assert client.get('/api/rewards/wallet').json()['balance'] == 0
    assert client.post(f'/api/creator/items/{post.id}/comments', json={'body': 'The lighting and composition are excellent.'}).status_code == 200
    assert client.get('/api/rewards/wallet').json()['balance'] == 3
    actor['user'] = author
    assert client.post(f'/api/creator/items/{post.id}/comments', json={'body': 'Replying to my own creation is not rewarded.'}).status_code == 200
    assert client.get('/api/rewards/wallet').json()['balance'] == 0
    assert len(session.scalars(select(rewards.RewardLedger).where(rewards.RewardLedger.owner_id == viewer.id)).all()) == 1
