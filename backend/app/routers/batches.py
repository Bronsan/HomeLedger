"""批次与保质期。

Why this lives in its own router rather than inside `items.py`: batches are a
flat resource with their own id (`/batches/{id}`), exactly like maintenance
tasks and loans. Item-scoped creation is nested only because a batch cannot
exist without its item.

Permission model: batches deliberately reuse `item.*`. A batch is an attribute
of an item, not a separate domain — inventing `batch.view/create/update/delete`
would add four entries to the catalogue that every role preset and the members
page has to be updated for, to express something nobody asked for ("may edit
items but not their batches"). A guest who can see an item can see its batches;
anyone who may not edit the item may not touch its batches either.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import add_event, diff, record
from ..db import get_db
from ..deps import require
from ..models import Item, ItemBatch, Location, utcnow
from ..permissions import ITEM_UPDATE, ITEM_VIEW, Principal
from ..schemas import BatchCreateIn, BatchUpdateIn
from ..serializers import batch_out

router = APIRouter(tags=["batches"])


def _item_or_404(db: Session, principal: Principal, item_id: str) -> Item:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id or item.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    return item


def _batch_or_404(db: Session, principal: Principal, batch_id: str) -> ItemBatch:
    batch = db.get(ItemBatch, batch_id)
    if not batch or batch.family_id != principal.family_id or batch.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "批次不存在")
    return batch


def _location_path(db: Session, family_id: str, location_id: str | None) -> str | None:
    """Human path for one location, e.g. 「厨房 / 冰箱 / 冷冻层」."""
    if not location_id:
        return None
    rows = {
        loc.id: loc
        for loc in db.execute(select(Location).where(Location.family_id == family_id)).scalars()
    }
    names: list[str] = []
    cursor: str | None = location_id
    seen: set[str] = set()
    while cursor and cursor in rows and cursor not in seen:
        seen.add(cursor)
        names.append(rows[cursor].name)
        cursor = rows[cursor].parent_id
    return " / ".join(reversed(names)) if names else None


def _check_location(db: Session, principal: Principal, location_id: str | None) -> None:
    """A batch may only be filed under a location of this family.

    Checked here rather than in the schema because the schema has no database
    access; without it a typo silently produces a batch that no location picker
    can ever show.
    """
    if not location_id:
        return
    loc = db.get(Location, location_id)
    if not loc or loc.family_id != principal.family_id or loc.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "存放位置不存在")


def _check_dates(produced: date | None, expires: date | None) -> None:
    """A best-before date earlier than the production date is always a typo."""
    if produced and expires and expires < produced:
        # 422 literal rather than `status.HTTP_422_UNPROCESSABLE_ENTITY`: the
        # constant was renamed in newer Starlette and warns on import order.
        raise HTTPException(422, "过期日期不能早于生产日期")


@router.get("/items/{item_id}/batches")
def list_batches(
    item_id: str,
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    item = _item_or_404(db, principal, item_id)
    rows = db.execute(
        select(ItemBatch)
        .where(ItemBatch.item_id == item.id, ItemBatch.deleted_at.is_(None))
        # Soonest expiry first; batches without a date sink to the bottom
        # instead of sorting as if they were infinitely fresh.
        .order_by(ItemBatch.expires_on.is_(None), ItemBatch.expires_on, ItemBatch.created_at)
    ).scalars().all()
    return {
        "items": [
            batch_out(b, _location_path(db, principal.family_id, b.location_id)) for b in rows
        ]
    }


@router.post("/items/{item_id}/batches", status_code=201)
def create_batch(
    item_id: str,
    payload: BatchCreateIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    item = _item_or_404(db, principal, item_id)
    _check_location(db, principal, payload.location_id)
    _check_dates(payload.produced_on, payload.expires_on)

    batch = ItemBatch(
        family_id=principal.family_id,
        item_id=item.id,
        created_by=principal.user_id,
        updated_by=principal.user_id,
        **payload.model_dump(),
    )
    db.add(batch)
    db.flush()
    add_event(
        db, principal, item, "batch_added",
        f"新增批次：{batch.batch_no or '未命名'}"
        + (f"，{batch.expires_on.isoformat()} 到期" if batch.expires_on else ""),
        {"batch_id": batch.id, "expires_on": batch.expires_on.isoformat() if batch.expires_on else None},
    )
    record(
        db, principal, "batch.create", entity_type="batch", entity_id=batch.id,
        summary=f"新增批次：{item.name} {batch.batch_no}".strip(), request=request,
    )
    db.commit()
    return {"batch": batch_out(batch, _location_path(db, principal.family_id, batch.location_id))}


@router.patch("/batches/{batch_id}")
def update_batch(
    batch_id: str,
    payload: BatchUpdateIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    batch = _batch_or_404(db, principal, batch_id)
    changes = payload.model_dump(exclude_unset=True)

    merged_produced = changes.get("produced_on", batch.produced_on)
    merged_expires = changes.get("expires_on", batch.expires_on)
    _check_dates(merged_produced, merged_expires)
    if "location_id" in changes:
        _check_location(db, principal, changes["location_id"])

    before = {
        k: (v.isoformat() if hasattr(v, "isoformat") else v)
        for k, v in ((f, getattr(batch, f)) for f in changes)
    }
    for key, value in changes.items():
        setattr(batch, key, value)
    batch.updated_by = principal.user_id
    batch.updated_at = utcnow()
    batch.version += 1
    after = {
        k: (v.isoformat() if hasattr(v, "isoformat") else v)
        for k, v in ((f, getattr(batch, f)) for f in changes)
    }
    delta = diff(before, after)

    item = db.get(Item, batch.item_id)
    if item and delta:
        add_event(
            db, principal, item, "batch_updated",
            f"更新批次：{batch.batch_no or '未命名'}（{len(delta)} 项）",
            {"batch_id": batch.id, "fields": list(delta)},
        )
    record(
        db, principal, "batch.update", entity_type="batch", entity_id=batch.id,
        summary=f"修改批次：{batch.batch_no or batch.id}", before=delta, request=request,
    )
    db.commit()
    return {"batch": batch_out(batch, _location_path(db, principal.family_id, batch.location_id))}


@router.delete("/batches/{batch_id}")
def delete_batch(
    batch_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    """Soft delete, like every other content row.

    The row stays so the deletion can replicate to other devices as a
    tombstone; a hard delete would look identical to "never existed" to a
    device that was offline, and the batch would come back on the next pull.
    """
    batch = _batch_or_404(db, principal, batch_id)
    batch.deleted_at = utcnow()
    batch.version += 1
    item = db.get(Item, batch.item_id)
    if item:
        add_event(
            db, principal, item, "batch_removed",
            f"删除批次：{batch.batch_no or '未命名'}",
            {"batch_id": batch.id},
        )
    record(
        db, principal, "batch.delete", entity_type="batch", entity_id=batch.id,
        summary=f"删除批次：{batch.batch_no or batch.id}", request=request,
    )
    db.commit()
    return {"ok": True}
