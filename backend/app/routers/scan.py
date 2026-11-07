"""Scanning entry point + AI assisted entry.

Three identifiers arrive from three different scanners, and they mean different
things. This router is the single place that resolves "what did the user just
scan" into an item, and it tells the client *which* identifier matched so the UI
can explain the result instead of silently guessing.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_principal, require
from ..models import Attachment, Item, ItemACL
from ..permissions import DOC_VIEW, ITEM_VIEW, PermissionDenied, Principal
from ..providers.ai import all_providers, get_ai_provider
from ..providers.storage import get_storage_provider
from ..schemas import OcrRequestIn

router = APIRouter(tags=["scan"])


def _visibility(principal: Principal):
    """None when the role already grants item.view, else the shared item ids."""
    if principal.can(ITEM_VIEW):
        return None
    return select(ItemACL.item_id).where(
        ItemACL.family_id == principal.family_id,
        ItemACL.user_id == principal.user_id,
    )


def require_scanner(
    principal: Principal = Depends(get_principal), db: Session = Depends(get_db)
) -> Principal:
    """Scanning needs item.view, or at least one item explicitly shared."""
    if principal.can(ITEM_VIEW):
        return principal
    if db.execute(_visibility(principal).limit(1)).first():
        return principal
    raise PermissionDenied(ITEM_VIEW)


@router.get("/scan/lookup")
def lookup(
    code: str = Query(min_length=1, max_length=128),
    principal: Principal = Depends(require_scanner),
    db: Session = Depends(get_db),
) -> dict:
    raw = code.strip()
    # A scanned URL may embed ?code=HL-000123
    if "code=" in raw:
        raw = raw.split("code=")[-1].split("&")[0]

    fid = principal.family_id
    scope = _visibility(principal)
    matches: list[tuple[str, Item]] = []

    stmt = select(Item).where(
        Item.family_id == fid, Item.code == raw, Item.deleted_at.is_(None)
    )
    if scope is not None:
        stmt = stmt.where(Item.id.in_(scope))
    item = db.execute(stmt).scalar_one_or_none()
    if item:
        matches.append(("asset_code", item))

    if not matches:
        stmt = select(Item).where(
            Item.family_id == fid,
            Item.deleted_at.is_(None),
            or_(Item.barcode == raw, Item.serial_number == raw),
        )
        if scope is not None:
            stmt = stmt.where(Item.id.in_(scope))
        for it in db.execute(stmt).scalars():
            matches.append(("barcode" if it.barcode == raw else "serial", it))

    if not matches:
        # 名称模糊匹配。桌面端没有相机，只能打字——只认编号和条码等于让桌面
        # 用户对着屏幕干瞪眼。精确标识符仍然优先：先命中编号/条码就直接返回，
        # 不会因为名字里恰好含这几个字而跑偏。
        stmt = (
            select(Item)
            .where(
                Item.family_id == fid,
                Item.deleted_at.is_(None),
                Item.name.ilike(f"%{raw}%"),
            )
            .order_by(Item.updated_at.desc())
            .limit(20)
        )
        if scope is not None:
            stmt = stmt.where(Item.id.in_(scope))
        for it in db.execute(stmt).scalars():
            matches.append(("name", it))

    if not matches:
        return {
            "found": False,
            "query": raw,
            "message": "没有找到对应物品。可能是新物品，可直接创建。",
            "suggest_create": True,
        }

    first_binding, first_item = matches[0]
    hints: list[str] = []
    if first_binding == "barcode" and len(matches) > 1:
        hints.append("该条码对应商品型号，可能有多件实物")
    if first_binding == "name" and len(matches) > 1:
        hints.append(f"{len(matches)} 件物品的名称里包含「{raw}」，选一件打开")
    if first_item.archived_at is not None:
        # Returning "not found" for an archived item would invite the user to
        # create a duplicate, so we surface it with an explicit flag instead.
        hints.append("该物品已归档，如需继续使用请先恢复")
    return {
        "found": True,
        "matched_by": first_binding,
        "ambiguous": len(matches) > 1,
        "archived": first_item.archived_at is not None,
        "query": raw,
        "item": {
            "id": first_item.id,
            "name": first_item.name,
            "code": first_item.code,
            "archived": first_item.archived_at is not None,
        },
        "candidates": [
            {
                "id": i.id, "name": i.name, "code": i.code,
                "match": kind, "status": i.status,
                "location_id": i.location_id,
                "archived": i.archived_at is not None,
            }
            for kind, i in matches
        ],
        "hint": "；".join(hints) if hints else None,
    }


@router.get("/scan/ai/providers")
def ai_providers(_: Principal = Depends(require(ITEM_VIEW))) -> dict:
    active = get_ai_provider()
    return {"active": active.describe(), "available": all_providers()}


@router.post("/scan/ocr")
def run_ocr(
    payload: OcrRequestIn,
    principal: Principal = Depends(require(DOC_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    att = db.get(Attachment, payload.attachment_id)
    if not att or att.family_id != principal.family_id or att.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "附件不存在")
    if not (att.mime_type or "").startswith("image/"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OCR 目前仅支持图片")

    provider = get_ai_provider()
    try:
        data = get_storage_provider().read(att.relative_path)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件已丢失")

    result = provider.extract(data, mime=att.mime_type, hint=att.original_name)
    result["attachment_id"] = att.id
    result["provider_info"] = provider.describe()
    return result
