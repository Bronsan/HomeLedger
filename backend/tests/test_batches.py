"""批次与保质期。

The interesting parts are not the CRUD: they are the *derived* expiry state
(never stored, so it cannot go stale overnight), the fact that deleting is a
tombstone rather than a row removal, and that a batch is scoped to both a
family and an item — the two ways one household's data could leak into another.
"""

from __future__ import annotations

from datetime import datetime, timedelta

TODAY = datetime.utcnow().date()


def _d(days: int) -> str:
    return (TODAY + timedelta(days=days)).isoformat()


def _batch(api, item_id: str, **overrides) -> dict:
    payload = {"batch_no": "B-001", "quantity": 3, "expires_on": _d(60)}
    payload.update(overrides)
    r = api.post(f"/items/{item_id}/batches", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["batch"]


def test_batch_is_created_and_embedded_in_the_item(family):
    item = family.create_item(name="鲜牛奶", quantity=6, unit="盒")
    batch = _batch(family, item["id"], batch_no="20261030-A", quantity=4, supplier="楼下超市")

    assert batch["batch_no"] == "20261030-A"
    assert batch["quantity"] == 4
    assert batch["supplier"] == "楼下超市"
    # 60 days out is comfortably fresh; the badge must not cry wolf.
    assert batch["expiry_state"] == "fresh"
    assert batch["days_left"] == 60

    detail = family.get(f"/items/{item['id']}").json()["item"]
    assert [b["id"] for b in detail["batches"]] == [batch["id"]]
    # The item total is authoritative and must not be rewritten by a batch.
    assert detail["quantity"] == 6


def test_expiry_state_is_derived_from_the_date(family):
    item = family.create_item(name="药品")
    expiring = _batch(family, item["id"], batch_no="soon", expires_on=_d(10))
    expired = _batch(family, item["id"], batch_no="gone", expires_on=_d(-1))
    undated = _batch(family, item["id"], batch_no="forever", expires_on=None)

    assert (expiring["expiry_state"], expiring["days_left"]) == ("expiring", 10)
    assert expired["expiry_state"] == "expired"
    assert expired["days_left"] == -1
    assert (undated["expiry_state"], undated["days_left"]) == ("none", None)

    # Batches without a date must sink to the bottom of the list, not sort as
    # if they expired in year zero.
    listed = family.get(f"/items/{item['id']}/batches").json()["items"]
    assert [b["batch_no"] for b in listed] == ["gone", "soon", "forever"]


def test_partial_update_does_not_clear_untouched_fields(family):
    item = family.create_item(name="咖啡豆")
    batch = _batch(family, item["id"], batch_no="roast-1", supplier="烘焙店", note="开封后冷藏")

    r = family.patch(f"/batches/{batch['id']}", json={"quantity": 0.5})
    assert r.status_code == 200, r.text
    updated = r.json()["batch"]
    assert updated["quantity"] == 0.5
    assert updated["batch_no"] == "roast-1"
    assert updated["supplier"] == "烘焙店"
    assert updated["note"] == "开封后冷藏"


def test_expiry_before_production_is_rejected(family):
    item = family.create_item(name="酸奶")
    r = family.post(
        f"/items/{item['id']}/batches",
        json={"batch_no": "typo", "produced_on": _d(0), "expires_on": _d(-5)},
    )
    assert r.status_code == 422
    assert "过期日期" in r.text


def test_update_validates_dates_against_the_stored_other_half(family):
    """Moving only the expiry date must still be checked against production."""
    item = family.create_item(name="面包")
    batch = _batch(family, item["id"], produced_on=_d(-10), expires_on=_d(5))
    r = family.patch(f"/batches/{batch['id']}", json={"expires_on": _d(-30)})
    assert r.status_code == 422


def test_unknown_location_is_rejected(family):
    item = family.create_item(name="洗衣液")
    r = family.post(
        f"/items/{item['id']}/batches", json={"batch_no": "x", "location_id": "no-such-location"}
    )
    assert r.status_code == 404
    assert "存放位置" in r.text


def test_batch_carries_the_location_path(family):
    kitchen = family.create_location("厨房")
    fridge = family.create_location("冰箱", parent_id=kitchen["id"])
    item = family.create_item(name="冷冻饺子")
    batch = _batch(family, item["id"], location_id=fridge["id"])
    assert batch["location_path"] == "厨房 / 冰箱"


def test_deleting_a_batch_is_a_tombstone(family):
    """A hard delete would look like "never existed" to an offline device."""
    item = family.create_item(name="电池")
    batch = _batch(family, item["id"])

    r = family.delete(f"/batches/{batch['id']}")
    assert r.status_code == 200, r.text
    assert family.get(f"/items/{item['id']}/batches").json()["items"] == []

    from app.db import provider
    from app.models import ItemBatch

    with provider.session() as db:
        row = db.get(ItemBatch, batch["id"])
        assert row is not None and row.deleted_at is not None

    # A tombstoned row is gone as far as the API is concerned.
    assert family.patch(f"/batches/{batch['id']}", json={"quantity": 1}).status_code == 404


def test_batch_never_crosses_family_boundaries(owner, family):
    other = owner.post("/families", json={"name": "别人家"}).json()["family"]["id"]
    stranger = owner.as_family(other)
    item = family.create_item(name="私人物品")
    batch = _batch(family, item["id"])

    # Reading through someone else's item id must not disclose the item...
    assert stranger.get(f"/items/{item['id']}/batches").status_code == 404
    # ...nor let them touch the batch by its own id.
    assert stranger.patch(f"/batches/{batch['id']}", json={"quantity": 99}).status_code == 404
    assert stranger.delete(f"/batches/{batch['id']}").status_code == 404


def test_unknown_item_is_404(family):
    assert family.post("/items/nope/batches", json={"batch_no": "x"}).status_code == 404


def test_viewer_cannot_write_batches(family, member_factory):
    viewer = member_factory("viewer")
    item = family.create_item(name="公共物品")
    batch = _batch(family, item["id"])

    assert viewer.get(f"/items/{item['id']}/batches").status_code == 200
    r = viewer.post(f"/items/{item['id']}/batches", json={"batch_no": "no"})
    assert r.status_code == 403
    assert r.json()["permission"] == "item.update"
    assert viewer.patch(f"/batches/{batch['id']}", json={"quantity": 1}).status_code == 403
    assert viewer.delete(f"/batches/{batch['id']}").status_code == 403


def test_dashboard_counts_expiring_and_expired_batches(family):
    item = family.create_item(name="调味料")
    _batch(family, item["id"], batch_no="a", expires_on=_d(5))
    _batch(family, item["id"], batch_no="b", expires_on=_d(20))
    _batch(family, item["id"], batch_no="c", expires_on=_d(-3))
    _batch(family, item["id"], batch_no="d", expires_on=_d(200))

    data = family.get("/system/dashboard").json()
    assert data["expiring_batches"] == 2
    assert data["expired_batches"] == 1
    # Soonest first, and the far-future batch is not in the reminder list.
    assert [row["batch_no"] for row in data["expiring_list"]] == ["c", "a", "b"]
    assert data["expiring_list"][0]["item_name"] == "调味料"


def test_dashboard_ignores_batches_of_deleted_items(family):
    item = family.create_item(name="丢掉的酸奶")
    _batch(family, item["id"], expires_on=_d(-1))
    assert family.get("/system/dashboard").json()["expired_batches"] == 1

    family.delete(f"/items/{item['id']}")
    assert family.get("/system/dashboard").json()["expired_batches"] == 0
