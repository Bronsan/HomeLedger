"""Accounts, sessions and family membership."""

from __future__ import annotations

import base64
import binascii
from io import BytesIO
import warnings

from PIL import Image, UnidentifiedImageError

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from datetime import timedelta
from sqlalchemy.orm import Session

from ..audit import record
from ..config import settings
from ..db import get_db
from ..deps import current_user, get_principal, require
from ..models import Family, Membership, User, utcnow
from ..permissions import (
    ALL_PERMISSIONS,
    MEMBER_VIEW,
    PERMISSION_GROUPS,
    PERMISSION_LABELS,
    ROLE_LABELS,
    ROLE_RANK,
    Principal,
    effective_permissions,
    role_preset,
)
from ..providers.deployment import get_deployment_config
from ..providers.storage import get_storage_provider
from ..providers.identity import get_identity_provider
from ..schemas import (
    ChangePasswordIn,
    FamilyCreateIn,
    FamilyUpdateIn,
    LoginIn,
    MemberInviteIn,
    MemberUpdateIn,
    ProfileUpdateIn,
    RegisterIn,
)
from ..rate_limit import check_auth_rate
from ..security import create_access_token, hash_password, make_invite_code, verify_password
from ..seed import seed_taxonomy
from ..serializers import family_out, member_out, user_public

router = APIRouter(tags=["auth"])
_DUMMY_HASH = hash_password("not-a-login-" + make_invite_code(24))

# 邀请码时效：生成/重置起 5 分钟内有效。短的寿命是故意的——它是临时口令，
# 不是长期凭据；过期重新生成比事后撤销便宜得多。
INVITE_TTL = timedelta(minutes=5)


def _new_invite() -> dict:
    return {"code": make_invite_code(), "expires_at": utcnow() + INVITE_TTL}


def _invite_expired(family: Family) -> bool:
    return (
        family.invite_expires_at is not None and family.invite_expires_at < utcnow()
    )


def _bootstrap_family(db: Session, user: User, name: str | None) -> Family:
    invite = _new_invite()
    family = Family(
        name=name or f"{user.display_name}的家",
        invite_code=invite["code"],
        invite_expires_at=invite["expires_at"],
        created_by=user.id,
        deployment_mode=settings.deployment_mode,
    )
    db.add(family)
    db.flush()
    db.add(Membership(family_id=family.id, user_id=user.id, role="owner"))
    seed_taxonomy(db, family.id, user.id)
    return family


@router.post("/auth/register", status_code=201)
def register(payload: RegisterIn, request: Request, db: Session = Depends(get_db)) -> dict:
    check_auth_rate(request, "register", payload.email)
    existing = db.execute(select(User).where(User.email == payload.email.lower())).scalar_one_or_none()
    is_first_user = db.execute(select(func.count(User.id))).scalar() == 0
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "该邮箱已注册")
    if not settings.allow_registration and not is_first_user:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "此部署已关闭自助注册，请联系家庭管理员")

    allowed_domains = settings.allowed_email_domains
    if allowed_domains:
        domain = payload.email.rsplit("@", 1)[-1].lower()
        if domain not in allowed_domains:
            # Deliberately generic: the client does not tell people which
            # mailbox providers are accepted, and neither does the server.
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "邮箱格式不正确")

    user = User(
        email=payload.email.lower(),
        display_name=payload.display_name.strip(),
        password_hash=hash_password(payload.password),
        is_instance_admin=False,
    )
    db.add(user)
    db.flush()

    joined: Family | None = None
    if request.app.state.service_mode:
        # The hosted account service manages accounts, not households. Creating
        # an empty family and taxonomy for every registration would store
        # exactly the kind of data the service promises not to keep.
        pass
    elif payload.invite_code:
        family = db.execute(
            select(Family).where(
                Family.invite_code == payload.invite_code.strip().upper(),
                Family.deleted_at.is_(None),
            )
        ).scalar_one_or_none()
        if not family:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "邀请码无效")
        if _invite_expired(family):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "邀请码已过期（有效期 5 分钟），请让对方重新生成",
            )
        db.add(Membership(family_id=family.id, user_id=user.id, role="member"))
        joined = family
    else:
        joined = _bootstrap_family(db, user, payload.family_name)

    record(
        db,
        None,
        "auth.register",
        entity_type="user",
        entity_id=user.id,
        summary=f"新用户注册：{user.display_name}",
        request=request,
        family_id=joined.id if joined else "",
        actor_name=user.display_name,
    )
    db.commit()
    token, expires_in = create_access_token(user.id, user.token_version)
    return {
        "token": token,
        "expires_in": expires_in,
        "user": user_public(user),
        "current_family_id": joined.id if joined else None,
    }


