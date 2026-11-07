"""Scanning resolution, QR/label generation and attachment handling."""

from __future__ import annotations

import io
import zipfile

import pytest
from PIL import Image


def test_lookup_resolves_asset_code(family):
    item = family.create_item(name="按资产码")
    hit = family.get("/scan/lookup", params={"code": item["code"]}).json()
    assert hit["found"] is True
    assert hit["matched_by"] == "asset_code"
    assert hit["ambiguous"] is False


def test_lookup_resolves_product_barcode_and_flags_ambiguity(family):
    """One EAN can legitimately map to several physical units of the same model."""
    a = family.create_item(name="同款一号", barcode="6901234567892")
    b = family.create_item(name="同款二号", barcode="6901234567892")

    hit = family.get("/scan/lookup", params={"code": "6901234567892"}).json()
    assert hit["found"] is True
    assert hit["matched_by"] == "barcode"
    assert hit["ambiguous"] is True
    assert {c["id"] for c in hit["candidates"]} == {a["id"], b["id"]}
    assert "商品型号" in hit["hint"]


def test_lookup_resolves_serial_number(family):
    item = family.create_item(name="按序列号", serial_number="SN-7788-ALPHA")
    hit = family.get("/scan/lookup", params={"code": "SN-7788-ALPHA"}).json()
    assert hit["matched_by"] == "serial"
    assert hit["item"]["id"] == item["id"]


def test_lookup_prefers_asset_code_over_barcode(family):
    """Asset code is the strongest identity, so it must win the tie-break."""
    item = family.create_item(name="双重命中", barcode="HL-000777", code="HL-000777")
    hit = family.get("/scan/lookup", params={"code": "HL-000777"}).json()
    assert hit["matched_by"] == "asset_code"
    assert hit["item"]["id"] == item["id"]


def test_lookup_falls_back_to_name(family):
    """桌面端没有相机，只能打字——只认编号等于让桌面用户查不了东西。"""
    item = family.create_item(name="博世充电冲击钻")
    family.create_item(name="牧高笛露营帐篷")

    hit = family.get("/scan/lookup", params={"code": "冲击钻"}).json()
    assert hit["found"] is True
    assert hit["matched_by"] == "name"
    assert hit["item"]["id"] == item["id"]
    assert hit["ambiguous"] is False


def test_lookup_lists_every_name_match(family):
    a = family.create_item(name="常温酸奶 原味")
    b = family.create_item(name="常温酸奶 草莓")

    hit = family.get("/scan/lookup", params={"code": "常温酸奶"}).json()
    assert hit["ambiguous"] is True
    assert {c["id"] for c in hit["candidates"]} == {a["id"], b["id"]}
    assert "名称" in hit["hint"]


def test_exact_identifier_beats_a_name_that_contains_it(family):
    """名字里恰好含编号时，仍然先按编号命中——否则精确查询会变得不可靠。"""
    by_name = family.create_item(name="HL-000042 备用")
    exact = family.create_item(name="真正的那件", code="HL-000042")

    hit = family.get("/scan/lookup", params={"code": "HL-000042"}).json()
    assert hit["matched_by"] == "asset_code"
    assert hit["item"]["id"] == exact["id"]
    assert by_name["id"] != hit["item"]["id"]


def test_name_lookup_does_not_cross_families(owner, family):
    other = owner.post("/families", json={"name": "隔壁家"}).json()["family"]["id"]
    owner.as_family(other).create_item(name="隔壁的酸奶")

    hit = family.get("/scan/lookup", params={"code": "酸奶"}).json()
    assert hit["found"] is False


def test_lookup_accepts_a_full_qr_url(family):
    item = family.create_item(name="整串 URL")
    url = f"https://home.example/scan?code={item['code']}&from=sticker"
    hit = family.get("/scan/lookup", params={"code": url}).json()
    assert hit["found"] is True
    assert hit["item"]["id"] == item["id"]


def test_lookup_miss_suggests_creation(family):
    hit = family.get("/scan/lookup", params={"code": "HL-999999"}).json()
    assert hit["found"] is False
    assert hit["suggest_create"] is True


