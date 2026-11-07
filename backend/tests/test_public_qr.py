"""Printed stickers: the public viewer, its gate, and its sleep cycle.

The interesting properties are all negative ones — the page must not answer
outside the house, must stop answering when the sticker is revoked, and must
release its resources when nobody is looking at it. Those are what these tests
check.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.qr_gateway import QrGateway
from tests.conftest import Api


class _HostOverride:
    """Pretend every request came from a given address.

    `TestClient` has a `client=` argument, but re-entering the app for a second
    client would run the lifespan twice. This wrapper only rewrites the scope.
    """

    def __init__(self, asgi, host: str):
        self.app = asgi
        self.host = host

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope = dict(scope)
            scope["client"] = (self.host, 51_234)
        await self.app(scope, receive, send)


@pytest.fixture()
def lan_client():
    return TestClient(_HostOverride(app, "192.168.1.23"))


@pytest.fixture()
def wan_client():
    return TestClient(_HostOverride(app, "8.8.8.8"))


def _item(api: Api, name: str = "戴森 V12") -> dict:
    res = api.post(
        "/items",
        json={"name": name, "status": "in_use", "purchase_price": 3299, "currency": "CNY"},
    )
    assert res.status_code == 201, res.text
    return res.json()["item"]


def test_link_is_created_and_scannable(lan_client, family):
    item = _item(family)
    res = family.get(f"/items/{item['id']}/qr-link")
    assert res.status_code == 200, res.text
    link = res.json()
    assert link["url"].endswith(f"/api/v1/public/q/{link['token']}")
    assert link["lan_only"] is True
    assert len(link["token"]) >= 16

    page = lan_client.get(f"/api/v1/public/q/{link['token']}")
    assert page.status_code == 200, page.text
    assert "戴森 V12" in page.text
    assert page.headers["cache-control"] == "no-store"


def test_outside_the_network_is_refused(wan_client, family):
    item = _item(family, "只能在家看的柜子")
    token = family.get(f"/items/{item['id']}/qr-link").json()["token"]

    res = wan_client.get(f"/api/v1/public/q/{token}")
    assert res.status_code == 403
    assert "仅限家庭内网" in res.text
    # The refusal must not confirm whether the token exists.
    assert "只能在家看的柜子" not in res.text


def test_revoked_sticker_stops_working(lan_client, family):
    item = _item(family, "旧路由器")
    token = family.get(f"/items/{item['id']}/qr-link").json()["token"]
    assert lan_client.get(f"/api/v1/public/q/{token}").status_code == 200

    rev = family.delete(f"/items/{item['id']}/qr-link")
    assert rev.status_code == 200 and rev.json()["revoked"] == 1

    assert lan_client.get(f"/api/v1/public/q/{token}").status_code == 404
    assert lan_client.get(f"/api/v1/public/q/{token}/photo").status_code == 404


def test_same_item_gets_one_link_per_base(lan_client, family):
    item = _item(family, "同一件东西")
    a = family.get(f"/items/{item['id']}/qr-link").json()
    b = family.get(f"/items/{item['id']}/qr-link").json()
    assert a["token"] == b["token"]


def test_heartbeat_registers_a_viewer(lan_client, family):
    item = _item(family, "心跳测试")
    token = family.get(f"/items/{item['id']}/qr-link").json()["token"]

    lan_client.get(f"/api/v1/public/q/{token}")
    beat = lan_client.post(f"/api/v1/public/q/{token}/beat")
    assert beat.status_code == 204

    status = family.get("/system/qr").json()
    assert status["state"] == "awake"
    assert status["viewers"] >= 1
    assert status["views_total"] >= 1


def test_beating_an_unknown_token_does_not_create_state(lan_client):
    # A page left open while the sticker was revoked. It must not resurrect a
    # lease for a token that no longer resolves.
    res = lan_client.post("/api/v1/public/q/definitely-not-a-token/beat")
    assert res.status_code == 404


def test_photo_is_served_from_the_sticker(lan_client, family):
    item = _item(family, "有照片的东西")
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (320, 240), (13, 107, 95)).save(buf, format="JPEG")
    up = family.post(
        "/attachments",
        files={"file": ("box.jpg", buf.getvalue(), "image/jpeg")},
        data={"item_id": item["id"], "kind": "photo", "set_cover": "true"},
    )
    assert up.status_code in (200, 201), up.text

    token = family.get(f"/items/{item['id']}/qr-link").json()["token"]
    photo = lan_client.get(f"/api/v1/public/q/{token}/photo")
    assert photo.status_code == 200
    assert photo.headers["content-type"].startswith("image/")


def test_lan_only_can_be_turned_off(wan_client, family, monkeypatch):
    from app.config import settings

    item = _item(family, "公网也允许")
    token = family.get(f"/items/{item['id']}/qr-link").json()["token"]
    monkeypatch.setattr(settings, "qr_lan_only", False)
    assert wan_client.get(f"/api/v1/public/q/{token}").status_code == 200


class _FastGateway(QrGateway):
    TICK = 0.02
    MIN_IDLE = 0.12
    CACHE_TTL = 0.05


def test_gateway_sleeps_after_idle(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "qr_idle_seconds", 0.12)
    gw = _FastGateway()
    assert gw.awake is False

    assert gw.wake("t1") is True
    assert gw.awake is True
    gw.remember("t1", "<html>")
    assert gw.cached("t1") == "<html>"

    # A heartbeat keeps it up.
    deadline = time.time() + 0.30
    while time.time() < deadline:
        gw.beat("t1")
        time.sleep(0.04)
    assert gw.awake is True

    # Silence lets it fall asleep, and sleeping drops the cache.
    deadline = time.time() + 2.0
    while gw.awake and time.time() < deadline:
        time.sleep(0.05)
    assert gw.awake is False
    assert gw.cached("t1") is None
    snap = gw.snapshot()
    assert snap["state"] == "asleep"
    assert snap["viewers"] == 0


def test_gateway_cache_is_bounded():
    gw = _FastGateway()
    gw.MIN_IDLE = 60
    gw.wake("keep")
    for i in range(200):
        gw.remember(f"t{i}", "<html>")
    assert len(gw._state.cache) <= 64  # noqa: SLF001 — the bound is the point
    gw.sleep()


def test_reachability_reports_a_loopback_bind_as_unreachable(monkeypatch):
    """A sticker printed while bound to 127.0.0.1 is useless — say so.

    `is_lan_address` accepts loopback on purpose (a request from this machine
    is local). Reusing it here was wrong: the desktop app binds to loopback by
    default, so every install would claim its stickers were reachable.
    """
    from app.config import settings

    from app.services.net import qr_reachable_from_lan

    for host, expected in [
        ("127.0.0.1", False),
        ("127.0.0.5", False),
        ("::1", False),
        ("localhost", False),
        ("0.0.0.0", True),
        ("::", True),
        ("", True),
        ("192.168.1.10", True),
        ("10.0.0.2", True),
        ("fe80::1%eth0", True),
        ("homeledger.lan", True),
    ]:
        monkeypatch.setattr(settings, "bind_host", host)
        assert qr_reachable_from_lan() is expected, host


def test_printed_sheets_use_the_sticker_url(family):
    """The A4 sheet and the zip must encode the same link as the single sticker.

    They used to embed `<base>/scan?code=HL-000123`, which is not a page that
    exists — every sheet printed from that screen produced QR codes that went
    nowhere. Reprinting must also reuse the token, or the sheets already on the
    shelf would stop working.
    """
    from app.db import provider
    from app.models import Item
    from app.routers.labels import sticker_urls

    item = _item(family, "标签用的二维码")
    db = provider.session()
    try:
        row = db.get(Item, item["id"])
        first = sticker_urls(db, [row], 8000, None)[item["id"]]
        second = sticker_urls(db, [row], 8000, None)[item["id"]]
    finally:
        db.close()

    assert "/api/v1/public/q/" in first
    assert "/scan?code=" not in first
    assert first == second
