"""CSV / Excel row importer.

The importer is intentionally forgiving and dry-runnable: migrating from a
spreadsheet is the single most common onboarding path, and a failed import that
half-writes data is worse than no import at all.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Category, Item, Location
from ..permissions import Principal

FIELD_ALIASES = {
    "名称": "name", "物品名称": "name", "name": "name", "标题": "name",
    "分类": "category", "category": "category",
    "位置": "location", "location": "location", "存放位置": "location",
    "品牌": "brand", "brand": "brand",
    "型号": "model", "model": "model",
    "序列号": "serial_number", "sn": "serial_number", "serial": "serial_number",
    "条码": "barcode", "barcode": "barcode", "ean": "barcode",
    "数量": "quantity", "quantity": "quantity",
    "单位": "unit", "unit": "unit",
    "状态": "status", "status": "status",
    "购买日期": "purchase_date", "purchase_date": "purchase_date",
    "价格": "purchase_price", "金额": "purchase_price", "purchase_price": "purchase_price",
    "保修截止": "warranty_until", "warranty_until": "warranty_until",
    "标签": "tags", "tags": "tags",
    "备注": "description", "description": "description", "说明": "description",
    "编号": "code", "code": "code",
}

STATUS_MAP = {
    "在用": "in_use", "使用中": "in_use", "in_use": "in_use",
    "存放": "stored", "闲置": "stored", "stored": "stored",
    "借出": "lent", "lent": "lent",
    "维修": "repair", "维修中": "repair", "repair": "repair",
    "丢失": "lost", "lost": "lost",
    "报废": "disposed", "已处理": "disposed", "disposed": "disposed",
}


def _parse_date(value: Any) -> date | None:
    if value in (None, "", "—", "-"):
        return None
    if isinstance(value, date):
        return value
    text = str(value).strip().replace("/", "-").replace(".", "-")
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y%m%d", "%m-%d-%Y"):
        try:
            from datetime import datetime

            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _parse_float(value: Any) -> float | None:
    if value in (None, "", "—", "-"):
        return None
    try:
        return float(str(value).replace("¥", "").replace("￥", "").replace(",", "").strip())
    except ValueError:
        return None


def normalise_row(raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in raw.items():
        target = FIELD_ALIASES.get(str(key).strip().lower()) or FIELD_ALIASES.get(str(key).strip())
        if target:
            out[target] = value
    return out


def import_rows(
    db: Session,
    principal: Principal,
    rows: list[dict[str, Any]],
    *,
    dry_run: bool,
    create_missing: bool,
    next_code: Callable[[], str],
) -> dict:
    cats = {
        c.name: c
        for c in db.execute(
            select(Category).where(Category.family_id == principal.family_id)
        ).scalars()
    }
    locs = {
        l.name: l
        for l in db.execute(
            select(Location).where(Location.family_id == principal.family_id)
        ).scalars()
    }

    taken_codes = {
        c for (c,) in db.execute(
            select(Item.code).where(Item.family_id == principal.family_id)
        ).all()
    }
    used_codes: set[str] = set()

    created = 0
    skipped = 0
    errors: list[dict] = []
    preview: list[dict] = []
    new_cats: set[str] = set()
    new_locs: set[str] = set()

    for idx, raw in enumerate(rows):
        row = normalise_row(raw)
        name = str(row.get("name") or "").strip()
        if not name:
            errors.append({"row": idx + 2, "message": "缺少物品名称"})
            skipped += 1
            continue

        cat_name = str(row.get("category") or "").strip()
        loc_name = str(row.get("location") or "").strip()

        category_id = None
        if cat_name:
            if cat_name in cats:
                category_id = cats[cat_name].id
            elif create_missing:
                cat = Category(family_id=principal.family_id, name=cat_name)
                db.add(cat)
                db.flush()
                cats[cat_name] = cat
                category_id = cat.id
                new_cats.add(cat_name)
            else:
                # Silently importing without the category would look like a
                # success while quietly losing the classification.
                errors.append(
                    {"row": idx + 2, "message": f"分类「{cat_name}」不存在（未开启自动创建）"}
                )
                skipped += 1
                continue

        location_id = None
        if loc_name:
            # Support "客厅 / 电视柜" paths.
            first = loc_name.split("/")[0].strip()
            if first in locs:
                location_id = locs[first].id
            elif create_missing:
                loc = Location(family_id=principal.family_id, name=first, kind="room")
                db.add(loc)
                db.flush()
                locs[first] = loc
                location_id = loc.id
                new_locs.add(first)
            else:
                errors.append(
                    {"row": idx + 2, "message": f"位置「{first}」不存在（未开启自动创建）"}
                )
                skipped += 1
                continue

        tags_raw = row.get("tags")
        tags = (
            [t.strip() for t in str(tags_raw).replace("，", ",").split(",") if t.strip()]
            if tags_raw
            else []
        )

        explicit_code = str(row.get("code") or "").strip()
        if explicit_code:
            if explicit_code in taken_codes or explicit_code in used_codes:
                errors.append({"row": idx + 2, "message": f"编号 {explicit_code} 已存在，已跳过"})
                skipped += 1
                continue
            code = explicit_code
        else:
            code = next_code()
            while code in taken_codes or code in used_codes:
                code = next_code()
        used_codes.add(code)

        payload = {
            "family_id": principal.family_id,
            "code": code,
            "name": name[:200],
            "description": str(row.get("description") or ""),
            "category_id": category_id,
            "location_id": location_id,
            "brand": str(row.get("brand") or ""),
            "model": str(row.get("model") or ""),
            "serial_number": str(row.get("serial_number") or ""),
            "barcode": str(row.get("barcode") or ""),
            "quantity": _parse_float(row.get("quantity")) or 1,
            "unit": str(row.get("unit") or "件"),
            "status": STATUS_MAP.get(str(row.get("status") or "").strip().lower(), "in_use"),
            "purchase_date": _parse_date(row.get("purchase_date")),
            "purchase_price": _parse_float(row.get("purchase_price")),
            "warranty_until": _parse_date(row.get("warranty_until")),
            "tags": tags,
            "created_by": principal.user_id,
            "updated_by": principal.user_id,
        }
        preview.append({"row": idx + 2, "code": payload["code"], "name": name})
        if not dry_run:
            db.add(Item(**payload))
        created += 1

    if not dry_run:
        db.flush()

    return {
        "dry_run": dry_run,
        "created": created,
        "skipped": skipped,
        "errors": errors[:50],
        "preview": preview[:50],
        "new_categories": sorted(new_cats),
        "new_locations": sorted(new_locs),
    }