@router.post("/auth/login")
def login(payload: LoginIn, request: Request, db: Session = Depends(get_db)) -> dict:
    check_auth_rate(request, "login", payload.email)
    user = db.execute(select(User).where(User.email == payload.email.lower())).scalar_one_or_none()
    identity = get_identity_provider()
    # Equal-cost work for unknown accounts; never save a dummy user.
    encoded = user.password_hash if user and user.password_hash != "!" else _DUMMY_HASH
    valid = identity.validate_credentials(payload.email, payload.password, encoded)
    if not user or user.password_hash == "!" or not valid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "邮箱或密码不正确")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "账号已停用")
    user.last_login_at = utcnow()
    db.commit()
    token, expires_in = create_access_token(user.id, user.token_version)
    memberships = list(
        db.execute(
            select(Membership, Family)
            .join(Family, Family.id == Membership.family_id)
            .where(Membership.user_id == user.id, Membership.status == "active")
        ).all()
    )
    return {
        "token": token,
        "expires_in": expires_in,
        "user": user_public(user),
        "current_family_id": memberships[0][1].id if memberships else None,
    }


@router.get("/auth/me")
def me(request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    if request.app.state.service_mode:
        return {"user": user_public(user), "families": [], "current_family_id": None,
                "role": None, "permissions": [], "service_mode": True}
    rows = db.execute(
        select(Membership, Family)
        .join(Family, Family.id == Membership.family_id)
        .where(Membership.user_id == user.id, Membership.status == "active", Family.deleted_at.is_(None))
        .order_by(Membership.joined_at)
    ).all()

    header_family = request.headers.get("x-family-id")
    current = None
    if header_family and not any(f.id == header_family for _, f in rows):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "无权访问所选家庭")
    if rows:
        current = next((r for r in rows if r[1].id == header_family), rows[0])
    memberships = [family_out(f, m) for m, f in rows]

    perms: list[str] = []
    role = None
    if current:
        role = current[0].role
        perms = sorted(effective_permissions(role, current[0].permission_overrides))

    return {
        "user": user_public(user),
        "families": memberships,
        "current_family_id": current[1].id if current else None,
        "role": role,
        "permissions": perms,
        "deployment": get_deployment_config().to_dict(),
        "identity": get_identity_provider().describe(),
    }


@router.patch("/auth/me")
def update_profile(
    payload: ProfileUpdateIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    if payload.display_name:
        user.display_name = payload.display_name.strip()
    if payload.avatar_color:
        user.avatar_color = payload.avatar_color
    if payload.locale:
        user.locale = payload.locale
    if payload.avatar_data is not None:
        if request.app.state.service_mode:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "账号服务不接收文件或头像")
        _set_avatar(db, user, payload.avatar_data)
    db.commit()
    return {"user": user_public(user)}


# 自定义头像：前端把图片读成 data URL 传上来（两种模式同一入口）。
# 后端解码校验后走 storage provider 落盘，用户行只存相对路径；
# 其他设备/成员经 GET /auth/avatar/{id} 取图。None = 清除头像。
_AVATAR_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
_AVATAR_MAX_BYTES = 1_000_000  # 解码后的原始大小上限；头像不是相册