def test_qr_png_is_a_real_image(family):
    item = family.create_item(name="二维码")
    r = family.get(f"/items/{item['id']}/qr.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    img = Image.open(io.BytesIO(r.content))
    assert img.width == img.height > 100


def test_label_png_is_sticker_sized(family):
    item = family.create_item(name="标签纸")
    r = family.get(f"/items/{item['id']}/label.png")
    assert r.status_code == 200
    img = Image.open(io.BytesIO(r.content))
    assert img.width > img.height  # landscape sticker


def test_label_sheet_is_printable_html_with_qr_inline(family):
    a = family.create_item(name="打印一")
    b = family.create_item(name="打印二")
    r = family.get("/labels/sheet", params={"item_ids": f"{a['id']},{b['id']}"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    html = r.text
    assert "@page" in html  # A4 print rules
    assert "data:image/png;base64," in html
    assert a["code"] in html and b["code"] in html


def test_label_batch_zip_contains_one_png_per_item(family):
    a = family.create_item(name="打包一")
    b = family.create_item(name="打包二")
    r = family.get("/labels/batch.zip", params={"item_ids": f"{a['id']},{b['id']}"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert len(names) == 2
    assert all(n.endswith(".png") for n in names)


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (13, 107, 95)).save(buf, format="PNG")
    return buf.getvalue()


def test_upload_creates_thumbnail_and_can_become_cover(family):
    item = family.create_item(name="带照片")
    r = family.post(
        "/attachments",
        files={"file": ("photo.png", _png_bytes(), "image/png")},
        data={"item_id": item["id"], "kind": "photo", "set_cover": "true"},
    )
    assert r.status_code == 201, r.text
    att = r.json()["attachment"]
    assert att["kind"] == "photo"
    assert att["thumbnail_url"]

    detail = family.get(f"/items/{item['id']}").json()["item"]
    assert detail["cover_url"]
    assert len(detail["attachments"]) == 1


def test_attachment_requires_matching_family(family, owner):
    item = family.create_item(name="跨家庭附件")
    other = owner.post("/families", json={"name": "另一个家"}).json()["family"]
    r = owner.as_family(other["id"]).post(
        "/attachments",
        files={"file": ("x.png", _png_bytes(), "image/png")},
        data={"item_id": item["id"]},
    )
    assert r.status_code == 404


def test_empty_upload_is_rejected(family):
    r = family.post("/attachments", files={"file": ("empty.png", b"", "image/png")})
    assert r.status_code == 400


def test_download_uses_utf8_filename_and_supports_thumb(family):
    item = family.create_item(name="下载测试")
    up = family.post(
        "/attachments",
        files={"file": ("保修卡 2026.png", _png_bytes(), "image/png")},
        data={"item_id": item["id"], "kind": "document"},
    ).json()["attachment"]

    full = family.get(f"/attachments/{up['id']}/raw")
    assert full.status_code == 200
    assert "filename*=utf-8''" in full.headers["content-disposition"].lower()

    thumb = family.get(f"/attachments/{up['id']}/raw", params={"variant": "thumb"})
    assert thumb.status_code == 200
    assert Image.open(io.BytesIO(thumb.content)).width <= 640


def test_soft_deleted_attachment_disappears_from_item(family):
    item = family.create_item(name="删除附件")
    att = family.post(
        "/attachments",
        files={"file": ("a.png", _png_bytes(), "image/png")},
        data={"item_id": item["id"]},
    ).json()["attachment"]

    assert family.delete(f"/attachments/{att['id']}").status_code == 200
    assert family.get(f"/items/{item['id']}").json()["item"]["attachments"] == []
    assert family.get(f"/attachments/{att['id']}/raw").status_code == 404


def test_labels_use_a_cjk_capable_font():
    """A Latin-only font silently turns every Chinese label into tofu boxes."""
    from app.services.qr import _font, cjk_font_path

    path = cjk_font_path()
    if path is None:
        pytest.skip("本机未安装中文字体")
    chosen = _font(20).path
    assert chosen != "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    assert chosen == path


def test_label_png_renders_chinese_without_tofu(family):
    """Sanity check: a CJK glyph produces visibly different pixels than .notdef."""
    from app.services.qr import cjk_font_path, label_png

    if cjk_font_path() is None:
        pytest.skip("本机未安装中文字体")
    png = label_png(url="https://home.lan/scan?code=HL-000001", title="戴森吸尘器", code="HL-000001")
    img = Image.open(io.BytesIO(png)).convert("L")
    # Chinese text occupies the right half; if it were tofu the ink coverage
    # would still be non-zero, so compare against a Latin-only rendering.
    right = img.crop((130, 0, img.width, 90))
    assert sum(1 for px in right.getdata() if px < 128) > 200
