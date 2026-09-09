"""No network/real credentials: SigV4 generation and mutable fake-object races."""
from copy import deepcopy
import hashlib
from io import BytesIO
from urllib.parse import parse_qs, urlsplit

import boto3
from botocore.config import Config
from fastapi import HTTPException
import pytest

from app import User
import creator
from creator import CreatorMedia, PendingUpload
from storage_services import R2Storage, object_key, pending_key
from test_media_quota import quota_db, pending


PNG = b'\x89PNG\r\n\x1a\n' + bytes(32)


class Objects:
    def __init__(self):
        self.rows = {}
        self.before_get = self.before_copy = None
        self.bad_copy = self.lost_copy_response = self.fail_delete = False
        self.last_body = None

    def put(self, key, body=PNG, content_type='image/png'):
        self.rows[key] = {'data': body, 'ContentLength': len(body), 'ContentType': content_type,
                          'ETag': '"' + hashlib.sha256(body).hexdigest() + '"'}

    def head_object(self, *, Bucket, Key, IfMatch=None):
        row = self.rows[Key]
        if IfMatch is not None and IfMatch != row['ETag']:
            raise RuntimeError('PreconditionFailed')
        return {k: v for k, v in row.items() if k != 'data'}

    def get_object(self, *, Bucket, Key, Range, IfMatch):
        if self.before_get:
            self.before_get(Key)
        row = self.head_object(Bucket=Bucket, Key=Key, IfMatch=IfMatch)
        self.last_body = BytesIO(self.rows[Key]['data'][:32])
        return {**row, 'Body': self.last_body}

    def copy_object(self, *, Bucket, Key, CopySource, CopySourceIfMatch, MetadataDirective, ContentType):
        if self.before_copy:
            self.before_copy(CopySource['Key'])
        self.head_object(Bucket=Bucket, Key=CopySource['Key'], IfMatch=CopySourceIfMatch)
        assert MetadataDirective == 'REPLACE'
        self.rows[Key] = deepcopy(self.rows[CopySource['Key']])
        self.rows[Key]['ContentType'] = ContentType
        if self.bad_copy:
            self.put(Key, PNG + b'corrupt', ContentType)
        if self.lost_copy_response:
            raise TimeoutError('A response was lost after the copy was stored')
        return {'CopyObjectResult': {'ETag': self.rows[Key]['ETag']}}

    def delete_object(self, *, Bucket, Key):
        if self.fail_delete:
            raise TimeoutError('Cleanup unavailable')
        self.rows.pop(Key, None)


def store(client):
    backend = R2Storage.__new__(R2Storage)
    backend.client, backend.bucket = client, 'isolated-test-bucket'
    return backend


def test_presigned_url_signs_actual_length_without_forbidden_browser_header():
    client = boto3.client('s3', endpoint_url='https://storage.invalid', region_name='auto',
        aws_access_key_id='test-access-key', aws_secret_access_key='test-secret-key',
        config=Config(signature_version='s3v4'))
    backend = store(client)
    first = backend.presign_put(1, 'test-id', 'image/png', 40)
    second = backend.presign_put(1, 'test-id', 'image/png', 41)
    a, b = (parse_qs(urlsplit(value['url']).query) for value in (first, second))
    assert a['X-Amz-SignedHeaders'] == ['content-length;content-type;host']
    assert a['X-Amz-Signature'] != b['X-Amz-Signature']
    assert first['headers'] == {'Content-Type': 'image/png'}
    assert first['method'] == 'PUT'


def test_header_inspection_is_pinned_to_head_identity():
    objects = Objects(); backend = store(objects)
    key = pending_key(1, 'asset')
    objects.put(key)
    objects.before_get = lambda key: objects.put(key, PNG + b'overwritten')
    with pytest.raises(HTTPException) as error:
        backend.inspect(1, 'asset')
    assert error.value.status_code == 409
    assert 'overwritten' not in error.value.detail


def test_successful_inspection_closes_response_and_promotion_keeps_verified_bytes():
    objects = Objects(); backend = store(objects)
    source, target = pending_key(1, 'asset'), object_key(1, 'asset')
    objects.put(source)
    verified = backend.inspect(1, 'asset')
    assert verified.size == 40 and verified.header == PNG[:32]
    assert objects.last_body.closed
    backend.promote(1, 'asset', verified)
    assert objects.rows[target]['data'] == PNG
    assert source not in objects.rows


def test_overwrite_between_inspection_and_copy_cannot_be_promoted():
    objects = Objects(); backend = store(objects)
    source, target = pending_key(1, 'asset'), object_key(1, 'asset')
    objects.put(source)
    verified = backend.inspect(1, 'asset')
    objects.before_copy = lambda key: objects.put(key, PNG + bytes(500))
    with pytest.raises(HTTPException) as error:
        backend.promote(1, 'asset', verified)
    assert error.value.status_code == 409
    assert target not in objects.rows and source in objects.rows


@pytest.mark.parametrize('failure', ['bad_copy', 'lost_copy_response'])
def test_failed_copy_verification_or_lost_response_removes_uncommitted_output(failure):
    objects = Objects(); backend = store(objects)
    source, target = pending_key(1, 'asset'), object_key(1, 'asset')
    objects.put(source)
    verified = backend.inspect(1, 'asset')
    setattr(objects, failure, True)
    with pytest.raises(HTTPException):
        backend.promote(1, 'asset', verified)
    assert target not in objects.rows and source in objects.rows


def test_failed_cleanup_reports_uncertainty_and_reservation_cleanup_removes_both_keys():
    objects = Objects(); backend = store(objects)
    source, target = pending_key(1, 'asset'), object_key(1, 'asset')
    objects.put(source)
    verified = backend.inspect(1, 'asset')
    objects.lost_copy_response = objects.fail_delete = True
    with pytest.raises(HTTPException) as error:
        backend.promote(1, 'asset', verified)
    assert error.value.status_code == 503
    assert source in objects.rows and target in objects.rows
    objects.fail_delete = False
    backend.delete_pending(1, 'asset')
    assert not objects.rows


def test_completion_race_keeps_reservation_and_retry_revalidates_bytes(quota_db, monkeypatch):
    factory, (owner, _), _ = quota_db
    objects = Objects(); backend = store(objects)
    monkeypatch.setattr(creator, 'storage', lambda: backend)
    with factory() as session:
        reservation = pending(session, owner, len(PNG)); session.commit()
        media_id = reservation.id
        source, target = pending_key(owner, media_id), object_key(owner, media_id)
        objects.put(source)
        objects.before_copy = lambda key: objects.put(key, PNG + b'overwrite')
        with pytest.raises(HTTPException) as error:
            creator.complete_upload(media_id, session.get(User, owner), session)
        session.rollback()
        assert error.value.status_code == 409
        assert session.get(PendingUpload, media_id) is not None
        assert session.get(CreatorMedia, media_id) is None and target not in objects.rows
        objects.before_copy = None
        objects.put(source)
        result = creator.complete_upload(media_id, session.get(User, owner), session)
        assert result['id'] == media_id
        assert session.get(PendingUpload, media_id) is None
        assert session.get(CreatorMedia, media_id).size == len(PNG)
        assert objects.rows[target]['data'] == PNG and source not in objects.rows
