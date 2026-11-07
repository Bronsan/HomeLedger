import assert from "node:assert/strict";
import test from "node:test";

import type { MaintenanceTask } from "../src/api/types";
import {
  calendarFallbackStart,
  maintenanceEvent,
  maintenanceTitle,
} from "../src/lib/calendar-plan";

function task(overrides: Partial<MaintenanceTask> = {}): MaintenanceTask {
  return {
    id: "task-1",
    item_id: "item-1",
    item_name: "净水器",
    item_code: "HL-000001",
    title: "更换滤芯",
    task_type: "routine",
    interval_days: 90,
    next_due_at: null,
    last_completed_at: null,
    assignee_id: null,
    assignee: null,
    status: "pending",
    priority: "normal",
    notes: "",
    estimated_cost: null,
    overdue: false,
    due_in_days: null,
    created_at: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

test("无到期日：按次日 09:00 写入，并在描述里说明兜底日期", () => {
  const now = new Date(2026, 10, 6, 23, 30);
  const fallback = calendarFallbackStart(now);
  assert.equal(fallback.getFullYear(), 2026);
  assert.equal(fallback.getMonth(), 10);
  assert.equal(fallback.getDate(), 7);
  assert.equal(fallback.getHours(), 9);

  const ev = maintenanceEvent(task({ notes: "滤芯型号 A" }), fallback);
  assert.equal(ev.startLocal, "2026-11-07 09:00");
  assert.equal(ev.startMs, fallback.getTime());
  assert.match(ev.description || "", /未设置到期日/);
  assert.match(ev.description || "", /2026-11-07 09:00/);
  assert.match(ev.description || "", /滤芯型号 A/);
  assert.equal(ev.intervalDays, 90);
});

test("有到期日：以任务日期为准，不被兜底日期覆盖", () => {
  const fallback = new Date(2026, 11, 25, 9, 0);
  const ev = maintenanceEvent(task({ next_due_at: "2026-11-10", notes: "备注" }), fallback);
  assert.equal(ev.startLocal, "2026-11-10 09:00");
  assert.equal(ev.description, "备注");
});

test("非法到期日：退回兜底日期", () => {
  const fallback = new Date(2026, 10, 7, 9, 0);
  const ev = maintenanceEvent(task({ next_due_at: "not-a-date" }), fallback);
  assert.equal(ev.startLocal, "2026-11-07 09:00");
  assert.match(ev.description || "", /未设置到期日/);
});

test("写入与撤回使用同一个事件标题", () => {
  const t = task();
  assert.equal(maintenanceTitle(t), "净水器：更换滤芯");
  assert.equal(maintenanceEvent(t).title, maintenanceTitle(t));
  assert.equal(maintenanceTitle(task({ item_name: "" })), "家庭维护：更换滤芯");
});