def _set_avatar(db: Session, user: User, avatar_data: str | None) -> None:
    if avatar_data == "":
        # 清除：文件一并删，行上路径清空
        if user.avatar_path:
            try:
                get_storage_provider().delete(user.avatar_path)
            except Exception:
                pass  # 文件没了不拦记录清理，与附件同一口径
        user.avatar_path = None
        return
    if not avatar_data:
        return
    head, _, b64 = avatar_data.partition(",")
    if not head.startswith("data:") or not b64:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "头像数据格式不正确")
    mime = head[5:].split(";", 1)[0].lower()
    ext = _AVATAR_TYPES.get(mime)
    if not ext:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "头像只支持 JPG / PNG / WebP")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "头像数据解码失败")
    if len(raw) > _AVATAR_MAX_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "头像图片超过 1MB，请换小一点的")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as image:
                if image.width * image.height > 16_000_000:
                    raise ValueError("image dimensions")
                image.thumbnail((512, 512))
                output = BytesIO()
                image.convert("RGB").save(output, format="JPEG", quality=85)
                raw = output.getvalue()
                ext = ".jpg"
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "头像不是有效图片或尺寸过大")
    old_path = user.avatar_path
    stored = get_storage_provider().save(
        raw,
        family_id="avatars",
        owner_id=user.id,
        filename=f"avatar-{user.id}{ext}",
    )
    user.avatar_path = stored.relative_path
    if old_path and old_path != stored.relative_path:
        try:
            get_storage_provider().delete(old_path)
        except Exception:
            pass
    db.flush()


@router.get("/auth/avatar/{user_id}")
def get_avatar(
    user_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(current_user),
) -> Response:
    if user_id != _user.id:
        own_families = select(Membership.family_id).where(
            Membership.user_id == _user.id, Membership.status == "active")
        shared = db.execute(select(Membership.id).join(Family).where(
            Membership.user_id == user_id, Membership.status == "active",
            Membership.family_id.in_(own_families), Family.deleted_at.is_(None))).first()
        if not shared:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "没有自定义头像")
    target = db.get(User, user_id)
    if not target or not target.avatar_path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有自定义头像")
    try:
        data = get_storage_provider().read(target.avatar_path)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "头像文件不存在")
    ext = target.avatar_path.rsplit(".", 1)[-1].lower()
    media = {v[1:]: k for k, v in _AVATAR_TYPES.items()}.get(ext, "image/png")
    return Response(content=data, media_type=media)


@router.post("/auth/change-password")
def change_password(
    payload: ChangePasswordIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    check_auth_rate(request, "change-password", user.id)
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "当前密码不正确")
    user.password_hash = hash_password(payload.new_password)
    user.token_version += 1
    db.commit()
    token, expires_in = create_access_token(user.id, user.token_version)
    return {"ok": True, "token": token, "expires_in": expires_in, "message": "密码已更新，其它设备需重新登录"}


# --------------------------------------------------------------------------
# families
# --------------------------------------------------------------------------
@router.get("/families")
def list_families(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    rows = db.execute(
        select(Membership, Family)
        .join(Family, Family.id == Membership.family_id)
        .where(Membership.user_id == user.id, Membership.status == "active")
    ).all()
    return {"items": [family_out(f, m) for m, f in rows]}


@router.post("/families", status_code=201)
def create_family(
    payload: FamilyCreateIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    invite = _new_invite()
    family = Family(
        name=payload.name.strip(),
        invite_code=invite["code"],
        invite_expires_at=invite["expires_at"],
        created_by=user.id,
        deployment_mode=payload.deployment_mode,
    )
    db.add(family)
    db.flush()
    membership = Membership(family_id=family.id, user_id=user.id, role="owner")
    db.add(membership)
    seed_taxonomy(db, family.id, user.id)
    record(
        db,
        None,
        "family.create",
        entity_type="family",
        entity_id=family.id,
        summary=f"创建家庭：{family.name}",
        request=request,
        family_id=family.id,
        actor_name=user.display_name,
    )
    db.commit()
    return {"family": family_out(family, membership)}


@router.post("/families/join")
def join_family(
    payload: dict,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    code = (payload.get("invite_code") or "").strip().upper()
    if not code:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "请输入邀请码")
    family = db.execute(
        select(Family).where(Family.invite_code == code, Family.deleted_at.is_(None))
    ).scalar_one_or_none()
    if not family:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "邀请码无效")
    if _invite_expired(family):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "邀请码已过期（有效期 5 分钟），请让对方重新生成",
        )
    existing = db.execute(
        select(Membership).where(
            Membership.family_id == family.id, Membership.user_id == user.id
        )
    ).scalar_one_or_none()
    if existing:
        if existing.status != "active":
            existing.status = "active"
            db.commit()
        return {"family": family_out(family, existing), "already_member": True}
    membership = Membership(family_id=family.id, user_id=user.id, role="member")
    db.add(membership)
    record(
        db,
        None,
        "family.join",
        entity_type="family",
        entity_id=family.id,
        summary=f"{user.display_name} 加入家庭",
        request=request,
        family_id=family.id,
        actor_name=user.display_name,
    )
    db.commit()
    return {"family": family_out(family, membership)}


