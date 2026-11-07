"""Canonical data model.

Every tenant-scoped row carries `family_id`. Every mutable entity carries
`created_by` / `updated_by` / `created_at` / `updated_at` / `deleted_at` (soft
delete) and a monotonically increasing `version` for optimistic concurrency —
these are the four things a future sync layer needs and the four things that are
almost impossible to retrofit later.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    """Naive UTC timestamp.

    SQLite has no native timezone support; storing naive UTC everywhere keeps
    SQLite and PostgreSQL behaviour identical and avoids the classic
    "aware vs naive" comparison crash on SQLite.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(microsecond=0).isoformat() + "Z"


class SchemaMigration(Base):
    __tablename__ = "schema_migrations"

    version: Mapped[str] = mapped_column(String(64), primary_key=True)
    description: Mapped[str] = mapped_column(String(255), default="")
    applied_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    avatar_color: Mapped[str] = mapped_column(String(16), default="#6366f1")
    locale: Mapped[str] = mapped_column(String(16), default="zh-CN")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_instance_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Bumped on password change / forced logout; embedded in the JWT.
    token_version: Mapped[int] = mapped_column(Integer, default=1)
    # 自定义头像：storage provider 里的相对路径；None = 用 avatar_color 色块
    avatar_path: Mapped[str | None] = mapped_column(String(255), nullable=True)


