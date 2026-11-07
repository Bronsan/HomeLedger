"""Locations and categories: the two taxonomies every household argues about."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import record
from ..db import get_db
from ..deps import require
from ..models import Category, Item, Location, utcnow
from ..permissions import ITEM_ARCHIVE, ITEM_UPDATE, ITEM_VIEW, Principal
from ..schemas import CategoryIn, CategoryUpdateIn, LocationIn, LocationUpdateIn
from ..serializers import category_out, location_out

router = APIRouter(tags=["catalog"])


def _location_path(db: Session, loc: Location, cache: dict[str, Location]) -> str:
    parts = [loc.name]
    seen = {loc.id}
    parent_id = loc.parent_id
    while parent_id and parent_id not in seen:
        parent = cache.get(parent_id) or db.get(Location, parent_id)
        if not parent:
            break
        seen.add(parent.id)
        parts.append(parent.name)
        parent_id = parent.parent_id
    return " / ".join(reversed(parts))


@router.get("/locations")
def list_locations(
    flat: bool = False,
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    locs = list(
        db.execute(
            select(Location)
            .where(Location.family_id == principal.family_id, Location.deleted_at.is_(None))
            .order_by(Location.sort_order, Location.name)
        ).scalars()
    )
    cache = {l.id: l for l in locs}
    counts = dict(
        db.execute(
            select(Item.location_id, func.count(Item.id))
            .where(Item.family_id == principal.family_id, Item.deleted_at.is_(None))
            .group_by(Item.location_id)
        ).all()
    )
    # roll child counts up so "储物间" shows the total of its shelves
    children: dict[str, list[str]] = {}
    for l in locs:
        if l.parent_id:
            children.setdefault(l.parent_id, []).append(l.id)

    def total(lid: str) -> int:
        return counts.get(lid, 0) + sum(total(c) for c in children.get(lid, []))

    nodes = [
        location_out(l, item_count=total(l.id), path=_location_path(db, l, cache)) for l in locs
    ]
    if flat:
        return {"items": nodes}

    by_parent: dict[str | None, list[dict]] = {}
    for node, l in zip(nodes, locs):
        by_parent.setdefault(l.parent_id, []).append(node)
    for group in by_parent.values():
        group.sort(key=lambda x: (x["sort_order"], x["name"]))

    def build(parent_id: str | None) -> list[dict]:
        out = []
        for node in by_parent.get(parent_id, []):
            node = dict(node)
            node["children"] = build(node["id"])
            out.append(node)
        return out

    return {"tree": build(None), "items": nodes}


@router.post("/locations", status_code=201)
def create_location(
    payload: LocationIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    if payload.parent_id and not db.get(Location, payload.parent_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "上级位置不存在")
    loc = Location(
        family_id=principal.family_id,
        parent_id=payload.parent_id,
        name=payload.name.strip(),
        kind=payload.kind,
        icon=payload.icon,
        note=payload.note,
        sort_order=payload.sort_order,
    )
    db.add(loc)
    db.flush()
    record(
        db, principal, "location.create", entity_type="location", entity_id=loc.id,
        summary=f"新增位置：{loc.name}", request=request,
    )
    db.commit()
    return {"location": location_out(loc, item_count=0)}


@router.patch("/locations/{location_id}")
def update_location(
    location_id: str,
    payload: LocationUpdateIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    loc = db.get(Location, location_id)
    if not loc or loc.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "位置不存在")
    if payload.parent_id is not None:
        if payload.parent_id == loc.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "不能把位置移动到自身之下")
        # prevent cycles
        cursor = db.get(Location, payload.parent_id) if payload.parent_id else None
        depth = 0
        while cursor and depth < 32:
            if cursor.id == loc.id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "不能移动到自己的子位置下")
            cursor = db.get(Location, cursor.parent_id) if cursor.parent_id else None
            depth += 1
        loc.parent_id = payload.parent_id
    for field in ("name", "kind", "icon", "note", "sort_order"):
        value = getattr(payload, field)
        if value is not None:
            setattr(loc, field, value)
    loc.updated_at = utcnow()
    record(
        db, principal, "location.update", entity_type="location", entity_id=loc.id,
        summary=f"修改位置：{loc.name}", request=request,
    )
    db.commit()
    return {"location": location_out(loc)}


@router.delete("/locations/{location_id}")
def delete_location(
    location_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_ARCHIVE)),
    db: Session = Depends(get_db),
) -> dict:
    loc = db.get(Location, location_id)
    if not loc or loc.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "位置不存在")
    child = db.execute(
        select(func.count(Location.id)).where(
            Location.parent_id == loc.id, Location.deleted_at.is_(None)
        )
    ).scalar()
    if child:
        raise HTTPException(status.HTTP_409_CONFLICT, "请先删除或移动子位置")
    used = db.execute(
        select(func.count(Item.id)).where(
            Item.location_id == loc.id, Item.deleted_at.is_(None)
        )
    ).scalar()
    if used:
        raise HTTPException(status.HTTP_409_CONFLICT, f"还有 {used} 件物品在此位置，请先移动")
    loc.deleted_at = utcnow()
    record(
        db, principal, "location.delete", entity_type="location", entity_id=loc.id,
        summary=f"删除位置：{loc.name}", request=request,
    )
    db.commit()
    return {"ok": True}


@router.get("/categories")
def list_categories(
    principal: Principal = Depends(require(ITEM_VIEW)), db: Session = Depends(get_db)
) -> dict:
    cats = list(
        db.execute(
            select(Category)
            .where(Category.family_id == principal.family_id, Category.deleted_at.is_(None))
            .order_by(Category.sort_order, Category.name)
        ).scalars()
    )
    counts = dict(
        db.execute(
            select(Item.category_id, func.count(Item.id))
            .where(Item.family_id == principal.family_id, Item.deleted_at.is_(None))
            .group_by(Item.category_id)
        ).all()
    )
    children: dict[str, list[str]] = {}
    for c in cats:
        if c.parent_id:
            children.setdefault(c.parent_id, []).append(c.id)

    def total(cid: str) -> int:
        return counts.get(cid, 0) + sum(total(x) for x in children.get(cid, []))

    return {"items": [category_out(c, item_count=total(c.id)) for c in cats]}


@router.post("/categories", status_code=201)
def create_category(
    payload: CategoryIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    cat = Category(
        family_id=principal.family_id,
        parent_id=payload.parent_id,
        name=payload.name.strip(),
        icon=payload.icon,
        color=payload.color,
        sort_order=payload.sort_order,
    )
    db.add(cat)
    db.flush()
    record(
        db, principal, "category.create", entity_type="category", entity_id=cat.id,
        summary=f"新增分类：{cat.name}", request=request,
    )
    db.commit()
    return {"category": category_out(cat, item_count=0)}


@router.patch("/categories/{category_id}")
def update_category(
    category_id: str,
    payload: CategoryUpdateIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    cat = db.get(Category, category_id)
    if not cat or cat.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "分类不存在")
    for field in ("name", "parent_id", "icon", "color", "sort_order"):
        value = getattr(payload, field)
        if value is not None:
            if field == "parent_id" and value == cat.id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "分类不能以自身为父级")
            setattr(cat, field, value)
    record(
        db, principal, "category.update", entity_type="category", entity_id=cat.id,
        summary=f"修改分类：{cat.name}", request=request,
    )
    db.commit()
    return {"category": category_out(cat)}


@router.delete("/categories/{category_id}")
def delete_category(
    category_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_ARCHIVE)),
    db: Session = Depends(get_db),
) -> dict:
    cat = db.get(Category, category_id)
    if not cat or cat.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "分类不存在")
    used = db.execute(
        select(func.count(Item.id)).where(
            Item.category_id == cat.id, Item.deleted_at.is_(None)
        )
    ).scalar()
    if used:
        raise HTTPException(status.HTTP_409_CONFLICT, f"还有 {used} 件物品属于此分类")
    cat.deleted_at = utcnow()
    record(
        db, principal, "category.delete", entity_type="category", entity_id=cat.id,
        summary=f"删除分类：{cat.name}", request=request,
    )
    db.commit()
    return {"ok": True}
