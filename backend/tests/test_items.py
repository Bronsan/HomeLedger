"""Item lifecycle: numbering, identity fields, concurrency, archiving, ACL, loans."""

from __future__ import annotations


def test_first_item_gets_sequential_asset_code(family):
    a = family.create_item(name="第一件")
    b = family.create_item(name="第二件")
    assert a["code"] == "HL-000001"
    assert b["code"] == "HL-000002"


def test_asset_code_barcode_and_serial_are_distinct_fields(family):
    """The product barcode identifies a model; the asset code identifies one unit."""
    item = family.create_item(
        name="戴森吸尘器",
        barcode="5025155056530",
        barcode_type="ean13",
        serial_number="SN-9F2A-1188",
    )
    assert item["code"].startswith("HL-")
    assert item["barcode"] == "5025155056530"
    assert item["barcode_type"] == "ean13"
    assert item["serial_number"] == "SN-9F2A-1188"
    assert len({item["code"], item["barcode"], item["serial_number"]}) == 3


def test_duplicate_barcode_returns_warning_not_error(family):
    family.create_item(name="同型号一号", barcode="6901234567892")
    r = family.post("/items", json={"name": "同型号二号", "barcode": "6901234567892"})
    assert r.status_code == 201
    warn = r.json()["item"]["duplicate_warning"]
    assert warn["name"] == "同型号一号"
    assert "同条码物品已存在" in warn["message"]


def test_duplicate_asset_code_is_rejected(family):
    family.create_item(name="占号", code="HL-900001")
    r = family.post("/items", json={"name": "撞号", "code": "HL-900001"})
    assert r.status_code == 409
    assert "已存在" in r.json()["detail"]


def test_negative_quantity_is_rejected(family):
    r = family.post("/items", json={"name": "负数量", "quantity": -1})
    assert r.status_code == 422


def test_optimistic_concurrency_conflict_returns_409_with_current(family):
    item = family.create_item(name="并发测试")
    assert item["version"] == 1

    first = family.patch(f"/items/{item['id']}", json={"name": "改名 A", "version": 1})
    assert first.status_code == 200
    assert first.json()["item"]["version"] == 2

    stale = family.patch(f"/items/{item['id']}", json={"name": "改名 B", "version": 1})
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["current_version"] == 2
    assert detail["current"]["name"] == "改名 A"
    assert "刷新" in detail["message"]


def test_patch_without_version_is_last_write_wins(family):
    """Optional version keeps simple clients (bulk edits) usable."""
    item = family.create_item(name="无版本更新")
    r = family.patch(f"/items/{item['id']}", json={"name": "直接覆盖"})
    assert r.status_code == 200


def test_update_writes_an_audit_trail_and_event(family):
    item = family.create_item(name="有历史", location_id=None)
    family.patch(f"/items/{item['id']}", json={"name": "改过名", "status": "repair"})

    events = family.get(f"/items/{item['id']}/events").json()["items"]
    assert any(e["event_type"] == "updated" for e in events)

    audit = family.get("/audit", params={"entity_type": "item"}).json()
    rows = [a for a in audit["items"] if a["entity_id"] == item["id"]]
    assert any(a["action"] == "item.update" for a in rows)


def test_archive_hides_item_but_keeps_it_recoverable(family):
    item = family.create_item(name="待归档")
    assert family.post(f"/items/{item['id']}/archive").status_code == 200

    assert all(i["id"] != item["id"] for i in family.get("/items").json()["items"])
    archived = family.get("/items", params={"include_archived": True}).json()["items"]
    assert any(i["id"] == item["id"] for i in archived)

    assert family.post(f"/items/{item['id']}/restore").status_code == 200
    assert any(i["id"] == item["id"] for i in family.get("/items").json()["items"])


