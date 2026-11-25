"""Keep member-only reuse permissions within Ziipa distribution."""

from fastapi import HTTPException
from sqlalchemy import select


def remix_item_exists(item_id):
    from remix_services import RemixProject

    return select(RemixProject.item_id).where(RemixProject.item_id == item_id).exists()


def require_external_media_permission(session, media_id: str | None) -> None:
    from remix_services import is_derived_media

    if media_id and is_derived_media(session, media_id):
        raise HTTPException(409, 'This remix can only be shared inside Ziipa.')
