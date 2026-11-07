"""Request payload contracts (Pydantic v2).

Validation lives here so routers stay thin and every rule is enforced even when
the caller is not our own frontend.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, field_validator

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email(value: str) -> str:
    """Deliberately permissive.

    Self-hosted households legitimately use addresses like `family@example.com` or
    `family@example.com`. RFC-strict validators reject those, so we only
    check shape and normalise case.
    """
    value = value.strip().lower()
    if len(value) > 255 or not _EMAIL_RE.fullmatch(value):
        raise ValueError("邮箱格式不正确")
    return value


Email = Annotated[str, AfterValidator(_validate_email)]

RoleLiteral = Literal["owner", "admin", "member", "viewer", "guest"]
ItemStatus = Literal[
    "in_use", "stored", "lent", "repair", "lost", "disposed", "archived"
]


class RegisterIn(BaseModel):
    email: Email
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=60)
    family_name: str | None = Field(default=None, max_length=120)
    invite_code: str | None = None


class LoginIn(BaseModel):
    email: Email
    password: str = Field(min_length=1, max_length=128)


class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class ProfileUpdateIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=60)
    avatar_color: str | None = Field(default=None, max_length=16)
    locale: str | None = Field(default=None, max_length=16)
    # 自定义头像 data URL；None = 不动，"" = 清除头像
    avatar_data: str | None = Field(default=None, max_length=1_500_000)


class FamilyCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    deployment_mode: Literal["local", "gateway", "cloud"] = "gateway"


class FamilyUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    settings: dict[str, Any] | None = None


class MemberInviteIn(BaseModel):
    email: Email
    display_name: str | None = None
    role: RoleLiteral = "member"


class MemberUpdateIn(BaseModel):
    role: RoleLiteral | None = None
    nickname: str | None = None
    status: Literal["active", "suspended"] | None = None
    permission_overrides: dict[str, list[str]] | None = None


class LocationIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: str | None = None
    kind: Literal["room", "furniture", "container", "zone"] = "room"
    icon: str = "box"
    note: str = ""
    sort_order: int = 0


class LocationUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    parent_id: str | None = None
    kind: Literal["room", "furniture", "container", "zone"] | None = None
    icon: str | None = None
    note: str | None = None
    sort_order: int | None = None


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: str | None = None
    icon: str = "tag"
    color: str = "#64748b"
    sort_order: int = 0


class CategoryUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    parent_id: str | None = None
    icon: str | None = None
    color: str | None = None
    sort_order: int | None = None


class ItemCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    code: str | None = Field(default=None, max_length=32)
    description: str = ""
    category_id: str | None = None
    location_id: str | None = None
    quantity: float = 1
    unit: str = "件"
    min_stock: float | None = None
    status: ItemStatus = "in_use"
    condition: Literal["new", "good", "fair", "poor"] = "good"
    brand: str = ""
    model: str = ""
    serial_number: str = ""
    barcode: str = ""
    barcode_type: str = ""
    purchase_date: date | None = None
    purchase_price: float | None = None
    currency: str = "CNY"
    purchase_from: str = ""
    warranty_until: date | None = None
    expected_life_months: int | None = None
    owner_user_id: str | None = None
    custodian_user_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    custom_fields: dict[str, Any] = Field(default_factory=dict)

    @field_validator("quantity")
    @classmethod
    def _qty_positive(cls, v: float) -> float:
        if v < 0:
            raise ValueError("数量不能为负")
        return v


class ItemUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    description: str | None = None
    category_id: str | None = None
    location_id: str | None = None
    quantity: float | None = None
    unit: str | None = None
    # 显式传 null 才清除阈值；exclude_unset 语义下不传即不动。
    min_stock: float | None = None
    status: ItemStatus | None = None
    condition: Literal["new", "good", "fair", "poor"] | None = None
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    barcode: str | None = None
    barcode_type: str | None = None
    purchase_date: date | None = None
    purchase_price: float | None = None
    currency: str | None = None
    purchase_from: str | None = None
    warranty_until: date | None = None
    expected_life_months: int | None = None
    owner_user_id: str | None = None
    custodian_user_id: str | None = None
    tags: list[str] | None = None
    custom_fields: dict[str, Any] | None = None
    cover_attachment_id: str | None = None
    version: int | None = None


class BulkItemIn(BaseModel):
    items: list[ItemCreateIn]


class ItemsBatchUpdateIn(BaseModel):
    """批量修改：只接受 fields 里给出的字段（白名单在路由里再收一次口）。"""

    ids: list[str] = Field(min_length=1, max_length=200)
    fields: ItemUpdateIn


class ComponentIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    component_type: str = "accessory"
    serial_number: str = ""
    quantity: float = 1
    installed_at: date | None = None
    note: str = ""


class BatchCreateIn(BaseModel):
    batch_no: str = Field(default="", max_length=64)
    quantity: float = Field(default=1, ge=0)
    unit: str = Field(default="", max_length=16)
    produced_on: date | None = None
    expires_on: date | None = None
    location_id: str | None = None
    supplier: str = Field(default="", max_length=160)
    note: str = ""


class BatchUpdateIn(BaseModel):
    """Every field optional: editing a batch is usually "I used half of it".

    `None` on `produced_on` / `expires_on` / `location_id` means "clear it",
    which is why the router reads `exclude_unset` rather than `exclude_none`.
    """

    batch_no: str | None = Field(default=None, max_length=64)
    quantity: float | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=16)
    produced_on: date | None = None
    expires_on: date | None = None
    location_id: str | None = None
    supplier: str | None = Field(default=None, max_length=160)
    note: str | None = None


class MaintenanceCreateIn(BaseModel):
    item_id: str
    title: str = Field(min_length=1, max_length=200)
    task_type: Literal["routine", "repair", "inspection", "warranty", "replacement"] = "routine"
    interval_days: int | None = Field(default=None, ge=1, le=3650)
    due_at: datetime | None = None
    assignee_id: str | None = None
    priority: Literal["low", "normal", "high", "urgent"] = "normal"
    notes: str = ""
    estimated_cost: float | None = None


class MaintenanceUpdateIn(BaseModel):
    title: str | None = None
    task_type: str | None = None
    interval_days: int | None = Field(default=None, ge=1, le=3650)
    due_at: datetime | None = None
    assignee_id: str | None = None
    priority: str | None = None
    notes: str | None = None
    estimated_cost: float | None = None
    status: Literal["pending", "done", "skipped"] | None = None


class MaintenanceCompleteIn(BaseModel):
    completed_at: datetime | None = None
    cost: float | None = None
    notes: str | None = None
    create_next: bool = True
    attachment_ids: list[str] = Field(default_factory=list)


class LoanCreateIn(BaseModel):
    item_id: str
    borrower_name: str = Field(min_length=1, max_length=120)
    borrower_user_id: str | None = None
    borrower_contact: str = ""
    due_at: datetime | None = None
    note: str = ""


class ItemACLIn(BaseModel):
    user_id: str
    permission: Literal["view", "edit"] = "view"


class ScanLookupIn(BaseModel):
    code: str


class OcrRequestIn(BaseModel):
    attachment_id: str
    mode: Literal["auto", "receipt", "manual", "business_card"] = "auto"


class NotificationMarkIn(BaseModel):
    ids: list[str] = Field(default_factory=list)
    all: bool = False


class BackupCreateIn(BaseModel):
    note: str = ""
    include_files: bool = True


class RestoreIn(BaseModel):
    filename: str
    confirm: str


class ImportIn(BaseModel):
    rows: list[dict[str, Any]]
    dry_run: bool = False
    create_missing_taxonomy: bool = True