def test_archived_filter_lists_only_archived(family):
    """回收站视图：archived=true 只给归档的，软删除的不借尸还魂。"""
    keep = family.create_item(name="在用")
    gone = family.create_item(name="已归档")
    deleted = family.create_item(name="已删除")
    family.post(f"/items/{gone['id']}/archive")
    family.delete(f"/items/{deleted['id']}")

    rows = family.get("/items", params={"archived": True}).json()["items"]
    ids = [i["id"] for i in rows]
    assert gone["id"] in ids
    assert keep["id"] not in ids
    assert deleted["id"] not in ids

    # 常规列表不受影响
    normal = family.get("/items").json()["items"]
    assert all(i["id"] != gone["id"] for i in normal)


def _test_png() -> bytes:
    import io as _io
    from PIL import Image

    buf = _io.BytesIO()
    Image.new("RGB", (64, 48), (13, 107, 95)).save(buf, format="PNG")
    return buf.getvalue()


def test_batch_update_moves_many_and_respects_visibility(family, member_factory):
    """批量修改：白名单字段生效、标识字段被拒、无权物品整体 403。"""
    a = family.create_item(name="批量A", quantity=1)
    b = family.create_item(name="批量B", quantity=1)

    r = family.post(
        "/items/batch-update",
        json={"ids": [a["id"], b["id"]], "fields": {"quantity": 9, "name": "都叫这个"}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 2
    # name 不在白名单里，没被动
    assert family.get(f"/items/{a['id']}").json()["item"]["name"] == "批量A"
    assert family.get(f"/items/{a['id']}").json()["item"]["quantity"] == 9

    # 无编辑权限的物品混进来 → 整体 403，谁也不动
    guest = member_factory("guest", permissions={"grant": [], "deny": ["item.update"]})
    r = guest.post(
        "/items/batch-update",
        json={"ids": [a["id"], b["id"]], "fields": {"quantity": 1}},
    )
    assert r.status_code == 403
    assert family.get(f"/items/{a['id']}").json()["item"]["quantity"] == 9


def test_soft_deleted_item_is_listed_and_restorable(family):
    """回收站的『已删除』视图：软删除只是标记，restore 必须够得着。"""
    item = family.create_item(name="误删的相机")
    family.delete(f"/items/{item['id']}")

    rows = family.get("/items", params={"deleted": True}).json()["items"]
    hit = [r for r in rows if r["id"] == item["id"]]
    assert len(hit) == 1
    assert hit[0]["deleted_at"]

    # 常规列表与归档视图都不含它
    assert all(r["id"] != item["id"] for r in family.get("/items").json()["items"])
    assert all(
        r["id"] != item["id"] for r in family.get("/items", params={"archived": True}).json()["items"]
    )

    # restore 解除软删除，回到常规列表
    assert family.post(f"/items/{item['id']}/restore").status_code == 200
    assert any(r["id"] == item["id"] for r in family.get("/items").json()["items"])
    assert family.get("/items", params={"deleted": True}).json()["items"] == []


def test_hard_delete_purges_children_and_blocks_open_loans(family):
    """彻底删除：未还借出拦下；附件记录+文件、ACL、二维码一起清场；
    生命周期历史保留（档案，孤儿事件不进任何列表）。"""
    item = family.create_item(name="将被打碎的杯子")
    family.post(
        "/attachments",
        files={"file": ("photo.png", _test_png(), "image/png")},

        data={"item_id": item["id"], "kind": "photo"},
    )

    # 有未还借出：409 拦下
    family.post("/loans", json={"item_id": item["id"], "borrower_name": "还没还的人"})
    r = family.delete(f"/items/{item['id']}?hard=true")
    assert r.status_code == 409
    assert family.get(f"/items/{item['id']}").status_code == 200

    # 归还之后才能真正抹掉
    loan_id = family.get("/loans").json()["items"][0]["id"]
    family.post(f"/loans/{loan_id}/return", json={})
    r = family.delete(f"/items/{item['id']}?hard=true")
    assert r.status_code == 200 and r.json()["hard"] is True
    assert family.get(f"/items/{item['id']}").status_code == 404

    # 附件记录与文件都不在了
    atts = family.get("/attachments", params={"item_id": item["id"]}).json()["items"]
    assert atts == []

    # 软删之外的路径：扫描一个已彻底删除的编号 → 真的没有
    hit = family.get("/scan/lookup", params={"code": item["code"]}).json()
    assert hit["found"] is False


def test_archived_filter_requires_view_permission(family, member_factory):
    guest = member_factory("guest", permissions={"grant": [], "deny": ["item.view"]})
    assert guest.get("/items", params={"archived": True}).status_code == 403


def test_soft_delete_removes_from_every_read_path(family):
    item = family.create_item(name="将被删除")
    assert family.delete(f"/items/{item['id']}").status_code == 200
    assert family.get(f"/items/{item['id']}").status_code == 404
    assert all(i["id"] != item["id"] for i in family.get("/items").json()["items"])
    # The audit log keeps the record of what was removed.
    rows = family.get("/audit").json()["items"]
    assert any(a["action"] == "item.delete" and a["entity_id"] == item["id"] for a in rows)


def test_scan_reports_archived_instead_of_pretending_it_is_gone(family):
    """A sticker on a retired item must not lead the user to create a duplicate."""
    item = family.create_item(name="归档后扫码", barcode="1112223334445")
    family.post(f"/items/{item['id']}/archive")

    hit = family.get("/scan/lookup", params={"code": item["code"]}).json()
    assert hit["found"] is True
    assert hit["archived"] is True
    assert "已归档" in hit["hint"]

    # Deleted items really are gone.
    family.delete(f"/items/{item['id']}")
    assert family.get("/scan/lookup", params={"code": item["code"]}).json()["found"] is False


def test_filters_search_status_and_facets(family):
    work = family.create_category("工具")
    family.create_item(name="博世电钻", category_id=work["id"], brand="Bosch", status="in_use")
    family.create_item(name="牧田角磨机", category_id=work["id"], brand="Makita", status="repair")

    assert family.get("/items", params={"q": "博世"}).json()["total"] == 1
    assert family.get("/items", params={"status": "repair"}).json()["total"] == 1
    assert family.get("/items", params={"category_id": work["id"]}).json()["total"] == 2

    facets = family.get("/items/facets").json()
    assert facets["total"] >= 2
    assert facets["by_status"]["repair"] == 1

    cats = family.get("/categories").json()["items"]
    assert next(c for c in cats if c["id"] == work["id"])["item_count"] == 2


def test_search_by_serial_and_barcode(family):
    family.create_item(name="序列号物品", serial_number="SN-ABC-001")
    assert family.get("/items", params={"q": "SN-ABC-001"}).json()["total"] == 1


def test_location_tree_filter_includes_descendants(family):
    living = family.create_location("客厅")
    shelf = family.create_location("电视柜", parent_id=living["id"])
    family.create_item(name="放在电视柜", location_id=shelf["id"])

    hits = family.get("/items", params={"location_id": living["id"]}).json()
    assert hits["total"] == 1

    tree = family.get("/locations").json()
    root = next(n for n in tree["tree"] if n["id"] == living["id"])
    assert [c["name"] for c in root["children"]] == ["电视柜"]
    # Counts roll up: the room reports the shelf's items too.
    assert root["item_count"] == 1


def test_location_cannot_be_its_own_ancestor(family):
    a = family.create_location("A 房间")
    b = family.create_location("B 柜子", parent_id=a["id"])
    r = family.patch(f"/locations/{a['id']}", json={"parent_id": b["id"]})
    assert r.status_code == 400


def test_warranty_state_is_derived_from_date(family):
    from datetime import date, timedelta

    expired = family.create_item(
        name="过保", warranty_until=(date.today() - timedelta(days=30)).isoformat()
    )
    expiring = family.create_item(
        name="快过保", warranty_until=(date.today() + timedelta(days=10)).isoformat()
    )
    active = family.create_item(
        name="保修中", warranty_until=(date.today() + timedelta(days=400)).isoformat()
    )
    assert expired["warranty_state"] == "expired"
    assert expiring["warranty_state"] == "expiring"
    assert active["warranty_state"] == "active"

    only_expired = family.get("/items", params={"warranty": "expired"}).json()["items"]
    assert {i["id"] for i in only_expired} == {expired["id"]}


def test_components_attach_and_detach(family):
    camera = family.create_item(name="相机机身")
    r = family.post(
        f"/items/{camera['id']}/components",
        json={"name": "24-70mm 镜头", "component_type": "accessory", "serial_number": "LENS-1"},
    )
    assert r.status_code == 201
    comp = r.json()["component"]

    detail = family.get(f"/items/{camera['id']}").json()["item"]
    assert [c["name"] for c in detail["components"]] == ["24-70mm 镜头"]

    assert family.delete(f"/items/{camera['id']}/components/{comp['id']}").status_code == 200


def test_loan_flow_marks_item_and_records_return(family, member_factory):
    item = family.create_item(name="借出用梯子")
    r = family.post(
        "/loans",
        json={"item_id": item["id"], "borrower_name": "邻居老王", "note": "周末还"},
    )
    assert r.status_code == 201
    loan = r.json()["loan"]

    open_loans = family.get("/loans").json()["items"]
    assert any(l["id"] == loan["id"] and l["is_open"] for l in open_loans)

    back = family.post(f"/loans/{loan['id']}/return", json={"note": "完好"})
    assert back.status_code == 200
    assert back.json()["loan"]["is_open"] is False


def test_dashboard_counts_overdue_loans_separately(family):
    """逾期借出要能在首页告警条里单独喊出来，混进 open_loans 就没人看见了。"""
    from datetime import datetime, timedelta

    item = family.create_item(name="逾期用梯子")
    yesterday = (datetime.utcnow() - timedelta(days=1)).isoformat()
    r = family.post(
        "/loans",
        json={"item_id": item["id"], "borrower_name": "健忘的人", "due_at": yesterday},
    )
    assert r.status_code == 201, r.text

    data = family.get("/system/dashboard").json()
    assert data["open_loans"] == 1
    assert data["overdue_loans"] == 1

    family.post(f"/loans/{r.json()['loan']['id']}/return", json={})
    data = family.get("/system/dashboard").json()
    assert data["open_loans"] == 0
    assert data["overdue_loans"] == 0


def test_min_stock_drives_dashboard_low_stock(family):
    """低库存阈值：数量跌破阈值 dashboard 要喊；清掉阈值就不喊。"""
    item = family.create_item(name="大米", quantity=10, min_stock=2)
    assert item["min_stock"] == 2

    data = family.get("/system/dashboard").json()
    assert data["low_stock"] == 0

    family.patch(f"/items/{item['id']}", json={"quantity": 2})
    assert family.get("/system/dashboard").json()["low_stock"] == 1

    family.patch(f"/items/{item['id']}", json={"quantity": 5})
    assert family.get("/system/dashboard").json()["low_stock"] == 0

    # 显式传 null 清除阈值之后，数量归零也不再提醒
    family.patch(f"/items/{item['id']}", json={"min_stock": None})
    detail = family.get(f"/items/{item['id']}").json()["item"]
    assert detail["min_stock"] is None
    family.patch(f"/items/{item['id']}", json={"quantity": 0})
    assert family.get("/system/dashboard").json()["low_stock"] == 0


def test_items_low_stock_filter_lists_only_dipped(family):
    """/items?low_stock=true 与 dashboard 用同一把尺子，两边数字必须对得上。"""
    dipped = family.create_item(name="缺货的", quantity=1, min_stock=3)
    fine = family.create_item(name="够用的", quantity=9, min_stock=3)
    no_threshold = family.create_item(name="没画线的", quantity=0)

    rows = family.get("/items", params={"low_stock": True}).json()["items"]
    ids = [i["id"] for i in rows]
    assert dipped["id"] in ids
    assert fine["id"] not in ids
    assert no_threshold["id"] not in ids

    # 告警条计数与列表口径一致
    assert family.get("/system/dashboard").json()["low_stock"] == len(ids)


def test_item_acl_widens_visibility_for_a_member_without_item_view(family, member_factory):
    """Item level sharing is additive: it grants access that the role lacks."""
    other = family.create_item(name="别人的东西")
    shared = family.create_item(name="共享给访客")

    guest = member_factory("guest", permissions={"grant": [], "deny": ["item.view"]})
    assert guest.get("/items").status_code == 403  # no item.view at all

    r = family.post(f"/items/{shared['id']}/acl", json={"user_id": guest.user_id, "permission": "view"})
    assert r.status_code == 201

    listed = guest.get("/items").json()
    assert [i["id"] for i in listed["items"]] == [shared["id"]]
    assert listed["total"] == 1

    assert guest.get(f"/items/{shared['id']}").status_code == 200
    assert guest.get(f"/items/{other['id']}").status_code == 403


def test_item_acl_edit_allows_updates_without_item_update_role(family, member_factory):
    item = family.create_item(name="协作编辑")
    viewer = member_factory("viewer")
    assert viewer.patch(f"/items/{item['id']}", json={"name": "改不动"}).status_code == 403

    family.post(f"/items/{item['id']}/acl", json={"user_id": viewer.user_id, "permission": "edit"})
    assert viewer.patch(f"/items/{item['id']}", json={"name": "改得动"}).status_code == 200

    family.delete(f"/items/{item['id']}/acl/{viewer.user_id}")
    assert viewer.patch(f"/items/{item['id']}", json={"name": "又改不动"}).status_code == 403


def test_bulk_create_assigns_consecutive_codes(family):
    before = family.get("/items/facets").json()["total"]
    r = family.post(
        "/items/bulk",
        json={"items": [{"name": "批量一"}, {"name": "批量二"}, {"name": "批量三"}]},
    )
    assert r.status_code == 200
    assert r.json()["created"] == 3
    assert family.get("/items/facets").json()["total"] == before + 3

    codes = [
        i["code"]
        for i in family.get("/items", params={"q": "批量"}).json()["items"]
    ]
    assert len(set(codes)) == 3


def test_clone_copies_fields_and_reassigns_identity(family):
    src = family.create_item(
        name="原型吸尘器",
        brand="戴森",
        model="V12",
        quantity=3,
        min_stock=1,
        tags=["清洁"],
        purchase_price=2999.0,
    )
    r = family.post(f"/items/{src['id']}/clone")
    assert r.status_code == 201, r.text
    clone = r.json()["item"]

    # 描述字段照搬
    assert clone["name"] == "原型吸尘器（副本）"
    assert clone["brand"] == src["brand"]
    assert clone["model"] == src["model"]
    assert clone["quantity"] == src["quantity"]
    assert clone["min_stock"] == src["min_stock"]
    assert clone["tags"] == src["tags"]
    assert clone["purchase_price"] == src["purchase_price"]
    # 身份字段重新来：新编号、条码/序列号不跟、新 id
    assert clone["id"] != src["id"]
    assert clone["code"] != src["code"]
    assert not clone["barcode"]
    assert not clone["serial_number"]

    # 列表里两件都在
    names = [i["name"] for i in family.get("/items", params={"q": "吸尘器"}).json()["items"]]
    assert "原型吸尘器" in names and "原型吸尘器（副本）" in names


def test_clone_of_a_clone_does_not_stack_suffix(family):
    src = family.create_item(name="扳手")
    clone = family.post(f"/items/{src['id']}/clone").json()["item"]
    again = family.post(f"/items/{clone['id']}/clone").json()["item"]
    assert again["name"] == "扳手（副本）"


def test_clone_missing_item_404(family):
    assert family.post("/items/nonexistent/clone").status_code == 404


def test_list_sort_name_respects_order(family):
    family.create_item(name="丙物品")
    family.create_item(name="甲物品")
    family.create_item(name="乙物品")

    asc = [i["name"] for i in family.get("/items", params={"sort": "name", "order": "asc"}).json()["items"]]
    desc = [i["name"] for i in family.get("/items", params={"sort": "name", "order": "desc"}).json()["items"]]
    assert asc == sorted(asc) and desc == sorted(desc, reverse=True)
    assert asc == list(reversed(desc))


def test_custom_fields_round_trip(family):
    item = family.create_item(name="带自定义字段", custom_fields={"保险单号": "PL-2024-001", "滤芯型号": "FX-5"})
    assert item["custom_fields"]["保险单号"] == "PL-2024-001"

    got = family.get(f"/items/{item['id']}").json()["item"]
    assert got["custom_fields"]["滤芯型号"] == "FX-5"

    r = family.patch(f"/items/{item['id']}", json={"custom_fields": {"保险单号": "PL-2025-777"}})
    assert r.status_code == 200
    assert r.json()["item"]["custom_fields"] == {"保险单号": "PL-2025-777"}

    # 克隆把自定义字段带走（它属于「描述」不属于「实体」）
    clone = family.post(f"/items/{item['id']}/clone").json()["item"]
    assert clone["custom_fields"] == {"保险单号": "PL-2025-777"}


def test_purge_deleted_clears_bin_and_skips_blocked(family):
    a = family.create_item(name="清空甲")
    b = family.create_item(name="清空乙", min_stock=0)
    c = family.create_item(name="有借出的")

    # 三件都软删除；c 再挂一条未归还借出
    for it in (a, b, c):
        assert family.delete(f"/items/{it['id']}").status_code == 200
    r = family.post("/loans", json={"item_id": c["id"], "borrower_name": "老王"})
    assert r.status_code == 201, r.text

    res = family.post("/items/purge-deleted")
    assert res.status_code == 200
    body = res.json()
    assert body["purged"] == 2
    assert [x["name"] for x in body["blocked"]] == ["有借出的"]

    # 已删除视图里只剩被跳过的那件；a、b 是真的没了（软删列表都查不到）
    left = family.get("/items", params={"deleted": "true"}).json()["items"]
    assert [i["name"] for i in left] == ["有借出的"]
    assert family.get(f"/items/{a['id']}").status_code == 404
    assert family.get(f"/items/{b['id']}").status_code == 404

    # 再次清空：没有新的可删，purged=0
    again = family.post("/items/purge-deleted").json()
    assert again["purged"] == 0 and len(again["blocked"]) == 1


def test_purge_deleted_empty_bin_is_noop(family):
    res = family.post("/items/purge-deleted")
    assert res.status_code == 200
    assert res.json() == {"purged": 0, "blocked": []}


def test_new_endpoints_respect_permissions(family, member_factory):
    item = family.create_item(name="权限探针")

    # viewer：只读——克隆/批量修改/清空回收站一律 403
    viewer = member_factory("viewer")
    assert viewer.post(f"/items/{item['id']}/clone").status_code == 403
    assert (
        viewer.post("/items/batch-update", json={"ids": [item["id"]], "fields": {"quantity": 2}})
        .status_code
        == 403
    )
    assert viewer.post("/items/purge-deleted").status_code == 403

    # member：能建能改，但没有 item.delete——清空回收站 403
    member = member_factory("member")
    assert member.post(f"/items/{item['id']}/clone").status_code == 201
    assert (
        member.post("/items/batch-update", json={"ids": [item["id"]], "fields": {"quantity": 2}})
        .status_code
        == 200
    )
    assert member.post("/items/purge-deleted").status_code == 403

    # owner（family 客户端）：都能做
    assert family.post(f"/items/{item['id']}/clone").status_code == 201
    assert family.post("/items/purge-deleted").status_code == 200


def test_invite_code_expires_after_five_minutes(family, client):
    """邀请码生成起 5 分钟内有效：过期注册被拒，重置立刻满血。"""
    import uuid
    from datetime import datetime, timedelta

    fam = family.get("/families/current").json()
    code = fam["invite_code"]
    assert fam["invite_expires_at"]

    # 把有效期拨回过去（直接改库，测的是校验逻辑不是时钟）
    from sqlalchemy import update

    from app.db import provider
    from app.models import Family

    with provider.transaction() as s:
        s.execute(
            update(Family)
            .where(Family.id == fam["id"])
            .values(invite_expires_at=datetime.utcnow() - timedelta(minutes=1))
        )

    r = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"expired-{uuid.uuid4().hex[:6]}@homeledger.test",
            "password": "password123",
            "display_name": "迟到的人",
            "invite_code": code,
        },
    )
    assert r.status_code == 400, r.text
    assert "过期" in r.json()["detail"]

    # 重置后：新码 + 新的 5 分钟时效
    res = family.post("/families/current/rotate-invite")
    assert res.status_code == 200
    assert res.json()["invite_expires_at"]
    outsider = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"fresh-{uuid.uuid4().hex[:6]}@homeledger.test",
            "password": "password123",
            "display_name": "准时的人",
            "invite_code": res.json()["invite_code"],
        },
    )
    assert outsider.status_code == 201, outsider.text


