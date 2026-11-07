"""System surface: health, deployment info, dashboard, audit, backups, export."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import record
from ..config import settings
from ..db import get_db, provider
from ..deps import get_principal, require, require_instance_admin
from ..models import (
    Attachment,
    AuditLog,
    BackupRecord,
    Category,
    Family,
    Item,
    ItemBatch,
    ItemEvent,
    Loan,
    Location,
    MaintenanceTask,
    Membership,
    Notification,
    User,
    utcnow,
)
from ..permissions import (
    ITEM_VIEW,
    SYSTEM_AUDIT,
    SYSTEM_EXPORT,
    Principal,
)
from ..providers.ai import get_ai_provider
from ..providers.backup import get_backup_provider, prune_old_backups, restore_from_zip
from ..providers.deployment import get_deployment_config
from ..providers.notification import get_notification_providers
from ..providers.storage import get_storage_provider
from ..services.net import public_base, qr_reachable_from_lan
from ..services.qr_gateway import gateway as qr_gateway
from ..schemas import BackupCreateIn, NotificationMarkIn, RestoreIn
from ..serializers import (
    EXPIRING_DAYS,
    audit_out,
    backup_out,
    batch_out,
    notification_out,
    page,
)

router = APIRouter(tags=["system"])


def registered_user_count(db: Session) -> int:
    """Number of accounts that can actually sign in.

    Invited people exist as placeholder rows until they complete registration;
    their sentinel password hash (`!`) must not inflate a public counter.
    """
    return db.execute(
        select(func.count(User.id)).where(User.password_hash != "!")
    ).scalar() or 0


@router.get("/system/health")
def health() -> dict:
    db_health = provider.health()
    return {
        "ok": db_health.get("ok", False),
        "app": settings.app_name,
        "version": settings.app_version,
        "mode": settings.deployment_mode,
        # Lets a desktop shell tell "my server" from "some other program that
        # happens to hold this port" before it decides to reuse an instance.
        "install_id": settings.resolved_install_id,
        "database": {"ok": bool(db_health.get("ok")), "dialect": provider.dialect},
        "time": datetime.utcnow().isoformat() + "Z",
    }


@router.get("/system/info")
def info() -> dict:
    """Public bootstrap payload — no auth, no secrets."""
    dep = get_deployment_config().to_dict()
    db_looks_empty = True
    registered_users = 0
    try:
        with provider.session() as db:
            db_looks_empty = (db.execute(select(func.count(User.id))).scalar() or 0) == 0
            registered_users = registered_user_count(db)
    except Exception:
        pass
    return {
        "app_name": settings.app_name,
        "version": settings.app_version,
        "deployment": dep,
        "allow_registration": settings.allow_registration,
        "bootstrap_required": db_looks_empty,
        # Aggregate only: the client never receives a user list, email or id.
        # Placeholder invite rows are excluded (see registered_user_count).
        "registered_users": registered_users,
        "max_upload_mb": settings.max_upload_mb,
        # Lets the web client adapt its copy ("data stays on this computer")
        # without sniffing the user agent. A browser hitting a gateway sees
        # false, and nothing changes for it.
        "desktop": settings.desktop_shell,
    }


@router.get("/system/stats")
def public_stats() -> dict:
    """Aggregate counters for a status page; intentionally has no identities."""
    try:
        with provider.session() as db:
            return {"registered_users": registered_user_count(db)}
    except Exception:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "统计暂不可用，请检查数据库连接"
        )


@router.get("/system/providers")
def providers_status(
    _: User = Depends(require_instance_admin), db: Session = Depends(get_db)
) -> dict:
    ai = get_ai_provider()
    return {
        "database": {**provider.capabilities(), **provider.health()},
        "storage": get_storage_provider().health(),
        "backup": get_backup_provider().health(),
        "notifications": [p.health() for p in get_notification_providers()],
        "ai": ai.describe(),
        "deployment": get_deployment_config().to_dict(),
    }


@router.get("/system/qr")
def qr_status(
    request: Request, principal: Principal = Depends(require(ITEM_VIEW))
) -> dict:
    """What the sticker viewer is doing right now.

    Exposed because the whole point of the lease design is that it is off most
    of the time, and "it is off" is indistinguishable from "it is broken"
    unless you can look. The settings screen prints this verbatim.
    """
    return {
        "enabled": settings.qr_enabled,
        "lan_only": settings.qr_lan_only,
        # The port matters: `http://192.168.1.10` without `:8000` sends whoever
        # types it to port 80, which is not this server.
        "base": public_base(request.url.port),
        "reachable": qr_reachable_from_lan(),
        "idle_seconds": settings.qr_idle_seconds,
        **qr_gateway.snapshot(),
    }


@router.get("/system/dashboard")
def dashboard(
    principal: Principal = Depends(require(ITEM_VIEW)), db: Session = Depends(get_db)
) -> dict:
    fid = principal.family_id
    today = datetime.utcnow().date()
    base = (Item.family_id == fid) & (Item.deleted_at.is_(None))

    total = db.execute(select(func.count(Item.id)).where(base)).scalar() or 0
    archived = db.execute(
        select(func.count(Item.id)).where(base, Item.archived_at.is_not(None))
    ).scalar() or 0
    total_value = db.execute(
        select(func.coalesce(func.sum(Item.purchase_price), 0)).where(
            base, Item.archived_at.is_(None)
        )
    ).scalar()

    by_status = dict(
        db.execute(
            select(Item.status, func.count(Item.id)).where(base).group_by(Item.status)
        ).all()
    )

    cat_rows = db.execute(
        select(Category.name, Category.color, func.count(Item.id))
        .join(Item, Item.category_id == Category.id)
        .where(base, Category.family_id == fid)
        .group_by(Category.id)
        .order_by(func.count(Item.id).desc())
        .limit(6)
    ).all()
    loc_rows = db.execute(
        select(Location.name, func.count(Item.id))
        .join(Item, Item.location_id == Location.id)
        .where(base, Location.family_id == fid)
        .group_by(Location.id)
        .order_by(func.count(Item.id).desc())
        .limit(6)
    ).all()

    warranty_expiring = db.execute(
        select(func.count(Item.id)).where(
            base,
            Item.warranty_until.is_not(None),
            Item.warranty_until >= today,
            Item.warranty_until <= today + timedelta(days=30),
        )
    ).scalar() or 0
    warranty_expired = db.execute(
        select(func.count(Item.id)).where(
            base, Item.warranty_until.is_not(None), Item.warranty_until < today
        )
    ).scalar() or 0

    task_base = (MaintenanceTask.family_id == fid) & (MaintenanceTask.deleted_at.is_(None))
    overdue_tasks = db.execute(
        select(func.count(MaintenanceTask.id)).where(
            task_base,
            MaintenanceTask.status == "pending",
            MaintenanceTask.next_due_at.is_not(None),
            MaintenanceTask.next_due_at < datetime.utcnow(),
        )
    ).scalar() or 0
    upcoming_tasks = db.execute(
        select(func.count(MaintenanceTask.id)).where(
            task_base,
            MaintenanceTask.status == "pending",
            MaintenanceTask.next_due_at.is_not(None),
            MaintenanceTask.next_due_at >= datetime.utcnow(),
            MaintenanceTask.next_due_at <= datetime.utcnow() + timedelta(days=30),
        )
    ).scalar() or 0

    open_loans = db.execute(
        select(func.count(Loan.id)).where(Loan.family_id == fid, Loan.returned_at.is_(None))
    ).scalar() or 0

    # 逾期的借出单独计数：首页告警条要为它把人送到 /loans，
    # 只有 open_loans 的话数字看着正常，东西其实已经晚了两周没还。
    overdue_loans = db.execute(
        select(func.count(Loan.id)).where(
            Loan.family_id == fid,
            Loan.returned_at.is_(None),
            Loan.due_at.is_not(None),
            Loan.due_at < datetime.utcnow(),
        )
    ).scalar() or 0

    # --- 低库存 -----------------------------------------------------------
    # 阈值是用户画的底线：数量 <= min_stock 且未归档未删除的物品。
    # 归档物品不喊——退役的东西不需要补货。
    low_base = (
        Item.deleted_at.is_(None),
        Item.archived_at.is_(None),
        Item.min_stock.is_not(None),
        Item.quantity <= Item.min_stock,
    )
    low_stock = db.execute(
        select(func.count(Item.id)).where(Item.family_id == fid, *low_base)
    ).scalar() or 0
    # 明细跟着计数走：告警条说「库存不足」，首页就能看到具体是哪几件、
    # 差多少——与临期批次卡同一模式，一次请求全给。
    low_rows = list(
        db.execute(
            select(Item)
            .where(Item.family_id == fid, *low_base)
            .order_by(Item.quantity - Item.min_stock)
            .limit(8)
        ).scalars()
    )
    low_stock_list = [
        {
            "id": it.id,
            "name": it.name,
            "code": it.code,
            "quantity": it.quantity,
            "min_stock": it.min_stock,
            "unit": it.unit,
        }
        for it in low_rows
    ]

    # --- 批次保质期 -------------------------------------------------------
    # Counted here rather than in a separate endpoint so the dashboard is still
    # one request. Deleted items are excluded through the join: a batch of a
    # thrown-away item must not keep nagging from the home screen.
    batch_base = (
        (ItemBatch.family_id == fid)
        & (ItemBatch.deleted_at.is_(None))
        & (Item.deleted_at.is_(None))
    )
    expired_batches = db.execute(
        select(func.count(ItemBatch.id))
        .select_from(ItemBatch)
        .join(Item, Item.id == ItemBatch.item_id)
        .where(batch_base, ItemBatch.expires_on.is_not(None), ItemBatch.expires_on < today)
    ).scalar() or 0
    expiring_batches = db.execute(
        select(func.count(ItemBatch.id))
        .select_from(ItemBatch)
        .join(Item, Item.id == ItemBatch.item_id)
        .where(
            batch_base,
            ItemBatch.expires_on.is_not(None),
            ItemBatch.expires_on >= today,
            ItemBatch.expires_on <= today + timedelta(days=EXPIRING_DAYS),
        )
    ).scalar() or 0
    expiring_rows = db.execute(
        select(ItemBatch, Item)
        .join(Item, Item.id == ItemBatch.item_id)
        .where(
            batch_base,
            ItemBatch.expires_on.is_not(None),
            ItemBatch.expires_on <= today + timedelta(days=EXPIRING_DAYS),
        )
        .order_by(ItemBatch.expires_on, ItemBatch.created_at)
        .limit(6)
    ).all()
    expiring_list = [
        {
            **batch_out(b),
            "item_name": item.name,
            "item_code": item.code,
            "item_unit": item.unit,
        }
        for b, item in expiring_rows
    ]

    recent_items = list(
        db.execute(
            select(Item).where(base, Item.archived_at.is_(None))
            .order_by(Item.created_at.desc()).limit(6)
        ).scalars()
    )
    recent_events = list(
        db.execute(
            select(ItemEvent).where(ItemEvent.family_id == fid)
            .order_by(ItemEvent.created_at.desc()).limit(8)
        ).scalars()
    )
    unread = db.execute(
        select(func.count(Notification.id)).where(
            Notification.family_id == fid, Notification.read_at.is_(None)
        )
    ).scalar() or 0

    # 6 month purchase trend
    trend = []
    for i in range(5, -1, -1):
        month_start = (datetime.utcnow().replace(day=1) - timedelta(days=30 * i)).replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
        next_month = (month_start + timedelta(days=32)).replace(day=1)
        amount = db.execute(
            select(func.coalesce(func.sum(Item.purchase_price), 0)).where(
                base,
                Item.purchase_date.is_not(None),
                Item.purchase_date >= month_start.date(),
                Item.purchase_date < next_month.date(),
            )
        ).scalar()
        count = db.execute(
            select(func.count(Item.id)).where(
                base,
                Item.purchase_date.is_not(None),
                Item.purchase_date >= month_start.date(),
                Item.purchase_date < next_month.date(),
            )
        ).scalar()
        trend.append(
            {"month": month_start.strftime("%Y-%m"), "amount": float(amount or 0), "count": count or 0}
        )

    storage_used = db.execute(
        select(func.coalesce(func.sum(Attachment.size_bytes), 0)).where(
            Attachment.family_id == fid, Attachment.deleted_at.is_(None)
        )
    ).scalar() or 0

    return {
        "total_items": total,
        "archived_items": archived,
        "total_value": float(total_value or 0),
        "by_status": by_status,
        "by_category": [{"name": n, "color": c, "count": k} for n, c, k in cat_rows],
        "by_location": [{"name": n, "count": k} for n, k in loc_rows],
        "warranty_expiring": warranty_expiring,
        "warranty_expired": warranty_expired,
        "overdue_tasks": overdue_tasks,
        "upcoming_tasks": upcoming_tasks,
        "open_loans": open_loans,
        "overdue_loans": overdue_loans,
        "low_stock": low_stock,
        "low_stock_list": low_stock_list,
        "unread_notifications": unread,
        "storage_bytes": int(storage_used),
        "expiring_batches": expiring_batches,
        "expired_batches": expired_batches,
        "expiring_list": expiring_list,
        "recent_items": [
            {
                "id": i.id, "name": i.name, "code": i.code, "status": i.status,
                "created_at": i.created_at.isoformat() + "Z",
                "cover": f"/api/v1/attachments/{i.cover_attachment_id}/raw?variant=thumb"
                if i.cover_attachment_id else None,
            }
            for i in recent_items
        ],
        "recent_events": [
            {
                "id": e.id, "item_id": e.item_id, "event_type": e.event_type,
                "summary": e.summary, "actor_name": e.actor_name,
                "created_at": e.created_at.isoformat() + "Z",
            }
            for e in recent_events
        ],
        "purchase_trend": trend,
    }


# --- audit ------------------------------------------------------------------
@router.get("/audit")
def list_audit(
    action: str | None = None,
    entity_type: str | None = None,
    actor_id: str | None = None,
    page_no: int = Query(default=1, ge=1, alias="page"),
    page_size: int = Query(default=30, ge=1, le=200),
    principal: Principal = Depends(require(SYSTEM_AUDIT)),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(AuditLog).where(AuditLog.family_id == principal.family_id)
    if action:
        stmt = stmt.where(AuditLog.action.like(f"{action}%"))
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if actor_id:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = list(
        db.execute(
            stmt.order_by(AuditLog.created_at.desc())
            .offset((page_no - 1) * page_size)
            .limit(page_size)
        ).scalars()
    )
    return page([audit_out(a) for a in rows], total, page_no, page_size)


# --- notifications ----------------------------------------------------------
@router.get("/notifications")
def list_notifications(
    unread_only: bool = False,
    limit: int = Query(default=50, ge=1, le=200),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Notification).where(Notification.family_id == principal.family_id)
    stmt = stmt.where(
        (Notification.user_id.is_(None)) | (Notification.user_id == principal.user_id)
    )
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    rows = list(db.execute(stmt.order_by(Notification.created_at.desc()).limit(limit)).scalars())
    unread = db.execute(
        select(func.count(Notification.id)).where(
            Notification.family_id == principal.family_id,
            Notification.read_at.is_(None),
            (Notification.user_id.is_(None)) | (Notification.user_id == principal.user_id),
        )
    ).scalar() or 0
    return {"items": [notification_out(n) for n in rows], "unread": unread}


@router.post("/notifications/read")
def mark_notifications(
    payload: NotificationMarkIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Notification).where(
        Notification.family_id == principal.family_id,
        Notification.read_at.is_(None),
        # Same visibility rule as the list: never mark another member's
        # personal reminder as read on their behalf.
        (Notification.user_id.is_(None)) | (Notification.user_id == principal.user_id),
    )
    if not payload.all:
        if not payload.ids:
            return {"updated": 0}
        stmt = stmt.where(Notification.id.in_(payload.ids))
    rows = list(db.execute(stmt).scalars())
    for n in rows:
        n.read_at = utcnow()
    db.commit()
    return {"updated": len(rows)}


# --- backups ----------------------------------------------------------------
@router.get("/system/backups")
def list_backups(
    _: User = Depends(require_instance_admin), db: Session = Depends(get_db)
) -> dict:
    records = list(
        db.execute(select(BackupRecord).order_by(BackupRecord.created_at.desc()).limit(100)).scalars()
    )
    return {
        "items": [backup_out(b) for b in records],
        "on_disk": get_backup_provider().list_files()[:50],
    }


@router.post("/system/backups", status_code=201)
def create_backup(
    payload: BackupCreateIn,
    request: Request,
    admin: User = Depends(require_instance_admin),
    db: Session = Depends(get_db),
) -> dict:
    info = get_backup_provider().create(
        include_files=payload.include_files,
        note=payload.note or "手动备份",
        created_by=admin.display_name,
    )
    record_row = BackupRecord(
        family_id=None,
        filename=info["filename"],
        relative_path=info["relative_path"],
        size_bytes=info["size_bytes"],
        sha256=info["sha256"],
        kind="manual",
        note=info["note"],
        includes_files=info["includes_files"],
        created_by=admin.id,
    )
    db.add(record_row)
    record(db, None, "system.backup", entity_type="backup", entity_id=record_row.id,
           summary=f"创建实例备份：{info['filename']}", request=request,
           actor_id=admin.id, actor_name=admin.display_name)
    # 先备份再清理：新备份刚落记录，永远在保留窗口内
    pruned = prune_old_backups(db)
    db.commit()
    return {"backup": backup_out(record_row), "pruned": pruned}


@router.get("/system/backups/{filename}/download")
def download_backup(
    filename: str, _: User = Depends(require_instance_admin)
) -> Response:
    try:
        path = get_backup_provider().path_of(filename)
    except (FileNotFoundError, ValueError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "备份文件不存在")
    return FileResponse(path, media_type="application/zip", filename=path.name)


@router.post("/system/backups/restore")
def restore_backup(
    payload: RestoreIn,
    request: Request,
    admin: User = Depends(require_instance_admin),
    db: Session = Depends(get_db),
) -> dict:
    if payload.confirm != "RESTORE":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, '请输入 RESTORE 以确认覆盖当前数据')
    try:
        pre = get_backup_provider().create(
            include_files=True, note="恢复前自动备份", created_by=admin.display_name
        )
    except Exception:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "恢复前安全备份失败，未覆盖任何数据；请检查磁盘、存储配置和备份权限")
    # 恢复要替换数据库文件，而 Windows 不允许删除（甚至替换）一个还有句柄
    # 打开的文件。`engine.dispose()` 只回收连接池里的空闲连接，**这个请求自己**
    # 通过 `get_db` 拿到的那个连接仍然开着，-wal 就锁在它手里。所以先把本请求的
    # 会话关掉，让文件句柄归零；下面的 restore 再 dispose 连接池。
    db.close()
    try:
        result = restore_from_zip(payload.filename)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "备份文件不存在")
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "归档未通过安全或数据库完整性校验，未执行恢复")
    except Exception:
        raise HTTPException(status.HTTP_409_CONFLICT, "恢复未完成，请保留恢复前备份并离线检查服务日志")
    return {
        "ok": True,
        "restored": result,
        "pre_restore_backup": pre["filename"] if pre else None,
        "message": "数据已恢复，请重启服务以重新加载数据库连接。",
    }


@router.delete("/system/backups/{filename}")
def delete_backup(
    filename: str,
    request: Request,
    admin: User = Depends(require_instance_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Remove a backup file and its record.

    A missing file must not block the record from going away. Users clean the
    backup directory by hand, restore onto a fresh box, or move the data dir —
    all of which leave rows pointing at files that no longer exist. Returning
    404 there would pin an undeletable entry to the list forever.
    """
    file_removed = False
    try:
        path = get_backup_provider().path_of(filename)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "非法的备份文件名")
    except FileNotFoundError:
        path = None
    if path is not None:
        try:
            path.unlink(missing_ok=True)
            file_removed = True
        except OSError as exc:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"文件删不掉：{exc.strerror or exc}。检查备份目录的权限后再试",
            )
    rows = list(
        db.execute(select(BackupRecord).where(BackupRecord.filename == filename)).scalars()
    )
    if not rows and not file_removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "备份不存在")
    for row in rows:
        db.delete(row)
    record(db, None, "system.backup.delete", entity_type="backup",
           summary=f"删除实例备份：{filename}", request=request,
           actor_id=admin.id, actor_name=admin.display_name)
    db.commit()
    return {"ok": True, "file_removed": file_removed, "record_removed": bool(rows)}


