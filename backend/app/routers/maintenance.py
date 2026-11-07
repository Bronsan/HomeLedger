"""Maintenance scheduling and completion.

A recurring task never spawns a new row on completion — it advances
`next_due_at`. That keeps history in `item_events` (where it belongs) and keeps
the task list readable. One-off tasks flip to `done`.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Query, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import add_event, record
from ..db import get_db
from ..deps import require
from ..models import Attachment, Item, MaintenanceTask, User, utcnow
from ..permissions import (
    MAINT_COMPLETE,
    MAINT_CREATE,
    MAINT_UPDATE,
    MAINT_VIEW,
    Principal,
)
from ..schemas import MaintenanceCompleteIn, MaintenanceCreateIn, MaintenanceUpdateIn
from ..serializers import task_out

router = APIRouter(tags=["maintenance"])


def _serialize(db: Session, tasks: list[MaintenanceTask], family_id: str) -> list[dict]:
    items = {
        i.id: i
        for i in db.execute(
            select(Item).where(Item.id.in_([t.item_id for t in tasks] or [""]))
        ).scalars()
    }
    users = {
        u.id: u
        for u in db.execute(
            select(User).where(
                User.id.in_([t.assignee_id for t in tasks if t.assignee_id] or [""])
            )
        ).scalars()
    }
    return [task_out(t, items.get(t.item_id), users.get(t.assignee_id)) for t in tasks]


@router.get("/maintenance")
def list_tasks(
    # alias="status"：前端与本地 handler 都发 `status`。曾经没有 alias，
    # 远程模式下待办/已完成筛选被静默忽略——本地好、远程坏的那一类漂移。
    status_: str | None = Query(default=None, alias="status"),
    item_id: str | None = None,
    assignee_id: str | None = None,
    overdue: bool = False,
    upcoming_days: int | None = None,
    principal: Principal = Depends(require(MAINT_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(MaintenanceTask).where(
        MaintenanceTask.family_id == principal.family_id, MaintenanceTask.deleted_at.is_(None)
    )
    if status_:
        stmt = stmt.where(MaintenanceTask.status == status_)
    if item_id:
        stmt = stmt.where(MaintenanceTask.item_id == item_id)
    if assignee_id:
        stmt = stmt.where(MaintenanceTask.assignee_id == assignee_id)
    now = datetime.utcnow()
    if overdue:
        stmt = stmt.where(
            MaintenanceTask.status == "pending",
            MaintenanceTask.next_due_at.is_not(None),
            MaintenanceTask.next_due_at < now,
        )
    if upcoming_days is not None:
        stmt = stmt.where(
            MaintenanceTask.status == "pending",
            MaintenanceTask.next_due_at.is_not(None),
            MaintenanceTask.next_due_at <= now + timedelta(days=upcoming_days),
        )
    tasks = list(
        db.execute(
            stmt.order_by(
                MaintenanceTask.status,
                MaintenanceTask.next_due_at.is_(None),
                MaintenanceTask.next_due_at,
            )
        ).scalars()
    )
    counts = dict(
        db.execute(
            select(MaintenanceTask.status, func.count(MaintenanceTask.id))
            .where(
                MaintenanceTask.family_id == principal.family_id,
                MaintenanceTask.deleted_at.is_(None),
            )
            .group_by(MaintenanceTask.status)
        ).all()
    )
    return {"items": _serialize(db, tasks, principal.family_id), "counts": counts}


@router.post("/maintenance", status_code=201)
def create_task(
    payload: MaintenanceCreateIn,
    request: Request,
    principal: Principal = Depends(require(MAINT_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    item = db.get(Item, payload.item_id)
    if not item or item.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")
    next_due = payload.due_at or utcnow()
    # 与 complete 同理：ISO 串可能带 Z（aware），库里统一 naive UTC
    if next_due.tzinfo:
        next_due = next_due.replace(tzinfo=None)
    task = MaintenanceTask(
        family_id=principal.family_id,
        created_by=principal.user_id,
        next_due_at=next_due,
        **payload.model_dump(exclude={"due_at"}),
    )
    db.add(task)
    db.flush()
    add_event(
        db, principal, item, "maintenance_created",
        f"创建维护任务：{task.title}",
        {"due_at": next_due.isoformat() if next_due else None},
    )
    record(db, principal, "maintenance.create", entity_type="maintenance", entity_id=task.id,
           summary=f"创建维护任务：{task.title}", request=request)
    db.commit()
    return {"task": _serialize(db, [task], principal.family_id)[0]}


@router.patch("/maintenance/{task_id}")
def update_task(
    task_id: str,
    payload: MaintenanceUpdateIn,
    request: Request,
    principal: Principal = Depends(require(MAINT_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    task = db.get(MaintenanceTask, task_id)
    if not task or task.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        if key == "due_at":
            value = value.replace(tzinfo=None) if value and value.tzinfo else value
            task.due_at = value
            task.next_due_at = value
        else:
            setattr(task, key, value)
    task.updated_at = utcnow()
    record(db, principal, "maintenance.update", entity_type="maintenance", entity_id=task.id,
           summary=f"修改维护任务：{task.title}", request=request)
    db.commit()
    return {"task": _serialize(db, [task], principal.family_id)[0]}


@router.post("/maintenance/{task_id}/complete")
def complete_task(
    task_id: str,
    payload: MaintenanceCompleteIn,
    request: Request,
    principal: Principal = Depends(require(MAINT_COMPLETE)),
    db: Session = Depends(get_db),
) -> dict:
    task = db.get(MaintenanceTask, task_id)
    if not task or task.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    completed_at = payload.completed_at or utcnow()
    # payload 里的 ISO 串可能带 Z（aware），库里的 naive UTC 无法与之比较——归一
    completed_at = completed_at.replace(tzinfo=None)
    task.last_completed_at = completed_at
    task.completed_at = completed_at
    task.completed_by = principal.user_id
    if payload.notes:
        task.notes = (task.notes + "\n" + payload.notes).strip()

    if task.interval_days:
        while task.next_due_at is None or task.next_due_at <= completed_at:
            base = task.next_due_at or completed_at
            task.next_due_at = base + timedelta(days=task.interval_days)
        task.status = "pending"
    else:
        task.status = "done"
        task.next_due_at = None

    item = db.get(Item, task.item_id)
    if item:
        add_event(
            db, principal, item, "maintenance_done",
            f"完成维护：{task.title}" + (f"（费用 ¥{payload.cost}）" if payload.cost else ""),
            {"task_id": task.id, "cost": payload.cost},
        )
        if payload.attachment_ids:
            for aid in payload.attachment_ids:
                att = db.get(Attachment, aid)
                if att and att.family_id == principal.family_id:
                    att.maintenance_id = task.id

    record(db, principal, "maintenance.complete", entity_type="maintenance", entity_id=task.id,
           summary=f"完成维护任务：{task.title}", request=request)
    db.commit()
    return {"task": _serialize(db, [task], principal.family_id)[0]}


@router.post("/maintenance/{task_id}/skip")
def skip_task(
    task_id: str,
    request: Request,
    principal: Principal = Depends(require(MAINT_COMPLETE)),
    db: Session = Depends(get_db),
) -> dict:
    """跳过一次：把到期日顺延一个周期，但**不**记完成。

    与 complete 的差别在语义而不是数值：跳过不写 last_completed_at /
    completed_by——「这次没换滤芯」和「这次换了滤芯」在下次该何时维护
    上的推算完全不同（跳过是按原周期原基准顺延，完成是按完成时间起算）。
    只对周期任务有意义；一次性任务没有「下一次」可跳，拒绝。
    """
    task = db.get(MaintenanceTask, task_id)
    if not task or task.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    if not task.interval_days:
        raise HTTPException(status.HTTP_409_CONFLICT, "一次性任务没有周期可跳过，直接完成或删除即可")
    task.next_due_at = (task.next_due_at or utcnow()) + timedelta(days=task.interval_days)
    # 拖太久一次顺延还落在过去的话，继续往前推——与 complete 的顺延循环一致
    while task.next_due_at <= utcnow():
        task.next_due_at = task.next_due_at + timedelta(days=task.interval_days)
    task.status = "pending"
    item = db.get(Item, task.item_id)
    if item:
        add_event(db, principal, item, "maintenance_skipped", f"跳过一次：{task.title}")
    record(db, principal, "maintenance.skip", entity_type="maintenance", entity_id=task.id,
           summary=f"跳过一次维护任务：{task.title}", request=request)
    db.commit()
    return {"task": _serialize(db, [task], principal.family_id)[0]}


def _ics_escape(text: str) -> str:
    """RFC 5545 转义：逗号/分号/反斜杠/换行。"""
    out = text.replace(chr(92), chr(92) * 2)
    out = out.replace(";", chr(92) + ";")
    out = out.replace(",", chr(92) + ",")
    out = out.replace(chr(10) + chr(13), chr(92) + "n")
    out = out.replace(chr(10), chr(92) + "n")
    out = out.replace(chr(13), "")
    return out

@router.get("/maintenance/calendar.ics")
def maintenance_calendar_ics(
    principal: Principal = Depends(require(MAINT_VIEW)),
    db: Session = Depends(get_db),
) -> Response:
    """把待办维护导出成 .ics，导入系统日历后由日历负责提醒。

    走文件导入而不是写接口：浏览器/桌面端没有日历 API，安卓的原生日历
    写入需要平台插件，.ics 是三端都能吃的中转格式。UID 稳定（task id），
    重复导入不会堆积重复事件。"""
    tasks = list(
        db.execute(
            select(MaintenanceTask).where(
                MaintenanceTask.family_id == principal.family_id,
                MaintenanceTask.status == "pending",
                MaintenanceTask.deleted_at.is_(None),
            )
        ).scalars()
    )
    items = {
        i.id: i
        for i in db.execute(
            select(Item).where(
                Item.id.in_([t.item_id for t in tasks] or [""]),
            )
        ).scalars()
    }

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//HomeLedger//Maintenance//CN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:HomeLedger 维护",
    ]
    # 旧版本建的任务可能没有 next_due_at。日历文件不能静默漏掉它们：
    # 按导出次日生成一条全天提醒，并在描述里说明这是兜底日期。
    fallback_due = (utcnow() + timedelta(days=1)).date()
    for t in tasks:
        item = items.get(t.item_id)
        assumed = t.next_due_at is None
        due = fallback_due if assumed else t.next_due_at
        start = due.strftime("%Y%m%d")
        end = (due + timedelta(days=1)).strftime("%Y%m%d")
        summary = f"维护：{item.name} · {t.title}" if item else f"维护：{t.title}"
        desc = " ".join(
            part
            for part in (
                f"物品编号 {item.code}" if item else "",
                "此任务未设置到期日；已按导出次日生成提醒。" if assumed else "",
            )
            if part
        )
        lines += [
            "BEGIN:VEVENT",
            f"UID:homeledger-maintenance-{t.id}@homeledger",
            f"DTSTART;VALUE=DATE:{start}",
            f"DTEND;VALUE=DATE:{end}",
            f"SUMMARY:{_ics_escape(summary)}",
            f"DESCRIPTION:{_ics_escape(desc)}",
            "TRANSP:TRANSPARENT",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            f"DESCRIPTION:{_ics_escape(summary)}",
            "TRIGGER:-PT9H",
            "END:VALARM",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    # RFC 5545 要求 CRLF
    body = (chr(13) + chr(10)).join(lines) + chr(13) + chr(10)
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="homeledger-maintenance.ics"',
            "Cache-Control": "no-store",
        },
    )


@router.delete("/maintenance/{task_id}")
def delete_task(
    task_id: str,
    request: Request,
    principal: Principal = Depends(require(MAINT_UPDATE)),
    db: Session = Depends(get_db),
) -> dict:
    task = db.get(MaintenanceTask, task_id)
    if not task or task.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    task.deleted_at = utcnow()
    record(db, principal, "maintenance.delete", entity_type="maintenance", entity_id=task.id,
           summary=f"删除维护任务：{task.title}", request=request)
    db.commit()
    return {"ok": True}