def test_avatar_upload_roundtrip(family):
    """头像上传：data URL 进库，GET 取图带 token，清除后 404。"""
    import base64

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    data_url = "data:image/png;base64," + base64.b64encode(png).decode()

    r = family.patch("/auth/me", json={"avatar_data": data_url})
    assert r.status_code == 200, r.text
    me = r.json()["user"]
    assert me["avatar_url"] == f"/auth/avatar/{me['id']}"

    img = family.get(me["avatar_url"])
    assert img.status_code == 200
    # Uploads are decoded and re-encoded as JPEG before storage: this strips
    # metadata and any payload hidden in a polyglot image.
    assert img.headers["content-type"] == "image/jpeg"

    # 清除后取图 404
    r2 = family.patch("/auth/me", json={"avatar_data": ""})
    assert r2.status_code == 200
    assert r2.json()["user"]["avatar_url"] is None
    assert family.get(f"/auth/avatar/{me['id']}").status_code == 404


def test_avatar_rejects_bad_data(family):
    r = family.patch("/auth/me", json={"avatar_data": "data:image/gif;base64,AAAA"})
    assert r.status_code == 400
    r2 = family.patch("/auth/me", json={"avatar_data": "data:image/png;base64,!!!notb64!!!"})
    assert r2.status_code == 400


