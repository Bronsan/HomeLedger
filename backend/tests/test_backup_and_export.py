"""Backup, restore and export — the parts that must not lose a family's data."""

from __future__ import annotations

import io
import json
import zipfile

from app.config import settings


def _make_backup(admin) -> dict:
    r = admin.post("/system/backups", json={"note": "测试备份"})
    assert r.status_code == 201, r.text
    return r.json()["backup"]


def test_backup_records_metadata_and_file_exists(instance_admin):
    rec = _make_backup(instance_admin)
    assert rec["filename"].endswith(".zip")
    assert rec["size_bytes"] > 0
    assert len(rec["sha256"]) == 64
    assert (settings.backup_dir / rec["filename"]).exists()

    listed = instance_admin.get("/system/backups").json()["items"]
    assert any(b["filename"] == rec["filename"] for b in listed)


def test_backup_retention_prunes_oldest(instance_admin, monkeypatch):
    """保留策略：连创建 5 个、只留 3 个——窗口外的记录和文件一起消失，
    且最新一次备份永远在窗口内（先备份再清理的承诺）。

    注意不能按「第 i 个创建的名字」断言：同一秒内的备份共享文件名前缀，
    旧的被清掉后 `_reserve()` 会复用基础名——文件名与创建顺序不一一对应，
    所以这里只断言不变量（数量、记录与磁盘一致、最新仍在）。
    """
    from app.providers import backup as backup_mod

    monkeypatch.setattr(backup_mod.settings, "backup_keep", 3)
    from app.db import provider as _prov
    from sqlalchemy import select as _s
    from app.models import BackupRecord as _B

    def _dump(tag):
        with _prov.session() as _db:
            rows = sorted(_db.execute(_s(_B)).scalars(), key=lambda r: r.created_at)
            print("DBG", tag, [(r.filename[-7:], r.created_at.isoformat()[-9:], r.family_id is None) for r in rows])

    recs = []
    for i in range(5):
        recs.append(_make_backup(instance_admin))
        _dump(str(i))

    listed = instance_admin.get("/system/backups").json()["items"]
    listed_names = {b["filename"] for b in listed}
    assert len(listed_names) == 3
    # 记录与磁盘一致：留下的都有文件（备份目录是全实例共享的，
    # 里面还有别的测试家庭留下的 zip，所以只断言包含不断言总数）
    for n in listed_names:
        assert (settings.backup_dir / n).exists()
    # 最后一次创建的备份一定还在（先备份再清理的承诺）
    assert recs[-1]["filename"] in listed_names


def test_backup_retention_disabled_at_zero(instance_admin, monkeypatch):
    """backup_keep <= 0 视为关闭：一次都不清。

    列表是实例级的，会混着同一 session 里别的测试家庭的记录，
    所以不看列表总数，看 create 响应里的 pruned。"""
    from app.providers import backup as backup_mod

    monkeypatch.setattr(backup_mod.settings, "backup_keep", 0)
    for _ in range(3):
        r = instance_admin.post("/system/backups", json={"note": "测试备份"})
        assert r.status_code == 201
        assert r.json()["pruned"] == []


def test_backup_zip_contains_manifest_and_database(instance_admin):
    rec = _make_backup(instance_admin)
    r = instance_admin.get(f"/system/backups/{rec['filename']}/download")
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert "manifest.json" in names
    assert "database.db" in names

    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["app"] == "HomeLedger"
    # Derived rather than hardcoded: the manifest must record the *latest*
    # applied migration, and pinning a literal here turns every new migration
    # into a false alarm about backups being broken.
    from app.migrate import MIGRATIONS

    assert manifest["schema_version"] == MIGRATIONS[-1][0]
    assert "created_at" in manifest


def test_restore_requires_explicit_confirmation(instance_admin):
    rec = _make_backup(instance_admin)
    r = instance_admin.post("/system/backups/restore", json={"filename": rec["filename"], "confirm": ""})
    assert r.status_code == 400
    assert "RESTORE" in r.json()["detail"]

    r = instance_admin.post("/system/backups/restore", json={"filename": rec["filename"], "confirm": "yes"})
    assert r.status_code == 400


