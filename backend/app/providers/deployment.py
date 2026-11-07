"""Deployment profile.

The same image runs in three modes. Rather than sprinkling `if mode == ...` all
over the codebase, the mode declares a capability matrix that the UI reads to
decide which features to expose and which warnings to show.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..config import settings

MODE_INFO = {
    "local": {
        "label": "本地单机",
        "tagline": "数据不离开这台设备",
        "description": "服务和数据库都跑在当前设备上，适合个人先开始整理。",
        "multi_user": False,
        "lan_access": False,
        "remote_access": False,
        "scheduled_tasks": False,
        "object_storage": False,
        "recommended_for": "个人 / 隐私优先 / 离线整理",
    },
    "gateway": {
        "label": "家庭网关",
        "tagline": "全家共用一份数据",
        "description": "常驻在家中的 NAS、迷你主机或旧电脑上，局域网内多成员同时使用。",
        "multi_user": True,
        "lan_access": True,
        "remote_access": False,
        "scheduled_tasks": True,
        "object_storage": False,
        "recommended_for": "家庭首选",
    },
    "cloud": {
        "label": "云服务器",
        "tagline": "异地访问与远程协作",
        "description": "部署在云主机上，支持家庭成员跨网络访问，可对接对象存储。",
        "multi_user": True,
        "lan_access": True,
        "remote_access": True,
        "scheduled_tasks": True,
        "object_storage": True,
        "recommended_for": "异地家庭 / 远程访问",
    },
}


@dataclass
class DeploymentConfig:
    mode: str
    label: str
    tagline: str
    description: str
    capabilities: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    checklist: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "label": self.label,
            "tagline": self.tagline,
            "description": self.description,
            "capabilities": self.capabilities,
            "warnings": self.warnings,
            "checklist": self.checklist,
            "database": settings.resolved_database_url.split(":", 1)[0],
            "storage": settings.storage_backend,
            "install_id": settings.resolved_install_id,
            "version": settings.app_version,
        }


def build_deployment_config() -> DeploymentConfig:
    mode = settings.deployment_mode if settings.deployment_mode in MODE_INFO else "gateway"
    info = MODE_INFO[mode]
    caps = {k: v for k, v in info.items() if isinstance(v, bool)}
    caps["object_storage"] = settings.storage_backend == "s3"
    caps["https_required"] = mode == "cloud"
    caps["backup_enabled"] = True

    warnings: list[str] = []
    checklist: list[dict] = []

    if mode == "gateway":
        warnings.append(
            "远程访问请通过 VPN 或反向代理加 HTTPS，不要把管理端口直接暴露到公网。"
        )
        checklist = [
            {"key": "static_ip", "label": "网关已设置固定内网 IP", "done": False},
            {"key": "backup", "label": "已配置每日自动备份并验证可恢复", "done": False},
            {"key": "ups", "label": "网关接入 UPS 或断电保护", "done": False},
            {"key": "https", "label": "如开启外网访问，已配置 HTTPS 与访问控制", "done": False},
        ]
    elif mode == "local":
        warnings.append("单机模式下其它设备无法实时共享数据；建议定期导出备份。")
        checklist = [
            {"key": "backup", "label": "已设置本地备份目录", "done": False},
            {"key": "disk", "label": "数据盘有足够剩余空间", "done": False},
        ]
    else:
        warnings.append("云端部署需自行负责 TLS 终止、数据库备份与访问审计。")
        checklist = [
            {"key": "tls", "label": "已启用 HTTPS", "done": False},
            {"key": "db", "label": "已使用 PostgreSQL 并配置备份", "done": False},
            {"key": "secret", "label": "已设置独立的 HOMELEDGER_SECRET_KEY", "done": False},
        ]
    if not settings.secret_key:
        warnings.append("当前使用自动生成的密钥，多实例部署时请显式设置 HOMELEDGER_SECRET_KEY。")

    return DeploymentConfig(
        mode=mode,
        label=info["label"],
        tagline=info["tagline"],
        description=info["description"],
        capabilities=caps,
        warnings=warnings,
        checklist=checklist,
    )


def get_deployment_config() -> DeploymentConfig:
    return build_deployment_config()
