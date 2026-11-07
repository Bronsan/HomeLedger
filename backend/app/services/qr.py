"""QR code and printable label generation.

Three identifiers, three purposes:
  * asset QR  (HL-000123)  -> the thing itself, printed on a sticker
  * barcode   (EAN/UPC)    -> the product model, scanned at the shop
  * serial    -> manufacturer warranty lookup

Labels are generated as PNG for single stickers and as a print-ready HTML sheet
for batch printing on A4.
"""

from __future__ import annotations

import io
import logging
from html import escape

import qrcode
from PIL import Image, ImageDraw, ImageFont
from qrcode.constants import ERROR_CORRECT_M

log = logging.getLogger("homeledger.qr")

FONT_CANDIDATES = [
    # CJK-capable fonts first. DejaVuSans is installed on almost every Linux
    # box but has no Chinese glyphs — putting it first renders 「戴森吸尘器」
    # as a row of tofu boxes while looking like everything worked.
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    # Latin-only last resort: correct for ASCII names, boxes for Chinese ones.
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]

_CJK_FONT_CACHE: str | None | bool = False


def cjk_font_path() -> str | None:
    """First installed font that can actually draw Chinese, or None."""
    global _CJK_FONT_CACHE
    if _CJK_FONT_CACHE is not False:
        return _CJK_FONT_CACHE  # type: ignore[return-value]
    latin = {
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    }
    found = None
    for path in FONT_CANDIDATES:
        if path in latin:
            continue
        try:
            ImageFont.truetype(path, 16)
            found = path
            break
        except Exception:
            continue
    _CJK_FONT_CACHE = found
    if not found:
        log.warning(
            "未找到中文字体，标签图片中的中文会显示为方块。"
            "Debian/Ubuntu 可安装 fonts-wqy-microhei，Alpine 可安装 font-noto-cjk。"
        )
    return found


def _font(size: int) -> ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def qr_image(data: str, box_size: int = 8, border: int = 2) -> Image.Image:
    qr = qrcode.QRCode(
        version=None,
        error_correction=ERROR_CORRECT_M,
        box_size=box_size,
        border=border,
    )
    qr.add_data(data)
    qr.make(fit=True)
    return qr.make_image(fill_color="#0f172a", back_color="white").convert("RGB")


def qr_png(data: str, box_size: int = 8) -> bytes:
    buf = io.BytesIO()
    qr_image(data, box_size=box_size).save(buf, format="PNG")
    return buf.getvalue()


def label_png(
    *,
    url: str,
    title: str,
    code: str,
    subtitle: str = "",
    width: int = 420,
    height: int = 168,
) -> bytes:
    """A sticker: QR on the left, human readable text on the right."""
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)
    qr = qr_image(url, box_size=6, border=1)
    qr = qr.resize((min(height - 24, 144), min(height - 24, 144)), Image.NEAREST)
    canvas.paste(qr, (14, (height - qr.height) // 2))

    x = 14 + qr.width + 16
    draw.text((x, 22), title[:18], fill="#0f172a", font=_font(22))
    draw.text((x, 58), code, fill="#475569", font=_font(17))
    if subtitle:
        draw.text((x, 88), subtitle[:22], fill="#64748b", font=_font(15))
    draw.text((x, height - 32), "HomeLedger", fill="#94a3b8", font=_font(13))
    draw.rectangle([(0, 0), (width - 1, height - 1)], outline="#e2e8f0")
    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def label_sheet_html(rows: list[dict], family_name: str) -> str:
    """A4 sheet, 3 columns. Ctrl+P -> stickers."""
    cells = []
    for r in rows:
        cells.append(
            f"""
        <div class="label">
          <img src="{escape(r['qr_data_url'])}" alt="qr" />
          <div class="meta">
            <div class="name">{escape(r['name'][:26])}</div>
            <div class="code">{escape(r['code'])}</div>
            <div class="loc">{escape(r.get('location', '') or '未分配位置')[:28]}</div>
            <div class="brand">HomeLedger</div>
          </div>
        </div>"""
        )
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>{escape(family_name)} · 物品标签</title>
<style>
  @page {{ size: A4; margin: 10mm; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; margin: 0; }}
  h1 {{ font-size: 14pt; margin: 0 0 6mm; color: #0f172a; }}
  .grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }}
  .label {{ display: flex; gap: 3mm; border: 1px solid #e2e8f0; border-radius: 3mm;
           padding: 3mm; align-items: center; break-inside: avoid; }}
  .label img {{ width: 26mm; height: 26mm; }}
  .meta {{ min-width: 0; }}
  .name {{ font-size: 9.5pt; font-weight: 600; color: #0f172a; line-height: 1.25; }}
  .code {{ font-size: 8pt; color: #475569; margin-top: 1mm; font-family: ui-monospace, monospace; }}
  .loc {{ font-size: 7.5pt; color: #64748b; margin-top: 1mm; }}
  .brand {{ font-size: 6.5pt; color: #94a3b8; margin-top: 1.5mm; letter-spacing: .05em; }}
  @media print {{ .no-print {{ display: none; }} }}
</style></head>
<body>
  <h1>{escape(family_name)} · 物品标签（{len(rows)} 张）</h1>
  <div class="grid">{''.join(cells)}</div>
</body></html>"""
