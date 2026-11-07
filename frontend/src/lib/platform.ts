/**
 * 这个界面跑在哪种壳里。
 *
 * 三种形态差别很大，而"有没有摄像头"是最要命的一条：
 *
 * - `desktop` —— Windows/macOS 的 Tauri 壳。有摄像头也没人拿它对着东西扫，
 *   所以那里只有输入查询。
 * - `mobile`  —— Android/iOS 的 Tauri 壳（或手机浏览器）。扫码是主入口。
 * - `web`     —— 桌面浏览器访问网关。能力介于两者之间：有摄像头，但通常是
 *   笔记本对着屏幕，扫码没什么用，所以按桌面处理。
 *
 * 判据用 `__TAURI_INTERNALS__`（Tauri 2 注入）加 UA，不依赖任何构建期常量：
 * 同一份产物既要能跑在浏览器里，也要能跑在壳里。
 */

import { isTauri } from "../api/client";

export type Shell = "desktop" | "mobile" | "web";

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i;

export function shell(): Shell {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const mobile = MOBILE_UA.test(ua);
  if (isTauri()) return mobile ? "mobile" : "desktop";
  return mobile ? "mobile" : "web";
}

/** 桌面壳：要显示菜单栏、把"扫码"换成"查询"。 */
export function isDesktopShell(): boolean {
  return shell() === "desktop";
}

/** 手机形态：保留摄像头扫码。 */
export function isMobileShell(): boolean {
  return shell() === "mobile";
}

/** 桌面壳或桌面浏览器：都不给相机入口。 */
export function prefersManualLookup(): boolean {
  return !isMobileShell();
}
