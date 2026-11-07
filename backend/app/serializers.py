"""Row -> JSON serialisers.

Hand written on purpose: it keeps the wire format explicit and lets us join in
derived fields (location path, category name, overdue flags) without dragging
ORM lazy loading into the response cycle.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .models import (
    Attachment,
    AuditLog,
    BackupRecord,
    Category,
    Family,
    Item,
    ItemBatch,
    ItemComponent,
    ItemEvent,
    Loan,
    Location,
    MaintenanceTask,
    Membership,
    Notification,
    User,
    iso,
)

# A batch counts as "临期" inside this window. Kept next to the serializer that
# computes the flag so the dashboard query and the per-batch badge can never
# disagree; the local engine mirrors the number in `local/serialize.ts`.
EXPIRING_DAYS = 30


def dt(value: datetime | None) -> str | None:
    return iso(value)


def d(value: date | None) -> str | None:
    return value.isoformat() if value else None


def user_public(u: User | None) -> dict | None:
    if not u:
        return None
    return {
        "id": u.id,
        "email": u.email,
        "display_name": u.display_name,
        "avatar_color": u.avatar_color,
        # 自定义头像的相对路径；前端用 authedUrl() 带上 token 取图
        "avatar_url": f"/auth/avatar/{u.id}" if u.avatar_path else None,
        "is_active": u.is_active,
        "is_instance_admin": u.is_instance_admin,
        "created_at": dt(u.created_at),
        "last_login_at": dt(u.last_login_at),
    }


def user_brief(u: User | None) -> dict | None:
    if not u:
        return None
    return {
        "id": u.id,
        "display_name": u.display_name,
        "avatar_color": u.avatar_color,
        "avatar_url": f"/auth/avatar/{u.id}" if u.avatar_path else None,
        "email": u.email,
    }


def family_out(f: Family, membership: Membership | None = None) -> dict:
    payload = {
        "id": f.id,
        "name": f.name,
        "invite_code": f.invite_code,
        "invite_expires_at": dt(f.invite_expires_at) if f.invite_expires_at else None,
        "deployment_mode": f.deployment_mode,
        "settings": f.settings or {},
        "created_by": f.created_by,
        "created_at": dt(f.created_at),
    }
    if membership:
        payload["my_role"] = membership.role
        payload["my_nickname"] = membership.nickname
        payload["my_overrides"] = membership.permission_overrides or {}
    return payload


def member_out(m: Membership, u: User) -> dict:
    return {
        "id": m.id,
        "user_id": u.id,
        "email": u.email,
        "display_name": u.display_name,
        "nickname": m.nickname,
        "avatar_color": u.avatar_color,
        "avatar_url": f"/auth/avatar/{u.id}" if u.avatar_path else None,
        "role": m.role,
        "status": m.status,
        "permission_overrides": m.permission_overrides or {},
        "joined_at": dt(m.joined_at),
        "last_login_at": dt(u.last_login_at),
    }


def location_out(loc: Location, item_count: int | None = None, path: str | None = None) -> dict:
    out = {
        "id": loc.id,
        "parent_id": loc.parent_id,
        "name": loc.name,
        "kind": loc.kind,
        "icon": loc.icon,
        "note": loc.note,
        "sort_order": loc.sort_order,
        "created_at": dt(loc.created_at),
    }
    if item_count is not None:
        out["item_count"] = item_count
    if path is not None:
        out["path"] = path
    return out


def category_out(c: Category, item_count: int | None = None) -> dict:
    out = {
        "id": c.id,
        "parent_id": c.parent_id,
        "name": c.name,
        "icon": c.icon,
        "color": c.color,
        "sort_order": c.sort_order,
    }
    if item_count is not None:
        out["item_count"] = item_count
    return out


def attachment_out(a: Attachment) -> dict:
    return {
        "id": a.id,
        "item_id": a.item_id,
        "maintenance_id": a.maintenance_id,
        "kind": a.kind,
        "original_name": a.original_name,
        "mime_type": a.mime_type,
        "size_bytes": a.size_bytes,
        "sha256": a.sha256,
        "uploaded_by": a.uploaded_by,
        "created_at": dt(a.created_at),
        "url": f"/api/v1/attachments/{a.id}/raw",
        "thumbnail_url": (
            f"/api/v1/attachments/{a.id}/raw?variant=thumb"
            if (a.mime_type or "").startswith("image/")
            else None
        ),
        "is_image": (a.mime_type or "").startswith("image/"),
    }


def component_out(c: ItemComponent) -> dict:
    return {
        "id": c.id,
        "item_id": c.item_id,
        "name": c.name,
        "component_type": c.component_type,
        "serial_number": c.serial_number,
        "quantity": c.quantity,
        "installed_at": d(c.installed_at),
        "note": c.note,
    }


def batch_expiry_state(expires_on: date | None, today: date | None = None) -> tuple[str, int | None]:
    """`(state, days_left)` for one expiry date.

    Derived, never stored: a stored status would be wrong the moment the clock
    crosses midnight, and would need a background job to stay honest.
    """
    if not expires_on:
        return "none", None
    days = (expires_on - (today or datetime.utcnow().date())).days
    if days < 0:
        return "expired", days
    if days <= EXPIRING_DAYS:
        return "expiring", days
    return "fresh", days


def batch_out(b: ItemBatch, location_path: str | None = None) -> dict:
    state, days_left = batch_expiry_state(b.expires_on)
    return {
        "id": b.id,
        "item_id": b.item_id,
        "batch_no": b.batch_no,
        "quantity": b.quantity,
        # Empty means "same as the item" — resolved by the client, which knows
        # the item's unit. Baking it in here would freeze the unit at write
        # time and go stale if the item is later changed to kg.
        "unit": b.unit,
        "produced_on": d(b.produced_on),
        "expires_on": d(b.expires_on),
        "location_id": b.location_id,
        "location_path": location_path,
        "supplier": b.supplier,
        "note": b.note,
        "expiry_state": state,
        "days_left": days_left,
        "version": b.version,
        "created_at": dt(b.created_at),
        "updated_at": dt(b.updated_at),
    }


def item_out(
    it: Item,
    *,
    category: Category | None = None,
    location: Location | None = None,
    location_path: str | None = None,
    cover_url: str | None = None,
    owner: User | None = None,
    custodian: User | None = None,
    open_tasks: int = 0,
    next_due: datetime | None = None,
) -> dict:
    now = datetime.utcnow()
    warranty_state = "none"
    if it.warranty_until:
        if it.warranty_until < now.date():
            warranty_state = "expired"
        elif (it.warranty_until - now.date()).days <= 30:
            warranty_state = "expiring"
        else:
            warranty_state = "active"

    return {
        "id": it.id,
        "code": it.code,
        "name": it.name,
        "description": it.description,
        "category_id": it.category_id,
        "category": category_out(category) if category else None,
        "location_id": it.location_id,
        "location": location_out(location) if location else None,
        "location_path": location_path,
        "quantity": it.quantity,
        "min_stock": it.min_stock,
        "unit": it.unit,
        "status": it.status,
        "condition": it.condition,
        "brand": it.brand,
        "model": it.model,
        "serial_number": it.serial_number,
        "barcode": it.barcode,
        "barcode_type": it.barcode_type,
        "purchase_date": d(it.purchase_date),
        "purchase_price": it.purchase_price,
        "currency": it.currency,
        "purchase_from": it.purchase_from,
        "warranty_until": d(it.warranty_until),
        "warranty_state": warranty_state,
        "expected_life_months": it.expected_life_months,
        "owner_user_id": it.owner_user_id,
        "owner": user_brief(owner),
        "custodian_user_id": it.custodian_user_id,
        "custodian": user_brief(custodian),
        "tags": it.tags or [],
        "custom_fields": it.custom_fields or {},
        "cover_url": cover_url,
        "open_tasks": open_tasks,
        "next_due_at": dt(next_due),
        "version": it.version,
        "created_by": it.created_by,
        "updated_by": it.updated_by,
        "created_at": dt(it.created_at),
        "updated_at": dt(it.updated_at),
        "archived_at": dt(it.archived_at),
        # 回收站的「已删除」视图需要它；常规列表里恒为 null
        "deleted_at": dt(it.deleted_at),
    }


def task_out(t: MaintenanceTask, item: Item | None = None, assignee: User | None = None) -> dict:
    now = datetime.utcnow()
    overdue = bool(t.next_due_at and t.next_due_at < now and t.status == "pending")
    due_in_days = None
    if t.next_due_at:
        due_in_days = (t.next_due_at.date() - now.date()).days
    return {
        "id": t.id,
        "item_id": t.item_id,
        "item_name": item.name if item else None,
        "item_code": item.code if item else None,
        "title": t.title,
        "task_type": t.task_type,
        "interval_days": t.interval_days,
        "due_at": dt(t.due_at),
        "next_due_at": dt(t.next_due_at),
        "last_completed_at": dt(t.last_completed_at),
        "assignee_id": t.assignee_id,
        "assignee": user_brief(assignee),
        "status": t.status,
        "priority": t.priority,
        "notes": t.notes,
        "estimated_cost": t.estimated_cost,
        "completed_at": dt(t.completed_at),
        "completed_by": t.completed_by,
        "overdue": overdue,
        "due_in_days": due_in_days,
        "created_at": dt(t.created_at),
    }


def event_out(e: ItemEvent) -> dict:
    return {
        "id": e.id,
        "item_id": e.item_id,
        "event_type": e.event_type,
        "summary": e.summary,
        "payload": e.payload or {},
        "actor_id": e.actor_id,
        "actor_name": e.actor_name,
        "created_at": dt(e.created_at),
    }


def loan_out(l: Loan, item: Item | None = None) -> dict:
    return {
        "id": l.id,
        "item_id": l.item_id,
        "item_name": item.name if item else None,
        "item_code": item.code if item else None,
        "borrower_name": l.borrower_name,
        "borrower_user_id": l.borrower_user_id,
        "borrower_contact": l.borrower_contact,
        "lent_at": dt(l.lent_at),
        "due_at": dt(l.due_at),
        "returned_at": dt(l.returned_at),
        "note": l.note,
        "is_open": l.returned_at is None,
        "overdue": bool(l.returned_at is None and l.due_at and l.due_at < datetime.utcnow()),
    }


def audit_out(a: AuditLog) -> dict:
    return {
        "id": a.id,
        "actor_id": a.actor_id,
        "actor_name": a.actor_name,
        "action": a.action,
        "entity_type": a.entity_type,
        "entity_id": a.entity_id,
        "summary": a.summary,
        "before": a.before,
        "after": a.after,
        "ip": a.ip,
        "user_agent": a.user_agent,
        "created_at": dt(a.created_at),
    }


def notification_out(n: Notification) -> dict:
    return {
        "id": n.id,
        "type": n.type,
        "title": n.title,
        "body": n.body,
        "entity_type": n.entity_type,
        "entity_id": n.entity_id,
        "read_at": dt(n.read_at),
        "created_at": dt(n.created_at),
    }


def backup_out(b: BackupRecord) -> dict:
    return {
        "id": b.id,
        "filename": b.filename,
        "size_bytes": b.size_bytes,
        "sha256": b.sha256,
        "kind": b.kind,
        "status": b.status,
        "note": b.note,
        "includes_files": b.includes_files,
        "created_by": b.created_by,
        "created_at": dt(b.created_at),
    }


def page(items: list[Any], total: int, page_no: int, page_size: int) -> dict:
    return {
        "items": items,
        "total": total,
        "page": page_no,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }
