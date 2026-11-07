/**
 * QR and label rendering, in the browser.
 *
 * The server used to draw these with Python and PIL. On a local-first device
 * there is no server to ask, and a sticker that only renders when the network
 * is up is worse than no sticker. `qrcode` produces SVG here, which stays
 * crisp at any print size and needs no canvas.
 */

import QRCode from "qrcode";
import { toBase64 } from "./crypto";

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(svg))}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string)
  );
}

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  });
}

export async function qrDataUrl(text: string): Promise<string> {
  return svgDataUrl(await qrSvg(text));
}

export interface LabelInput {
  url: string;
  title: string;
  code: string;
  subtitle?: string;
}

/** A 60 × 36 mm sticker at 300 dpi, sized to fit a standard label sheet. */
export async function labelDataUrl(input: LabelInput): Promise<string> {
  const qr = await qrSvg(input.url);
  // The QR generator emits a full <svg> document; strip its wrapper so the
  // matrix can be nested inside the label with our own positioning.
  const inner = qr.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const vbMatch = /viewBox="([^"]+)"/.exec(qr);
  const viewBox = vbMatch ? vbMatch[1] : "0 0 320 320";

  const title = escapeXml(input.title.slice(0, 22));
  const subtitle = escapeXml((input.subtitle || "").slice(0, 26));
  const code = escapeXml(input.code);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="709" height="425" viewBox="0 0 709 425">
  <rect width="709" height="425" fill="#ffffff"/>
  <g transform="translate(28 40) scale(0.98)">
    <svg width="330" height="330" viewBox="${viewBox}">${inner}</svg>
  </g>
  <text x="392" y="118" font-family="-apple-system, 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif"
        font-size="42" font-weight="700" fill="#111827">${title}</text>
  <text x="392" y="176" font-family="-apple-system, 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif"
        font-size="26" fill="#4b5563">${subtitle}</text>
  <text x="392" y="248" font-family="ui-monospace, 'SFMono-Regular', Menlo, monospace"
        font-size="34" fill="#0d6b5f" letter-spacing="2">${code}</text>
  <text x="392" y="300" font-family="-apple-system, sans-serif" font-size="20" fill="#9ca3af">HomeLedger</text>
  <rect x="28" y="392" width="653" height="1" fill="#e5e7eb"/>
</svg>`;
  return svgDataUrl(svg);
}
