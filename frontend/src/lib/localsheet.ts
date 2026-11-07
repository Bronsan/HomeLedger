/**
 * 本机/同步模式的标签纸。
 *
 * `/labels/sheet` 只有服务器能渲染：标签页是浏览器直接加载的 HTML，
 * 本机模式没有任何东西可以服务这个 URL（1.0.7 起连 SW 拦截也没有）。
 * 这里在页面里把同一套排版（A4 · 三列 · 二维码 + 名称/编号/位置）拼成
 * HTML 文档，交给 lib/print 的三个打印出口——它们吃 URL，
 * 所以产出一个 blob: URL，用完记得 revokeObjectURL。
 *
 * 二维码内容优先用服务器签发的贴纸链接（配了服务器且物品已同步时，
 * 扫码直接跳到物品页）；拿不到就退化为资产编号原文——扫出来的是
 * "HL-000012" 这样的文本，粘进查询页照样能定位到物品。
 */

import type { Item } from "../api/types";
import { qrLinkFor } from "../sync/engine";
import { qrSvg } from "../local/qr";

function escapeHtml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string)
  );
}

export interface LocalSheetInput {
  items: Item[];
  /** 位置 id → 展示名。调用方已加载过位置列表，不在这里重复请求。 */
  locationName: (id: string | null) => string;
  familyName?: string;
}

export async function localSheetUrl(input: LocalSheetInput): Promise<string> {
  const cells: string[] = [];
  for (const it of input.items) {
    const link = await qrLinkFor(it.id);
    const qrContent = link?.url || it.code;
    const svg = await qrSvg(qrContent);
    const loc = input.locationName(it.location_id);
    cells.push(`
        <div class="label">
          <img src="data:image/svg+xml;utf8,${encodeURIComponent(svg)}" alt="qr" />
          <div class="meta">
            <div class="name">${escapeHtml(it.name.slice(0, 26))}</div>
            <div class="code">${escapeHtml(it.code)}</div>
            <div class="loc">${escapeHtml((loc || "未分配位置").slice(0, 28))}</div>
            <div class="brand">HomeLedger</div>
          </div>
        </div>`);
  }

  const title = `${input.familyName || "HomeLedger"} · 物品标签（${input.items.length} 张）`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; margin: 0; }
  h1 { font-size: 14pt; margin: 0 0 6mm; color: #0f172a; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
  .label { display: flex; gap: 3mm; border: 1px solid #e2e8f0; border-radius: 3mm;
           padding: 3mm; align-items: center; break-inside: avoid; }
  .label img { width: 26mm; height: 26mm; }
  .meta { min-width: 0; }
  .name { font-size: 9.5pt; font-weight: 600; color: #0f172a; line-height: 1.25; }
  .code { font-size: 8pt; color: #475569; margin-top: 1mm; font-family: ui-monospace, monospace; }
  .loc { font-size: 7.5pt; color: #64748b; margin-top: 1mm; }
  .brand { font-size: 6.5pt; color: #94a3b8; margin-top: 1.5mm; letter-spacing: .05em; }
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="grid">${cells.join("")}</div>
</body></html>`;

  return URL.createObjectURL(new Blob([html], { type: "text/html" }));
}
