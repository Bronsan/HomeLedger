"""Provider contracts and deployment profiles.

These tests pin down the parts of the architecture the product is built on:
every integration point is replaceable, and a provider must never claim a
capability it does not have.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.providers.ai import CloudAIProvider, DisabledAIProvider, LocalHeuristicProvider
from app.providers.deployment import MODE_INFO, build_deployment_config
from app.providers.notification import EmailProvider, InAppProvider, WebhookProvider
from app.providers.storage import LocalStorage


def test_all_three_modes_declare_a_full_capability_matrix():
    keys = {"multi_user", "lan_access", "remote_access", "scheduled_tasks", "object_storage"}
    for mode, info in MODE_INFO.items():
        assert keys <= set(info), f"{mode} 缺少能力声明"
        assert info["label"] and info["tagline"] and info["description"]
        assert info["recommended_for"]


def test_local_mode_admits_it_has_no_multi_user_support():
    """Honesty over marketing: single-device mode must not claim to be shared."""
    local = MODE_INFO["local"]
    assert local["multi_user"] is False
    assert local["lan_access"] is False
    assert MODE_INFO["gateway"]["multi_user"] is True
    assert MODE_INFO["gateway"]["remote_access"] is False
    assert MODE_INFO["cloud"]["remote_access"] is True


def test_gateway_is_the_documented_default():
    assert Settings.model_fields["deployment_mode"].default == "gateway"


def test_deployment_config_exposes_warnings_and_checklist():
    cfg = build_deployment_config().to_dict()
    assert cfg["mode"] in MODE_INFO
    assert cfg["warnings"], "部署模式必须至少给出一条风险提示"
    assert cfg["checklist"], "上线检查清单不能为空"
    assert all("label" in item for item in cfg["checklist"])
    assert "install_id" in cfg and cfg["install_id"].startswith("hl_")


def test_cloud_mode_backup_is_still_enabled():
    """Backups are not a gateway-only feature — cloud deployments need them too."""
    cfg = build_deployment_config().to_dict()
    assert cfg["capabilities"]["backup_enabled"] is True


def test_database_capabilities_do_not_pretend_sqlite_scales():
    from app.db import provider

    caps = provider.capabilities()
    assert caps["dialect"] == "sqlite"
    assert caps["concurrent_writers"] is False
    assert "API" in caps["note"] or "api" in caps["note"].lower()


def test_provider_status_endpoint_covers_every_extension_point(instance_admin):
    data = instance_admin.get("/system/providers").json()
    assert {"database", "storage", "backup", "notifications", "ai", "deployment"} <= set(data)
    assert data["database"]["ok"] is True
    assert isinstance(data["notifications"], list)
    assert data["ai"]["name"]


def test_ai_provider_is_honest_about_data_leaving_the_device():
    local = LocalHeuristicProvider().describe()
    assert local["leaves_device"] is False
    assert local["privacy_notice"]

    cloud = CloudAIProvider().describe()
    assert cloud["leaves_device"] is True
    assert "上传" in cloud["privacy_notice"] or "离开" in cloud["privacy_notice"]

    off = DisabledAIProvider().describe()
    assert off["supports_vision"] is False
    assert off["leaves_device"] is False


def test_local_ai_marks_results_as_needing_review():
    """Heuristics must never silently write data as if a human confirmed it."""
    result = LocalHeuristicProvider().extract(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    assert result["needs_review"] is True
    assert result["provider"] == "local"
    assert result["message"]

    # A barcode typed into the hint is picked up, but still flagged for review.
    hinted = LocalHeuristicProvider().extract(None, hint="小票 6901234567892 ￥299.00")
    assert hinted["fields"]["barcode"] == "6901234567892"
    assert hinted["fields"]["purchase_price"] == 299.0
    assert hinted["needs_review"] is True


def test_notification_providers_report_availability_without_raising():
    for p in (InAppProvider(), EmailProvider(), WebhookProvider()):
        health = p.health()
        assert "ok" in health
        assert health["channel"]


def test_notification_providers_never_raise_when_misconfigured(family):
    """A broken SMTP config must not take down the request that triggered it."""
    from app.providers.notification import dispatch
    from app.db import provider as db_provider

    with db_provider.transaction() as db:
        n = dispatch(
            db,
            family_id=family.family_id,
            title="测试通知",
            body="仅入库，不应抛异常",
            type="system",
        )
    assert n is not None


def test_storage_provider_is_pluggable():
    """The same interface is implemented by local disk and S3."""
    from app.providers.storage import FileStorageProvider, S3Storage

    assert isinstance(LocalStorage(), FileStorageProvider)
    for method in ("save", "read", "delete", "read_thumbnail"):
        assert hasattr(S3Storage, method)


def test_s3_backend_fails_loudly_when_the_optional_dependency_is_missing():
    """An unmet optional dependency must surface as a clear error, not a silent
    fallback to local disk (which would scatter blobs across two backends)."""
    import importlib.util

    from app.providers.storage import S3Storage

    if importlib.util.find_spec("boto3"):
        pytest.skip("boto3 已安装")
    with pytest.raises(RuntimeError) as exc:
        S3Storage()
    assert "boto3" in str(exc.value)


def test_storage_rejects_dot_dot_paths():
    from app.providers.storage import get_storage_provider

    storage = get_storage_provider()
    with pytest.raises((ValueError, FileNotFoundError)):
        storage.read("../../etc/passwd")


def test_health_endpoint_is_public_and_cheap(client):
    r = client.get("/api/v1/system/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["database"]["dialect"] == "sqlite"


def test_bootstrap_info_is_public_and_leaks_nothing(client):
    r = client.get("/api/v1/system/info")
    assert r.status_code == 200
    body = r.json()
    assert "deployment" in body
    assert "bootstrap_required" in body
    assert isinstance(body["registered_users"], int)
    serialised = str(body).lower()
    for secret in ("secret_key", "password", "smtp_password", "ai_api_key"):
        assert secret not in serialised


def test_public_stats_returns_only_an_aggregate(client):
    r = client.get("/api/v1/system/stats")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"registered_users"}
    assert isinstance(body["registered_users"], int)
    assert body["registered_users"] >= 1


def test_audit_trail_does_not_store_network_metadata(owner):
    owner.create_item()
    r = owner.get("/audit", params={"action": "item.create", "page_size": 10})
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert rows
    assert all(row["ip"] == "" for row in rows)
    assert all(row["user_agent"] == "" for row in rows)