# --- export -----------------------------------------------------------------
@router.get("/system/export.json")
def export_json(
    principal: Principal = Depends(require(SYSTEM_EXPORT)), db: Session = Depends(get_db)
) -> Response:
    fid = principal.family_id
    family = db.get(Family, fid)
    items = list(db.execute(select(Item).where(Item.family_id == fid)).scalars())
    cats = list(db.execute(select(Category).where(Category.family_id == fid)).scalars())
    locs = list(db.execute(select(Location).where(Location.family_id == fid)).scalars())
    tasks = list(db.execute(select(MaintenanceTask).where(MaintenanceTask.family_id == fid)).scalars())
    members = db.execute(
        select(Membership, User).join(User, User.id == Membership.user_id).where(
            Membership.family_id == fid
        )
    ).all()
    payload = {
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "app": settings.app_name,
        "version": settings.app_version,
        "family": {"id": family.id, "name": family.name, "invite_code": family.invite_code},
        "members": [
            {"email": u.email, "display_name": u.display_name, "role": m.role}
            for m, u in members
        ],
        "categories": [
            {"id": c.id, "name": c.name, "parent_id": c.parent_id, "icon": c.icon, "color": c.color}
            for c in cats
        ],
        "locations": [
            {"id": l.id, "name": l.name, "parent_id": l.parent_id, "kind": l.kind}
            for l in locs
        ],
        "items": [
            {
                "code": i.code, "name": i.name, "description": i.description,
                "category_id": i.category_id, "location_id": i.location_id,
                "quantity": i.quantity, "unit": i.unit, "status": i.status,
                "condition": i.condition, "brand": i.brand, "model": i.model,
                "serial_number": i.serial_number, "barcode": i.barcode,
                "purchase_date": i.purchase_date.isoformat() if i.purchase_date else None,
                "purchase_price": i.purchase_price,
                "warranty_until": i.warranty_until.isoformat() if i.warranty_until else None,
                "tags": i.tags, "custom_fields": i.custom_fields,
                "created_at": i.created_at.isoformat() + "Z",
            }
            for i in items
        ],
        "maintenance": [
            {
                "item_id": t.item_id, "title": t.title, "task_type": t.task_type,
                "interval_days": t.interval_days, "status": t.status,
                "next_due_at": t.next_due_at.isoformat() + "Z" if t.next_due_at else None,
            }
            for t in tasks
        ],
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return Response(
        content=body,
        media_type="application/json; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="homeledger-export.json"'
        },
    )
