"""The page a printed sticker opens, and nothing else.

This is the only part of HomeLedger that answers without a session, so it is
written to be small and paranoid:

  * it exists for one token and returns one item's card;
  * it refuses to answer anyone outside the local network;
  * it stores nothing about the viewer — no cookie, no log of who scanned;
  * it renders server-side, so it works on a five-year-old phone with no
    JavaScript beyond the heartbeat.

The heartbeat is what keeps the viewer service awake; see `services/qr_gateway`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from html import escape

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Attachment, Category, Family, Item, Location, MaintenanceTask
from ..providers.storage import get_storage_provider
from ..services import qr_links
from ..services.net import client_is_lan
from ..services.qr_gateway import gateway

router = APIRouter(prefix="/public", tags=["public"])

STATUS_LABEL = {
    "in_use": "在用",
    "stored": "存放",
    "lent": "借出",
    "repair": "维修中",
    "lost": "丢失",
    "disposed": "已处理",
    "archived": "已归档",
}


def _loc_path(locs: dict[str, Location], start: str | None) -> str:
    if not start:
        return ""
    parts: list[str] = []
    seen: set[str] = set()
    cur = locs.get(start)
    while cur and cur.id not in seen:
        seen.add(cur.id)
        parts.append(cur.name)
        cur = locs.get(cur.parent_id) if cur.parent_id else None
    return " / ".join(reversed(parts))


def _money(value: float | None, currency: str) -> str:
    if value is None:
        return ""
    symbol = {"CNY": "¥", "USD": "$", "EUR": "€", "JPY": "¥", "GBP": "£"}.get(
        currency or "CNY", ""
    )
    return f"{symbol}{value:,.2f}".rstrip("0").rstrip(".")


def _date(value) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    return value.strftime("%Y-%m-%d")


def _blocked_page(reason: str) -> str:
    return f"""<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要家庭内网</title>
<style>
:root{{color-scheme:light dark}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f1;
font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;color:#17211f;
padding:24px}}
.card{{max-width:380px;background:#fff;border:1px solid #e6e4dc;border-radius:18px;padding:26px;
box-shadow:0 10px 30px -16px rgba(23,33,31,.18)}}
h1{{font-size:17px;margin:0 0 8px}}
p{{margin:0;color:#5a6864;font-size:13.5px}}
.tag{{display:inline-block;margin-top:14px;font-size:11.5px;padding:3px 9px;border-radius:999px;
background:#fdecea;color:#b42318}}
@media(prefers-color-scheme:dark){{body{{background:#121614;color:#e8ecea}}
.card{{background:#191f1d;border-color:#2a3330}}p{{color:#a3b0ac}}}}
</style></head><body><div class="card">
<h1>这张标签只能在家里看</h1>
<p>{escape(reason)}</p>
<p style="margin-top:10px">连上家里的 Wi-Fi 再扫一次就可以了。这样设计是为了让贴纸离开家之后变成一张普通贴纸。</p>
<span class="tag">仅限家庭内网</span>
</div></body></html>"""


def _page(
    *,
    family: str,
    item: Item,
    location: str,
    category: str,
    next_due: str,
    next_due_title: str,
    has_photo: bool,
    token: str,
) -> str:
    status_text = STATUS_LABEL.get(item.status, item.status)
    facts: list[tuple[str, str]] = []
    if location:
        facts.append(("位置", location))
    if category:
        facts.append(("分类", category))
    if item.brand or item.model:
        facts.append(("品牌型号", " ".join(x for x in (item.brand, item.model) if x)))
    if item.purchase_date:
        facts.append(("购买日期", _date(item.purchase_date)))
    if item.warranty_until:
        facts.append(("保修至", _date(item.warranty_until)))
    if settings.qr_show_price and item.purchase_price is not None:
        facts.append(("购入价", _money(item.purchase_price, item.currency)))
    if item.serial_number:
        facts.append(("序列号", item.serial_number))
    if item.quantity and item.quantity != 1:
        facts.append(("数量", f"{item.quantity:g} {item.unit}"))

    facts_html = "".join(
        f'<div class="fact"><dt>{escape(k)}</dt><dd>{escape(v)}</dd></div>'
        for k, v in facts
    )

    due_html = ""
    if next_due:
        due_html = (
            '<div class="due"><span class="dot"></span>'
            f'<div><b>{escape(next_due_title or "下次保养")}</b>'
            f'<span>{escape(next_due)}</span></div></div>'
        )

    notes = (item.description or "").strip()
    notes_html = (
        f'<section class="notes"><h2>备注</h2><p>{escape(notes[:600])}</p></section>'
        if notes
        else ""
    )

    photo_html = (
        f'<div class="photo"><img src="{token}/photo" alt="" loading="eager"></div>'
        if has_photo
        else f'<div class="photo empty"><span>{escape(item.name[:1])}</span></div>'
    )

    return f"""<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d6b5f">
<meta name="robots" content="noindex,nofollow">
<title>{escape(item.name)} · {escape(family)}</title>
<style>
:root{{color-scheme:light dark;--bg:#f6f5f1;--surface:#fff;--border:#e6e4dc;--text:#17211f;
--text-2:#5a6864;--text-3:#8b9894;--brand:#0d6b5f;--brand-soft:#e6f2ef;--radius:16px}}
@media(prefers-color-scheme:dark){{:root{{--bg:#121614;--surface:#191f1d;--border:#2a3330;
--text:#e8ecea;--text-2:#a3b0ac;--text-3:#7d8a86;--brand:#4fb3a3;--brand-soft:#16241f}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--text);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif;
-webkit-text-size-adjust:100%;padding:calc(12px + env(safe-area-inset-top)) 14px
calc(28px + env(safe-area-inset-bottom))}}
.wrap{{max-width:520px;margin:0 auto}}
.top{{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 2px 14px}}
.family{{font-size:12px;color:var(--text-3);letter-spacing:.02em}}
.brand{{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--brand);font-weight:600}}
.brand i{{width:7px;height:7px;border-radius:50%;background:var(--brand)}}
.card{{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
overflow:hidden;box-shadow:0 1px 2px rgba(23,33,31,.04),0 10px 30px -20px rgba(23,33,31,.25)}}
.photo{{aspect-ratio:4/3;background:var(--brand-soft);display:grid;place-items:center;overflow:hidden}}
.photo img{{width:100%;height:100%;object-fit:cover;display:block}}
.photo.empty span{{font-size:56px;font-weight:600;color:var(--brand);opacity:.5}}
.body{{padding:16px 18px 18px}}
h1{{font-size:20px;line-height:1.35;margin:0 0 6px;letter-spacing:-.01em;word-break:break-word}}
.meta{{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}}
.chip{{font-size:11.5px;padding:3px 9px;border-radius:999px;background:var(--bg);
color:var(--text-2);border:1px solid var(--border);font-variant-numeric:tabular-nums}}
.chip.ok{{background:var(--brand-soft);color:var(--brand);border-color:transparent}}
.chip.warn{{background:#fdf1e0;color:#b45309;border-color:transparent}}
.chip.danger{{background:#fdecea;color:#b42318;border-color:transparent}}
dl{{margin:0;display:grid;grid-template-columns:1fr;gap:0}}
.fact{{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-top:1px solid var(--border)}}
.fact:first-child{{border-top:0}}
dt{{color:var(--text-3);font-size:13px;flex:0 0 auto}}
dd{{margin:0;font-size:13.5px;text-align:right;word-break:break-word}}
.due{{display:flex;gap:10px;align-items:center;margin-top:14px;padding:11px 13px;
background:var(--brand-soft);border-radius:12px}}
.due .dot{{width:8px;height:8px;border-radius:50%;background:#b45309;flex:0 0 auto}}
.due b{{display:block;font-size:12.5px}}
.due span{{font-size:12px;color:var(--text-2)}}
.notes{{margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}}
.notes h2{{font-size:12px;color:var(--text-3);font-weight:600;margin:0 0 6px}}
.notes p{{margin:0;font-size:13px;color:var(--text-2);white-space:pre-wrap;word-break:break-word}}
.foot{{margin:16px 4px 0;font-size:11.5px;color:var(--text-3);line-height:1.7}}
.foot code{{font-family:ui-monospace,Menlo,monospace;font-size:11px}}
</style></head>
<body><div class="wrap">
  <div class="top">
    <span class="family">{escape(family)}</span>
    <span class="brand"><i></i>HomeLedger</span>
  </div>
  <div class="card">
    {photo_html}
    <div class="body">
      <h1>{escape(item.name)}</h1>
      <div class="meta">
        <span class="chip ok">{escape(status_text)}</span>
        <span class="chip">{escape(item.code)}</span>
        {f'<span class="chip warn">维修中</span>' if item.status == "repair" else ""}
      </div>
      <dl>{facts_html}</dl>
      {due_html}
      {notes_html}
    </div>
  </div>
  <div class="foot">
    这张标签由家人在 HomeLedger 里打印。只能在家里网络打开，离开家就是一张普通贴纸。<br>
    仅家庭内网可访问 · 数据不离开你的服务器
  </div>
</div>
<script>
(function () {{
  var t = {token!r};
  var beatUrl = {token!r} + "/beat";
  function beat() {{
    fetch(beatUrl, {{ method: "POST", cache: "no-store", keepalive: true }}).catch(function () {{}});
  }}
  beat();
  var timer = setInterval(beat, 5000);
  document.addEventListener("visibilitychange", function () {{
    if (document.hidden) return;
    beat();
  }});
  window.addEventListener("pagehide", function () {{ clearInterval(timer); }});
}})();
</script>
</body></html>"""


@router.get("/q/{token}", response_class=HTMLResponse, include_in_schema=False)
def sticker_page(token: str, request: Request, db: Session = Depends(get_db)) -> HTMLResponse:
    if not settings.qr_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "二维码服务未启用")

    client = request.client.host if request.client else ""
    if settings.qr_lan_only and not client_is_lan(client):
        return HTMLResponse(_blocked_page("你现在的网络不在家里。"), status_code=403)

    link = qr_links.resolve(db, token)
    if not link:
        return HTMLResponse(_blocked_page("这张标签已经失效了。"), status_code=404)

    item = db.get(Item, link.item_id)
    if not item or item.deleted_at or item.family_id != link.family_id:
        return HTMLResponse(_blocked_page("这件物品已经从账本里删掉了。"), status_code=404)

    family = db.get(Family, item.family_id)
    if not family or family.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "家庭不存在")
    gateway.wake(token)
    # Validate live resources even if an earlier render is still cached.
    locs = {
        l.id: l
        for l in db.execute(
            select(Location).where(Location.family_id == item.family_id)
        ).scalars()
    }
    cat = db.get(Category, item.category_id) if item.category_id else None

    next_due, next_title = None, ""
    row = db.execute(
        select(MaintenanceTask)
        .where(
            MaintenanceTask.item_id == item.id,
            MaintenanceTask.status == "pending",
            MaintenanceTask.next_due_at.is_not(None),
        )
        .order_by(MaintenanceTask.next_due_at.asc())
        .limit(1)
    ).scalars().first()
    if row:
        next_due = _date(row.next_due_at)
        next_title = row.title

    has_photo = bool(
        db.execute(
            select(func.count(Attachment.id)).where(
                Attachment.item_id == item.id,
                Attachment.deleted_at.is_(None),
                Attachment.mime_type.like("image/%"),
            )
        ).scalar()
    )

    html = _page(
        family=family.name if family else "",
        item=item,
        location=_loc_path(locs, item.location_id),
        category=cat.name if cat else "",
        next_due=next_due or "",
        next_due_title=next_title,
        has_photo=has_photo,
        token=link.token,
    )

    link.hits = (link.hits or 0) + 1
    link.last_used_at = datetime.now(timezone.utc)
    db.commit()
    gateway.remember(token, html)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@router.post("/q/{token}/beat", include_in_schema=False)
def sticker_beat(token: str, request: Request, db: Session = Depends(get_db)) -> Response:
    if not settings.qr_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "二维码服务未启用")
    client = request.client.host if request.client else ""
    if settings.qr_lan_only and not client_is_lan(client):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "仅限家庭内网")
    link = qr_links.resolve(db, token)
    item = db.get(Item, link.item_id) if link else None
    family = db.get(Family, link.family_id) if link else None
    if not link or not item or item.deleted_at or item.family_id != link.family_id or not family or family.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "标签已失效")
    # A heartbeat may extend a known lease, never allocate an unknown one.
    gateway.beat(token)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/q/{token}/photo", include_in_schema=False)
def sticker_photo(token: str, request: Request, db: Session = Depends(get_db)) -> Response:
    if not settings.qr_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "二维码服务未启用")
    client = request.client.host if request.client else ""
    if settings.qr_lan_only and not client_is_lan(client):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "仅限家庭内网")
    link = qr_links.resolve(db, token)
    if not link:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "标签已失效")

    item = db.get(Item, link.item_id)
    family = db.get(Family, link.family_id)
    if not item or item.deleted_at or item.family_id != link.family_id or not family or family.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "标签已失效")
    stmt = select(Attachment).where(
        Attachment.item_id == link.item_id, Attachment.family_id == link.family_id,
        Attachment.deleted_at.is_(None)
    )
    att = db.execute(
        stmt.where(Attachment.id == _cover_id(db, link.item_id))
    ).scalars().first()
    if not att:
        att = db.execute(
            stmt.where(Attachment.mime_type.like("image/%"))
            .order_by(Attachment.created_at.asc())
            .limit(1)
        ).scalars().first()
    if not att:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有照片")

    storage = get_storage_provider()
    try:
        payload = storage.read_thumbnail(att.relative_path)
        if payload is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "没有安全预览图")
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件已丢失")

    return Response(
        content=payload,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600", "ETag": f'"{att.sha256[:24]}"'},
    )


def _cover_id(db: Session, item_id: str) -> str:
    item = db.get(Item, item_id)
    return (item.cover_attachment_id if item else None) or ""
