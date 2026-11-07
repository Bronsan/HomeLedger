"""Request-scoped dependencies: authentication and authorisation."""

from __future__ import annotations

import re

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_db
from .models import Family, Membership, User
from .permissions import PermissionDenied, Principal, effective_permissions
from .security import decode_token


def _bearer(request: Request, authorization: str | None = Header(default=None)) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    # Browser media and downloads cannot attach headers. Never accept a URL
    # credential for generic API reads or for any mutation.
    if request.method == "GET" and query_token_path(request.url.path):
        return request.query_params.get("token")
    return None


def query_token_path(path: str) -> bool:
    return bool(re.fullmatch(
        r"/api/v1/(?:attachments/[^/]+/raw|auth/avatar/[^/]+|"
        r"items/[^/]+/(?:qr\.png|label\.svg)|labels/(?:sheet|batch\.zip)|"
        r"items/export\.csv|system/export\.json|system/backups/[^/]+/download)",
        path,
    ))


def current_user(
    request: Request,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token = _bearer(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "未登录")
    payload = decode_token(token)
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录已过期，请重新登录")
    user = db.get(User, payload.get("sub", ""))
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不可用")
    if payload["ver"] != user.token_version:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "会话已失效，请重新登录")
    request.state.user = user
    request.state.token = token
    return user


def require_instance_admin(user: User = Depends(current_user)) -> User:
    if not user.is_instance_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "此操作仅限实例管理员")
    return user


def resolve_family(
    request: Request,
    db: Session,
    user: User,
    family_id: str | None = None,
) -> Family:
    """Pick the family for this request.

    The client sends `X-Family-Id` when a user belongs to more than one
    household; otherwise we fall back to their first membership. Multi-family
    support exists from day one because retrofitting a tenant column is painful.
    """
    header_family = family_id or request.headers.get("x-family-id")
    if not header_family and query_token_path(request.url.path):
        header_family = request.query_params.get("family_id")
    stmt = select(Membership).where(
        Membership.user_id == user.id, Membership.status == "active"
    )
    memberships = list(db.execute(stmt).scalars())
    if not memberships:
        raise HTTPException(status.HTTP_409_CONFLICT, "你还没有加入任何家庭")
    membership = None
    if header_family:
        membership = next((m for m in memberships if m.family_id == header_family), None)
        if membership is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "无权访问所选家庭")
    if membership is None:
        membership = memberships[0]
    family = db.get(Family, membership.family_id)
    if not family or family.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "家庭不存在")
    request.state.membership = membership
    request.state.family = family
    return family


def get_principal(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Principal:
    family = resolve_family(request, db, user)
    membership: Membership = request.state.membership
    perms = effective_permissions(membership.role, membership.permission_overrides)
    return Principal(
        user_id=user.id,
        display_name=user.display_name,
        family_id=family.id,
        role=membership.role,
        is_owner=membership.role == "owner",
        permissions=perms,
    )


def require(permission: str):
    def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        if not principal.can(permission):
            # Raising PermissionDenied (not HTTPException) keeps the error body
            # structured: {detail, permission, code}. The UI can then point at
            # the exact capability that is missing instead of a generic 403.
            raise PermissionDenied(permission)
        return principal

    return _dep


def client_meta(request: Request) -> tuple[str, str]:
    ip = request.client.host if request.client else ""
    return ip, (request.headers.get("user-agent") or "")[:250]
