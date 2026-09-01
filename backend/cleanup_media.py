"""Retry failed account-deletion file cleanup. Run from backend, never against an unreviewed environment."""
from app import SessionLocal
from mobile_api import drain_media_deletions

if __name__ == '__main__':
    with SessionLocal() as session:
        drain_media_deletions(session)
    print('Queued media cleanup attempted; failed files remain queued for retry.')
