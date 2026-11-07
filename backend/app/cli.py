"""Offline instance-admin provisioning; never exposed as a public HTTP endpoint.

Run from the deployed backend directory: python -m app.cli admin user@example.com
Run with the service stopped and the deployment's environment/data volume mounted.
Existing passwords and household memberships are not changed on promotion.
"""

from __future__ import annotations

import argparse
import getpass

from sqlalchemy import select

from .audit import record
from .db import provider
from .migrate import run_migrations
from .models import User
from .schemas import RegisterIn
from .security import hash_password


def main() -> None:
    parser = argparse.ArgumentParser(description="HomeLedger 离线实例管理员配置")
    parser.add_argument("command", choices=["admin"])
    parser.add_argument("email")
    args = parser.parse_args()
    run_migrations(verbose=False)
    with provider.transaction() as db:
        user = db.execute(select(User).where(User.email == args.email.strip().lower())).scalar_one_or_none()
        if user is None:
            password = getpass.getpass("新管理员密码（至少 8 字符，不显示）: ")
            if password != getpass.getpass("再次输入: "):
                parser.error("两次密码不一致")
            payload = RegisterIn(email=args.email, password=password, display_name="实例管理员")
            user = User(email=payload.email, display_name=payload.display_name,
                        password_hash=hash_password(payload.password), is_instance_admin=True)
            db.add(user)
            db.flush()
        else:
            if not user.is_active or user.password_hash == "!":
                parser.error("不能提升停用或尚未设置密码的占位账号")
            user.is_instance_admin = True
        record(db, None, "instance.admin.provision", entity_type="user", entity_id=user.id,
               actor_name="offline-cli", summary="通过部署终端显式设置实例管理员")
    print("实例管理员已设置；原家庭和密码不变。不要与家庭成员共享此账号。")


if __name__ == "__main__":
    main()
