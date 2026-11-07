/**
 * 维护任务 → 日历事件的纯逻辑。
 *
 * 单独放在这里，是为了让「没有到期日的任务怎么处理」可以被 Node 单测覆盖：
 * native-calendar.ts 依赖 Tauri 注入的全局对象，不适合直接进单元测试。
 */

import type { MaintenanceTask } from "../api/types";

/** 发给 Rust 的载荷，字段与 src-tauri/src/calendar.rs 的 CalendarEvent 对齐。 */
export interface CalendarEvent {
  taskId: string;
  title: string;
  description: string | null;
  startMs: number;
  durationMs: number;
  allDay: boolean;
  intervalDays: number | null;
  reminderMinutes: number;
  startLocal: string;
}

/**
 * "2026-11-05" 这类纯日期串必须按本地零点解释：`new Date("2026-11-05")`
 * 按 UTC 解析，在东八区会变成 08:00，事件直接落到错误的时段。
 */
function asLocal(date: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(date);
}

/**
 * 没有到期日的待办写日历时的兜底时间：次日 09:00（本地时区）。
 *
 * 不用「今天 09:00」：用户下午点写入时它已经是过去时间，系统日历不会提醒。
 * 次日 09:00 一定在未来，至少能形成一次有效提醒；事件描述里会写明这是
 * 兜底日期，避免用户误以为任务本来就有到期日。
 */
export function calendarFallbackStart(now = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/**
 * 写入系统日历时使用的事件标题。桌面的 Outlook 去重键就是标题，
 * 删除任务时也要用同一个标题才能把对应事件找回来，所以单独抽出来。
 */
export function maintenanceTitle(t: MaintenanceTask): string {
  return `${t.item_name || "家庭维护"}：${t.title}`;
}

/**
 * 维护任务 → 日历事件。到期的日子定在上午 9 点：日历的「提前 N 分钟」
 * 是从事件开始时刻倒推的，全天事件从零点倒推会提醒到前一天下午，
 * 所以这里不用全天事件，用一条 9:00-10:00 的事件提前 30 分钟响铃。
 *
 * `fallbackStart` 只给没有（或无法解析）`next_due_at` 的任务使用。
 * 有正常到期日的任务永远以 `next_due_at` 为准，不存在被兜底日期覆盖的问题。
 */
export function maintenanceEvent(t: MaintenanceTask, fallbackStart?: Date): CalendarEvent {
  const due = t.next_due_at ? asLocal(t.next_due_at) : null;
  const validDue = due !== null && !Number.isNaN(due.getTime());
  const start = validDue ? due : fallbackStart ? new Date(fallbackStart) : new Date();
  start.setHours(9, 0, 0, 0);

  const pad = (n: number) => String(n).padStart(2, "0");
  const y = start.getFullYear();
  const mo = start.getMonth() + 1;
  const d = start.getDate();
  const startLocal = `${y}-${pad(mo)}-${pad(d)} 09:00`;
  const assumed = !validDue;
  const description = [
    t.notes?.trim(),
    assumed
      ? `此任务未设置到期日；已按 ${startLocal} 生成提醒。补充到期日后重新写入，即可更新日历中的时间。`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    taskId: t.id,
    title: maintenanceTitle(t),
    description: description || null,
    startMs: start.getTime(),
    durationMs: 60 * 60_000,
    allDay: false,
    intervalDays: t.interval_days ?? null,
    reminderMinutes: 30,
    startLocal,
  };
}
