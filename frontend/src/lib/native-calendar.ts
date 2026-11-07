/**
 * 系统日历的原生写入。
 *
 * 与 .ics 导出的区别：ics 是「下载文件 → 用户手动导入」，这里是由壳直接
 * 写进设备的日历数据库，提醒由系统日历负责，用户不感知任何中间步骤。
 *
 * - Android：壳内嵌的 CalendarPlugin（Kotlin）用 READ/WRITE_CALENDAR
 *   运行时权限写 CalendarProvider；首次写入会弹系统授权框。
 * - 桌面（Windows）：系统没有公开的日历接口，装了 Outlook 时通过 COM
 *   写默认日历；没装则抛错，调用方回退到 .ics 导出。
 * - 浏览器：两者都没有，永远走 .ics。
 *
 * 去重键：安卓用 CUSTOM_APP_URI（homeledger://maintenance/<任务 id>），
 * 桌面 Outlook 用事件标题。重复写是更新不是新增，任务顺延后再点一次即可
 * 把提醒挪到新日期；删除任务时用同一键撤回对应事件。
 */

import { isTauri } from "../api/client";
import type { CalendarEvent } from "./calendar-plan";

type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
};

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> | null {
  const call = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke;
  if (!isTauri() || typeof call !== "function") return null;
  return call(cmd, args) as Promise<T>;
}

/**
 * Tauri 的 invoke 在安卓侧经常以字符串（而不是 Error）reject；
 * 直接把 err.message 取出来会得到 undefined，最后只剩一句无用的
 * 「写入日历失败」。这里统一转成带原始信息的 Error。
 */
function asError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string" && err.trim()) return new Error(err);
  if (err && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return new Error(msg);
    try {
      return new Error(JSON.stringify(err));
    } catch {
      /* fall through */
    }
  }
  return new Error(fallback);
}

/** 壳里才有原生写入；浏览器一律回退 .ics。 */
export function canWriteCalendar(): boolean {
  const call = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke;
  return isTauri() && typeof call === "function";
}

/** 写入/更新一条。安卓首次会弹系统授权框；桌面没装 Outlook 时抛错。 */
export async function writeCalendarEvent(
  ev: CalendarEvent
): Promise<{ eventId?: number; updated?: boolean }> {
  try {
    const res = await invoke<{ eventId?: number; updated?: boolean }>(
      "calendar_write_event",
      { event: ev }
    );
    if (res === null) throw new Error("当前环境不支持直接写入日历");
    return res;
  } catch (err) {
    throw asError(err, "写入日历失败");
  }
}

/**
 * 从日历移除某条任务的事件（按 task id 定位，可以删掉多端同步出的副本）。
 *
 * 安卓只认 taskId；桌面 Outlook 用标题定位，因此可选传标题。日历里本来
 * 没有这条事件也算成功——调用方通常按「尽力而为」处理，不应让删除任务失败。
 */
export async function removeCalendarEvent(taskId: string, title?: string): Promise<void> {
  try {
    await invoke("calendar_remove_event", { taskId, title: title ?? null });
  } catch (err) {
    throw asError(err, "从日历移除失败");
  }
}
