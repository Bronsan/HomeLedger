"""Replication layer tests.

The contract under test is narrow but load-bearing: every device must be able
to walk away with the family's whole state, come back later with a cursor, and
lose nothing when two of them edited the same record while offline.
"""

from __future__ import annotations

import hashlib
import uuid

from conftest import Api

API = "/api/v1"


def _rec(entity: str, rid: str, hlc: str, **meta) -> dict:
    return {
        "entity": entity,
        "id": rid,
        "hlc": hlc,
        "op": "upsert",
        "meta": {"name": meta.pop("name", "物品"), **meta},
        "secret": "ciphertext-placeholder",
        "blobs": [],
    }


class Device:
    def __init__(self, api: Api, name: str = "测试设备"):
        self.api = api
        self.id = f"dev-{uuid.uuid4().hex[:10]}"
        self.name = name
        self.cursor = 0

    def push(self, records: list[dict]) -> dict:
        r = self.api.post(
            "/sync/apply",
            json={
                "device_id": self.id,
                "device_name": self.name,
                "device_kind": "desktop",
                "app_version": "1.0.0",
                "cursor": self.cursor,
                "records": records,
            },
        )
        assert r.status_code == 200, r.text
        return r.json()

    def pull(self, limit: int = 200) -> list[dict]:
        out: list[dict] = []
        while True:
            r = self.api.get(f"/sync/pull?since={self.cursor}&limit={limit}")
            assert r.status_code == 200, r.text
            data = r.json()
            out.extend(data["records"])
            self.cursor = data["cursor"]
            if not data["has_more"]:
                break
        return out