def test_maintenance_calendar_ics(family):
    """日历导出：含待办任务的稳定 UID 与标题，已完成的不出现。"""
    item = family.create_item(name="日历滤芯")
    r = family.post(
        "/maintenance",
        json={"item_id": item["id"], "title": "换滤芯", "interval_days": 90},
    )
    assert r.status_code == 201
    task = r.json()["task"]

    res = family.get("/maintenance/calendar.ics")
    assert res.status_code == 200
    assert "text/calendar" in res.headers["content-type"]
    body = res.text
    assert "BEGIN:VCALENDAR" in body
    assert f"UID:homeledger-maintenance-{task['id']}@homeledger" in body
    assert "换滤芯" in body
    assert "BEGIN:VALARM" in body

    # 一次性任务（无周期）完成后不再出现在日历里；周期任务是再次待办，照常出现
    one = family.post(
        "/maintenance",
        json={"item_id": item["id"], "title": "撕膜", "due_at": "2026-11-01T00:00:00Z"},
    ).json()["task"]
    assert f"homeledger-maintenance-{one['id']}@" in family.get("/maintenance/calendar.ics").text
    family.post(f"/maintenance/{one['id']}/complete", json={})
    body2 = family.get("/maintenance/calendar.ics").text
    assert f"homeledger-maintenance-{one['id']}@" not in body2
    assert f"homeledger-maintenance-{task['id']}@" in body2


def test_maintenance_calendar_includes_undated_task(family):
    """旧任务没有 next_due_at 时，日历导出按次日兜底，不能静默漏掉。"""
    item = family.create_item(name="无期限滤芯")
    task = family.post(
        "/maintenance",
        json={"item_id": item["id"], "title": "换无期限滤芯"},
    ).json()["task"]
    # 创建接口会默认今天；显式清空，模拟 1.x 遗留数据。
    patched = family.patch(f"/maintenance/{task['id']}", json={"due_at": None})
    assert patched.status_code == 200
    assert patched.json()["task"]["next_due_at"] is None

    body = family.get("/maintenance/calendar.ics").text
    assert f"UID:homeledger-maintenance-{task['id']}@homeledger" in body
    assert "未设置到期日" in body
    assert "换无期限滤芯" in body
