"""Copy suggestions must remain owner scoped, rights checked and non-executing."""
from datetime import datetime, timedelta, timezone
import json

from fastapi import HTTPException
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import Base, User
from creator import CreatorItem
import assistant_api
import campaign_planning as planning
from personal_media import OSAssetMetadata


@pytest.fixture
def source(monkeypatch):
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        owner = User(name='Creator', email='copy@example.test', password_hash='unused')
        other = User(name='Other', email='copy-other@example.test', password_hash='unused')
        session.add_all([owner, other]); session.flush()
        item = CreatorItem(owner_id=owner.id, data={'title': 'My clip', 'description': 'Original copy'})
        session.add(item); session.flush()
        metadata = OSAssetMetadata(owner_id=owner.id, item_id=item.id,
                    rights={'basis': 'original', 'allow_ai': True})
        session.add(metadata); session.commit()
        monkeypatch.setattr(assistant_api.config, 'local_ai_enabled', True)
        yield session, owner, other, item, metadata
    engine.dispose()


def test_other_owner_cannot_send_source_to_model(source, monkeypatch):
    session, owner, other, item, metadata = source
    monkeypatch.setattr(assistant_api, 'infer_json', lambda *a, **k: pytest.fail('must not infer'))
    with pytest.raises(HTTPException) as error:
        planning.propose_copy(session, other.id, item.id, 'private words')
    assert error.value.status_code == 404


@pytest.mark.parametrize('rights', [
    {}, {'basis': 'original', 'allow_ai': False},
    {'basis': 'licensed', 'allow_ai': True, 'expires_at': (datetime.now(timezone.utc)-timedelta(days=1)).isoformat()},
])
def test_ai_permission_and_expiry_checked_before_inference(source, monkeypatch, rights):
    session, owner, _, item, metadata = source
    metadata.rights = rights; session.commit()
    monkeypatch.setattr(assistant_api, 'infer_json', lambda *a, **k: pytest.fail('must not infer'))
    result = planning.propose_copy(session, owner.id, item.id, 'private words')
    assert result['status'] == 'rights_required' and result['title'] == 'My clip'


def test_only_bounded_selected_text_is_sent_and_result_is_a_suggestion(source, monkeypatch):
    session, owner, _, item, _ = source
    def infer(messages, schema, **kwargs):
        payload = json.loads(messages[1]['content'])
        assert set(payload) == {'title', 'description', 'transcript'}
        assert len(payload['transcript']) == 6000
        assert 'tools' not in schema
        return {'title': 'Prepared title', 'description': 'A description for review'}
    monkeypatch.setattr(assistant_api, 'infer_json', infer)
    result = planning.propose_copy(session, owner.id, item.id, {'text': 'x' * 20000})
    assert result['status'] == 'ready' and result['title'] == 'Prepared title'
    session.refresh(item)
    assert item.data['title'] == 'My clip' and item.visibility == 'draft'


@pytest.mark.parametrize('output', [None, {'title': '<script>', 'description': 'bad'},
                                  {'title': '\u0000', 'description': 'invalid control-only title'},
                                  {'title': 'ok', 'description': 'ok', 'tool': 'publish'}])
def test_unavailable_or_invalid_model_cannot_change_saved_copy(source, monkeypatch, output):
    session, owner, _, item, _ = source
    monkeypatch.setattr(assistant_api, 'infer_json', lambda *a, **k: output)
    result = planning.propose_copy(session, owner.id, item.id, 'spoken text')
    assert result['status'] == 'unavailable' and result['description'] == 'Original copy'


def test_permission_revocation_during_inference_discards_suggestion(source, monkeypatch):
    session, owner, _, item, metadata = source
    def infer(*args, **kwargs):
        metadata.rights = {'basis': 'original', 'allow_ai': False}; session.commit()
        return {'title': 'Generated', 'description': 'Must not retain'}
    monkeypatch.setattr(assistant_api, 'infer_json', infer)
    result = planning.propose_copy(session, owner.id, item.id, 'spoken text')
    assert result['status'] == 'rights_required' and result['title'] == 'My clip'


def test_source_change_during_inference_discards_old_suggestion(source, monkeypatch):
    session, owner, _, item, _ = source
    def infer(*args, **kwargs):
        item.data = {**item.data, 'description': 'A new edit'}; session.commit()
        return {'title': 'Old suggestion', 'description': 'Wrong edit'}
    monkeypatch.setattr(assistant_api, 'infer_json', infer)
    result = planning.propose_copy(session, owner.id, item.id, 'old spoken text')
    assert result['status'] == 'rights_required'
    assert result['title'] != 'Old suggestion'