def test_status_starts_empty(family: Api) -> None:
    r = family.get("/sync/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    assert body["head"] == 0
    assert body["record_count"] == 0
    assert body["e2ee"] is False
    assert body["devices"] == []


def test_push_then_pull_roundtrip(family: Api) -> None:
    a = Device(family, "客厅平板")
    b = Device(family, "手机")

    res = a.push([_rec("item", "i1", "0001-0001-a", name="吸尘器")])
    assert res["applied"] == 1
    assert res["head"] == 1

    got = b.pull()
    assert len(got) == 1
    assert got[0]["id"] == "i1"
    assert got[0]["meta"]["name"] == "吸尘器"
    assert got[0]["secret"] == "ciphertext-placeholder"

    # A device that already has the record sees nothing new.
    assert b.pull() == []


def test_push_is_idempotent_by_hlc(family: Api) -> None:
    a = Device(family)
    rec = _rec("item", "i2", "0002-0001-a")
    assert a.push([rec])["applied"] == 1
    # Same HLC again: nothing changes, head must not advance.
    again = a.push([rec])
    assert again["applied"] == 0
    assert again["head"] == 1


def test_newer_wins_and_older_is_resolved_back(family: Api) -> None:
    a = Device(family, "A")
    b = Device(family, "B")

    a.push([_rec("item", "i3", "0003-0001-a", name="旧名字")])
    b.pull()

    b.push([_rec("item", "i3", "0004-0001-b", name="新名字")])
    # A pushes a stale edit afterwards; the server must keep B's version and
    # hand it back inside the same response.
    stale = a.push([_rec("item", "i3", "0003-0002-a", name="并发编辑")])
    assert stale["applied"] == 0
    assert len(stale["resolved"]) == 1
    assert stale["resolved"][0]["meta"]["name"] == "新名字"


def test_tombstone_propagates(family: Api) -> None:
    a = Device(family)
    b = Device(family)
    a.push([_rec("item", "i4", "0005-0001-a")])
    b.pull()

    a.push(
        [
            {
                "entity": "item",
                "id": "i4",
                "hlc": "0006-0001-a",
                "op": "delete",
                "meta": {},
                "secret": None,
                "blobs": [],
            }
        ]
    )
    changes = b.pull()
    assert len(changes) == 1
    assert changes[0]["op"] == "delete"


def test_unknown_entity_is_ignored(family: Api) -> None:
    a = Device(family)
    res = a.push([_rec("nonsense", "x", "0007-0001-a")])
    assert res["applied"] == 0
    assert res["ignored"] == 1


def test_oversized_secret_is_rejected(family: Api) -> None:
    a = Device(family)
    big = {**_rec("item", "i5", "0008-0001-a"), "secret": "x" * (600 * 1024)}
    res = a.push([big])
    assert res["applied"] == 0
    assert res["ignored"] == 1


def test_family_isolation(owner: Api, family: Api) -> None:
    other = owner.post("/families", json={"name": f"隔壁-{uuid.uuid4().hex[:4]}"})
    other_id = other.json()["family"]["id"]
    other_api = owner.as_family(other_id)

    Device(family).push([_rec("item", "secret-item", "0009-0001-a")])
    theirs = Device(other_api).pull()
    assert theirs == []


def test_device_registry_and_forget(family: Api) -> None:
    a = Device(family, "书房电脑")
    a.push([_rec("item", "i6", "0010-0001-a")])
    status = family.get("/sync/status").json()
    assert len(status["devices"]) == 1
    assert status["devices"][0]["name"] == "书房电脑"

    r = family.delete(f"/sync/device/{a.id}")
    assert r.status_code == 200
    assert family.get("/sync/status").json()["devices"] == []


def test_key_material_lifecycle(family: Api) -> None:
    assert family.get("/sync/key").json()["configured"] is False

    import base64

    def enc(n: int) -> str:
        return base64.b64encode(b"\x00" * n).decode()

    payload = {
        "kdf": "argon2id",
        "salt": enc(16),
        "memory_kib": 65536,
        "iterations": 3,
        "parallelism": 1,
        "wrapped_dek": enc(72),
        "verifier": enc(50),
    }
    r = family.post("/sync/key", json=payload)
    assert r.status_code == 200, r.text
    assert r.json()["created"] is True

    got = family.get("/sync/key").json()
    assert got["configured"] is True
    assert got["salt"] == enc(16)
    assert got["wrapped_dek"] == enc(72)

    # Overwriting without an explicit rotate must fail: it would orphan every
    # secret already uploaded under the old key.
    again = family.post("/sync/key", json=payload)
    assert again.status_code == 409

    rotated = family.post("/sync/key", json={**payload, "rotate": True})
    assert rotated.status_code == 200
    assert rotated.json()["created"] is False


def test_blob_roundtrip(family: Api) -> None:
    data = b"\x00\x01binary-ciphertext" * 100
    blob_id = f"blob-{uuid.uuid4().hex[:12]}"

    # Use the raw client so we can send octet-stream bodies.
    resp = family._c.put(
        f"{API}/sync/blob/{blob_id}",
        headers={
            "Authorization": f"Bearer {family.token}",
            "X-Family-Id": family.family_id or "",
            "Content-Type": "application/octet-stream",
        },
        content=data,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["sha256"] == hashlib.sha256(data).hexdigest()

    got = family.get(f"/sync/blob/{blob_id}")
    assert got.status_code == 200
    assert got.content == data

    assert family.delete(f"/sync/blob/{blob_id}").status_code == 200
    assert family.get(f"/sync/blob/{blob_id}").status_code == 404


def test_blob_rejects_path_tricks(family: Api) -> None:
    resp = family._c.put(
        f"{API}/sync/blob/..%2F..%2Fescape",
        headers={
            "Authorization": f"Bearer {family.token}",
            "X-Family-Id": family.family_id or "",
        },
        content=b"x",
    )
    assert resp.status_code in (404, 422)


def test_reset_requires_head_confirmation(family: Api) -> None:
    a = Device(family)
    a.push([_rec("item", "i7", "0011-0001-a")])
    head = family.get("/sync/status").json()["head"]

    assert family.post("/sync/reset", json={"confirm_head": head + 99}).status_code == 409
    ok = family.post("/sync/reset", json={"confirm_head": head})
    assert ok.status_code == 200
    assert family.get("/sync/status").json()["head"] == 0


def test_pull_pagination(family: Api) -> None:
    a = Device(family)
    a.push([_rec("item", f"p{i}", f"0020-{i:04d}-a") for i in range(12)])

    b = Device(family)
    first = family.get("/sync/pull?since=0&limit=5").json()
    assert len(first["records"]) == 5
    assert first["has_more"] is True
    assert first["cursor"] == first["records"][-1]["seq"]

    rest = b.pull()
    assert len(rest) == 12
