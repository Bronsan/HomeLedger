"""Items: the heart of the system.

Design notes worth calling out:

* `code` is the instance identity printed on the QR sticker. It is generated
  server side, never reused, and stable across renames.
* Updates are optimistic: if `version` is supplied and stale, we return 409 with
  the current record so the client can show a merge prompt. Households editing
  the same item from two phones is a real scenario, not a theoretical one.
* Every mutation writes an `ItemEvent` (human story) and an `AuditLog` (who did
  what). Neither is ever updated.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import String, and_, func, or_, select
from sqlalchemy.orm import Session

from ..audit import add_event, diff, record
from ..db import get_db
from ..deps import get_principal, require
from ..models import (
    Attachment,
    Category,
    Item,
    ItemACL,
    QrLink,
    ItemBatch,
    ItemComponent,
    ItemEvent,
    Loan,
    Location,
    MaintenanceTask,
    User,
    utcnow,
)
from ..providers.storage import get_storage_provider
from ..permissions import (
    ITEM_ARCHIVE,
    ITEM_CREATE,
    ITEM_DELETE,
    ITEM_LOAN,
    ITEM_UPDATE,
    ITEM_VIEW,
    PermissionDenied,
    Principal,
)
from ..schemas import (
    BulkItemIn,
    ComponentIn,
    ImportIn,
    ItemACLIn,
    ItemCreateIn,
    ItemsBatchUpdateIn,
    ItemUpdateIn,
    LoanCreateIn,
)
from ..serializers import (
    attachment_out,
    batch_out,
    component_out,
    event_out,
    item_out,
    loan_out,
    page,
)
from ..config import settings
from ..services import qr_links
from ..services.importer import import_rows
from ..services.net import public_base, qr_reachable_from_lan
from ..services.qr import label_png, qr_png

router = APIRouter(tags=["items"])

SORT_FIELDS = {
    "updated": Item.updated_at,
    "created": Item.created_at,
    "name": Item.name,
    "price": Item.purchase_price,
    "warranty": Item.warranty_until,
    "code": Item.code,
}


def _shared_item_ids(principal: Principal):
    """Sub-select of item ids explicitly shared with this user."""
    return select(ItemACL.item_id).where(
        ItemACL.family_id == principal.family_id,
        ItemACL.user_id == principal.user_id,
    )


def require_view_or_shared(
    principal: Principal = Depends(get_principal), db: Session = Depends(get_db)
) -> Principal:
    """`item.view` **or** at least one item explicitly shared with this user.

    Item level sharing is *additive*: it can only widen what a role already
    allows, never narrow it. That keeps a single mental model ("deny beats
    grant, grant beats role") across family-wide overrides and per-item ACLs,
    and avoids the failure mode where hiding one item silently skews dashboard
    counters for everybody else.
    """
    if principal.can(ITEM_VIEW):
        return principal
    shared = db.execute(_shared_item_ids(principal).limit(1)).first()
    if not shared:
        raise PermissionDenied(ITEM_VIEW)
    return principal


def _visible_scope(principal: Principal):
    """Extra WHERE clause for list/scans; None means "see everything"."""
    if principal.can(ITEM_VIEW):
        return None
    return Item.id.in_(_shared_item_ids(principal))


def _shared_with(db: Session, item_id: str, user_id: str) -> str | None:
    row = db.execute(
        select(ItemACL.permission).where(
            ItemACL.item_id == item_id, ItemACL.user_id == user_id
        )
    ).first()
    return row[0] if row else None


def _may_touch(db: Session, item: Item, principal: Principal, permission: str) -> bool:
    """Role permission first, then an explicit item grant (edit only)."""
    if principal.can(permission):
        return True
    if permission == ITEM_VIEW:
        return _shared_with(db, item.id, principal.user_id) in ("view", "edit")
    if permission == ITEM_UPDATE:
        return _shared_with(db, item.id, principal.user_id) == "edit"
    return False


def _next_seq(db: Session, family_id: str) -> int:
    """Highest numeric suffix in use, plus one.

    Codes are per-family and never reused, so a deleted item's number stays
    retired. That is intentional: a printed sticker must not silently point at
    a different object later.
    """
    rows = db.execute(
        select(Item.code).where(Item.family_id == family_id, Item.code.like("HL-%"))
    ).scalars().all()
    biggest = 0
    for code in rows:
        try:
            biggest = max(biggest, int(code.split("-")[1]))
        except (IndexError, ValueError):
            continue
    return biggest + 1


def _next_code(db: Session, family_id: str, seq: int | None = None) -> str:
    seq = _next_seq(db, family_id) if seq is None else seq
    # Guard against collisions left by manually entered codes.
    while db.execute(
        select(Item.id).where(Item.family_id == family_id, Item.code == f"HL-{seq:06d}")
    ).first():
        seq += 1
    return f"HL-{seq:06d}"


def code_allocator(db: Session, family_id: str):
    """Stateful `HL-000123` generator for batch operations.

    `_next_code` reads committed rows. Inside one transaction nothing is
    committed yet, so calling it repeatedly hands out the same number to every
    row. This closure advances a local cursor instead, and is the only safe way
    to allocate codes in a loop.
    """
    seq = _next_seq(db, family_id)

    def allocate() -> str:
        nonlocal seq
        code = _next_code(db, family_id, seq)
        seq = int(code.split("-")[1]) + 1
        return code

    return allocate


def _load_maps(db: Session, family_id: str) -> tuple[dict, dict, dict]:
    cats = {
        c.id: c
        for c in db.execute(select(Category).where(Category.family_id == family_id)).scalars()
    }
    locs = {
        l.id: l
        for l in db.execute(select(Location).where(Location.family_id == family_id)).scalars()
    }
    return cats, locs, {}


def _loc_path(locs: dict, loc_id: str | None, guard: int = 0) -> str | None:
    if not loc_id:
        return None
    parts: list[str] = []
    cur = locs.get(loc_id)
    while cur and guard < 16:
        parts.append(cur.name)
        cur = locs.get(cur.parent_id) if cur.parent_id else None
        guard += 1
    return " / ".join(reversed(parts)) if parts else None


def _cover_urls(db: Session, items: list[Item]) -> dict[str, str]:
    ids = [i.cover_attachment_id for i in items if i.cover_attachment_id]
    if not ids:
        return {}
    rows = db.execute(select(Attachment).where(Attachment.id.in_(ids))).scalars().all()
    by_id = {a.id: a for a in rows}
    return {
        i.id: f"/api/v1/attachments/{i.cover_attachment_id}/raw?variant=thumb"
        for i in items
        if i.cover_attachment_id in by_id
    }


def _open_task_counts(db: Session, item_ids: list[str]) -> dict[str, int]:
    if not item_ids:
        return {}
    rows = db.execute(
        select(MaintenanceTask.item_id, func.count(MaintenanceTask.id))
        .where(
            MaintenanceTask.item_id.in_(item_ids),
            MaintenanceTask.status == "pending",
            MaintenanceTask.deleted_at.is_(None),
        )
        .group_by(MaintenanceTask.item_id)
    ).all()
    return {r[0]: r[1] for r in rows}


def _serialize_many(db: Session, items: list[Item], family_id: str) -> list[dict]:
    cats, locs, _ = _load_maps(db, family_id)
    users = {
        u.id: u
        for u in db.execute(
            select(User).where(
                User.id.in_(
                    {i.owner_user_id for i in items if i.owner_user_id}
                    | {i.custodian_user_id for i in items if i.custodian_user_id}
                    or {""}
                )
            )
        ).scalars()
    }
    covers = _cover_urls(db, items)
    tasks = _open_task_counts(db, [i.id for i in items])
    next_due = {
        r[0]: r[1]
        for r in db.execute(
            select(MaintenanceTask.item_id, func.min(MaintenanceTask.next_due_at))
            .where(
                MaintenanceTask.item_id.in_([i.id for i in items]),
                MaintenanceTask.status == "pending",
                MaintenanceTask.next_due_at.is_not(None),
            )
            .group_by(MaintenanceTask.item_id)
        ).all()
    }
    return [
        item_out(
            i,
            category=cats.get(i.category_id),
            location=locs.get(i.location_id),
            location_path=_loc_path(locs, i.location_id),
            cover_url=covers.get(i.id),
            owner=users.get(i.owner_user_id),
            custodian=users.get(i.custodian_user_id),
            open_tasks=tasks.get(i.id, 0),
            next_due=next_due.get(i.id),
        )
        for i in items
    ]


@router.get("/items")
def list_items(
    q: str | None = None,
    category_id: str | None = None,
    location_id: str | None = None,
    status_: str | None = Query(default=None, alias="status"),
    condition: str | None = None,
    tag: str | None = None,
    owner_id: str | None = None,
    warranty: str | None = Query(default=None, description="active|expiring|expired"),
    include_archived: bool = False,
    archived: bool = Query(default=False, description="只看归档物品（回收站视图）"),
    low_stock: bool = Query(default=False, description="只看数量已跌破 min_stock 的"),
    deleted: bool = Query(default=False, description="只看软删除的（回收站的『已删除』视图）"),
    sort: str = "updated",
    order: str = "desc",
    page_no: int = Query(default=1, ge=1, alias="page"),
    page_size: int = Query(default=24, ge=1, le=200),
    principal: Principal = Depends(require_view_or_shared),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Item).where(Item.family_id == principal.family_id)
    scope = _visible_scope(principal)
    if scope is not None:
        stmt = stmt.where(scope)
    if deleted:
        # 回收站的「已删除」视图：软删除只是标记，得有个地方看见它，
        # 否则 restore 路由永远够不着——误删的人被锁在门外。
        stmt = stmt.where(Item.deleted_at.is_not(None))
    else:
        stmt = stmt.where(Item.deleted_at.is_(None))
        if archived:
            # 回收站视图：只看归档的。归档物从常规列表消失之后得有个地方找回来，
            # 否则「归档」对误操作的人就是单向门。
            stmt = stmt.where(Item.archived_at.is_not(None))
        elif not include_archived:
            stmt = stmt.where(Item.archived_at.is_(None))
    if category_id:
        # include descendants so "家电" shows everything under it
        all_cats = db.execute(
            select(Category).where(Category.family_id == principal.family_id)
        ).scalars().all()
        ids = {category_id}
        changed = True
        while changed:
            changed = False
            for c in all_cats:
                if c.parent_id in ids and c.id not in ids:
                    ids.add(c.id)
                    changed = True
        stmt = stmt.where(Item.category_id.in_(ids))
    if location_id:
        all_locs = db.execute(
            select(Location).where(Location.family_id == principal.family_id)
        ).scalars().all()
        ids = {location_id}
        changed = True
        while changed:
            changed = False
            for l in all_locs:
                if l.parent_id in ids and l.id not in ids:
                    ids.add(l.id)
                    changed = True
        stmt = stmt.where(Item.location_id.in_(ids))
    if low_stock:
        # 告警条把人送到这里之后不该让人自己找哪件缺货——同一把尺子
        # （数量 <= min_stock）在列表里再量一遍。
        stmt = stmt.where(Item.min_stock.is_not(None), Item.quantity <= Item.min_stock)
    if status_:
        stmt = stmt.where(Item.status == status_)
    if condition:
        stmt = stmt.where(Item.condition == condition)
    if owner_id:
        stmt = stmt.where(Item.owner_user_id == owner_id)
    if tag:
        stmt = stmt.where(func.cast(Item.tags, String).like(f'%"{tag}"%'))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Item.name.like(like),
                Item.brand.like(like),
                Item.model.like(like),
                Item.serial_number.like(like),
                Item.barcode.like(like),
                Item.code.like(like),
                Item.description.like(like),
            )
        )
    today = datetime.utcnow().date()
    if warranty == "expired":
        stmt = stmt.where(Item.warranty_until.is_not(None), Item.warranty_until < today)
    elif warranty == "expiring":
        from datetime import timedelta

        stmt = stmt.where(
            Item.warranty_until.is_not(None),
            Item.warranty_until >= today,
            Item.warranty_until <= today + timedelta(days=30),
        )
    elif warranty == "active":
        stmt = stmt.where(Item.warranty_until.is_not(None), Item.warranty_until >= today)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    column = SORT_FIELDS.get(sort, Item.updated_at)
    stmt = stmt.order_by(column.desc() if order == "desc" else column.asc())
    items = list(
        db.execute(stmt.offset((page_no - 1) * page_size).limit(page_size)).scalars()
    )
    return page(_serialize_many(db, items, principal.family_id), total, page_no, page_size)


@router.get("/items/facets")
def item_facets(
    principal: Principal = Depends(require(ITEM_VIEW)), db: Session = Depends(get_db)
) -> dict:
    base = and_(Item.family_id == principal.family_id, Item.deleted_at.is_(None))
    statuses = dict(
        db.execute(
            select(Item.status, func.count(Item.id)).where(base).group_by(Item.status)
        ).all()
    )
    total = sum(statuses.values())
    value = db.execute(
        select(func.coalesce(func.sum(Item.purchase_price), 0)).where(base)
    ).scalar()
    tags = db.execute(select(Item.tags).where(base)).scalars().all()
    tag_counts: dict[str, int] = {}
    for t in tags:
        for x in t or []:
            tag_counts[x] = tag_counts.get(x, 0) + 1
    return {
        "by_status": statuses,
        "total": total,
        "total_value": float(value or 0),
        "tags": sorted(
            [{"tag": k, "count": v} for k, v in tag_counts.items()],
            key=lambda x: -x["count"],
        )[:20],
    }


@router.post("/items", status_code=201)
def create_item(
    payload: ItemCreateIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    code = (payload.code or "").strip() or _next_code(db, principal.family_id)
    exists = db.execute(
        select(Item.id).where(Item.family_id == principal.family_id, Item.code == code)
    ).first()
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, f"物品编号 {code} 已存在")
    if payload.barcode:
        dup = db.execute(
            select(Item).where(
                Item.family_id == principal.family_id,
                Item.barcode == payload.barcode.strip(),
                Item.deleted_at.is_(None),
            )
        ).scalar_one_or_none()
    else:
        dup = None

    item = Item(
        family_id=principal.family_id,
        code=code,
        created_by=principal.user_id,
        updated_by=principal.user_id,
        **payload.model_dump(exclude={"code"}),
    )
    db.add(item)
    db.flush()
    add_event(db, principal, item, "created", f"创建物品「{item.name}」", {"code": item.code})
    record(
        db, principal, "item.create", entity_type="item", entity_id=item.id,
        summary=f"新增物品：{item.name}", after={"name": item.name, "code": item.code},
        request=request,
    )
    db.commit()
    result = _serialize_many(db, [item], principal.family_id)[0]
    if dup:
        result["duplicate_warning"] = {
            "item_id": dup.id,
            "name": dup.name,
            "message": f"同条码物品已存在：{dup.name}（{dup.code}）",
        }
    return {"item": result}


@router.post("/items/{item_id}/clone", status_code=201)
def clone_item(
    item_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    """复制一件物品：字段照搬，身份字段重新来。

    复制的是「描述」不是「实体」——编号重新分配，条码/序列号留空（那是
    贴在实物上的东西，复制出来的新实物没有），附件与二维码链接不跟。
    名字追加「（副本)」让列表里一眼分得开；已有后缀就不再叠。
    """
    src = db.get(Item, item_id)
    if not src or src.family_id != principal.family_id or src.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    item = Item(
        family_id=principal.family_id,
        code=_next_code(db, principal.family_id),
        name=src.name if src.name.endswith("（副本）") else f"{src.name}（副本）",
        description=src.description,
        category_id=src.category_id,
        location_id=src.location_id,
        quantity=src.quantity,
        unit=src.unit,
        min_stock=src.min_stock,
        status=src.status,
        condition=src.condition,
        brand=src.brand,
        model=src.model,
        purchase_date=src.purchase_date,
        purchase_price=src.purchase_price,
        currency=src.currency,
        purchase_from=src.purchase_from,
        warranty_until=src.warranty_until,
        expected_life_months=src.expected_life_months,
        owner_user_id=src.owner_user_id,
        custodian_user_id=src.custodian_user_id,
        tags=list(src.tags or []),
        custom_fields=dict(src.custom_fields or {}),
        created_by=principal.user_id,
        updated_by=principal.user_id,
    )
    db.add(item)
    db.flush()
    add_event(
        db, principal, item, "created",
        f"复制自「{src.name}」（{src.code}）", {"cloned_from": src.id},
    )
    record(
        db, principal, "item.clone", entity_type="item", entity_id=item.id,
        summary=f"复制物品：{src.name} → {item.name}", request=request,
    )
    db.commit()
    return {"item": _serialize_many(db, [item], principal.family_id)[0]}


# --- 静态路径必须声明在 /items/{item_id} 之前 -------------------------------
# FastAPI 按声明顺序匹配，若 /items/{item_id} 在前，/items/export.csv 会被
# 当作 item_id 吞掉并返回 404。新增 /items/xxx 形式的静态路由请放在此处。
# --- export / import --------------------------------------------------------
@router.get("/items/export.csv")
def export_csv(
    principal: Principal = Depends(require("system.export")), db: Session = Depends(get_db)
) -> Response:
    items = list(
        db.execute(
            select(Item).where(Item.family_id == principal.family_id, Item.deleted_at.is_(None))
        ).scalars()
    )
    cats, locs, _ = _load_maps(db, principal.family_id)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["code", "name", "category", "location", "brand", "model", "serial_number",
         "barcode", "quantity", "unit", "status", "purchase_date", "purchase_price",
         "warranty_until", "tags", "description"]
    )
    for i in items:
        writer.writerow([
            i.code, i.name,
            cats.get(i.category_id).name if i.category_id and i.category_id in cats else "",
            _loc_path(locs, i.location_id) or "",
            i.brand, i.model, i.serial_number, i.barcode, i.quantity, i.unit, i.status,
            i.purchase_date.isoformat() if i.purchase_date else "",
            i.purchase_price if i.purchase_price is not None else "",
            i.warranty_until.isoformat() if i.warranty_until else "",
            ",".join(i.tags or []), i.description,
        ])
    data = "\ufeff" + buf.getvalue()
    return Response(
        content=data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="homeledger-items.csv"'},
    )


@router.post("/items/import")
def import_items(
    payload: ImportIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    result = import_rows(
        db,
        principal,
        payload.rows,
        dry_run=payload.dry_run,
        create_missing=payload.create_missing_taxonomy,
        next_code=code_allocator(db, principal.family_id),
    )
    if not payload.dry_run:
        record(db, principal, "item.import", entity_type="item",
               summary=f"批量导入 {result['created']} 件物品", request=request)
        db.commit()
    return result


@router.post("/items/bulk")
def bulk_create(
    payload: BulkItemIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    created = []
    allocate = code_allocator(db, principal.family_id)
    for row in payload.items:
        item = Item(
            family_id=principal.family_id,
            code=allocate(),
            created_by=principal.user_id,
            updated_by=principal.user_id,
            **row.model_dump(exclude={"code"}),
        )
        db.add(item)
        created.append(item)
    db.flush()
    record(db, principal, "item.bulk_create", entity_type="item",
           summary=f"批量新增 {len(created)} 件物品", request=request)
    db.commit()
    return {"created": len(created)}


# 批量修改允许的字段：不把 name/code/barcode 这类「每件都该不同」的
# 标识字段放进白名单——批量写同值等于销毁数据。
BATCHABLE_FIELDS = {
    "quantity", "unit", "min_stock", "status", "condition",
    "category_id", "location_id", "tags",
    "purchase_date", "purchase_price", "currency", "purchase_from",
    "warranty_until", "expected_life_months", "custodian_user_id",
}


@router.post("/items/batch-update")
def batch_update_items(
    payload: ItemsBatchUpdateIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    fields = {
        k: v
        for k, v in payload.fields.model_dump(exclude_unset=True).items()
        if k in BATCHABLE_FIELDS
    }
    if not fields:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有可批量修改的字段")
    if len(set(payload.ids)) != len(payload.ids):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "物品列表里有重复项")

    items = list(db.execute(select(Item).where(Item.family_id == principal.family_id, Item.id.in_(payload.ids))).scalars())
    found = {it.id for it in items}
    missing = [i for i in payload.ids if i not in found]
    untouchable = [
        it.id for it in items
        if it.deleted_at or not _may_touch(db, it, principal, ITEM_UPDATE)
    ]
    if missing or untouchable:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"这些物品不存在或没有编辑权限：{', '.join((missing + untouchable)[:5])}"
            + ("…" if len(missing + untouchable) > 5 else ""),
        )

    now = utcnow()
    for it in items:
        for k, v in fields.items():
            setattr(it, k, v)
        it.updated_by = principal.user_id
        it.updated_at = now
        it.version += 1
        add_event(db, principal, it, "updated", "批量修改", {"fields": sorted(fields)})
    record(
        db, principal, "item.batch_update", entity_type="item",
        summary=f"批量修改 {len(items)} 件物品：{', '.join(sorted(fields))}", request=request,
    )
    db.commit()
    return {"ok": True, "updated": len(items), "fields": sorted(fields)}


@router.get("/items/{item_id}")
def get_item(
    item_id: str,
    principal: Principal = Depends(require_view_or_shared),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id or item.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    if not _may_touch(db, item, principal, ITEM_VIEW):
        # 403 rather than 404: the existence of a shared item is not a secret,
        # only its contents are.
        raise PermissionDenied(ITEM_VIEW)
    if principal.role == "guest" and not _guest_can(db, item.id, principal.user_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "你没有查看该物品的授权")

    data = _serialize_many(db, [item], principal.family_id)[0]
    components = db.execute(
        select(ItemComponent).where(
            ItemComponent.item_id == item.id, ItemComponent.deleted_at.is_(None)
        )
    ).scalars().all()
    attachments = db.execute(
        select(Attachment).where(
            Attachment.item_id == item.id, Attachment.deleted_at.is_(None)
        ).order_by(Attachment.created_at.desc())
    ).scalars().all()
    tasks = db.execute(
        select(MaintenanceTask)
        .where(MaintenanceTask.item_id == item.id, MaintenanceTask.deleted_at.is_(None))
        .order_by(MaintenanceTask.status, MaintenanceTask.next_due_at)
    ).scalars().all()
    events = db.execute(
        select(ItemEvent)
        .where(ItemEvent.item_id == item.id)
        .order_by(ItemEvent.created_at.desc())
        .limit(50)
    ).scalars().all()
    loans = db.execute(
        select(Loan).where(Loan.item_id == item.id).order_by(Loan.lent_at.desc()).limit(20)
    ).scalars().all()
    acl = db.execute(select(ItemACL).where(ItemACL.item_id == item.id)).scalars().all()
    acl_users = {
        u.id: u
        for u in db.execute(
            select(User).where(User.id.in_([a.user_id for a in acl] or [""]))
        ).scalars()
    }
    # Batches are embedded rather than exposed as a second call: the detail page
    # always needs them next to the quantity, and one round trip is one fewer
    # place for the local engine and the server to drift apart.
    batch_rows = db.execute(
        select(ItemBatch)
        .where(ItemBatch.item_id == item.id, ItemBatch.deleted_at.is_(None))
        .order_by(ItemBatch.expires_on.is_(None), ItemBatch.expires_on, ItemBatch.created_at)
    ).scalars().all()
    batch_locations = {
        l.id: l
        for l in db.execute(
            select(Location).where(
                Location.id.in_([b.location_id for b in batch_rows if b.location_id] or [""])
            )
        ).scalars()
    }

    data.update(
        {
            "components": [component_out(c) for c in components],
            "batches": [
                batch_out(b, _loc_path(batch_locations, b.location_id)) for b in batch_rows
            ],
            "attachments": [attachment_out(a) for a in attachments],
            "maintenance": [
                {
                    "id": t.id,
                    "title": t.title,
                    "task_type": t.task_type,
                    "status": t.status,
                    "next_due_at": t.next_due_at.isoformat() + "Z" if t.next_due_at else None,
                    "interval_days": t.interval_days,
                    "priority": t.priority,
                }
                for t in tasks
            ],
            "events": [event_out(e) for e in events],
            "loans": [loan_out(l, item) for l in loans],
            "acl": [
                {
                    "id": a.id,
                    "user_id": a.user_id,
                    "permission": a.permission,
                    "user": {
                        "display_name": acl_users[a.user_id].display_name if a.user_id in acl_users else "",
                        "email": acl_users[a.user_id].email if a.user_id in acl_users else "",
                    },
                }
                for a in acl
            ],
            "qr_url": f"/api/v1/items/{item.id}/qr.png",
            "label_url": f"/api/v1/items/{item.id}/label.png",
        }
    )
    return {"item": data}


def _guest_can(db: Session, item_id: str, user_id: str) -> bool:
    return (
        db.execute(
            select(ItemACL.id).where(ItemACL.item_id == item_id, ItemACL.user_id == user_id)
        ).first()
        is not None
    )


@router.patch("/items/{item_id}")
def update_item(
    item_id: str,
    payload: ItemUpdateIn,
    request: Request,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id or item.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    if not _may_touch(db, item, principal, ITEM_UPDATE):
        raise PermissionDenied(ITEM_UPDATE)
    if payload.version is not None and payload.version != item.version:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": "该物品已被其他人修改，请刷新后重试",
                "current_version": item.version,
                "current": _serialize_many(db, [item], principal.family_id)[0],
            },
        )

    changes = payload.model_dump(exclude_unset=True)
    changes.pop("version", None)
    before_snapshot = {
        k: getattr(item, k)
        for k in changes
        if hasattr(item, k)
    }
    old_location = item.location_id
    old_status = item.status

    for key, value in changes.items():
        if key in {"purchase_date", "warranty_until"} and isinstance(value, str):
            continue
        setattr(item, key, value)
    item.updated_by = principal.user_id
    item.updated_at = utcnow()
    item.version += 1

    after_snapshot = {k: getattr(item, k) for k in changes if hasattr(item, k)}
    d = diff(
        {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in before_snapshot.items()},
        {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in after_snapshot.items()},
    )

    if "location_id" in d:
        locs = {l.id: l for l in db.execute(select(Location).where(Location.family_id == item.family_id)).scalars()}
        add_event(
            db, principal, item, "moved",
            f"位置从「{_loc_path(locs, old_location) or '未分配'}」移至「{_loc_path(locs, item.location_id) or '未分配'}」",
        )
    if "status" in d:
        add_event(
            db, principal, item, "status_change",
            f"状态变更：{old_status} → {item.status}", {"from": old_status, "to": item.status},
        )
    if d:
        add_event(db, principal, item, "updated", f"更新了 {len(d)} 个字段", {"fields": list(d)})
        record(
            db, principal, "item.update", entity_type="item", entity_id=item.id,
            summary=f"修改物品：{item.name}", before=d, request=request,
        )
    db.commit()
    return {"item": _serialize_many(db, [item], principal.family_id)[0]}


@router.post("/items/{item_id}/archive")
def archive_item(
    item_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_ARCHIVE)),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    item.archived_at = utcnow()
    item.status = "archived"
    item.version += 1
    add_event(db, principal, item, "archived", "归档物品")
    record(db, principal, "item.archive", entity_type="item", entity_id=item.id,
           summary=f"归档物品：{item.name}", request=request)
    db.commit()
    return {"ok": True}


@router.post("/items/{item_id}/restore")
def restore_item(
    item_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_ARCHIVE)),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    item.archived_at = None
    item.deleted_at = None
    item.status = "stored" if item.status == "archived" else item.status
    item.version += 1
    add_event(db, principal, item, "restored", "恢复物品")
    record(db, principal, "item.restore", entity_type="item", entity_id=item.id,
           summary=f"恢复物品：{item.name}", request=request)
    db.commit()
    return {"ok": True}


def _hard_delete_item(db: Session, item: Item) -> bool:
    """彻底删除一件物品。返回 False = 有未归还借出，拦下。

    外键没有 CASCADE（或根本没有外键）的三张表，db.delete 不会碰：
    附件（记录 + 文件 + 缩略图）、物品级授权、二维码 token。
    贴纸作废是刻意的：印出去的码指向一件不存在的物品，扫出来就该 404。
    item_events 保留——抹掉的是物品，不是历史。
    """
    open_loan = db.execute(
        select(Loan.id).where(Loan.item_id == item.id, Loan.returned_at.is_(None))
    ).first()
    if open_loan:
        return False
    for a in db.execute(select(Attachment).where(Attachment.item_id == item.id)).scalars():
        if a.relative_path:
            try:
                get_storage_provider().delete(a.relative_path)
            except Exception:
                pass  # 文件删不掉不拦记录删除，与手动删附件同一口径
        db.delete(a)
    for row in db.execute(select(ItemACL).where(ItemACL.item_id == item.id)).scalars():
        db.delete(row)
    for row in db.execute(select(QrLink).where(QrLink.item_id == item.id)).scalars():
        db.delete(row)
    db.delete(item)
    return True


@router.delete("/items/{item_id}")
def delete_item(
    item_id: str,
    request: Request,
    hard: bool = False,
    principal: Principal = Depends(require(ITEM_DELETE)),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    if hard:
        # HANDOFF §5 承诺过「未还的记录阻止删除物品」——软删从不拦，
        # 硬删是唯一真正抹掉数据的地方，在这里把承诺兑现。
        if not _hard_delete_item(db, item):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "物品还有未归还的借出记录，归还后再彻底删除"
            )
        record(
            db, principal, "item.delete.hard", entity_type="item", entity_id=item.id,
            summary=f"永久删除物品：{item.name}", before={"name": item.name, "code": item.code},
            request=request,
        )
    else:
        item.deleted_at = utcnow()
        item.version += 1
        record(
            db, principal, "item.delete", entity_type="item", entity_id=item.id,
            summary=f"删除物品：{item.name}", before={"name": item.name, "code": item.code},
            request=request,
        )
    db.commit()
    return {"ok": True, "hard": hard}


@router.post("/items/purge-deleted")
def purge_deleted_items(
    request: Request,
    principal: Principal = Depends(require(ITEM_DELETE)),
    db: Session = Depends(get_db),
) -> dict:
    """清空回收站的「已删除」视图：把所有软删除的物品彻底抹掉。

    有未归还借出的物品**跳过而不是拒绝**——一批里一件卡住不该挡住其余
    的清理，用户能在返回的 blocked 里看到是谁没走。
    """
    deleted = list(
        db.execute(
            select(Item).where(
                Item.family_id == principal.family_id, Item.deleted_at.is_not(None)
            )
        ).scalars()
    )
    purged, blocked = [], []
    for item in deleted:
        if _hard_delete_item(db, item):
            purged.append(item.name)
        else:
            blocked.append({"id": item.id, "name": item.name})
    if purged:
        record(
            db, principal, "item.purge", entity_type="item",
            summary=f"清空回收站：彻底删除 {len(purged)} 件物品", request=request,
        )
    db.commit()
    return {"purged": len(purged), "blocked": blocked}


@router.get("/items/{item_id}/events")
def item_events(
    item_id: str,
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    rows = db.execute(
        select(ItemEvent).where(ItemEvent.item_id == item_id).order_by(ItemEvent.created_at.desc())
    ).scalars().all()
    return {"items": [event_out(e) for e in rows]}


# --- components -------------------------------------------------------------
@router.post("/items/{item_id}/components", status_code=201)
def add_component(
    item_id: str,
    payload: ComponentIn,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    comp = ItemComponent(family_id=item.family_id, item_id=item.id, **payload.model_dump())
    db.add(comp)
    db.flush()
    add_event(db, principal, item, "component_added", f"添加组件：{comp.name}")
    db.commit()
    return {"component": component_out(comp)}


@router.delete("/items/{item_id}/components/{component_id}")
def delete_component(
    item_id: str,
    component_id: str,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    comp = db.get(ItemComponent, component_id)
    if not comp or comp.item_id != item_id or comp.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "组件不存在")
    comp.deleted_at = utcnow()
    db.commit()
    return {"ok": True}


# --- per item ACL -----------------------------------------------------------
@router.post("/items/{item_id}/acl", status_code=201)
def grant_acl(
    item_id: str,
    payload: ItemACLIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    existing = db.execute(
        select(ItemACL).where(ItemACL.item_id == item_id, ItemACL.user_id == payload.user_id)
    ).scalar_one_or_none()
    if existing:
        existing.permission = payload.permission
        acl = existing
    else:
        acl = ItemACL(
            family_id=item.family_id, item_id=item_id,
            user_id=payload.user_id, permission=payload.permission,
        )
        db.add(acl)
    record(db, principal, "item.acl", entity_type="item", entity_id=item_id,
           summary=f"授予可见权限：{payload.user_id} ({payload.permission})", request=request)
    db.commit()
    return {"acl": {"id": acl.id, "user_id": acl.user_id, "permission": acl.permission}}


@router.delete("/items/{item_id}/acl/{user_id}")
def revoke_acl(
    item_id: str,
    user_id: str,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    acl = db.execute(
        select(ItemACL).where(ItemACL.item_id == item_id, ItemACL.user_id == user_id)
    ).scalar_one_or_none()
    if acl:
        db.delete(acl)
        db.commit()
    return {"ok": True}


# --- loans ------------------------------------------------------------------
@router.get("/loans")
def list_loans(
    open_only: bool = True,
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Loan).where(Loan.family_id == principal.family_id)
    if open_only:
        stmt = stmt.where(Loan.returned_at.is_(None))
    loans = list(db.execute(stmt.order_by(Loan.lent_at.desc())).scalars())
    items = {
        i.id: i
        for i in db.execute(select(Item).where(Item.id.in_([l.item_id for l in loans] or [""]))).scalars()
    }
    return {"items": [loan_out(l, items.get(l.item_id)) for l in loans]}


@router.post("/loans", status_code=201)
def create_loan(
    payload: LoanCreateIn,
    request: Request,
    principal: Principal = Depends(require(ITEM_LOAN)),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, payload.item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    if item.status == "lent":
        raise HTTPException(status.HTTP_409_CONFLICT, "该物品已借出")
    loan = Loan(
        family_id=item.family_id,
        created_by=principal.user_id,
        **payload.model_dump(),
    )
    db.add(loan)
    item.status = "lent"
    item.version += 1
    add_event(
        db, principal, item, "lent",
        f"借出给 {payload.borrower_name}",
        {"due_at": payload.due_at.isoformat() if payload.due_at else None},
    )
    record(db, principal, "loan.create", entity_type="loan", entity_id=loan.id,
           summary=f"借出：{item.name} → {payload.borrower_name}", request=request)
    db.commit()
    return {"loan": loan_out(loan, item)}


@router.post("/loans/{loan_id}/return")
def return_loan(
    loan_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_LOAN)),
    db: Session = Depends(get_db),
) -> dict:
    loan = db.get(Loan, loan_id)
    if not loan or loan.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "借出记录不存在")
    if loan.returned_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "该记录已归还")
    loan.returned_at = utcnow()
    item = db.get(Item, loan.item_id)
    if item:
        item.status = "in_use"
        item.version += 1
        add_event(db, principal, item, "returned", f"{loan.borrower_name} 归还")
    record(db, principal, "loan.return", entity_type="loan", entity_id=loan.id,
           summary="物品归还", request=request)
    db.commit()
    return {"loan": loan_out(loan, item)}


@router.get("/items/{item_id}/qr.png")
def item_qr(
    item_id: str,
    request: Request,
    size: int = 8,
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> Response:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    # The sticker points at the server, not at this app. A phone that has never
    # installed anything has to be able to read it, and an app deep link cannot
    # do that. `public_base` deliberately ignores the loopback address the app
    # itself uses — see services/net.py.
    link = qr_links.ensure_link(db, item, public_base(request.url.port), created_by=principal.user_id)
    db.commit()
    return Response(
        content=qr_png(qr_links.sticker_url(link), box_size=max(2, min(size, 20))),
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/items/{item_id}/label.png")
def item_label(
    item_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> Response:
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    locs = {l.id: l for l in db.execute(select(Location).where(Location.family_id == item.family_id)).scalars()}
    link = qr_links.ensure_link(db, item, public_base(request.url.port), created_by=principal.user_id)
    db.commit()
    png = label_png(
        url=qr_links.sticker_url(link),
        title=item.name,
        code=item.code,
        subtitle=_loc_path(locs, item.location_id) or "",
    )
    return Response(content=png, media_type="image/png")


@router.get("/items/{item_id}/qr-link")
def item_qr_link(
    item_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    """The URL a printed sticker should contain, plus whether it will work.

    The client renders its own QR from this instead of downloading a PNG: at
    label size the difference between a 300 dpi raster and an SVG is the
    difference between scanning on the first try and not scanning at all.
    """
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    base = public_base(request.url.port)
    link = qr_links.ensure_link(db, item, base, created_by=principal.user_id)
    db.commit()
    return {
        "token": link.token,
        "url": qr_links.sticker_url(link),
        "base": base,
        "lan_only": settings.qr_lan_only,
        # False when the server is bound to loopback: the sticker is still
        # printable, but a phone will not reach it until LAN sharing is on.
        "reachable": qr_reachable_from_lan(),
        "hits": link.hits,
    }


@router.delete("/items/{item_id}/qr-link")
def item_qr_revoke(
    item_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    """Turn every sticker already printed for this item into a dead link."""
    item = db.get(Item, item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    count = qr_links.revoke_for_item(db, item.id)
    record(db, principal, "item.qr.revoke", entity_type="item", entity_id=item.id,
           summary=f"作废 {count} 个二维码标签", request=request)
    db.commit()
    return {"revoked": count}
