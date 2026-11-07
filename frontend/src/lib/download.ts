/**
 * data URL → 文件下载。
 *
 * 各处下载按钮共用的最后一公里：data URL 转 Blob、造 objectURL、点一下
 * 隐藏锚点。Android WebView 里 blob 下载不可用（那是分享面板的活），桌面
 * 与浏览器都走这里。
 */

export function downloadDataUrl(dataUrl: string, fileName: string): void {
  const [head, body] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(head)?.[1] || "application/octet-stream";
  const binary = atob(body || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}