@router.get("/families/current")
def current_family(
    principal: Principal = Depends(get_principal), db: Session = Depends(get_db)
) -> dict:
    family = db.get(Family, principal.family_id)
    membership = db.execute(
        select(Membership).where(
            Membership.family_id == principal.family_id, Membership.user_id == principal.user_id
        )
    ).scalar_one()
    counts = db.execute(
        select(func.count(Membership.id)).where(
            Membership.family_id == principal.family_id, Membership.status == "active"
        )
    ).scalar()
    out = family_out(family, membership)
    out["member_count"] = counts
    out["my_permissions"] = sorted(principal.permissions)
    return out


@router.patch("/families/current")
def update_family(
    payload: FamilyUpdateIn,
    request: Request,
    principal: Principal = Depends(require("system.deploy")),
    db: Session = Depends(get_db),
) -> dict:
    family = db.get(Family, principal.family_id)
    before = {"name": family.name}
    if payload.name:
        family.name = payload.name.strip()
    if payload.settings is not None:
        family.settings = {**(family.settings or {}), **payload.settings}
    record(
        db,
        principal,
        "family.update",
        entity_type="family",
        entity_id=family.id,
        summary="更新家庭设置",
        before=before,
        after={"name": family.name},
        request=request,
    )
    db.commit()
    return {"family": family_out(family)}


@router.post("/families/current/rotate-invite")
def rotate_invite(
    request: Request,
    principal: Principal = Depends(require("member.invite")),
    db: Session = Depends(get_db),
) -> dict:
    family = db.get(Family, principal.family_id)
    invite = _new_invite()
    family.invite_code = invite["code"]
    family.invite_expires_at = invite["expires_at"]
    record(
        db,
        principal,
        "family.rotate_invite",
        entity_type="family",
        entity_id=family.id,
        summary="重置邀请码",
        request=request,
    )
    db.commit()
    return {"invite_code": family.invite_code, "invite_expires_at": family.invite_expires_at}


@router.get("/families/current/permission-meta")
def permission_meta(_: Principal = Depends(get_principal)) -> dict:
    return {
        "roles": [
            {"value": k, "label": v, "rank": ROLE_RANK[k], "permissions": role_preset(k)}
            for k, v in ROLE_LABELS.items()
        ],
        "groups": [
            {
                "name": group,
                "items": [
                    {"key": p, "label": PERMISSION_LABELS.get(p, p)} for p in perms
                ],
            }
            for group, perms in PERMISSION_GROUPS.items()
        ],
        "all": list(ALL_PERMISSIONS),
    }


# --------------------------------------------------------------------------
# members
# --------------------------------------------------------------------------
@router.get("/families/current/members")
def list_members(
    principal: Principal = Depends(require(MEMBER_VIEW)), db: Session = Depends(get_db)
) -> dict:
    rows = db.execute(
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(Membership.family_id == principal.family_id)
        .order_by(Membership.joined_at)
    ).all()
    return {"items": [member_out(m, u) for m, u in rows]}


