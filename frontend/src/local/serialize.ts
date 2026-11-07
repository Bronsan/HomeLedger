/**
 * Row -> wire shape.
 *
 * The local engine speaks the same JSON the HTTP API does, so every page and
 * component works unchanged regardless of where the data came from. That is
 * the whole point of keeping the serialisers separate from the handlers: one
 * place to change when the API shape moves.
 */

import type { LocalStore, Row } from "./store";

export function locationPath(store: LocalStore, id: string | null): string | null {
  if (!id) return null;
  const names: string[] = [];
  let cursor = id;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const row = store.get("locations", cursor);
    if (!row) break;
    names.unshift(row.name);
    cursor = row.parent_id as string;
  }
  return names.length ? names.join(" / ") : null;
}

export function categoryOut(row: Row | null): Row | null {
  if (!row) return null;
  return {
    id: row.id,
    parent_id: row.parent_id ?? null,
    name: row.name,
    icon: row.icon || "box",
    color: row.color || "#64748b",
    sort_order: row.sort_order ?? 0,
  };
}

export function locationOut(row: Row | null, path?: string | null, itemCount?: number): Row | null {
  if (!row) return null;
  const out: Row = {
    id: row.id,
    parent_id: row.parent_id ?? null,
    name: row.name,
    kind: row.kind || "container",
    icon: row.icon || "box",
    note: row.note || "",
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
  };
  if (path !== undefined) out.path = path;
  if (itemCount !== undefined) out.item_count = itemCount;
  return out;
}

function userBrief(store: LocalStore, id: string | null): Row | null {
  if (!id) return null;
  const u = store.get("users", id);
  if (!u) return null;
  return {
    id: u.id,
    display_name: u.display_name,
    avatar_color: u.avatar_color,
    email: u.email,
  };
}

export function attachmentOut(row: Row): Row {
  return {
    id: row.id,
    item_id: row.item_id || null,
    kind: row.kind || "other",
    original_name: row.original_name || "附件",
    mime_type: row.mime_type || "application/octet-stream",
    size_bytes: row.size_bytes || 0,
    created_at: row.created_at,
    // `local:` is a sentinel the asset resolver understands; it never reaches
    // the network. Keeping it explicit beats pretending to be an http URL that
    // would 404 the moment someone copies it.
    url: `local:${row.blob_id}`,
    thumbnail_url: row.thumb_data || null,
    is_image: Boolean(row.is_image),
  };
}

export function warrantyState(value: string | null | undefined): string {
  if (!value) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const until = new Date(`${value}T00:00:00`);
  if (Number.isNaN(until.getTime())) return "none";
  const days = Math.round((until.getTime() - today.getTime()) / 86400000);
  if (days < 0) return "expired";
  if (days <= 30) return "expiring";
  return "active";
}

export function itemOut(store: LocalStore, row: Row): Row {
  const category = store.get("categories", row.category_id);
  const location = store.get("locations", row.location_id);
  const tasks = store
    .all("maintenance")
    .filter((t) => t.item_id === row.id && t.status === "pending");
  const dues = tasks
    .map((t) => t.next_due_at as string | null)
    .filter((d): d is string => Boolean(d))
    .sort();
  const cover = row.cover_attachment_id
    ? store.get("attachments", row.cover_attachment_id)
    : null;

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    category_id: row.category_id || null,
    category: categoryOut(category),
    location_id: row.location_id || null,
    location: locationOut(location),
    location_path: locationPath(store, row.location_id || null),
    quantity: row.quantity ?? 1,
    unit: row.unit || "件",
    min_stock: row.min_stock ?? null,
    status: row.status || "stored",
    condition: row.condition || "good",
    brand: row.brand || "",
    model: row.model || "",
    serial_number: row.serial_number || "",
    barcode: row.barcode || "",
    barcode_type: row.barcode_type || "",
    purchase_date: row.purchase_date || null,
    purchase_price: row.purchase_price ?? null,
    currency: row.currency || "CNY",
    purchase_from: row.purchase_from || "",
    warranty_until: row.warranty_until || null,
    warranty_state: warrantyState(row.warranty_until),
    expected_life_months: row.expected_life_months ?? null,
    owner_user_id: row.owner_user_id || null,
    owner: userBrief(store, row.owner_user_id),
    custodian_user_id: row.custodian_user_id || null,
    custodian: userBrief(store, row.custodian_user_id),
    tags: row.tags || [],
    custom_fields: row.custom_fields || {},
    cover_url: cover?.thumb_data || null,
    open_tasks: tasks.length,
    next_due_at: dues[0] || null,
    version: row.version ?? 1,
    created_by: row.created_by || "",
    updated_by: row.updated_by || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at || null,
    deleted_at: row.deleted_at || null,
  };
}

export function componentOut(row: Row): Row {
  return {
    id: row.id,
    name: row.name,
    component_type: row.component_type || "part",
    serial_number: row.serial_number || "",
    quantity: row.quantity ?? 1,
    installed_at: row.installed_at || null,
    note: row.note || "",
  };
}

