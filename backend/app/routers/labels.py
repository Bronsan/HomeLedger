"""QR labels: single sticker, batch sheet, and a zip for label printers."""

from __future__ import annotations

import base64
import io
import zipfile

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..models import Item, Location
from ..permissions import ITEM_VIEW, Principal
from ..services import qr_links
from ..services.net import public_base
from ..services.qr import label_png, label_sheet_html, qr_png

router = APIRouter(tags=["labels"])


def sticker_urls(
    db: Session, items: list[Item], port: int | None, created_by: str | None = None
) -> dict[str, str]:
    """One sticker URL per item, at the address a phone can actually reach.

    `request.base_url` would be whatever host the browser used — often
    `localhost`, which no phone can open. `public_base()` asks the kernel which
    address it would route from instead.

    Links are reused, so reprinting a sheet does not invalidate the stickers
    already on the shelves.
    """
    base = public_base(port)
    out: dict[str, str] = {}
    for it in items:
        link = qr_links.ensure_link(db, it, base, created_by=created_by)
        out[it.id] = qr_links.sticker_url(link)
    db.commit()
    return out


def _loc_path(locs: dict, loc_id: str | None) -> str:
    parts = []
    cur = locs.get(loc_id) if loc_id else None
    guard = 0
    while cur and guard < 16:
        parts.append(cur.name)
        cur = locs.get(cur.parent_id) if cur.parent_id else None
        guard += 1
    return " / ".join(reversed(parts))


@router.get("/labels/sheet")
def label_sheet(
    request: Request,
    item_ids: str | None = Query(default=None, description="逗号分隔；为空则导出全部"),
    location_id: str | None = None,
    category_id: str | None = None,
    limit: int = Query(default=60, ge=1, le=300),
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> Response:
    stmt = select(Item).where(
        Item.family_id == principal.family_id,
        Item.deleted_at.is_(None),
        Item.archived_at.is_(None),
    )
    if item_ids:
        ids = [x.strip() for x in item_ids.split(",") if x.strip()]
        stmt = stmt.where(Item.id.in_(ids))
    if location_id:
        stmt = stmt.where(Item.location_id == location_id)
    if category_id:
        stmt = stmt.where(Item.category_id == category_id)
    items = list(db.execute(stmt.order_by(Item.code).limit(limit)).scalars())
    locs = {
        l.id: l
        for l in db.execute(select(Location).where(Location.family_id == principal.family_id)).scalars()
    }
    urls = sticker_urls(db, items, request.url.port, principal.user_id)
    rows = []
    for it in items:
        png = qr_png(urls[it.id], box_size=4)
        rows.append(
            {
                "name": it.name,
                "code": it.code,
                "location": _loc_path(locs, it.location_id),
                "qr_data_url": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
            }
        )
    from ..models import Family

    family = db.get(Family, principal.family_id)
    html = label_sheet_html(rows, family.name if family else "HomeLedger")
    return Response(content=html, media_type="text/html; charset=utf-8")


@router.get("/labels/batch.zip")
def label_batch_zip(
    request: Request,
    item_ids: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> Response:
    stmt = select(Item).where(
        Item.family_id == principal.family_id, Item.deleted_at.is_(None)
    )
    if item_ids:
        stmt = stmt.where(Item.id.in_([x.strip() for x in item_ids.split(",") if x.strip()]))
    items = list(db.execute(stmt.order_by(Item.code).limit(limit)).scalars())
    locs = {
        l.id: l
        for l in db.execute(select(Location).where(Location.family_id == principal.family_id)).scalars()
    }
    urls = sticker_urls(db, items, request.url.port, principal.user_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for it in items:
            png = label_png(
                url=urls[it.id],
                title=it.name,
                code=it.code,
                subtitle=_loc_path(locs, it.location_id),
            )
            zf.writestr(f"{it.code}.png", png)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="homeledger-labels.zip"'},
    )
