"""Role based access control with per-member overrides.

Permissions are flat strings grouped by domain. A role is just a preset bundle;
a membership can additionally grant or deny individual permissions. Deny always
wins over grant, which always wins over the role preset. This makes it possible
to express "a member who may edit items but not delete them" without inventing
a new role.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

# --- permission catalogue ---------------------------------------------------
ITEM_VIEW = "item.view"
ITEM_CREATE = "item.create"
ITEM_UPDATE = "item.update"
ITEM_ARCHIVE = "item.archive"
ITEM_DELETE = "item.delete"
ITEM_LOAN = "item.loan"

DOC_VIEW = "doc.view"
DOC_UPLOAD = "doc.upload"
DOC_DOWNLOAD = "doc.download"
DOC_DELETE = "doc.delete"

MAINT_VIEW = "maintenance.view"
MAINT_CREATE = "maintenance.create"
MAINT_COMPLETE = "maintenance.complete"
MAINT_UPDATE = "maintenance.update"

MEMBER_VIEW = "member.view"
MEMBER_INVITE = "member.invite"
MEMBER_UPDATE = "member.update"
MEMBER_DISABLE = "member.disable"

SYSTEM_BACKUP = "system.backup"
SYSTEM_RESTORE = "system.restore"
SYSTEM_EXPORT = "system.export"
SYSTEM_DEPLOY = "system.deploy"
SYSTEM_AUDIT = "system.audit"

ALL_PERMISSIONS: tuple[str, ...] = (
    ITEM_VIEW, ITEM_CREATE, ITEM_UPDATE, ITEM_ARCHIVE, ITEM_DELETE, ITEM_LOAN,
    DOC_VIEW, DOC_UPLOAD, DOC_DOWNLOAD, DOC_DELETE,
    MAINT_VIEW, MAINT_CREATE, MAINT_COMPLETE, MAINT_UPDATE,
    MEMBER_VIEW, MEMBER_INVITE, MEMBER_UPDATE, MEMBER_DISABLE,
    SYSTEM_BACKUP, SYSTEM_RESTORE, SYSTEM_EXPORT, SYSTEM_DEPLOY, SYSTEM_AUDIT,
)

PERMISSION_GROUPS: dict[str, list[str]] = {
    "物品": [ITEM_VIEW, ITEM_CREATE, ITEM_UPDATE, ITEM_ARCHIVE, ITEM_DELETE, ITEM_LOAN],
    "文档": [DOC_VIEW, DOC_UPLOAD, DOC_DOWNLOAD, DOC_DELETE],
    "维护": [MAINT_VIEW, MAINT_CREATE, MAINT_COMPLETE, MAINT_UPDATE],
    "成员": [MEMBER_VIEW, MEMBER_INVITE, MEMBER_UPDATE, MEMBER_DISABLE],
    "系统": [SYSTEM_BACKUP, SYSTEM_RESTORE, SYSTEM_EXPORT, SYSTEM_DEPLOY, SYSTEM_AUDIT],
}

PERMISSION_LABELS: dict[str, str] = {
    ITEM_VIEW: "查看物品",
    ITEM_CREATE: "新增物品",
    ITEM_UPDATE: "修改物品",
    ITEM_ARCHIVE: "归档物品",
    ITEM_DELETE: "删除物品",
    ITEM_LOAN: "借出 / 归还",
    DOC_VIEW: "查看文档",
    DOC_UPLOAD: "上传文档",
    DOC_DOWNLOAD: "下载文档",
    DOC_DELETE: "删除文档",
    MAINT_VIEW: "查看维护",
    MAINT_CREATE: "创建维护任务",
    MAINT_COMPLETE: "完成维护任务",
    MAINT_UPDATE: "修改维护计划",
    MEMBER_VIEW: "查看成员",
    MEMBER_INVITE: "邀请成员",
    MEMBER_UPDATE: "调整角色权限",
    MEMBER_DISABLE: "停用成员",
    SYSTEM_BACKUP: "备份数据",
    SYSTEM_RESTORE: "恢复数据",
    SYSTEM_EXPORT: "导出数据",
    SYSTEM_DEPLOY: "查看部署设置",
    SYSTEM_AUDIT: "查看审计日志",
}

# --- roles ------------------------------------------------------------------
ROLE_OWNER = "owner"
ROLE_ADMIN = "admin"
ROLE_MEMBER = "member"
ROLE_VIEWER = "viewer"
ROLE_GUEST = "guest"

ROLE_LABELS = {
    ROLE_OWNER: "家庭所有者",
    ROLE_ADMIN: "家庭管理员",
    ROLE_MEMBER: "普通成员",
    ROLE_VIEWER: "只读成员",
    ROLE_GUEST: "访客",
}

ROLE_RANK = {ROLE_OWNER: 100, ROLE_ADMIN: 80, ROLE_MEMBER: 60, ROLE_VIEWER: 40, ROLE_GUEST: 20}

_ROLE_PRESETS: dict[str, set[str]] = {
    ROLE_OWNER: set(ALL_PERMISSIONS),
    ROLE_ADMIN: {
        ITEM_VIEW, ITEM_CREATE, ITEM_UPDATE, ITEM_ARCHIVE, ITEM_DELETE, ITEM_LOAN,
        DOC_VIEW, DOC_UPLOAD, DOC_DOWNLOAD, DOC_DELETE,
        MAINT_VIEW, MAINT_CREATE, MAINT_COMPLETE, MAINT_UPDATE,
        MEMBER_VIEW, MEMBER_INVITE, MEMBER_UPDATE,
        SYSTEM_BACKUP, SYSTEM_EXPORT, SYSTEM_AUDIT,
    },
    ROLE_MEMBER: {
        ITEM_VIEW, ITEM_CREATE, ITEM_UPDATE, ITEM_LOAN,
        DOC_VIEW, DOC_UPLOAD, DOC_DOWNLOAD,
        MAINT_VIEW, MAINT_CREATE, MAINT_COMPLETE,
        MEMBER_VIEW,
    },
    ROLE_VIEWER: {ITEM_VIEW, DOC_VIEW, DOC_DOWNLOAD, MAINT_VIEW, MEMBER_VIEW},
    ROLE_GUEST: {ITEM_VIEW, DOC_VIEW},
}


@dataclass(frozen=True)
class Principal:
    user_id: str
    display_name: str
    family_id: str
    role: str
    is_owner: bool
    permissions: frozenset[str]

    def can(self, permission: str) -> bool:
        return permission in self.permissions

    def can_any(self, permissions: Iterable[str]) -> bool:
        return any(p in self.permissions for p in permissions)


def effective_permissions(
    role: str, overrides: dict[str, Any] | None = None
) -> frozenset[str]:
    base = set(_ROLE_PRESETS.get(role, _ROLE_PRESETS[ROLE_VIEWER]))
    if overrides:
        for p in overrides.get("grant", []) or []:
            if p in ALL_PERMISSIONS:
                base.add(p)
        for p in overrides.get("deny", []) or []:
            base.discard(p)
    # The owner can never lock themselves out of their own household.
    if role == ROLE_OWNER:
        base.add(SYSTEM_RESTORE)
        base.add(SYSTEM_DEPLOY)
    return frozenset(base)


def role_preset(role: str) -> list[str]:
    return sorted(_ROLE_PRESETS.get(role, set()))


class PermissionDenied(Exception):
    def __init__(self, permission: str):
        self.permission = permission
        super().__init__(f"缺少权限：{PERMISSION_LABELS.get(permission, permission)}")
