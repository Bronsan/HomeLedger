"""Lightweight schema migration runner.

Why not Alembic? For a self-hosted appliance we want a single `python -m app.migrate`
that is deterministic, dependency-free and prints human readable output. The
migration list is append-only; each entry is idempotent and recorded in
`schema_migrations`.

When the project grows beyond a handful of migrations, swapping this for Alembic
is a contained change — the version table already exists.
"""

from __future__ import annotations

import logging
from typing import Callable

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from .db import Base, provider
from .models import SchemaMigration

log = logging.getLogger("homeledger.migrate")


def _has_column(conn, table: str, column: str) -> bool:
    insp = inspect(conn)
    return any(c["name"] == column for c in insp.get_columns(table))


MIGRATIONS: list[tuple[str, str, Callable]] = []


def migration(version: str, description: str):
    def deco(fn: Callable):
        MIGRATIONS.append((version, description, fn))
        return fn

    return deco


@migration("0001", "初始表结构")
def _m0001(session: Session) -> None:
    # create_all already ran; nothing to do beyond recording the baseline.
    pass


@migration("0002", "物品实例码与标签索引")
def _m0002(session: Session) -> None:
    conn = session.connection()
    if not _has_column(conn, "items", "barcode_type"):
        conn.execute(text("ALTER TABLE items ADD COLUMN barcode_type VARCHAR(24) DEFAULT ''"))
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_item_code_lookup ON items (family_id, code)")
    )


@migration("0003", "通知去重键")
def _m0003(session: Session) -> None:
    conn = session.connection()
    if not _has_column(conn, "notifications", "dedupe_key"):
        conn.execute(
            text("ALTER TABLE notifications ADD COLUMN dedupe_key VARCHAR(160) DEFAULT ''")
        )


@migration("0004", "批次与保质期")
def _m0004(session: Session) -> None:
    """`item_batches` itself is created by `create_all`, which runs for old
    databases too — a brand new table needs no ALTER. What it does not
    guarantee is the index the expiry query needs on an existing install, so
    that is what this entry is for.
    """
    conn = session.connection()
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_batch_family_expires "
            "ON item_batches (family_id, expires_on)"
        )
    )


@migration("0005", "物品低库存阈值")
def _m0005(session: Session) -> None:
    conn = session.connection()
    if not _has_column(conn, "items", "min_stock"):
        conn.execute(text("ALTER TABLE items ADD COLUMN min_stock FLOAT"))


@migration("0006", "用户自定义头像与邀请码 5 分钟时效")
def _m0006(session: Session) -> None:
    conn = session.connection()
    if not _has_column(conn, "users", "avatar_path"):
        conn.execute(text("ALTER TABLE users ADD COLUMN avatar_path VARCHAR(255)"))
    if not _has_column(conn, "families", "invite_expires_at"):
        conn.execute(text("ALTER TABLE families ADD COLUMN invite_expires_at DATETIME"))


@migration("0007", "审计日志不再保留 IP 与 User-Agent")
def _m0007(session: Session) -> None:
    """Privacy cleanup for databases created before audit metadata was dropped.

    The columns stay in the schema for backwards compatibility, but new rows are
    written empty and existing values are removed. The audit trail still records
    actor, action and before/after, which is what the product actually needs.
    """
    conn = session.connection()
    conn.execute(
        text(
            "UPDATE audit_logs SET ip = '', user_agent = '' "
            "WHERE COALESCE(ip, '') <> '' OR COALESCE(user_agent, '') <> ''"
        )
    )


def run_migrations(verbose: bool = True) -> list[str]:
    engine = provider.engine
    Base.metadata.create_all(engine)
    applied: list[str] = []
    with provider.transaction() as session:
        done = {row.version for row in session.query(SchemaMigration).all()}
        for version, description, fn in MIGRATIONS:
            if version in done:
                continue
            try:
                fn(session)
                session.add(SchemaMigration(version=version, description=description))
                applied.append(version)
                if verbose:
                    print(f"  ✓ {version} {description}")
            except Exception as exc:
                session.rollback()
                log.error("migration %s failed: %s", version, exc)
                raise
    if verbose:
        if applied:
            print(f"已应用 {len(applied)} 个迁移")
        else:
            print("数据库已是最新版本")
    return applied


if __name__ == "__main__":
    print(f"数据库：{provider.url}")
    run_migrations()
