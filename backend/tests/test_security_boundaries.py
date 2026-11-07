"""Security boundaries that are easy to regress.

These tests describe the promises the deployment makes: household roles cannot
reach instance administration, the account service cannot reach family data,
uploaded archives cannot escape their staging directory, and attachments are
not a way around the download permission.
"""

from __future__ import annotations

import base64
import io
import stat
import uuid
import zipfile

from fastapi.testclient import TestClient

from app.config import settings
from app.main import create_app

API = "/api/v1"


# --- instance administration ------------------------------------------------


def test_household_owner_cannot_reach_instance_administration(owner):
    assert owner.get("/system/backups").status_code == 403
    assert owner.get("/system/providers").status_code == 403
    assert owner.post("/system/backups", json={"note": "越权"}).status_code == 403


def test_instance_admin_without_a_family_can_administer(instance_admin):
    r = instance_admin.get("/system/backups")
    assert r.status_code == 200, r.text
    assert "items" in r.json()
    assert instance_admin.get("/system/providers").status_code == 200


def test_family_data_requires_a_family_not_just_admin(instance_admin):
    # Instance administration is about the server, not about reading a
    # household. An admin with no membership still has no tenant to query.
    r = instance_admin.get("/items")
    assert r.status_code == 409
    assert "还没有加入任何家庭" in r.json()["detail"]


# --- service mode route assembly --------------------------------------------


def test_account_service_app_has_no_data_plane(client):
    accounts = create_app(service_mode=True)
    with TestClient(accounts) as service:
        assert service.get(f"{API}/system/health").status_code == 200
        assert service.get(f"{API}/system/stats").status_code == 200
        for path in ("/items", "/families", "/sync/key", "/attachments",
                     "/system/backups", "/audit", "/maintenance"):
            assert service.get(f"{API}{path}").status_code == 404, path
        assert service.get("/api/docs").status_code == 404
        assert service.get("/api/openapi.json").status_code == 404


def test_account_service_registration_creates_no_household(client):
    accounts = create_app(service_mode=True)
    with TestClient(accounts) as service:
        r = service.post(
            f"{API}/auth/register",
            json={
                "email": f"account-{uuid.uuid4().hex[:6]}@homeledger.test",
                "password": "a-long-enough-password",
                "display_name": "账号用户",
                "family_name": "不应创建",
            },
        )
        assert r.status_code == 201, r.text
        assert r.json()["current_family_id"] is None


# --- static file containment ------------------------------------------------


def _static_app(tmp_path, monkeypatch):
    root = tmp_path / "web"
    root.mkdir()
    (root / "index.html").write_text("SPA-INDEX", encoding="utf-8")
    (root / "app.js").write_text("console.log(1)", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP-SECRET-OUTSIDE-ROOT", encoding="utf-8")
    monkeypatch.setattr(settings, "serve_frontend", True)
    return create_app(static_dir=root)


def test_static_fallback_serves_the_spa(tmp_path, monkeypatch):
    app = _static_app(tmp_path, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/items/abc")
        assert r.status_code == 200
        assert "SPA-INDEX" in r.text
        assert c.get("/app.js").text == "console.log(1)"


def test_static_paths_cannot_escape_the_build_directory(tmp_path, monkeypatch):
    app = _static_app(tmp_path, monkeypatch)
    attempts = [
        "/..%2Fsecret.txt",
        "/%2e%2e/secret.txt",
        "/%2e%2e%2fsecret.txt",
        "/..%5Csecret.txt",
        "/C:%5Csecret.txt",
        "/%252e%252e%252fsecret.txt",
        "/uploads/..%2F..%2Fsecret.txt",
        "/%2e%2e%2f%2e%2e%2fsecret.txt",
    ]
    with TestClient(app) as c:
        for path in attempts:
            r = c.get(path)
            assert "TOP-SECRET" not in r.text, path
            assert r.status_code in (200, 404), path


# --- attachment permissions -------------------------------------------------


def _png_bytes() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (32, 24), (30, 90, 160)).save(buf, format="PNG")
    return buf.getvalue()


def test_guest_can_preview_but_cannot_download_originals(family, member_factory):
    item = family.create_item(name="有图纸的柜子")
    up = family.post(
        "/attachments",
        files={"file": ("box.png", _png_bytes(), "image/png")},
        data={"item_id": item["id"], "kind": "photo"},
    )
    assert up.status_code == 201, up.text
    att = up.json()["attachment"]

    guest = member_factory("guest")
    assert guest.get(f"/attachments/{att['id']}/raw?variant=thumb").status_code == 200
    assert guest.get(f"/attachments/{att['id']}/raw").status_code == 403
    # The query-parameter token fallback must not bypass the same check.
    denied = guest._c.get(
        f"{API}/attachments/{att['id']}/raw?token={guest.token}"
    )
    assert denied.status_code == 403


def test_missing_thumbnail_is_not_replaced_by_the_original(family, member_factory):
    item = family.create_item(name="说明文档")
    up = family.post(
        "/attachments",
        files={"file": ("manual.txt", b"plain text, no preview", "text/plain")},
        data={"item_id": item["id"], "kind": "manual"},
    )
    assert up.status_code == 201, up.text
    att = up.json()["attachment"]

    guest = member_factory("guest")
    assert guest.get(f"/attachments/{att['id']}/raw?variant=thumb").status_code == 404
    # The original still exists, but only the download permission opens it.
    owner_orig = family.get(f"/attachments/{att['id']}/raw")
    assert owner_orig.status_code == 200
    assert owner_orig.headers["content-disposition"].startswith("attachment")
    assert owner_orig.headers["content-type"] == "application/octet-stream"


def test_attachment_is_not_readable_across_households(owner, family):
    item = family.create_item(name="本家物品")
    up = family.post(
        "/attachments",
        files={"file": ("note.txt", b"tenant-private", "text/plain")},
        data={"item_id": item["id"]},
    )
    att = up.json()["attachment"]
    other = owner.post("/families", json={"name": f"旁观-{uuid.uuid4().hex[:4]}"}).json()["family"]
    assert owner.as_family(other["id"]).get(f"/attachments/{att['id']}/raw").status_code == 404


# --- request bounds ---------------------------------------------------------


def test_oversized_json_body_is_rejected_before_routing(owner):
    r = owner.post("/items", json={"name": "x" * (5 * 1024 * 1024)})
    assert r.status_code == 413


def test_query_token_is_ignored_outside_media_paths(owner):
    r = owner._c.get(f"{API}/items?token={owner.token}")
    assert r.status_code == 401


# --- hostile backup archives ------------------------------------------------


def _write_zip(name: str, entries: list[tuple[zipfile.ZipInfo, bytes]]) -> str:
    target = settings.backup_dir / name
    settings.backup_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w") as archive:
        for info, data in entries:
            archive.writestr(info, data)
    return name


def _zipinfo(name: str, mode: int = stat.S_IFREG | 0o600) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name)
    info.external_attr = mode << 16
    return info


