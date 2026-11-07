"""Shared pytest fixtures.

The application reads its configuration from the environment *at import time*,
so the temp data directory has to be installed before `app.main` is imported.
That is why the environment setup sits at module level rather than in a fixture.

Every test module gets its own family (tenant) instead of its own database:
the row level `family_id` filter is the isolation boundary the product actually
relies on, so exercising it is more valuable than resetting the DB between
tests. A handful of tests that need a pristine database (backup/restore) build
their own family instead.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from typing import Any

_TMP_ROOT = tempfile.mkdtemp(prefix="homeledger-tests-")

os.environ["HOMELEDGER_DATA_DIR"] = os.path.join(_TMP_ROOT, "data")
os.environ["HOMELEDGER_SECRET_KEY"] = "test-secret-key-do-not-use-in-production"
os.environ["HOMELEDGER_ENABLE_SCHEDULER"] = "false"
os.environ["HOMELEDGER_ALLOW_REGISTRATION"] = "true"
os.environ["HOMELEDGER_SERVE_FRONTEND"] = "false"
os.environ["HOMELEDGER_DEPLOYMENT_MODE"] = "gateway"
os.environ["HOMELEDGER_AI_PROVIDER"] = "local"
os.environ["HOMELEDGER_NOTIFICATION_CHANNELS"] = "inapp"
os.environ["HOMELEDGER_LOG_LEVEL"] = "WARNING"
os.environ["HOMELEDGER_AUTH_RATE_LIMIT"] = "0"
os.environ["HOMELEDGER_AUTH_ACCOUNT_RATE_LIMIT"] = "0"
os.environ["HOMELEDGER_SERVICE_MODE"] = "false"
os.environ["HOMELEDGER_EMAIL_DOMAINS"] = ""
os.environ["HOMELEDGER_DATABASE_URL"] = ""
os.environ["HOMELEDGER_STORAGE_BACKEND"] = "local"
os.environ["HOMELEDGER_DESKTOP_SHELL"] = "false"

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.security import create_access_token, hash_password

API = "/api/v1"


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


class Api:
    """Thin per-identity wrapper that carries token and family header."""

    def __init__(self, client: TestClient, token: str, family_id: str | None = None):
        self._c = client
        self.token = token
        self.family_id = family_id

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"Authorization": f"Bearer {self.token}"}
        if self.family_id:
            h["X-Family-Id"] = self.family_id
        if extra:
            h.update(extra)
        return h

    def get(self, path: str, **kw: Any):
        return self._c.get(f"{API}{path}", headers=self._headers(), **kw)

    def post(self, path: str, **kw: Any):
        return self._c.post(f"{API}{path}", headers=self._headers(), **kw)

    def patch(self, path: str, **kw: Any):
        return self._c.patch(f"{API}{path}", headers=self._headers(), **kw)

    def delete(self, path: str, **kw: Any):
        return self._c.delete(f"{API}{path}", headers=self._headers(), **kw)

    def as_family(self, family_id: str) -> "Api":
        return Api(self._c, self.token, family_id)

    # -- helpers -----------------------------------------------------------
    def create_item(self, **overrides: Any) -> dict:
        payload = {"name": f"测试物品-{uuid.uuid4().hex[:6]}"}
        payload.update(overrides)
        r = self.post("/items", json=payload)
        assert r.status_code == 201, r.text
        return r.json()["item"]

    def create_location(self, name: str, parent_id: str | None = None) -> dict:
        r = self.post("/locations", json={"name": name, "parent_id": parent_id, "kind": "room"})
        assert r.status_code == 201, r.text
        return r.json()["location"]

    def create_category(self, name: str) -> dict:
        r = self.post("/categories", json={"name": name})
        assert r.status_code == 201, r.text
        return r.json()["category"]

    def invite(self, email: str, role: str) -> dict:
        r = self.post(
            "/families/current/members",
            json={"email": email, "display_name": email.split("@")[0], "role": role},
        )
        assert r.status_code == 201, r.text
        return r.json()["member"]


def _register(client: TestClient, email: str, family_name: str) -> dict:
    r = client.post(
        f"{API}/auth/register",
        json={
            "email": email,
            "password": "correct-horse-battery",
            "display_name": family_name,
            "family_name": family_name,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture(scope="session")
def owner_token(client) -> dict:
    data = _register(client, "owner@homeledger.test", "测试家庭")
    return data


@pytest.fixture(scope="session")
def owner(client, owner_token) -> Api:
    return Api(client, owner_token["token"], owner_token["current_family_id"])


@pytest.fixture(scope="session")
def instance_admin(client) -> Api:
    from app.db import provider
    from app.models import User
    with provider.transaction() as db:
        user = User(email="instance-admin@homeledger.test", display_name="实例管理员",
                    password_hash=hash_password("test-admin-password"), is_instance_admin=True)
        db.add(user)
        db.flush()
        token, _ = create_access_token(user.id, user.token_version)
    return Api(client, token)


@pytest.fixture()
def family(owner: Api) -> Api:
    """A fresh, empty tenant for one test."""
    r = owner.post("/families", json={"name": f"家庭-{uuid.uuid4().hex[:6]}"})
    assert r.status_code == 201, r.text
    fid = r.json()["family"]["id"]
    return owner.as_family(fid)


@pytest.fixture()
def member_factory(family: Api, client):
    """Create a family member with a given role and return an authenticated client."""

    def _make(role: str, permissions: dict | None = None) -> Api:
        email = f"{role}-{uuid.uuid4().hex[:6]}@homeledger.test"
        member = family.invite(email, role)
        user_id = member["user_id"]
        if permissions:
            family.patch(
                f"/families/current/members/{member['id']}",
                json={"permission_overrides": permissions},
            )
        # Placeholder accounts are inserted with token_version=1 (model default).
        token, _ = create_access_token(user_id, 1)
        api = Api(client, token, family.family_id)
        api.user_id = user_id  # type: ignore[attr-defined]
        return api

    return _make


@pytest.fixture(scope="session", autouse=True)
def _cleanup():
    yield
    if not os.environ.get("HOMELEDGER_KEEP_TEST_DATA"):
        shutil.rmtree(_TMP_ROOT, ignore_errors=True)


# `hash_password` is imported so a test can seed a real password on an invited
# placeholder account without going through the UI flow.
__all__ = ["Api", "client", "owner", "family", "member_factory", "hash_password", "settings"]