class Family(Base):
    __tablename__ = "families"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120))
    invite_code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    # 邀请码 5 分钟时效：生成/重置时写入，过期即失效（重置立即失效旧码的老语义保留）
    invite_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    deployment_mode: Mapped[str] = mapped_column(String(16), default="gateway")
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("family_id", "user_id", name="uq_membership"),
        Index("ix_membership_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("families.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(16), default="member")
    # {"grant": [...], "deny": [...]} — per-member overrides on top of the role.
    permission_overrides: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="active")
    nickname: Mapped[str] = mapped_column(String(120), default="")
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Location(Base):
    """Physical place: room -> furniture -> container. Self referencing tree."""

    __tablename__ = "locations"
    __table_args__ = (Index("ix_location_family_parent", "family_id", "parent_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("families.id", ondelete="CASCADE"), index=True
    )
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("locations.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(32), default="room")  # room|furniture|container|zone
    icon: Mapped[str] = mapped_column(String(32), default="box")
    note: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (Index("ix_category_family_parent", "family_id", "parent_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("families.id", ondelete="CASCADE"), index=True
    )
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(120))
    icon: Mapped[str] = mapped_column(String(32), default="tag")
    color: Mapped[str] = mapped_column(String(16), default="#64748b")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Item(Base):
    """A physical *instance* of a thing.

    Three identifiers are deliberately distinct:
      * `barcode`      — manufacturer EAN/UPC, identifies a product *model*
      * `code`         — HomeLedger asset code, identifies this instance
      * `serial_number`— manufacturer serial, optional
    Conflating them is the #1 modelling mistake in inventory apps.
    """

    __tablename__ = "items"
    __table_args__ = (
        UniqueConstraint("family_id", "code", name="uq_item_code"),
        Index("ix_item_family_deleted", "family_id", "deleted_at"),
        Index("ix_item_family_category", "family_id", "category_id"),
        Index("ix_item_family_location", "family_id", "location_id"),
        Index("ix_item_family_status", "family_id", "status"),
        Index("ix_item_barcode", "barcode"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("families.id", ondelete="CASCADE"), index=True
    )
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")

    category_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    location_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    quantity: Mapped[float] = mapped_column(Float, default=1)
    unit: Mapped[str] = mapped_column(String(16), default="件")
    # 低库存阈值：None = 不提醒。米、洗衣液这类消耗品低于阈值时首页提醒。
    min_stock: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="in_use")
    condition: Mapped[str] = mapped_column(String(24), default="good")

    brand: Mapped[str] = mapped_column(String(120), default="")
    model: Mapped[str] = mapped_column(String(120), default="")
    serial_number: Mapped[str] = mapped_column(String(120), default="")
    barcode: Mapped[str] = mapped_column(String(64), default="")
    barcode_type: Mapped[str] = mapped_column(String(24), default="")

    purchase_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    purchase_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    purchase_from: Mapped[str] = mapped_column(String(160), default="")
    warranty_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    expected_life_months: Mapped[int | None] = mapped_column(Integer, nullable=True)

    owner_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    custodian_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    custom_fields: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    cover_attachment_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    version: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[str] = mapped_column(String(36))
    updated_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ItemComponent(Base):
    """A sub-part of an item (lens, filter, battery, accessory)."""

    __tablename__ = "item_components"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("items.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(160))
    component_type: Mapped[str] = mapped_column(String(48), default="accessory")
    serial_number: Mapped[str] = mapped_column(String(120), default="")
    quantity: Mapped[float] = mapped_column(Float, default=1)
    installed_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ItemBatch(Base):
    """One physical batch of a consumable — food, medicine, toner, batteries.

    Why a separate table instead of `items.quantity` plus custom fields:

    * A batch has its own expiry date. Five packs of milk bought on three
      different days are three dates; a single `warranty_until` on the item
      cannot express that, and "expired" would have to mean "the earliest one",
      which is wrong for the other four.
    * A batch can be stored somewhere else than the item default. The pantry
      shelf and the fridge are both legitimate homes for the same SKU.
    * Consuming a batch is a quantity change on one row, not a rewrite of the
      item's history.

    `items.quantity` stays the authoritative on-hand total. It is *not* derived
    from the batches: a household that never opens the batch ledger must keep
    working, and silently recomputing the item total on every batch edit would
    be a destructive surprise. When batches exist the UI shows their sum next
    to the recorded quantity and flags the difference instead of picking a
    winner.

    Expiry is a `Date`, not a `DateTime`: a label says "best before 2026-11-03",
    nobody knows the hour, and an instant would shift by a day across timezones.
    """

    __tablename__ = "item_batches"
    __table_args__ = (
        Index("ix_batch_family_expires", "family_id", "expires_on"),
        Index("ix_batch_item", "item_id", "deleted_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("families.id", ondelete="CASCADE"), index=True
    )
    item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("items.id", ondelete="CASCADE"), index=True
    )
    batch_no: Mapped[str] = mapped_column(String(64), default="")
    quantity: Mapped[float] = mapped_column(Float, default=1)
    # Empty means "inherit the item's unit" — keeps old rows valid if the item
    # unit changes, and avoids writing 件 on every row of a kg-based item.
    unit: Mapped[str] = mapped_column(String(16), default="")
    produced_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    location_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    supplier: Mapped[str] = mapped_column(String(160), default="")
    note: Mapped[str] = mapped_column(Text, default="")

    version: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[str] = mapped_column(String(36), default="")
    updated_by: Mapped[str] = mapped_column(String(36), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Attachment(Base):
    __tablename__ = "attachments"
    __table_args__ = (Index("ix_attachment_item", "item_id", "deleted_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    item_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    maintenance_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    kind: Mapped[str] = mapped_column(String(32), default="photo")
    original_name: Mapped[str] = mapped_column(String(255))
    stored_name: Mapped[str] = mapped_column(String(255))
    relative_path: Mapped[str] = mapped_column(String(512))
    mime_type: Mapped[str] = mapped_column(String(120), default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    uploaded_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class MaintenanceTask(Base):
    __tablename__ = "maintenance_tasks"
    __table_args__ = (Index("ix_maint_family_due", "family_id", "status", "next_due_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("items.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    task_type: Mapped[str] = mapped_column(String(32), default="routine")
    interval_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    next_due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    assignee_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    notes: Mapped[str] = mapped_column(Text, default="")
    estimated_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_by: Mapped[str] = mapped_column(String(36))
    completed_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ItemEvent(Base):
    """Lifecycle timeline of one item. Append-only."""

    __tablename__ = "item_events"
    __table_args__ = (Index("ix_event_item_time", "item_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    event_type: Mapped[str] = mapped_column(String(32))
    summary: Mapped[str] = mapped_column(String(255), default="")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    actor_id: Mapped[str] = mapped_column(String(36))
    actor_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Loan(Base):
    __tablename__ = "loans"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("items.id", ondelete="CASCADE"), index=True
    )
    borrower_name: Mapped[str] = mapped_column(String(120))
    borrower_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    borrower_contact: Mapped[str] = mapped_column(String(120), default="")
    lent_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    returned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ItemACL(Base):
    """Explicit per-item grant, used for guests and for sharing a single item."""

    __tablename__ = "item_acl"
    __table_args__ = (UniqueConstraint("item_id", "user_id", name="uq_item_acl"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    permission: Mapped[str] = mapped_column(String(16), default="view")  # view|edit
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_family_time", "family_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    actor_id: Mapped[str] = mapped_column(String(36), default="")
    actor_name: Mapped[str] = mapped_column(String(120), default="")
    action: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(48), default="")
    entity_id: Mapped[str] = mapped_column(String(36), default="")
    summary: Mapped[str] = mapped_column(String(255), default="")
    before: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("family_id", "dedupe_key", name="uq_notification_dedupe"),
        Index("ix_notif_user_unread", "user_id", "read_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    channel: Mapped[str] = mapped_column(String(24), default="inapp")
    type: Mapped[str] = mapped_column(String(32), default="system")
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    entity_type: Mapped[str] = mapped_column(String(48), default="")
    entity_id: Mapped[str] = mapped_column(String(36), default="")
    dedupe_key: Mapped[str] = mapped_column(String(160), default=new_id)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class BackupRecord(Base):
    __tablename__ = "backups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    family_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    filename: Mapped[str] = mapped_column(String(255))
    relative_path: Mapped[str] = mapped_column(String(512))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    kind: Mapped[str] = mapped_column(String(16), default="manual")  # manual|auto|pre-restore
    status: Mapped[str] = mapped_column(String(16), default="ready")
    note: Mapped[str] = mapped_column(String(255), default="")
    includes_files: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(36), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# --- synchronisation --------------------------------------------------------
# The sync layer is deliberately separate from the business tables. It stores
# one row per (entity, id) plus a per-family monotonic sequence, which is all a
# device needs to catch up after being offline. Business rules stay in the
# routers; this layer only replicates state.


class SyncFamilyState(Base):
    """Per-family replication head.

    A global autoincrement would leak how many families exist and how active
    they are through the cursor alone. A per-family counter keeps cursors
    meaningless to anyone outside the family.
    """

    __tablename__ = "sync_family_state"

    family_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    head: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SyncRecord(Base):
    """Latest known state of one entity, as seen by the family.

    `meta` holds the low-sensitivity fields — enough for a freshly paired
    device to render a list before the user types the passphrase. `secret` is
    opaque AES-256-GCM ciphertext produced on the client. There is no server
    code path that decrypts it and no key material that would allow one.
    """

    __tablename__ = "sync_records"

    family_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    entity: Mapped[str] = mapped_column(String(40), primary_key=True)
    entity_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    hlc: Mapped[str] = mapped_column(String(48), default="")
    op: Mapped[str] = mapped_column(String(16), default="upsert")  # upsert|delete
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    blob_ids: Mapped[list] = mapped_column(JSON, default=list)
    device_id: Mapped[str] = mapped_column(String(64), default="")
    seq: Mapped[int] = mapped_column(Integer, default=0, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    __table_args__ = (Index("ix_sync_record_family_seq", "family_id", "seq"),)


class SyncDevice(Base):
    __tablename__ = "sync_devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    kind: Mapped[str] = mapped_column(String(24), default="desktop")
    app_version: Mapped[str] = mapped_column(String(32), default="")
    last_cursor: Mapped[int] = mapped_column(Integer, default=0)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SyncKey(Base):
    """End-to-end encryption parameters for one family.

    We store the *wrapped* data key, never the passphrase and never the
    unwrapped key. `verifier` lets a device tell "wrong passphrase" apart from
    "corrupted key material" without a round trip that would leak anything.
    """

    __tablename__ = "sync_keys"

    family_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    kdf: Mapped[str] = mapped_column(String(24), default="argon2id")
    salt: Mapped[str] = mapped_column(String(64), default="")
    memory_kib: Mapped[int] = mapped_column(Integer, default=65536)
    iterations: Mapped[int] = mapped_column(Integer, default=3)
    parallelism: Mapped[int] = mapped_column(Integer, default=1)
    wrapped_dek: Mapped[str] = mapped_column(Text, default="")
    verifier: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SyncBlob(Base):
    """Encrypted attachment bytes.

    Size and hash are plaintext so the server can enforce quotas and detect a
    truncated upload without holding the key. The bytes themselves are the
    client's ciphertext, stored verbatim.
    """

    __tablename__ = "sync_blobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    storage_key: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class QrLink(Base):
    """A scanned-able pointer to one item, usable without the app.

    The sticker on a box outlives the phone that printed it, so the QR cannot
    embed an account, a token or a device identity: it has to be an opaque
    handle the server can resolve years later. That is what this table is.

    `token` is the only thing in the URL. It is random, unguessable, and
    revocable — deleting the row turns every printed sticker for that item into
    a 404, which is the correct behaviour when a label ends up on a box that
    leaves the house.

    Deliberately not tied to `item.code`: two stickers on the same box (a
    reprint with a different host, say) are two rows and both work.
    """

    __tablename__ = "qr_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    item_id: Mapped[str] = mapped_column(String(36), index=True)
    token: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    # Printed once and then fixed, so the row records what it will resolve to.
    # A hostname the family later changes does not silently rewrite old stickers.
    base_url: Mapped[str] = mapped_column(String(200), default="")
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    hits: Mapped[int] = mapped_column(Integer, default=0)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
