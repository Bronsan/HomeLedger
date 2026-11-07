"""Authentication, session lifecycle and household onboarding."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.security import hash_password

API = "/api/v1"


def test_register_bootstraps_family_and_owner_role(client: TestClient):
    email = f"new-{uuid.uuid4().hex[:6]}@homeledger.test"
    r = client.post(
        f"{API}/auth/register",
        json={
            "email": email,
            "password": "a-long-enough-password",
            "display_name": "小明",
            "family_name": "新家",
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["token"]
    assert body["current_family_id"]

    me = client.get(
        f"{API}/auth/me",
        headers={"Authorization": f"Bearer {body['token']}"},
    ).json()
    assert me["role"] == "owner"
    assert me["families"][0]["name"] == "新家"
    # An owner must never be locked out of their own household.
    assert "system.restore" in me["permissions"]
    assert "system.deploy" in me["permissions"]


def test_register_rejects_duplicate_email(client: TestClient, owner):
    r = client.post(
        f"{API}/auth/register",
        json={
            "email": "owner@homeledger.test",
            "password": "another-password",
            "display_name": "冒名者",
        },
    )
    assert r.status_code == 409


def test_register_rejects_short_password(client: TestClient):
    r = client.post(
        f"{API}/auth/register",
        json={"email": "short@homeledger.test", "password": "123", "display_name": "短"},
    )
    assert r.status_code == 422


def test_self_hosted_email_shapes_are_accepted(client: TestClient):
    """A home server has no public DNS name; `family@example.com` must be valid."""
    email = f"lan-{uuid.uuid4().hex[:5]}@home.lan"
    r = client.post(
        f"{API}/auth/register",
        json={"email": email, "password": "a-long-enough-password", "display_name": "老爸"},
    )
    assert r.status_code == 201, r.text


def test_service_mode_accepts_only_whitelisted_domains(client: TestClient, monkeypatch):
    """The hosted account service is QQ-only by default and stores no family."""
    from app.config import settings

    monkeypatch.setattr(settings, "service_mode", True)
    # Starlette's State routes writes into a private dict, so pytest's
    # monkeypatch cannot restore an attribute it set there. Restore it by hand.
    previous = client.app.state.service_mode
    client.app.state.service_mode = True
    monkeypatch.setattr(settings, "email_domains", "")
    try:
        _assert_service_mode_domains(client)
    finally:
        client.app.state.service_mode = previous


def _assert_service_mode_domains(client: TestClient) -> None:
    rejected = client.post(
        f"{API}/auth/register",
        json={
            "email": f"outside-{uuid.uuid4().hex[:6]}@example.com",
            "password": "a-long-enough-password",
            "display_name": "外部邮箱",
        },
    )
    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "邮箱格式不正确"

    accepted = client.post(
        f"{API}/auth/register",
        json={
            "email": f"qq-{uuid.uuid4().hex[:6]}@qq.com",
            "password": "a-long-enough-password",
            "display_name": "QQ 用户",
        },
    )
    assert accepted.status_code == 201, accepted.text
    # Account service only: no household rows are created here.
    assert accepted.json()["current_family_id"] is None


def test_login_rejects_wrong_password(client: TestClient):
    r = client.post(
        f"{API}/auth/login",
        json={"email": "owner@homeledger.test", "password": "wrong-password"},
    )
    assert r.status_code == 401


def test_login_is_case_insensitive_on_email(client: TestClient):
    r = client.post(
        f"{API}/auth/login",
        json={"email": "OWNER@HomeLedger.test", "password": "correct-horse-battery"},
    )
    assert r.status_code == 200


def test_missing_or_garbage_token_is_401(client: TestClient):
    assert client.get(f"{API}/items").status_code == 401
    assert (
        client.get(f"{API}/items", headers={"Authorization": "Bearer nope"}).status_code == 401
    )


def test_token_query_parameter_works_for_image_tags(client: TestClient, owner):
    """`<img>` cannot set headers, so the same JWT is accepted via ?token=."""
    item = owner.create_item()
    r = client.get(f"{API}/items/{item['id']}/qr.png?token={owner.token}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_registration_counter_ignores_invited_placeholders(client: TestClient, family):
    """Only accounts that can sign in count; invite shells are not registrations."""
    before = client.get(f"{API}/system/stats").json()["registered_users"]

    family.invite(f"placeholder-{uuid.uuid4().hex[:6]}@homeledger.test", "member")
    assert client.get(f"{API}/system/stats").json()["registered_users"] == before

    email = f"real-{uuid.uuid4().hex[:6]}@homeledger.test"
    r = client.post(
        f"{API}/auth/register",
        json={
            "email": email,
            "password": "a-long-enough-password",
            "display_name": "新成员",
        },
    )
    assert r.status_code == 201, r.text
    assert client.get(f"{API}/system/stats").json()["registered_users"] == before + 1


def test_password_change_invalidates_existing_sessions(client: TestClient, owner):
    email = f"rotate-{uuid.uuid4().hex[:6]}@homeledger.test"
    reg = client.post(
        f"{API}/auth/register",
        json={
            "email": email,
            "password": "original-password",
            "display_name": "改密用户",
            "family_name": "改密家庭",
        },
    ).json()
    token = reg["token"]

    r = client.post(
        f"{API}/auth/change-password",
        json={"current_password": "original-password", "new_password": "brand-new-password"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200

    # The old token carries the previous token_version and must be rejected.
    assert client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401

    relogin = client.post(
        f"{API}/auth/login", json={"email": email, "password": "brand-new-password"}
    )
    assert relogin.status_code == 200


def test_wrong_current_password_is_rejected(client: TestClient, owner):
    r = owner.post(
        "/auth/change-password",
        json={"current_password": "not-my-password", "new_password": "another-password"},
    )
    assert r.status_code == 400


def test_join_family_with_invite_code(client: TestClient, family):
    invite = family.get("/families/current").json()["invite_code"]
    r = client.post(
        f"{API}/auth/register",
        json={
            "email": f"join-{uuid.uuid4().hex[:6]}@homeledger.test",
            "password": "a-long-enough-password",
            "display_name": "新成员",
            "invite_code": invite,
        },
    )
    assert r.status_code == 201
    body = r.json()
    me = client.get(
        f"{API}/auth/me", headers={"Authorization": f"Bearer {body['token']}"}
    ).json()
    assert me["role"] == "member"
    assert me["families"][0]["id"] == family.family_id


def test_join_with_bad_invite_code_is_404(client: TestClient):
    r = client.post(
        f"{API}/auth/register",
        json={
            "email": f"bad-{uuid.uuid4().hex[:6]}@homeledger.test",
            "password": "a-long-enough-password",
            "display_name": "陌生人",
            "invite_code": "NOPE0000",
        },
    )
    assert r.status_code == 404


def test_multi_family_switching_uses_header(client: TestClient, owner):
    a = owner.post("/families", json={"name": "老家"}).json()["family"]
    b = owner.post("/families", json={"name": "海边小屋"}).json()["family"]
    assert a["id"] != b["id"]

    item_a = owner.as_family(a["id"]).create_item(name="只属于老家")
    names_b = [i["name"] for i in owner.as_family(b["id"]).get("/items").json()["items"]]
    assert "只属于老家" not in names_b

    me = owner.as_family(a["id"]).get("/auth/me").json()
    assert me["current_family_id"] == a["id"]
    assert {f["id"] for f in me["families"]} >= {a["id"], b["id"]}
    # Cross-tenant reads must 404 rather than leak the record.
    assert owner.as_family(b["id"]).get(f"/items/{item_a['id']}").status_code == 404


def test_user_without_membership_gets_actionable_error(client: TestClient):
    """A user removed from every household must get a clear message, not a 500."""
    from sqlalchemy import delete

    from app.db import provider
    from app.models import Membership

    email = f"lonely-{uuid.uuid4().hex[:6]}@homeledger.test"
    reg = client.post(
        f"{API}/auth/register",
        json={"email": email, "password": "a-long-enough-password", "display_name": "独行"},
    ).json()
    token = reg["token"]
    headers = {"Authorization": f"Bearer {token}"}

    with provider.transaction() as db:
        db.execute(delete(Membership).where(Membership.user_id == reg["user"]["id"]))

    r = client.get(f"{API}/items", headers=headers)
    assert r.status_code == 409
    assert "还没有加入任何家庭" in r.json()["detail"]


def test_unknown_family_header_is_rejected(client: TestClient, owner):
    """Explicitly selecting an unauthorized household must never silently rebind."""
    r = client.get(
        f"{API}/items",
        headers={"Authorization": f"Bearer {owner.token}", "X-Family-Id": "does-not-exist"},
    )
    assert r.status_code == 403


def test_invited_placeholder_can_set_password_and_login(client: TestClient, family):
    email = f"placeholder-{uuid.uuid4().hex[:6]}@homeledger.test"
    member = family.invite(email, "member")

    login = client.post(
        f"{API}/auth/login", json={"email": email, "password": "anything"}
    )
    assert login.status_code == 401  # placeholder hash is not a real password

    # Simulate the invitee accepting the invite and choosing a password.
    from sqlalchemy import select

    from app.db import provider
    from app.models import User

    with provider.transaction() as db:
        user = db.execute(select(User).where(User.id == member["user_id"])).scalar_one()
        user.password_hash = hash_password("chosen-by-invitee")
        user.token_version += 1

    login = client.post(
        f"{API}/auth/login", json={"email": email, "password": "chosen-by-invitee"}
    )
    assert login.status_code == 200
    assert login.json()["current_family_id"] == family.family_id
