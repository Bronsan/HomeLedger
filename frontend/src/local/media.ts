/**
 * Image handling for local attachments.
 *
 * Phones shoot 4–8 MB photos. Storing those raw would make a household's
 * library grow faster than the device, and every one of them would have to be
 * encrypted and pushed on the next sync. So the original is downscaled once,
 * at capture time, to something a 6-inch screen can actually display, and a
 * small thumbnail is embedded in the row so lists render without touching the
 * blob store.
 */

export const MAX_EDGE = 1920;
export const THUMB_EDGE = 320;
const QUALITY = 0.82;

export interface PreparedImage {
  blob: Blob;
  thumb: string;
  width: number;
  height: number;
  mime: string;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取这张图片"));
    };
    img.src = url;
  });
}

function draw(img: HTMLImageElement, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前环境不支持图片处理");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, mime = "image/jpeg", quality = QUALITY): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("图片编码失败"))),
      mime,
      quality
    );
  });
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const img = await loadImage(file);
  const full = draw(img, MAX_EDGE);
  const thumb = draw(img, THUMB_EDGE);
  const blob = await toBlob(full);
  return {
    blob,
    thumb: thumb.toDataURL("image/jpeg", 0.7),
    width: full.width,
    height: full.height,
    mime: "image/jpeg",
  };
}

export async function isImage(file: File): Promise<boolean> {
  if (file.type.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name);
}
