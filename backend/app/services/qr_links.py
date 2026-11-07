"""Creating and resolving the opaque handles printed on stickers.

A sticker is a promise: it will still work in three years, on a phone that has
never seen this app, from a router that may have been replaced twice. That
constrains the design more than it looks:

  * the URL cannot contain an item id, because ids are internal and change
    when a family imports an export;
  * it cannot contain an account, because the person holding the box may not
    have one;
  * it cannot be regenerated per print, or reprinting a label would silently
    break the one already stuck to the shelf.

So: one random token per (item, base URL), stored server-side, revocable.
"""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Item, QrLink


def new_token() -> str:
    # 22 characters of URL-safe base64 = 128 bits. Short enough to survive a
    # cheap scanner at an angle, long enough that guessing is not a threat.
    return secrets.token_urlsafe(16)


def sticker_url(link: QrLink) -> str:
    base = (link.base_url or "").rstrip("/")
    return f"{base}/api/v1/public/q/{link.token}"


def ensure_link(
    db: Session,
    item: Item,
    base: str,
    *,
    created_by: str | None = None,
) -> QrLink:
    """The live link for this item at this base URL, creating one if needed.

    Keyed on the base URL on purpose: moving the server from
    `192.168.1.10:8000` to a hostname must produce *new* stickers while the
    old ones keep resolving to the address that was actually printed on them.
    """
    base = (base or "").rstrip("/")
    existing = db.execute(
        select(QrLink).where(
            QrLink.item_id == item.id,
            QrLink.base_url == base,
            QrLink.revoked.is_(False),
        )
    ).scalars().first()
    if existing:
        return existing

    link = QrLink(
        family_id=item.family_id,
        item_id=item.id,
        token=new_token(),
        base_url=base,
        created_by=created_by,
    )
    db.add(link)
    db.flush()
    return link


def revoke_for_item(db: Session, item_id: str) -> int:
    links = db.execute(
        select(QrLink).where(QrLink.item_id == item_id, QrLink.revoked.is_(False))
    ).scalars().all()
    for link in links:
        link.revoked = True
    return len(links)


def resolve(db: Session, token: str) -> QrLink | None:
    if not token or len(token) > 40:
        return None
    return db.execute(
        select(QrLink).where(QrLink.token == token, QrLink.revoked.is_(False))
    ).scalars().first()