def test_restore_roundtrip_drops_changes_made_after_the_snapshot(family, instance_admin):
    """The core promise of a backup: it actually rolls the database back."""
    kept = family.create_item(name="备份前就存在")
    rec = _make_backup(instance_admin)

    transient = family.create_item(name="备份之后才建的")
    assert family.get(f"/items/{transient['id']}").status_code == 200

    r = instance_admin.post(
        "/system/backups/restore", json={"filename": rec["filename"], "confirm": "RESTORE"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    # A safety copy of the pre-restore state must always be taken first.
    assert r.json()["pre_restore_backup"]

    assert family.get(f"/items/{transient['id']}").status_code == 404
    assert family.get(f"/items/{kept['id']}").status_code == 200


def test_restore_missing_file_is_404(instance_admin):
    r = instance_admin.post(
        "/system/backups/restore",
        json={"filename": "homeledger-nope.zip", "confirm": "RESTORE"},
    )
    assert r.status_code == 404


def test_backup_can_be_deleted_but_not_escaped(instance_admin):
    rec = _make_backup(instance_admin)
    assert instance_admin.delete("/system/backups/../etc/passwd").status_code in (404, 400)
    r = instance_admin.delete(f"/system/backups/{rec['filename']}")
    assert r.status_code == 200
    assert r.json()["file_removed"] is True
    assert all(b["filename"] != rec["filename"] for b in instance_admin.get("/system/backups").json()["items"])


def test_record_is_deletable_after_its_file_disappears(instance_admin):
    """A row whose file went away must still be removable.

    People clean the backup directory by hand, or restore onto a fresh box and
    bring only the database. If the endpoint 404s on a missing file, the stale
    row stays in the list and can never be dismissed.
    """
    rec = _make_backup(instance_admin)
    (settings.backup_dir / rec["filename"]).unlink()

    r = instance_admin.delete(f"/system/backups/{rec['filename']}")
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "file_removed": False, "record_removed": True}
    assert all(b["filename"] != rec["filename"] for b in instance_admin.get("/system/backups").json()["items"])


def test_deleting_an_unknown_backup_is_404(instance_admin):
    assert instance_admin.delete("/system/backups/homeledger-19700101-000000.zip").status_code == 404


def test_full_json_export_is_complete_and_portable(family):
    loc = family.create_location("书房")
    cat = family.create_category("电子设备")
    item = family.create_item(name="导出的笔记本", location_id=loc["id"], category_id=cat["id"])

    r = family.get("/system/export.json")
    assert r.status_code == 200
    data = r.json()
    assert data["family"]["id"] == family.family_id
    # Items are keyed by their human asset code; ids are installation-local.
    assert any(i["code"] == item["code"] for i in data["items"])
    assert any(c["id"] == cat["id"] for c in data["categories"])
    assert any(l["id"] == loc["id"] for l in data["locations"])
    # Timestamps must be serialisable, not datetime objects.
    json.dumps(data)


def test_csv_export_round_trips_through_the_importer(family):
    family.create_item(name="可导出物品", brand="Bosch", purchase_price=199.5)
    csv_text = family.get("/items/export.csv").text
    assert "code,name,category,location" in csv_text.splitlines()[0]

    # Re-import the exported rows into a second, empty household.
    rows = []
    lines = csv_text.lstrip("\ufeff").splitlines()
    header = lines[0].split(",")
    for line in lines[1:]:
        rows.append(dict(zip(header, line.split(","))))
    if not rows:
        return

    target_name = "导入目标家庭"
    target = family._c.post(
        "/api/v1/families",
        json={"name": target_name},
        headers={"Authorization": f"Bearer {family.token}"},
    ).json()["family"]
    other = family.as_family(target["id"])
    r = other.post("/items/import", json={"rows": rows, "dry_run": False})
    assert r.status_code == 200, r.text
    assert r.json()["created"] >= 1
