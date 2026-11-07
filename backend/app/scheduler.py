"""Background scheduler.

Runs inside the API process for gateway/local deployments. For multi-replica
cloud deployments set HOMELEDGER_ENABLE_SCHEDULER=false and run
`python -m app.scheduler` as a single dedicated worker instead.

Every tick is idempotent: notifications carry a dedupe key tied to the task and
the due date, so restarts and double ticks do not spam the family.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import select

from .db import provider
from .models import BackupRecord, Item, ItemBatch, Loan, MaintenanceTask, Notification, User
from .providers.notification import dispatch
from .serializers import EXPIRING_DAYS

log = logging.getLogger("homeledger.scheduler")


def _already_sent(db, family_id: str, key: str) -> bool:
    stmt = select(Notification.id).where(
        Notification.family_id == family_id, Notification.dedupe_key == key
    )
    return db.execute(stmt).first() is not None


def tick(now: datetime | None = None) -> dict:
    """One scan pass. Returns counters, safe to call from tests."""
    now = now or datetime.utcnow()
    stats = {"maintenance": 0, "warranty": 0, "batch": 0, "loan": 0, "low_stock": 0, "backup": 0}

    with provider.transaction() as db:
        # --- due maintenance -------------------------------------------------
        tasks = db.execute(
            select(MaintenanceTask).where(
                MaintenanceTask.status == "pending",
                MaintenanceTask.deleted_at.is_(None),
                MaintenanceTask.next_due_at.is_not(None),
                MaintenanceTask.next_due_at <= now,
            )
        ).scalars().all()
        for t in tasks:
            key = f"maint:{t.id}:{t.next_due_at.date().isoformat()}"
            if _already_sent(db, t.family_id, key):
                continue
            item = db.get(Item, t.item_id)
            title = f"维护到期：{item.name if item else '物品'}"
            body = f"{t.title} 应于 {t.next_due_at.date().isoformat()} 处理。"
            if t.assignee_id:
                user = db.get(User, t.assignee_id)
                dispatch(
                    db,
                    family_id=t.family_id,
                    title=title,
                    body=body,
                    type="maintenance_due",
                    entity_type="maintenance",
                    entity_id=t.id,
                    dedupe_key=key,
                    user_id=t.assignee_id,
                    email_to=user.email if user else None,
                )
            else:
                dispatch(
                    db,
                    family_id=t.family_id,
                    title=title,
                    body=body,
                    type="maintenance_due",
                    entity_type="maintenance",
                    entity_id=t.id,
                    dedupe_key=key,
                )
            stats["maintenance"] += 1

        # --- warranty expiring within 30 days --------------------------------
        horizon = (now + timedelta(days=30)).date()
        items = db.execute(
            select(Item).where(
                Item.deleted_at.is_(None),
                Item.warranty_until.is_not(None),
                Item.warranty_until <= horizon,
            )
        ).scalars().all()
        for it in items:
            if not it.warranty_until:
                continue
            state = "已过保" if it.warranty_until < now.date() else "即将过保"
            key = f"warranty:{it.id}:{it.warranty_until.isoformat()}"
            if _already_sent(db, it.family_id, key):
                continue
            dispatch(
                db,
                family_id=it.family_id,
                title=f"{state}：{it.name}",
                body=f"{it.name}（{it.code}）保修截止 {it.warranty_until.isoformat()}。",
                type="warranty",
                entity_type="item",
                entity_id=it.id,
                dedupe_key=key,
            )
            stats["warranty"] += 1

        # --- 批次临期 / 过期 -------------------------------------------------
        # Dedupe key carries the expiry date, not the day the reminder fired:
        # a batch is one event ("this milk goes off on the 3rd"), so it should
        # be announced once, and announced again only if someone corrects the
        # date. A date-keyed reminder that fired daily would train people to
        # ignore it.
        horizon_date = (now + timedelta(days=EXPIRING_DAYS)).date()
        batches = db.execute(
            select(ItemBatch).where(
                ItemBatch.deleted_at.is_(None),
                ItemBatch.expires_on.is_not(None),
                ItemBatch.expires_on <= horizon_date,
            )
        ).scalars().all()
        for b in batches:
            if not b.expires_on:
                continue
            item = db.get(Item, b.item_id)
            if not item or item.deleted_at:
                continue
            state = "已过期" if b.expires_on < now.date() else "即将过期"
            label = b.batch_no or "未命名批次"
            key = f"batch:{b.id}:{b.expires_on.isoformat()}"
            if _already_sent(db, b.family_id, key):
                continue
            dispatch(
                db,
                family_id=b.family_id,
                title=f"{state}：{item.name}",
                body=(
                    f"{item.name}（{item.code}）批次「{label}」"
                    f"{'已于' if state == '已过期' else '将于'} "
                    f"{b.expires_on.isoformat()} 到期。"
                ),
                type="batch_expiring",
                # entity 指向物品本身：点通知直达物品详情（批次页藏在详情 tab 里）
                entity_type="item",
                entity_id=b.item_id,
                dedupe_key=key,
            )
            stats["batch"] += 1

        # --- overdue loans ---------------------------------------------------
        loans = db.execute(
            select(Loan).where(Loan.returned_at.is_(None), Loan.due_at.is_not(None), Loan.due_at < now)
        ).scalars().all()
        for l in loans:
            key = f"loan:{l.id}:{now.date().isoformat()}"
            if _already_sent(db, l.family_id, key):
                continue
            item = db.get(Item, l.item_id)
            dispatch(
                db,
                family_id=l.family_id,
                title=f"借出逾期：{item.name if item else ''}",
                body=f"{l.borrower_name} 借用的物品已超过归还时间。",
                type="loan_overdue",
                # 同上：点「借出逾期」直达那件物品，而不是一个没有页面的 loan 实体
                entity_type="item",
                entity_id=l.item_id,
                dedupe_key=key,
            )
            stats["loan"] += 1

        # --- 低库存 ---------------------------------------------------------
        # 数量 <= min_stock 的在库物品。key 带日期：跌破期间每天最多喊一次，
        # 数量回升再跌破才重新提醒——与借出逾期同一口径。
        # 已知边界：同步模式的数量是密文，服务器算不了这一段；该提醒只在
        # 远程（网关）模式生效。首页的低库存计数在客户端算，不受影响。
        low_items = db.execute(
            select(Item).where(
                Item.deleted_at.is_(None),
                Item.archived_at.is_(None),
                Item.min_stock.is_not(None),
                Item.quantity <= Item.min_stock,
            )
        ).scalars().all()
        for it in low_items:
            key = f"lowstock:{it.id}:{now.date().isoformat()}"
            if _already_sent(db, it.family_id, key):
                continue
            dispatch(
                db,
                family_id=it.family_id,
                title=f"库存不足：{it.name}",
                body=f"{it.name}（{it.code}）当前 {it.quantity:g} {it.unit}，低于阈值 {it.min_stock:g}。",
                type="low_stock",
                entity_type="item",
                entity_id=it.id,
                dedupe_key=key,
            )
            stats["low_stock"] += 1

    return stats


def maybe_auto_backup() -> bool:
    from .config import settings
    from .providers.backup import get_backup_provider, prune_old_backups

    if settings.auto_backup_hours <= 0:
        return False
    with provider.session() as db:
        last = db.execute(
            select(BackupRecord).where(BackupRecord.kind == "auto").order_by(
                BackupRecord.created_at.desc()
            )
        ).scalars().first()
        if last and (datetime.utcnow() - last.created_at) < timedelta(hours=settings.auto_backup_hours):
            return False
    info = get_backup_provider().create(
        include_files=True, note="自动备份", created_by="system"
    )
    with provider.transaction() as db:
        db.add(
            BackupRecord(
                filename=info["filename"],
                relative_path=info["relative_path"],
                size_bytes=info["size_bytes"],
                sha256=info["sha256"],
                kind="auto",
                note=info["note"],
                includes_files=info["includes_files"],
                created_by="system",
            )
        )
        # 自动备份同样受保留策略约束——它才是无限增长的主力
        pruned = prune_old_backups(db)
    log.info("auto backup created: %s (pruned %d)", info["filename"], len(pruned))
    return True


async def run_forever(interval: int = 60) -> None:
    log.info("scheduler started (interval=%ss)", interval)
    while True:
        try:
            await asyncio.to_thread(tick)
            await asyncio.to_thread(maybe_auto_backup)
        except Exception as exc:  # keep the loop alive
            log.warning("scheduler tick failed: %s", exc)
        await asyncio.sleep(interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(tick())
