"""Maintenance tasks and the reminder scheduler (including its dedupe contract)."""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select

from app.db import provider
from app.models import Notification
from app.scheduler import tick


def _task(family, item, **overrides) -> dict:
    payload = {"item_id": item["id"], "title": "更换滤芯", "task_type": "routine"}
    payload.update(overrides)
    r = family.post("/maintenance", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["task"]


def test_task_lifecycle_and_overdue_flag(family):
    item = family.create_item(name="净水器")
    past = (datetime.utcnow() - timedelta(days=3)).isoformat()
    task = _task(family, item, due_at=past, priority="high")

    assert task["overdue"] is True
    assert task["due_in_days"] < 0

    listing = family.get("/maintenance", params={"filter": "overdue"}).json()
    assert any(t["id"] == task["id"] for t in listing["items"])

    done = family.post(
        f"/maintenance/{task['id']}/complete",
        json={"cost": 89.0, "notes": "换了 PP 棉"},
    ).json()["task"]
    assert done["status"] == "done"
    assert done["last_completed_at"]
    assert "换了 PP 棉" in done["notes"]


def test_recurring_task_rolls_forward_and_stays_pending(family):
    item = family.create_item(name="空气净化器")
    task = _task(family, item, interval_days=30, due_at=(datetime.utcnow() - timedelta(days=1)).isoformat())

    done = family.post(f"/maintenance/{task['id']}/complete", json={}).json()["task"]
    assert done["status"] == "pending"
    assert done["next_due_at"] > done["last_completed_at"]
    assert done["overdue"] is False


def test_completing_a_task_appends_an_item_event(family):
    item = family.create_item(name="扫地机器人")
    task = _task(family, item)
    family.post(f"/maintenance/{task['id']}/complete", json={"cost": 0})

    events = family.get(f"/items/{item['id']}/events").json()["items"]
    assert any(e["event_type"] == "maintenance_done" for e in events)


def test_maintenance_counts_endpoint(family):
    item = family.create_item(name="热水器")
    _task(family, item, due_at=(datetime.utcnow() - timedelta(days=2)).isoformat())
    _task(family, item, title="明天到期", due_at=(datetime.utcnow() + timedelta(days=1)).isoformat())

    listing = family.get("/maintenance").json()
    assert listing["counts"]["pending"] >= 2
    overdue_only = family.get("/maintenance", params={"overdue": True}).json()["items"]
    assert [t["title"] for t in overdue_only] == ["更换滤芯"]
    soon = family.get("/maintenance", params={"upcoming_days": 2}).json()["items"]
    assert any(t["title"] == "明天到期" for t in soon)


def test_maintenance_skip_defers_without_completing(family):
    """跳过一次：到期日顺延一个周期，但不写完成时间——
    「没换滤芯」和「换了滤芯」对下次维护的推算是两回事。"""
    item = family.create_item(name="净水器")
    due = (datetime.utcnow() - timedelta(days=2)).isoformat()
    task = _task(family, item, interval_days=30, due_at=due)

    r = family.post(f"/maintenance/{task['id']}/skip", json={})
    assert r.status_code == 200, r.text
    t = r.json()["task"]
    assert t["status"] == "pending"
    assert t["last_completed_at"] is None
    assert t["next_due_at"] > due
    assert t["next_due_at"] > datetime.utcnow().isoformat()

    # 一次性任务没有周期可跳
    once = _task(family, item, interval_days=None)
    assert family.post(f"/maintenance/{once['id']}/skip", json={}).status_code == 409


def test_maintenance_status_filter_accepts_status_param(family):
    """回归：列表参数曾经叫 status_（无 alias），而前端和本地 handler 都发
    `status`——远程模式下待办/已完成筛选被静默忽略，本地好、远程坏。"""
    item = family.create_item(name="净水器")
    task = _task(family, item)

    pending = family.get("/maintenance", params={"status": "pending"}).json()["items"]
    assert any(t["id"] == task["id"] for t in pending)
    done = family.get("/maintenance", params={"status": "done"}).json()["items"]
    assert all(t["id"] != task["id"] for t in done)


def test_scheduler_notifies_once_per_due_date(family):
    item = family.create_item(name="洗碗机")
    task = _task(family, item, due_at=(datetime.utcnow() - timedelta(hours=2)).isoformat())

    first = tick()
    assert first["maintenance"] >= 1

    notes = family.get("/notifications").json()["items"]
    mine = [n for n in notes if n["entity_id"] == task["id"]]
    assert len(mine) == 1
    assert mine[0]["type"] == "maintenance_due"

    # A restart or a double tick must not spam the household.
    tick()
    again = [n for n in family.get("/notifications").json()["items"] if n["entity_id"] == task["id"]]
    assert len(again) == 1


def test_scheduler_warns_about_expiring_warranty(family):
    from datetime import date

    item = family.create_item(
        name="快过保的冰箱",
        warranty_until=(date.today() + timedelta(days=12)).isoformat(),
    )
    tick()
    notes = family.get("/notifications").json()["items"]
    hit = [n for n in notes if n["entity_id"] == item["id"] and n["type"] == "warranty"]
    assert hit
    assert "即将过保" in hit[0]["title"]


def test_scheduler_flags_overdue_loan(family):
    item = family.create_item(name="借出的割草机")
    loan = family.post(
        "/loans",
        json={
            "item_id": item["id"],
            "borrower_name": "表哥",
            "due_at": (datetime.utcnow() - timedelta(days=5)).isoformat(),
        },
    ).json()["loan"]

    tick()
    notes = family.get("/notifications").json()["items"]
    hit = [n for n in notes if n["type"] == "loan_overdue"]
    assert hit
    assert "逾期" in hit[0]["title"]
    # entity 指向物品本身：点通知直达物品详情（而不是没有页面的 loan 实体）
    assert hit[0]["entity_type"] == "item"
    assert hit[0]["entity_id"] == item["id"]


def test_scheduler_flags_low_stock_once_per_day(family):
    """数量跌破阈值：当天喊一次，重复 tick 不刷屏；回升再跌破才重新提醒。"""
    item = family.create_item(name="快见底的米", quantity=1, min_stock=3)

    first = tick()
    assert first["low_stock"] >= 1
    notes = family.get("/notifications").json()["items"]
    hit = [n for n in notes if n["entity_id"] == item["id"] and n["type"] == "low_stock"]
    assert len(hit) == 1
    assert "库存不足" in hit[0]["title"]
    assert "低于阈值" in hit[0]["body"]

    # 同一天内重复 tick 不重复
    tick()
    hit = [n for n in family.get("/notifications").json()["items"] if n["type"] == "low_stock"]
    assert len(hit) == 1

    # 补货之后不再提醒
    family.patch(f"/items/{item['id']}", json={"quantity": 9})
    stats = tick()
    assert stats["low_stock"] == 0


def test_notifications_can_be_marked_read(family):
    item = family.create_item(name="通知测试")
    _task(family, item, due_at=(datetime.utcnow() - timedelta(hours=1)).isoformat())
    tick()

    unread = family.get("/notifications").json()
    assert unread["unread"] >= 1

    assert family.post("/notifications/read", json={"all": True}).status_code == 200
    assert family.get("/notifications").json()["unread"] == 0


def test_dedupe_key_is_unique_per_family(family):
    """The dedupe index must be scoped, otherwise one household silences another."""
    item = family.create_item(name="去重键")
    _task(family, item, due_at=(datetime.utcnow() - timedelta(hours=1)).isoformat())
    tick()

    with provider.session() as db:
        keys = db.execute(
            select(Notification.dedupe_key).where(Notification.family_id == family.family_id)
        ).scalars().all()
    assert len(keys) == len(set(keys))
    assert all(k.startswith(("maint:", "warranty:", "loan:")) for k in keys)