/**
 * 临期窗口，和后端 `serializers.EXPIRING_DAYS` 是同一个数字。
 *
 * 这里必须重复一遍：本机模式没有后端可问，而"30 天"是产品口径，不是实现
 * 细节。两边改一个忘一个，同一个批次会在手机上显示「临期」、在浏览器里显示
 * 「正常」——这正是这个项目最容易出的那种 bug。
 */
export const EXPIRING_DAYS = 30;

/** 本地日期字符串（YYYY-MM-DD）之间的整天差，避开时区把日期算偏一天。 */
function daysBetween(fromIso: string, toIso: string): number | null {
  const from = new Date(`${fromIso}T00:00:00`);
  const to = new Date(`${toIso}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function batchOut(store: LocalStore, row: Row): Row {
  const expires = (row.expires_on as string) || null;
  const daysLeft = expires ? daysBetween(todayIso(), expires) : null;
  let state = "none";
  if (daysLeft !== null) {
    if (daysLeft < 0) state = "expired";
    else if (daysLeft <= EXPIRING_DAYS) state = "expiring";
    else state = "fresh";
  }
  return {
    id: row.id,
    item_id: row.item_id,
    batch_no: row.batch_no || "",
    quantity: row.quantity ?? 1,
    // 空字符串表示"跟物品同一个单位"，由界面回填，不在这里固化。
    unit: row.unit || "",
    produced_on: row.produced_on || null,
    expires_on: expires,
    location_id: row.location_id || null,
    location_path: locationPath(store, row.location_id || null),
    supplier: row.supplier || "",
    note: row.note || "",
    expiry_state: state,
    days_left: daysLeft,
    version: row.version ?? 1,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
  };
}

export function eventOut(row: Row): Row {
  return {
    id: row.id,
    item_id: row.item_id,
    event_type: row.event_type,
    summary: row.summary,
    payload: row.payload || {},
    actor_name: row.actor_name || "",
    created_at: row.created_at,
  };
}

export function maintenanceOut(store: LocalStore, row: Row): Row {
  const item = store.get("items", row.item_id);
  const assignee = row.assignee_id ? store.get("users", row.assignee_id) : null;
  const due = row.next_due_at ? new Date(row.next_due_at).getTime() : null;
  const now = Date.now();
  return {
    id: row.id,
    item_id: row.item_id,
    item_name: item?.name || null,
    item_code: item?.code || null,
    title: row.title,
    task_type: row.task_type || "maintenance",
    interval_days: row.interval_days ?? null,
    next_due_at: row.next_due_at || null,
    last_completed_at: row.last_completed_at || null,
    assignee_id: row.assignee_id || null,
    assignee: assignee
      ? { id: assignee.id, display_name: assignee.display_name, avatar_color: assignee.avatar_color }
      : null,
    status: row.status || "pending",
    priority: row.priority || "normal",
    notes: row.notes || "",
    estimated_cost: row.estimated_cost ?? null,
    overdue: row.status === "pending" && due !== null && due < now,
    due_in_days: due === null ? null : Math.ceil((due - now) / 86400000),
    created_at: row.created_at,
  };
}

export function loanOut(store: LocalStore, row: Row): Row {
  const item = store.get("items", row.item_id);
  const due = row.due_at ? new Date(row.due_at).getTime() : null;
  return {
    id: row.id,
    item_id: row.item_id,
    item_name: item?.name || null,
    item_code: item?.code || null,
    borrower_name: row.borrower_name,
    borrower_contact: row.borrower_contact || "",
    lent_at: row.lent_at,
    due_at: row.due_at || null,
    returned_at: row.returned_at || null,
    is_open: !row.returned_at,
    overdue: !row.returned_at && due !== null && due < Date.now(),
    note: row.note || "",
  };
}

export function memberOut(store: LocalStore, row: Row): Row {
  const user = store.get("users", row.user_id);
  return {
    id: row.id,
    user_id: row.user_id,
    email: user?.email || "",
    display_name: user?.display_name || "",
    nickname: row.nickname || "",
    avatar_color: user?.avatar_color || "#64748b",
    role: row.role,
    status: row.status || "active",
    permission_overrides: row.permission_overrides || {},
    joined_at: row.joined_at,
    last_login_at: user?.last_login_at || null,
  };
}

export function auditOut(row: Row): Row {
  return {
    id: row.id,
    actor_id: row.actor_id || "",
    actor_name: row.actor_name || "",
    action: row.action,
    entity_type: row.entity_type || "",
    entity_id: row.entity_id || "",
    summary: row.summary || "",
    before: row.before || null,
    after: row.after || null,
    ip: row.ip || "",
    created_at: row.created_at,
  };
}

export function notificationOut(row: Row): Row {
  return {
    id: row.id,
    type: row.type || "system",
    title: row.title,
    body: row.body || "",
    entity_type: row.entity_type || "",
    entity_id: row.entity_id || "",
    read_at: row.read_at || null,
    created_at: row.created_at,
  };
}

export function page<T>(items: T[], total: number, pageNo: number, pageSize: number): Row {
  return {
    items,
    total,
    page: pageNo,
    page_size: pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
