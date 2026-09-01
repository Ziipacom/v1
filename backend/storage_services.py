"""Private creator-media storage with local and Cloudflare R2 adapters."""
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException

from app import settings


def object_key(owner_id: int, media_id: str) -> str:
    return f"creator-media/{owner_id}/{media_id}"


def pending_key(owner_id: int, media_id: str) -> str:
    return f"pending-uploads/{owner_id}/{media_id}"


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
            region_name='auto', config=Config(signature_version='s3v4'),
        )
        self.bucket = settings.r2_bucket_name

    def presign_put(self, owner_id: int, media_id: str, content_type: str, size: int):
        key = pending_key(owner_id, media_id)
        url = self.client.generate_presigned_url(
            'put_object', Params={'Bucket': self.bucket, 'Key': key,
                                  'ContentType': content_type},
            ExpiresIn=settings.r2_presign_ttl_seconds,
        )
        return {'url': url, 'method': 'PUT', 'headers': {'Content-Type': content_type}}

    def inspect(self, owner_id: int, media_id: str):
        key = pending_key(owner_id, media_id)
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=key)
            sample = self.client.get_object(Bucket=self.bucket, Key=key, Range='bytes=0-31')['Body'].read(32)
            return int(head['ContentLength']), head.get('ContentType', '').split(';')[0], sample
        except Exception as exc:
            raise HTTPException(409, 'The upload is not available in private storage yet.') from exc

    def promote(self, owner_id: int, media_id: str) -> None:
        source = pending_key(owner_id, media_id)
        target = object_key(owner_id, media_id)
        try:
            self.client.copy_object(Bucket=self.bucket, Key=target,
                                    CopySource={'Bucket': self.bucket, 'Key': source})
            self.client.delete_object(Bucket=self.bucket, Key=source)
        except Exception as exc:
            raise HTTPException(503, 'The verified upload could not be finalized. Please retry.') from exc

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
        self.client.delete_object(Bucket=self.bucket, Key=pending_key(owner_id, media_id))


@lru_cache
def storage():
    if settings.media_storage_backend == 'r2':
        return R2Storage()
    return LocalStorage()
