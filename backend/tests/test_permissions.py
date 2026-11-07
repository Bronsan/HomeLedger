"""RBAC: role presets, per-member grants/denies, and the owner safeguards."""

from __future__ import annotations

from app.permissions import ALL_PERMISSIONS, ROLE_RANK, effective_permissions


def test_every_role_preset_only_contains_known_permissions():
    for role in ROLE_RANK:
        assert effective_permissions(role, None) <= set(ALL_PERMISSIONS)


def test_deny_overrides_grant_which_overrides_role():
    role_only = effective_permissions("member", None)
    assert "item.update" in role_only

    granted = effective_permissions("member", {"grant": ["system.export"], "deny": []})
    assert "system.export" in granted

    both = effective_permissions("member", {"grant": ["system.export"], "deny": ["system.export"]})
    assert "system.export" not in both

    denied = effective_permissions("member", {"deny": ["item.update"]})
    assert "item.update" not in denied


def test_unknown_permission_in_override_is_ignored():
    perms = effective_permissions("member", {"grant": ["totally.made.up"], "deny": []})
    assert "totally.made.up" not in perms


def test_owner_can_never_lose_restore_and_deploy():
    perms = effective_permissions("owner", {"deny": ["system.restore", "system.deploy"]})
    assert "system.restore" in perms and "system.deploy" in perms


def test_viewer_cannot_create_items(family, member_factory):
    viewer = member_factory("viewer")
    r = viewer.post("/items", json={"name": "只读成员不该能建"})
    assert r.status_code == 403
    assert r.json()["permission"] == "item.create"
    assert r.json()["code"] == "permission_denied"


def test_viewer_can_read_items(family, member_factory):
    family.create_item(name="公开可见")
    viewer = member_factory("viewer")
    r = viewer.get("/items")
    assert r.status_code == 200
    assert any(i["name"] == "公开可见" for i in r.json()["items"])


def test_member_can_create_and_edit_but_not_delete(family, member_factory):
    member = member_factory("member")
    item = member.create_item(name="成员建的")
    assert member.patch(f"/items/{item['id']}", json={"name": "成员改的"}).status_code == 200
    assert member.delete(f"/items/{item['id']}").status_code == 403


def test_member_cannot_reach_system_backup(family, member_factory):
    member = member_factory("member")
    assert member.post("/system/backups", json={"note": "偷偷备份"}).status_code == 403
    assert member.get("/system/backups").status_code == 403


def test_grant_widens_a_role_without_changing_it(family, member_factory):
    """A member who may delete is expressed as member + grant, not a new role."""
    member = member_factory("viewer", permissions={"grant": ["item.create"], "deny": []})
    item = member.create_item(name="被授权的访客")
    assert item["name"] == "被授权的访客"
    assert member.get("/auth/me").json()["role"] == "viewer"


def test_deny_narrows_a_role(family, member_factory):
    member = member_factory("member", permissions={"grant": [], "deny": ["item.update"]})
    item = family.create_item(name="不可编辑")
    r = member.patch(f"/items/{item['id']}", json={"name": "尝试改名"})
    assert r.status_code == 403
    assert r.json()["permission"] == "item.update"


def test_plain_member_cannot_invite_others(family, member_factory):
    member = member_factory("member")
    r = member.post(
        "/families/current/members",
        json={"email": "friend@homeledger.test", "display_name": "朋友", "role": "viewer"},
    )
    assert r.status_code == 403
    assert r.json()["permission"] == "member.invite"


def test_admin_cannot_promote_to_owner_rank(family, member_factory):
    admin = member_factory("admin")
    target = family.invite("promote-me@homeledger.test", "viewer")
    r = admin.patch(
        f"/families/current/members/{target['id']}", json={"role": "owner"}
    )
    assert r.status_code == 403


def test_owner_membership_cannot_be_demoted_or_removed(family):
    members = family.get("/families/current/members").json()["items"]
    owner_row = next(m for m in members if m["role"] == "owner")
    assert family.patch(
        f"/families/current/members/{owner_row['id']}", json={"role": "viewer"}
    ).status_code == 403
    assert family.delete(f"/families/current/members/{owner_row['id']}").status_code == 403


def test_suspended_member_loses_access(client, family, member_factory):
    member = member_factory("member")
    members = family.get("/families/current/members").json()["items"]
    row = next(m for m in members if m["email"].startswith("member-"))
    assert family.patch(
        f"/families/current/members/{row['id']}", json={"status": "suspended"}
    ).status_code == 200

    r = client.get(
        "/api/v1/items",
        headers={"Authorization": f"Bearer {member.token}", "X-Family-Id": family.family_id},
    )
    assert r.status_code == 409  # no active membership left -> explicit message


def test_permission_denied_body_is_machine_readable(family, member_factory):
    viewer = member_factory("viewer")
    r = viewer.post("/items", json={"name": "x"})
    body = r.json()
    assert set(body) >= {"detail", "permission", "code"}
    assert body["code"] == "permission_denied"


def test_permission_meta_matches_catalogue(family):
    meta = family.get("/families/current/permission-meta").json()
    listed = {p["key"] for group in meta["groups"] for p in group["items"]}
    assert listed == set(ALL_PERMISSIONS)
    assert len(meta["roles"]) == len(ROLE_RANK)
    for role in meta["roles"]:
        assert role["label"]
        assert role["permissions"] == sorted(effective_permissions(role["value"], None))
