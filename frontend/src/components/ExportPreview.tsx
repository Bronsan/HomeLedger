import { useState } from "react";
import { Icon } from "./icons";
import { Modal, Spinner, useToast } from "./ui";
import {
  canSaveDownload,
  canShareImage,
  printImage,
  rasterizeSvg,
  saveDownload,
  shareImage,
} from "../lib/native-share";
import { downloadDataUrl } from "../lib/download";

/**
 * 二维码 / 标签的「先看后发」弹窗。
 *
 * 出口按环境分流——每条都绕开一个真实踩过的坑：
 * - 手机壳：栅格化 PNG → 系统分享面板（blob 下载与 window.open 在 WebView
 *   里都是死路）；标签可打印（系统打印对话框，WebView 不接 window.print）。
 * - 桌面壳：栅格化 PNG → 写入系统下载目录（WebView 里锚点下载点了没反应）。
 * - 浏览器：blob 锚点下载，一切如常。
 */

export interface ExportTarget {
  title: string;
  /** SVG data URL——预览与打印共用一份，分享/下载前再栅格化。 */
  dataUrl: string;
  fileName: string;
  /** 手机上是否给「打印」入口（标签要打，二维码不需要）。 */
  printable?: boolean;
  jobName?: string;
  /** 栅格化位图宽度（px）。标签 709px 恰好是 60mm @300dpi。 */
  rasterWidth?: number;
  /** 未配对服务器时二维码/标签编码的是资产编号文本，要说明它扫出来是什么。 */
  offline?: boolean;
}

export function ExportPreview({ target, onClose }: { target: ExportTarget | null; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"share" | "print" | "download" | null>(null);
  const mobile = canShareImage();
  const desktopShell = canSaveDownload();

  if (!target || !target.dataUrl) return null;

  const run = async (kind: "share" | "print" | "download") => {
    setBusy(kind);
    try {
      const png = await rasterizeSvg(target.dataUrl, target.rasterWidth || 709);
      if (kind === "share") {
        await shareImage(target.fileName, png);
        toast("已交给系统分享面板");
      } else if (kind === "print") {
        await printImage(target.jobName || target.title, png);
        toast("已交给系统打印");
      } else if (desktopShell) {
        const path = await saveDownload(target.fileName, png);
        toast(`已保存到 ${path}`);
      } else {
        downloadDataUrl(png, target.fileName);
        toast("已开始下载");
      }
      onClose();
    } catch (err) {
      toast((err as Error).message || "操作失败", "error");
    } finally {
      setBusy(null);
    }
  };

  const label = desktopShell ? "保存到下载目录" : "下载图片";

  return (
    <Modal open onClose={onClose} title={target.title}>
      <div
        style={{
          background: "var(--bg-sunken)",
          borderRadius: "var(--radius-sm)",
          padding: 14,
          display: "grid",
          placeItems: "center",
        }}
      >
        <img
          src={target.dataUrl}
          alt={target.title}
          style={{ maxWidth: "100%", maxHeight: 260, display: "block" }}
        />
      </div>
      {target.offline && (
        <div
          className="row gap-8 mt-10"
          style={{ fontSize: 12, color: "var(--text-2)", alignItems: "flex-start" }}
        >
          <Icon name="info" size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            这台设备没有连接服务器，二维码编码的是<strong>资产编号文本</strong>：
            别人扫出来后，在「扫码/查询」页粘贴即可定位物品。配对服务器后，
            贴纸会改为指向服务器的链接，任何手机扫码直接打开物品。
          </span>
        </div>
      )}
      <div className="hint mt-8">
        {mobile
          ? "从分享面板里可选保存到相册、发给家人或其它应用。"
          : "图片按打印分辨率生成（60×36mm @300dpi）。"}
      </div>
      <div className="row gap-8 mt-14" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
        {mobile ? (
          <>
            {target.printable && (
              <button className="btn" onClick={() => void run("print")} disabled={busy !== null}>
                {busy === "print" ? <Spinner /> : <Icon name="printer" size={14} />}
                打印
              </button>
            )}
            <button className="btn btn-primary" onClick={() => void run("share")} disabled={busy !== null}>
              {busy === "share" ? <Spinner /> : <Icon name="share" size={14} />}
              分享 / 保存
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => void run("download")} disabled={busy !== null}>
            {busy === "download" ? <Spinner /> : <Icon name="download" size={14} />}
            {label}
          </button>
        )}
      </div>
    </Modal>
  );
}