@router.post("/families/current/members", status_code=201)
def invite_member(
    payload: MemberInviteIn,
    request: Request,
    principal: Principal = Depends(require("member.invite")),
    db: Session = Depends(get_db),
) -> dict:
    if ROLE_RANK.get(payload.role, 0) >= ROLE_RANK.get(principal.role, 0):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "不能邀请与自己同级或更高角色的成员")
    user = db.execute(select(User).where(User.email == payload.email.lower())).scalar_one_or_none()
    created_user = False
    if not user:
        # A placeholder account: the invitee sets their own password on first login
        # via the invite flow. For simplicity we create a disabled shell account.
        user = User(
            email=payload.email.lower(),
            display_name=payload.display_name or payload.email.split("@")[0],
            password_hash="!",
            is_active=True,
        )
        db.add(user)
        db.flush()
        created_user = True
    existing = db.execute(
        select(Membership).where(
            Membership.family_id == principal.family_id, Membership.user_id == user.id
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "该用户已在家庭中")
    membership = Membership(
        family_id=principal.family_id, user_id=user.id, role=payload.role
    )
    db.add(membership)
    record(
        db,
        principal,
        "member.invite",
        entity_type="user",
        entity_id=user.id,
        summary=f"邀请 {user.display_name} 加入，角色 {ROLE_LABELS[payload.role]}",
        request=request,
    )
    db.commit()
    return {
        "member": member_out(membership, user),
        "created_user": created_user,
        "invite_link": f"/join?code={db.get(Family, principal.family_id).invite_code}",
    }


@router.patch("/families/current/members/{membership_id}")
def update_member(
    membership_id: str,
    payload: MemberUpdateIn,
    request: Request,
    principal: Principal = Depends(require("member.update")),
    db: Session = Depends(get_db),
) -> dict:
    membership = db.get(Membership, membership_id)
    if not membership or membership.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "成员不存在")
    if membership.role == "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "家庭所有者不能被修改，请先转移所有权")
    if payload.role and ROLE_RANK[payload.role] >= ROLE_RANK[principal.role]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "不能把成员提升到与自己同级或更高")

    before = {
        "role": membership.role,
        "status": membership.status,
        "overrides": membership.permission_overrides,
    }
    if payload.role:
        membership.role = payload.role
    if payload.nickname is not None:
        membership.nickname = payload.nickname
    if payload.status:
        if payload.status == "suspended" and not principal.can("member.disable"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "缺少停用成员的权限")
        membership.status = payload.status
    if payload.permission_overrides is not None:
        membership.permission_overrides = payload.permission_overrides
    membership.updated_at = utcnow()

    record(
        db,
        principal,
        "member.update",
        entity_type="membership",
        entity_id=membership.id,
        summary=f"调整成员角色/权限：{ROLE_LABELS.get(before['role'])} → {ROLE_LABELS.get(membership.role)}",
        before=before,
        after={
            "role": membership.role,
            "status": membership.status,
            "overrides": membership.permission_overrides,
        },
        request=request,
    )
    db.commit()
    user = db.get(User, membership.user_id)
    return {"member": member_out(membership, user)}


@router.delete("/families/current/members/{membership_id}")
def remove_member(
    membership_id: str,
    request: Request,
    principal: Principal = Depends(require("member.disable")),
    db: Session = Depends(get_db),
) -> dict:
    membership = db.get(Membership, membership_id)
    if not membership or membership.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "成员不存在")
    if membership.role == "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "不能移除家庭所有者")
    user = db.get(User, membership.user_id)
    name = user.display_name if user else membership.user_id
    db.delete(membership)
    record(
        db,
        principal,
        "member.remove",
        entity_type="membership",
        entity_id=membership_id,
        summary=f"移除成员：{name}",
        request=request,
    )
    db.commit()
    return {"ok": True}