def _restore(admin, filename: str):
    return admin.post("/system/backups/restore", json={"filename": filename, "confirm": "RESTORE"})


def test_backup_restore_rejects_path_traversal(instance_admin):
    name = f"traversal-{uuid.uuid4().hex[:8]}.zip"
    _write_zip(name, [
        (_zipinfo("manifest.json"), b"{}"),
        (_zipinfo("../../escape.txt"), b"owned"),
    ])
    r = _restore(instance_admin, name)
    assert r.status_code == 400, r.text
    assert not (settings.backup_dir.parent.parent / "escape.txt").exists()
    assert instance_admin.get("/system/health").status_code == 200


def test_backup_restore_rejects_symlinks(instance_admin):
    name = f"symlink-{uuid.uuid4().hex[:8]}.zip"
    _write_zip(name, [
        (_zipinfo("manifest.json"), b"{}"),
        (_zipinfo("uploads/link", stat.S_IFLNK | 0o777), b"../../database.db"),
    ])
    assert _restore(instance_admin, name).status_code == 400


def test_backup_restore_rejects_duplicate_names_casefold(instance_admin):
    name = f"duplicate-{uuid.uuid4().hex[:8]}.zip"
    _write_zip(name, [
        (_zipinfo("manifest.json"), b"{}"),
        (_zipinfo("uploads/A.txt"), b"one"),
        (_zipinfo("uploads/a.txt"), b"two"),
    ])
    assert _restore(instance_admin, name).status_code == 400


def test_backup_restore_rejects_a_non_database_payload(instance_admin):
    name = f"notdb-{uuid.uuid4().hex[:8]}.zip"
    _write_zip(name, [
        (_zipinfo("manifest.json"), b'{"app": "HomeLedger", "includes_files": false}'),
        (_zipinfo("database.db"), b"this is not sqlite"),
    ])
    r = _restore(instance_admin, name)
    assert r.status_code == 400, r.text
    # The live database must still be usable after a rejected archive.
    assert instance_admin.get("/system/backups").status_code == 200


def test_backup_filename_cannot_escape(instance_admin):
    r = instance_admin.post(
        "/system/backups/restore",
        json={"filename": "../database.zip", "confirm": "RESTORE"},
    )
    assert r.status_code in (400, 404)


# --- sync key protocol bounds ----------------------------------------------


def test_sync_key_rejects_short_or_noncanonical_material(family):
    good = {
        "kdf": "argon2id",
        "salt": base64.b64encode(b"\x00" * 16).decode(),
        "memory_kib": 65536,
        "iterations": 3,
        "parallelism": 1,
        "wrapped_dek": base64.b64encode(b"\x00" * 72).decode(),
        "verifier": base64.b64encode(b"\x00" * 50).decode(),
    }
    bad = {**good, "salt": base64.b64encode(b"\x00" * 8).decode()}
    assert family.post("/sync/key", json=bad).status_code == 422

    # Non-canonical Base64 (extra padding / trailing bits) is rejected so two
    # clients cannot derive different keys from the "same" string.
    bad2 = {**good, "verifier": good["verifier"] + "="}
    assert family.post("/sync/key", json=bad2).status_code == 422

    over_budget = {**good, "memory_kib": 131072, "iterations": 6}
    assert family.post("/sync/key", json=over_budget).status_code == 422
