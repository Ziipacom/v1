"""Private creator-media storage with local and Cloudflare R2 adapters."""
from functools import lru_cache
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException

from app import settings


def object_key(owner_id: int, media_id: str) -> str:
    return f"creator-media/{owner_id}/{media_id}"


def pending_key(owner_id: int, media_id: str) -> str:
    return f"pending-uploads/{owner_id}/{media_id}"


@dataclass(frozen=True)
class VerifiedUpload:
    size: int
    content_type: str
    header: bytes
    etag: str


def _etag(value) -> str:
    if not isinstance(value, str) or not 2 <= len(value) <= 128 or any(ord(c) < 32 for c in value):
        raise ValueError('Storage did not return an object identity.')
    return value


class LocalStorage:
    def __init__(self):
        self.root = Path(settings.uploads_dir).expanduser().resolve()

    def path(self, media_id: str) -> Path:
        return self.root / media_id

    def delete(self, owner_id: int, media_id: str) -> None:
        self.path(media_id).unlink(missing_ok=True)


class R2Storage:
    def __init__(self):
        if not all((settings.r2_endpoint_url, settings.r2_access_key_id,
                    settings.r2_secret_access_key, settings.r2_bucket_name)):
            raise RuntimeError('R2 storage is selected but its credentials are incomplete')
        import boto3
        from botocore.config import Config
        self.client = boto3.client(
            's3', endpoint_url=settings.r2_endpoint_url,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name='auto', config=Config(signature_version='s3v4', connect_timeout=5,
                read_timeout=10, retries={'max_attempts': 1, 'mode': 'standard'}),
        )
        self.bucket = settings.r2_bucket_name

    def presign_put(self, owner_id: int, media_id: str, content_type: str, size: int):
        key = pending_key(owner_id, media_id)
        url = self.client.generate_presigned_url(
            'put_object', Params={'Bucket': self.bucket, 'Key': key,
                                  'ContentType': content_type, 'ContentLength': size},
            ExpiresIn=settings.r2_presign_ttl_seconds,
        )
        # Fetch forbids scripts setting Content-Length. Browser Blob/File bodies
        # and native binary file uploads supply their actual byte length instead.
        return {'url': url, 'method': 'PUT', 'headers': {'Content-Type': content_type}}

    def inspect(self, owner_id: int, media_id: str):
        key = pending_key(owner_id, media_id)
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=key)
            etag = _etag(head.get('ETag'))
            response = self.client.get_object(Bucket=self.bucket, Key=key, Range='bytes=0-31', IfMatch=etag)
            body = response['Body']
            try:
                if _etag(response.get('ETag')) != etag:
                    raise ValueError('The upload changed while reading its header.')
                sample = body.read(32)
            finally:
                body.close()
            return VerifiedUpload(int(head['ContentLength']), head.get('ContentType', '').split(';')[0], sample, etag)
        except Exception as exc:
            raise HTTPException(409, 'The upload is not available in private storage yet.') from exc

    def promote(self, owner_id: int, media_id: str, verified: VerifiedUpload) -> None:
        source = pending_key(owner_id, media_id)
        target = object_key(owner_id, media_id)
        try:
            copied = self.client.copy_object(Bucket=self.bucket, Key=target,
                CopySource={'Bucket': self.bucket, 'Key': source}, CopySourceIfMatch=verified.etag,
                MetadataDirective='REPLACE', ContentType=verified.content_type)
            copied_etag = _etag(copied.get('CopyObjectResult', {}).get('ETag'))
            head = self.client.head_object(Bucket=self.bucket, Key=target, IfMatch=copied_etag)
            if (_etag(head.get('ETag')) != copied_etag or int(head['ContentLength']) != verified.size
                    or head.get('ContentType', '').split(';')[0] != verified.content_type):
                raise ValueError('The copied upload did not match the verified object.')
            self.client.delete_object(Bucket=self.bucket, Key=source)
        except Exception as exc:
            # Keep the database reservation and remove any uncommitted target,
            # including when a provider response was lost after copying.
            try:
                self.client.delete_object(Bucket=self.bucket, Key=target)
            except Exception:
                raise HTTPException(503, 'Upload finalization and cleanup could not be confirmed. Retry completion.') from exc
            raise HTTPException(409, 'The upload changed or could not be finalized. Retry completion; if it has expired, upload it again.') from exc

    def read_url(self, owner_id: int, media_id: str):
        return self.client.generate_presigned_url(
            'get_object', Params={'Bucket': self.bucket, 'Key': object_key(owner_id, media_id)},
            ExpiresIn=settings.r2_download_ttl_seconds,
        )

    def read_bytes(self, owner_id: int, media_id: str) -> bytes:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=object_key(owner_id, media_id))['Body'].read(100 * 1024 * 1024 + 1)
        except Exception as exc:
            raise HTTPException(503, 'Private media storage is temporarily unavailable.') from exc

    def delete(self, owner_id: int, media_id: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=object_key(owner_id, media_id))

    def delete_pending(self, owner_id: int, media_id: str) -> None:
        # Only call for a database-owned pending reservation. A failed/uncertain
        # copy can leave an uncatalogued target under that same reserved ID.
        self.client.delete_object(Bucket=self.bucket, Key=object_key(owner_id, media_id))
        self.client.delete_object(Bucket=self.bucket, Key=pending_key(owner_id, media_id))


@lru_cache
def storage():
    if settings.media_storage_backend == 'r2':
        return R2Storage()
    return LocalStorage()
