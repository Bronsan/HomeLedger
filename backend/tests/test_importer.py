"""CSV importer: dry runs, header aliases, taxonomy creation and error rows."""

from __future__ import annotations


def test_dry_run_previews_without_writing(family):
    before = family.get("/items/facets").json()["total"]
    r = family.post(
        "/items/import",
        json={
            "rows": [{"name": "预检物品", "category": "厨房", "location": "厨房"}],
            "dry_run": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 1
    assert body["preview"][0]["name"] == "预检物品"
    assert body["preview"][0]["code"].startswith("HL-")
    assert family.get("/items/facets").json()["total"] == before


def test_chinese_headers_are_mapped(family):
    r = family.post(
        "/items/import",
        json={
            "rows": [
                {
                    "名称": "电饭煲",
                    "品牌": "象印",
                    "型号": "NP-HQ10",
                    "数量": "1",
                    "价格": "¥1,299.00",
                    "购买日期": "2024/03/05",
                    "保修截止": "2026-03-05",
                    "状态": "在用",
                    "标签": "厨房,常用",
                    "备注": "内胆有轻微划痕",
                }
            ],
            "dry_run": False,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1

    item = family.get("/items", params={"q": "电饭煲"}).json()["items"][0]
    assert item["brand"] == "象印"
    assert item["purchase_price"] == 1299.0
    assert item["purchase_date"] == "2024-03-05"
    assert item["warranty_until"] == "2026-03-05"
    assert item["status"] == "in_use"
    assert set(item["tags"]) == {"厨房", "常用"}


def test_missing_taxonomy_is_created_on_demand(family):
    r = family.post(
        "/items/import",
        json={
            "rows": [{"name": "露营灯", "category": "户外装备", "location": "储藏室"}],
            "dry_run": False,
            "create_missing_taxonomy": True,
        },
    ).json()
    assert r["created"] == 1
    assert "户外装备" in r["new_categories"]
    assert "储藏室" in r["new_locations"]

    cats = family.get("/categories").json()["items"]
    assert any(c["name"] == "户外装备" for c in cats)


def test_missing_taxonomy_can_be_rejected_per_row(family):
    r = family.post(
        "/items/import",
        json={
            "rows": [
                {"name": "正常物品"},
                {"name": "未知分类物品", "category": "不存在的分类"},
            ],
            "dry_run": False,
            "create_missing_taxonomy": False,
        },
    ).json()
    assert r["created"] == 1
    assert len(r["errors"]) == 1
    assert r["errors"][0]["row"] == 3  # header is row 1
    assert "分类" in r["errors"][0]["message"]


def test_rows_without_a_name_are_reported_not_silently_dropped(family):
    r = family.post(
        "/items/import",
        json={"rows": [{"brand": "无名字"}, {"name": "有名字"}], "dry_run": False},
    ).json()
    assert r["created"] == 1
    assert any("名称" in e["message"] for e in r["errors"])


def test_duplicate_codes_inside_one_batch_are_skipped(family):
    existing = family.create_item(name="已存在", code="HL-777001")
    r = family.post(
        "/items/import",
        json={
            "rows": [
                {"name": "重复编号", "code": "HL-777001"},
                {"name": "新编号", "code": "HL-777002"},
            ],
            "dry_run": False,
        },
    ).json()
    assert r["created"] == 1
    assert r["skipped"] == 1
    assert any("已存在" in e["message"] for e in r["errors"])
    assert family.get(f"/items/{existing['id']}").json()["item"]["name"] == "已存在"


def test_import_is_family_scoped(family, owner):
    other = owner.post("/families", json={"name": "另一个家庭"}).json()["family"]
    family.post("/items/import", json={"rows": [{"name": "只导入这家"}], "dry_run": False})

    names = [i["name"] for i in owner.as_family(other["id"]).get("/items").json()["items"]]
    assert "只导入这家" not in names
