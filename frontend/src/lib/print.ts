/**
 * 打印机连接接口。
 *
 * 浏览器和 WebView 都**拿不到打印机列表**——没有 API，`window.print()` 一调就是
 * 系统打印对话框，具体哪台机器在那儿选。所以这里不去假装能枚举设备，而是把
 * "怎么把这一页送到打印机"抽象成三种出口，各自说清楚它会干什么：
 *
 * - `system` —— 离屏 iframe 加载标签页，再调它的 `print()`。弹系统对话框，
 *   用户在对话框里选打印机、份数、纸张。这是唯一真正"连到打印机"的路径。
 * - `pdf`    —— 同一条路径，只是提示用户在对话框里选「另存为 PDF」。有些人
 *   家里没有打印机，先存成 PDF 拿去打印店。
 * - `window` —— 打不开 iframe 时（iOS Safari、某些内嵌浏览器）退化成新窗口，
 *   让用户自己按 Ctrl+P。
 *
 * 选中的出口记在 localStorage，下次不用再选一遍。
 */

import { authedUrl, isTauri } from "../api/client";

export type PrinterId = "system" | "pdf" | "window";

export interface Printer {
  id: PrinterId;
  label: string;
  hint: string;
  /** 这个出口在当前环境里能不能用。 */
  available: boolean;
  run: (url: string) => Promise<void>;
}

const PRINTER_KEY = "hl_printer";
const AUTO_KEY = "hl_printer_auto";

/**
 * 标签页地址。
 *
 * 这个页面由浏览器直接加载（iframe / 新窗口），带不了 `Authorization` 头，
 * 所以走 `authedUrl`——它负责把 token 放进查询串（远程模式），本机模式则是
 * 相对路径。
 */
export function sheetUrl(params: {
  itemIds?: string[];
  locationId?: string;
  categoryId?: string;
  limit?: number;
}): string {
  const search: Record<string, string> = {};
  if (params.itemIds?.length) search.item_ids = params.itemIds.join(",");
  if (params.locationId) search.location_id = params.locationId;
  if (params.categoryId) search.category_id = params.categoryId;
  if (params.limit) search.limit = String(params.limit);
  return authedUrl("/labels/sheet", search);
}

function printViaIframe(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    let done = false;

    const cleanup = () => {
      // 打印对话框是阻塞的，关掉之后至少还要留一帧让浏览器收尾，否则
      // 某些版本会在 removeChild 时崩掉渲染进程。
      window.setTimeout(() => frame.remove(), 400);
    };

    frame.onload = () => {
      if (done) return;
      done = true;
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        cleanup();
        resolve();
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    frame.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("标签页加载失败"));
    };

    frame.src = url;
    document.body.appendChild(frame);
  });
}

export function printers(): Printer[] {
  const hasIframe = typeof window !== "undefined" && "print" in window;
  return [
    {
      id: "system",
      label: "系统打印对话框",
      hint: "在对话框里选打印机和份数，直接打出来",
      available: hasIframe,
      run: printViaIframe,
    },
    {
      id: "pdf",
      label: "先存成 PDF",
      hint: "同样弹打印对话框，在「打印机」里选「另存为 PDF」",
      available: hasIframe,
      run: printViaIframe,
    },
    {
      id: "window",
      label: "在新窗口打开",
      hint: "打印对话框打不开时的兜底，在新窗口里按 Ctrl+P",
      // 壳里（桌面/手机）window.open 的 _blank 会被交给系统浏览器，而
      // blob:/相对地址在那边打不开——用户会看到"跳浏览器然后 404"。
      // 壳有自己的打印路径（手机接 PrintManager，桌面用前两项），只在浏览器里保留。
      available: hasIframe && !isTauri(),
      run: async (url: string) => {
        window.open(url, "_blank", "noopener");
      },
    },
  ];
}

export function preferredPrinter(): Printer {
  const all = printers();
  const stored = localStorage.getItem(PRINTER_KEY) as PrinterId | null;
  return all.find((p) => p.id === stored && p.available) || all[0];
}

export function setPreferredPrinter(id: PrinterId): void {
  localStorage.setItem(PRINTER_KEY, id);
}

/** 生成后是否直接打印（跳过询问）。默认问一次。 */
export function autoPrint(): boolean {
  return localStorage.getItem(AUTO_KEY) === "1";
}

export function setAutoPrint(on: boolean): void {
  if (on) localStorage.setItem(AUTO_KEY, "1");
  else localStorage.removeItem(AUTO_KEY);
}

export async function printSheet(url: string, printer?: Printer): Promise<void> {
  const chosen = printer || preferredPrinter();
  await chosen.run(url);
}
