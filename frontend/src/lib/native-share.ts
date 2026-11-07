/**
 * 图片出壳：系统分享与系统打印。
 *
 * 二维码/标签在应用里是 SVG data URL（矢量，预览不糊），但安卓的分享目标
 * 和打印框架只认位图——这里先把 SVG 画到 canvas 栅格化成 PNG，再交给壳：
 *
 * - `shareImage`：写临时文件 → FileProvider → 系统分享面板（保存到相册、
 *   发给微信、传打印机服务都从面板里选）。这就是移动端唯一的「保存」路径：
 *   Android WebView 里 blob 下载和 window.open 都是死路。
 * - `printImage`：Android WebView 不接 window.print()（标签页的 iframe
 *   打印路径因此是 no-op），由壳用离屏 WebView + PrintManager 弹系统打印。
 *
 * 桌面/浏览器两者都不走这里：下载用 blob，打印用标签页的系统对话框。
 */

import { isTauri } from "../api/client";
import { shell } from "./platform";

type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
};

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> | null {
  const call = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke;
  if (!isTauri() || typeof call !== "function") return null;
  return call(cmd, args) as Promise<T>;
}

/** 只有手机壳有分享/打印通道；桌面与浏览器各走各的下载与打印路径。 */
export function canShareImage(): boolean {
  const call = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke;
  return isTauri() && typeof call === "function" && shell() === "mobile";
}

/** 桌面壳用「写入下载目录」代替 blob 下载（WebView 里锚点下载没反应）。 */
export function canSaveDownload(): boolean {
  const call = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke;
  return isTauri() && typeof call === "function" && shell() === "desktop";
}

/** 桌面壳：把 data URL 落成系统下载目录里的文件，返回完整路径。 */
export async function saveDownload(fileName: string, dataUrl: string): Promise<string> {
  const res = await invoke<string>("save_download", { fileName, dataUrl });
  if (res === null) throw new Error("当前环境不支持保存文件");
  return res;
}

/**
 * SVG data URL → PNG data URL。
 *
 * data: 来源的 SVG 画进 canvas 不会污染画布，toDataURL 可用；字体走系统
 * 字体（标签里的中文由 Noto Sans CJK 兜底），外部资源本来也引不进来。
 */
export async function rasterizeSvg(svgDataUrl: string, width: number): Promise<string> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = svgDataUrl;
  });
  const natural = img.naturalWidth || width;
  const naturalH = img.naturalHeight || Math.round((width * 425) / 709);
  const scale = width / natural;
  const w = Math.max(1, Math.round(natural * scale));
  const h = Math.max(1, Math.round(naturalH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/** 弹系统分享面板（安卓：保存到相册 / 发给别人都从这里选）。 */
export async function shareImage(fileName: string, pngDataUrl: string): Promise<void> {
  const res = await invoke("share_image", { fileName, dataUrl: pngDataUrl });
  if (res === null) throw new Error("当前环境不支持分享图片");
}

/** 弹系统打印对话框（安卓；对话框里也能选「另存为 PDF」）。 */
export async function printImage(jobName: string, pngDataUrl: string): Promise<void> {
  const res = await invoke("print_image", { jobName, dataUrl: pngDataUrl });
  if (res === null) throw new Error("当前环境不支持直接打印");
}

/** 整张标签纸（HTML 文档）交给系统打印——安卓 WebView 里 window.print() 是 no-op，
 *  这是批量标签打印唯一走得通的路。 */
export async function printHtml(jobName: string, html: string): Promise<void> {
  const res = await invoke("print_html", { jobName, html });
  if (res === null) throw new Error("当前环境不支持直接打印");
}
