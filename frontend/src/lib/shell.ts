/**
 * 桌面壳（Tauri）提供的原生能力。
 *
 * 这里刻意把「能不能用」和「去做」分成两组函数：
 *
 * - `canOpenDataDir()` / `canOpenLogs()` / `canCloseWindow()` —— **纯查询**，
 *   不产生任何副作用，可以放心在渲染里调用。
 * - `openDataDir()` / `openLogs()` / `closeWindow()` —— 真的去做。
 *
 * 分开是有代价换来的：两组合在一起时，`disabled: !openLogs()` 这种写法会在
 * 每次渲染时真的打开一次文件夹——菜单栏每重渲染一次，资源管理器就弹一次。
 * 判能力永远用 `can*`，做事才用动词。
 */

import { isTauri } from "../api/client";

type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  window?: {
    getCurrentWindow?: () => {
      close: () => Promise<void>;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
    };
  };
};

function tauri(): TauriGlobal | null {
  if (!isTauri()) return null;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> | null {
  const call = tauri()?.core?.invoke;
  if (typeof call !== "function") return null;
  return call(cmd, args) as Promise<T>;
}

// --- 能力查询：无副作用，可以在渲染里调 -------------------------------------

export function canOpenDataDir(): boolean {
  return typeof tauri()?.core?.invoke === "function";
}

export function canOpenLogs(): boolean {
  return typeof tauri()?.core?.invoke === "function";
}

export function canCloseWindow(): boolean {
  return typeof tauri()?.window?.getCurrentWindow === "function";
}

/** 无边框窗口（decorations:false）的自绘窗口控制是否可用。 */
export function canWindowControls(): boolean {
  return canCloseWindow();
}

// --- 动作：只在用户点击时调 -------------------------------------------------

export interface ShellInfo {
  version?: string;
  dataDir?: string;
  baseUrl?: string;
  lanUrls?: string[];
  platform?: string;
}

export function shellInfo(): Promise<ShellInfo | null> {
  return invoke<ShellInfo>("app_info") ?? Promise.resolve(null);
}

/** 在系统文件管理器里打开数据目录。 */
export function openDataDir(): void {
  void invoke("open_data_dir");
}

/** 打开日志目录（`<data>/logs`），排查问题时用。 */
export function openLogs(): void {
  void invoke("open_logs");
}

/** 关闭窗口。注意桌面版默认最小化到托盘，进程仍在跑。 */
export function closeWindow(): void {
  const win = tauri()?.window?.getCurrentWindow?.();
  void win?.close();
}

/** 最小化 / 最大化-还原（自绘窗口控制用）。 */
export function minimizeWindow(): void {
  void tauri()?.window?.getCurrentWindow?.().minimize();
}

export function toggleMaximizeWindow(): void {
  void tauri()?.window?.getCurrentWindow?.().toggleMaximize();
}
