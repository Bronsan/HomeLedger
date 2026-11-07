/**
 * The local API.
 *
 * Every handler here mirrors a route in `backend/app/routers/*.py`. The shapes
 * are identical on purpose: the React pages were written against the HTTP API
 * and they should not know or care that the data now lives in this tab.
 *
 * What is deliberately *not* mirrored: permission checks (a local device has
 * exactly one member, the owner), rate limits (there is no network), and
 * multi-tenant filters (a device holds one family). Pretending otherwise would
 * be security theatre. The real boundary in local mode is the device itself.
 */

import { ApiError } from "../api/errors";
import { getMode } from "../api/client";
import { LocalStore, Row, nowIso, uuid } from "./store";
import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  ROLE_PRESETS,
  nextAssetCode,
} from "./seed";
import * as S from "./serialize";
import { isImage, prepareImage } from "./media";
import { qrDataUrl, labelDataUrl } from "./qr";

export interface Ctx {
  store: LocalStore;
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  form: FormData | null;
}

const APP_VERSION = "2.0.2-beta";

// --- small helpers ----------------------------------------------------------
function notFound(message = "记录不存在"): never {
  throw new ApiError(404, message);
}

function bad(message: string): never {
  throw new ApiError(422, message);
}

function str(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

function num(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function currentUser(store: LocalStore): Row {
  const user = store.get("users", store.meta.user_id);
  if (!user) throw new ApiError(401, "本地账号缺失，请重新初始化");
  return user;
}

function currentFamilyRow(store: LocalStore): Row {
  const fam = store.get("families", store.meta.family_id);
  if (!fam) throw new ApiError(404, "家庭不存在");
  return fam;
}

function audit(
  store: LocalStore,
  action: string,
  summary: string,
  entityType = "",
  entityId = "",
  before: unknown = null,
  after: unknown = null
): void {
  const user = store.get("users", store.meta.user_id);
  store.write("audits", {
    id: uuid(),
    family_id: store.meta.family_id,
    actor_id: user?.id || "",
    actor_name: user?.display_name || "",
    action,
    entity_type: entityType,
    entity_id: entityId,
    summary,
    before: before ?? null,
    after: after ?? null,
    ip: "本机",
    created_at: nowIso(),
  });
  trimAudit(store);
}

function trimAudit(store: LocalStore): void {
  const rows = store.all("audits");
  const LIMIT = 3000;
  if (rows.length <= LIMIT + 200) return;
  rows
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, rows.length - LIMIT)
    .forEach((r) => {
      store.tables.audits.delete(r.id);
    });
}

function event(
  store: LocalStore,
  itemId: string,
  type: string,
  summary: string,
  payload: Record<string, unknown> = {}
): void {
  const user = store.get("users", store.meta.user_id);
  store.write("events", {
    id: uuid(),
    family_id: store.meta.family_id,
    item_id: itemId,
    event_type: type,
    summary,
    payload,
    actor_name: user?.display_name || "我",
    created_at: nowIso(),
  });
}

function familyItems(store: LocalStore): Row[] {
  return store.all("items").filter((r) => r.family_id === store.meta.family_id);
}

function describeItem(row: Row): Record<string, unknown> {
  return { name: row.name, code: row.code, status: row.status };
}

// --- auth -------------------------------------------------------------------
function userOut(store: LocalStore): Row {
  const user = currentUser(store);
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    avatar_color: user.avatar_color,
    // 本机模式头像存 data URL（IndexedDB 行内），前端 <img> 直接可用；
    // 与远程模式的 /auth/avatar/{id} 路径字段同名同语义
    avatar_url: user.avatar_data || null,
    is_active: true,
    created_at: user.created_at,
    last_login_at: user.last_login_at || null,
  };
}

function familyOut(store: LocalStore): Row {
  const fam = currentFamilyRow(store);
  const membership = store
    .all("memberships")
    .find((m) => m.family_id === fam.id && m.user_id === store.meta.user_id);
  const members = store.all("memberships").filter((m) => m.family_id === fam.id);
  return {
    id: fam.id,
    name: fam.name,
    invite_code: fam.invite_code || "",
    invite_expires_at: fam.invite_expires_at || null,
    deployment_mode: fam.deployment_mode || "local",
    settings: fam.settings || {},
    created_by: fam.created_by,
    created_at: fam.created_at,
    my_role: membership?.role || "owner",
    my_nickname: membership?.nickname || "",
    my_overrides: membership?.permission_overrides || {},
    member_count: members.filter((m) => m.status !== "suspended").length,
    my_permissions: ALL_PERMISSIONS,
  };
}

function meResponse(store: LocalStore): Row {
  const fam = familyOut(store);
  return {
    user: userOut(store),
    families: [fam],
    current_family_id: fam.id,
    role: "owner",
    permissions: ALL_PERMISSIONS,
    deployment: deploymentInfo(store),
  };
}

export function deploymentInfo(store: LocalStore): Row {
  const meta = store.meta;
  const syncing = meta.sync_enabled && Boolean(meta.server_url);
  return {
    mode: syncing ? "gateway" : "local",
    label: syncing ? "本机优先 · 已连接同步" : "仅本机",
    tagline: syncing ? "数据在本机，加密后同步" : "数据只保存这台设备上",
    description: syncing
      ? `本机保留完整数据，变更通过端到端加密同步到 ${meta.server_url}。断网不影响使用。`
      : "所有数据保存在本机浏览器数据库中，不依赖任何服务器。换设备需要先在设置里配置同步。",
    capabilities: {
      offline: true,
      local_database: true,
      multi_device: syncing,
      e2ee: Boolean(meta.e2ee),
      sso: false,
      object_storage: false,
    },
    warnings: syncing ? [] : ["清除浏览器数据会删除本机资料，请在设置里定期导出备份"],
    checklist: [
      { key: "local", label: "本地数据库已就绪", done: true },
      { key: "sync", label: "已配置同步服务器", done: syncing },
      { key: "key", label: "已设置同步口令", done: Boolean(meta.e2ee) },
    ],
    database: "IndexedDB（本机）",
    storage: "本机文件系统",
    data_dir: "浏览器 / 应用本地存储",
    install_id: meta.device_id,
    version: APP_VERSION,
  };
}

// --- query helpers ----------------------------------------------------------
function descendants(store: LocalStore, table: "categories" | "locations", id: string): Set<string> {
  const rows = store.all(table).filter((r) => r.family_id === store.meta.family_id);
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.parent_id && ids.has(row.parent_id) && !ids.has(row.id)) {
        ids.add(row.id);
        changed = true;
      }
    }
  }
  return ids;
}

const SORT_KEYS: Record<string, string> = {
  updated: "updated_at",
  created: "created_at",
  name: "name",
  code: "code",
  price: "purchase_price",
  purchase_price: "purchase_price",
  purchase_date: "purchase_date",
  warranty: "warranty_until",
  quantity: "quantity",
  status: "status",
};

function compare(a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh-CN");
}

// --- items ------------------------------------------------------------------
function listItems(ctx: Ctx): Row {
  const { store, query } = ctx;
  const q = (query.get("q") || "").trim().toLowerCase();
  const categoryId = query.get("category_id") || "";
  const locationId = query.get("location_id") || "";
  const status = query.get("status") || "";
  const condition = query.get("condition") || "";
  const tag = query.get("tag") || "";
  const ownerId = query.get("owner_id") || "";
  const warranty = query.get("warranty") || "";
  const includeArchived = query.get("include_archived") === "true";
  // 与后端对齐：archived=true 只看归档（回收站视图），优先于 include_archived。
  const archivedOnly = query.get("archived") === "true";
  const deletedOnly = query.get("deleted") === "true";
  const lowStock = query.get("low_stock") === "true";
  const sort = SORT_KEYS[query.get("sort") || "updated"] || "updated_at";
  const order = query.get("order") === "asc" ? "asc" : "desc";
  const pageNo = Math.max(1, Number(query.get("page") || 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.get("page_size") || 24)));

  if (deletedOnly) {
    // 墓碑不在 store.all() 里（它自动排除 _deleted），要原始扫描。
    // 解墓碑恢复走 restore 路由：write 回 _deleted=false，同步引擎照常推。
    const raw = [...store.tables["items"].values()].filter(
      (r) => r.family_id === store.meta.family_id && r._deleted
    );
    raw.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const total = raw.length;
    const slice = raw.slice((pageNo - 1) * pageSize, pageNo * pageSize);
    return S.page(slice.map((r) => S.itemOut(store, r)), total, pageNo, pageSize);
  }
  let rows = familyItems(store);
  if (archivedOnly) rows = rows.filter((r) => r.archived_at);
  else if (!includeArchived) rows = rows.filter((r) => !r.archived_at);
  if (categoryId) {
    const ids = descendants(store, "categories", categoryId);
    rows = rows.filter((r) => ids.has(r.category_id));
  }
  if (locationId) {
    const ids = descendants(store, "locations", locationId);
    rows = rows.filter((r) => ids.has(r.location_id));
  }
  if (lowStock) {
    rows = rows.filter(
      (r) => r.min_stock !== null && r.min_stock !== undefined && Number(r.quantity) <= Number(r.min_stock)
    );
  }
  if (status) rows = rows.filter((r) => r.status === status);
  if (condition) rows = rows.filter((r) => r.condition === condition);
  if (ownerId) rows = rows.filter((r) => r.owner_user_id === ownerId);
  if (tag) rows = rows.filter((r) => (r.tags || []).includes(tag));
  if (q) {
    rows = rows.filter((r) =>
      [r.name, r.brand, r.model, r.serial_number, r.barcode, r.code, r.description]
        .some((v) => String(v || "").toLowerCase().includes(q))
    );
  }
  if (warranty) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    rows = rows.filter((r) => {
      if (!r.warranty_until) return false;
      const state = S.warrantyState(r.warranty_until);
      return state === warranty;
    });
  }

  rows.sort((a, b) => {
    const cmp = compare(a[sort], b[sort]);
    return order === "asc" ? cmp : -cmp;
  });

  const total = rows.length;
  const slice = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return S.page(slice.map((r) => S.itemOut(store, r)), total, pageNo, pageSize);
}

function facets(store: LocalStore): Row {
  const rows = familyItems(store);
  const byStatus: Record<string, number> = {};
  let value = 0;
  const tagCount = new Map<string, number>();
  for (const r of rows) {
    byStatus[r.status || "stored"] = (byStatus[r.status || "stored"] || 0) + 1;
    if (typeof r.purchase_price === "number") value += r.purchase_price;
    for (const t of r.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  return {
    by_status: byStatus,
    total: rows.length,
    total_value: value,
    tags: Array.from(tagCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([t, c]) => ({ tag: t, count: c })),
  };
}

function createItem(ctx: Ctx): Row {
  const { store } = ctx;
  const body = ctx.body || {};
  const name = str(body.name).trim();
  if (!name) bad("请填写物品名称");

  let code = str(body.code).trim();
  if (!code) code = nextAssetCode(store);
  const clash = familyItems(store).find((r) => r.code === code);
  if (clash) throw new ApiError(409, `物品编号 ${code} 已存在`);

  const now = nowIso();
  const user = currentUser(store);
  const row: Row = {
    id: uuid(),
    family_id: store.meta.family_id,
    code,
    name,
    description: str(body.description),
    category_id: body.category_id || null,
    location_id: body.location_id || null,
    quantity: num(body.quantity, 1) || 1,
    unit: str(body.unit, "件") || "件",
    min_stock: body.min_stock === null || body.min_stock === undefined ? null : num(body.min_stock, 0),
    status: str(body.status, "stored") || "stored",
    condition: str(body.condition, "good") || "good",
    brand: str(body.brand),
    model: str(body.model),
    serial_number: str(body.serial_number),
    barcode: str(body.barcode),
    barcode_type: str(body.barcode_type),
    purchase_date: body.purchase_date || null,
    purchase_price: num(body.purchase_price),
    currency: str(body.currency, "CNY") || "CNY",
    purchase_from: str(body.purchase_from),
    warranty_until: body.warranty_until || null,
    expected_life_months: num(body.expected_life_months),
    owner_user_id: body.owner_user_id || null,
    custodian_user_id: body.custodian_user_id || null,
    tags: Array.isArray(body.tags) ? body.tags : [],
    custom_fields: body.custom_fields || {},
    cover_attachment_id: null,
    archived_at: null,
    created_by: user.id,
    updated_by: user.id,
    created_at: now,
    updated_at: now,
    version: 1,
  };
  store.write("items", row);
  event(store, row.id, "created", `创建物品「${name}」`, { code });
  audit(store, "item.create", `新增物品：${name}`, "item", row.id, null, describeItem(row));

  const out = S.itemOut(store, row);
  const dup = body.barcode
    ? familyItems(store).find(
        (r) => r.id !== row.id && r.barcode === str(body.barcode) && !r._deleted
      )
    : null;
  if (dup) {
    out.duplicate_warning = {
      item_id: dup.id,
      name: dup.name,
      message: `同条码物品已存在：${dup.name}（${dup.code}）`,
    };
  }
  return { item: out };
}

/**
 * 清空回收站的「已删除」视图：把所有墓碑物品彻底抹掉。与后端
 * `/items/purge-deleted` 同一口径——有未归还借出的**跳过不拦**，
 * 放进 blocked 让用户看到是谁没走。本机模式才有意义（同步/远程
 * 模式下服务器才是数据库，走服务器自己的清理）。
 */
function purgeDeletedItems(ctx: Ctx): { purged: number; blocked: Array<{ id: string; name: string }> } {
  const { store } = ctx;
  if (getMode() === "sync") {
    throw new ApiError(409, "同步模式下请连接服务器后在服务器上清理");
  }
  const raw = [...store.tables["items"].values()].filter(
    (r) => r.family_id === store.meta.family_id && r._deleted
  );
  let purged = 0;
  const blocked: Array<{ id: string; name: string }> = [];
  for (const row of raw) {
    const openLoan = store
      .all("loans")
      .find((l) => l.item_id === row.id && !l.returned_at && !l._deleted);
    if (openLoan) {
      blocked.push({ id: row.id, name: String(row.name) });
      continue;
    }
    // 子表与附件同单件硬删的口径；items 行本身连墓碑一起抹掉
    for (const a of store.all("attachments").filter((x) => x.item_id === row.id)) {
      if (a.blob_id) void store.deleteBlob(a.blob_id as string);
      store.remove("attachments", a.id);
    }
    for (const t of ["components", "batches", "maintenance", "loans"] as const) {
      for (const child of store.all(t).filter((x) => x.item_id === row.id)) {
        store.remove(t, child.id);
      }
    }
    store.purge("items", row.id);
    purged += 1;
  }
  if (purged) audit(store, "item.purge", `清空回收站：彻底删除 ${purged} 件物品`, "item", "");
  return { purged, blocked };
}

/**
 * 复制物品：复制的是「描述」不是「实体」——与后端 clone 对齐，
 * 编号重排、条码/序列号留空、封面与附件不跟。
 */
function cloneItem(ctx: Ctx, id: string): { item: ReturnType<typeof S.itemOut> } {
  const { store } = ctx;
  const src = store.get("items", id);
  if (!src || src._deleted) notFound("物品不存在");
  const now = nowIso();
  const user = currentUser(store);
  const name = String(src.name).endsWith("（副本）") ? String(src.name) : `${src.name}（副本）`;
  const row: Row = {
    ...src,
    id: uuid(),
    code: nextAssetCode(store),
    name,
    barcode: "",
    barcode_type: "",
    serial_number: "",
    cover_attachment_id: null,
    archived_at: null,
    created_by: user.id,
    updated_by: user.id,
    created_at: now,
    updated_at: now,
    version: 1,
  };
  store.write("items", row);
  event(store, row.id, "created", `复制自「${src.name}」（${src.code}）`, { cloned_from: src.id });
  audit(store, "item.clone", `复制物品：${src.name} → ${name}`, "item", row.id, null, describeItem(row));
  return { item: S.itemOut(store, row) };
}

function updateItem(ctx: Ctx, id: string): Row {
  const { store } = ctx;
  const existing = store.get("items", id);
  if (!existing) notFound("物品不存在");
  const body = ctx.body || {};
  if (body.version !== undefined && Number(body.version) !== Number(existing.version)) {
    throw new ApiError(409, "这件物品在别处被修改过，请刷新后重试");
  }
  const before = describeItem(existing);
  const merged: Row = { ...existing };
  const fields = [
    "name", "description", "category_id", "location_id", "quantity", "unit", "min_stock",
    "status", "condition", "brand", "model", "serial_number", "barcode", "barcode_type",
    "purchase_date", "purchase_price", "currency", "purchase_from", "warranty_until",
    "expected_life_months", "owner_user_id", "custodian_user_id", "tags", "custom_fields",
  ];
  for (const f of fields) {
    if (body[f] !== undefined) merged[f] = body[f];
  }
  if (!str(merged.name).trim()) bad("请填写物品名称");
  const user = currentUser(store);
  merged.updated_by = user.id;
  merged.updated_at = nowIso();
  merged.version = Number(existing.version || 1) + 1;
  const saved = store.write("items", merged);
  event(store, id, "updated", `更新物品「${saved.name}」`);
  audit(store, "item.update", `编辑物品：${saved.name}`, "item", id, before, describeItem(saved));
  return { item: S.itemOut(store, saved) };
}

function itemDetail(ctx: Ctx, id: string): Row {
  const { store } = ctx;
  const row = store.get("items", id);
  if (!row) notFound("物品不存在");

  const base = S.itemOut(store, row);
  const attachments = store
    .all("attachments")
    .filter((a) => a.item_id === id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(S.attachmentOut);
  const components = store
    .all("components")
    .filter((c) => c.item_id === id)
    .map(S.componentOut);
  const batches = batchList(store, id);
  const maintenance = store
    .all("maintenance")
    .filter((m) => m.item_id === id)
    .map((m) => {
      const out = S.maintenanceOut(store, m);
      return {
        id: out.id,
        title: out.title,
        task_type: out.task_type,
        status: out.status,
        next_due_at: out.next_due_at,
        interval_days: out.interval_days,
        priority: out.priority,
      };
    });
  const events = store
    .all("events")
    .filter((e) => e.item_id === id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 50)
    .map(S.eventOut);
  const loans = store
    .all("loans")
    .filter((l) => l.item_id === id)
    .sort((a, b) => String(b.lent_at).localeCompare(String(a.lent_at)))
    .map((l) => S.loanOut(store, l));

  return {
    item: {
      ...base,
      components,
      batches,
      attachments,
      maintenance,
      events,
      loans,
      acl: [],
      qr_url: "",
      label_url: "",
    },
  };
}

async function itemDetailWithQr(ctx: Ctx, id: string): Promise<Row> {
  const res = itemDetail(ctx, id);
  const item = res.item as Row;
  const link = `homeledger://scan?code=${encodeURIComponent(item.code)}`;
  item.qr_url = await qrDataUrl(link);
  item.label_url = await labelDataUrl({
    url: link,
    title: item.name,
    code: item.code,
    subtitle: item.location_path || "",
  });
  return res;
}

function archiveItem(ctx: Ctx, id: string, restore: boolean): Row {
  const { store } = ctx;
  const row = store.get("items", id);
  if (!row) notFound("物品不存在");
  const merged: Row = {
    ...row,
    archived_at: restore ? null : nowIso(),
    status: restore ? (row.status === "archived" ? "stored" : row.status) : "archived",
    updated_at: nowIso(),
    version: Number(row.version || 1) + 1,
  };
  const saved = store.write("items", merged);
  event(store, id, restore ? "restored" : "archived", restore ? "恢复物品" : "归档物品");
  audit(
    store,
    restore ? "item.restore" : "item.archive",
    `${restore ? "恢复" : "归档"}物品：${saved.name}`,
    "item",
    id
  );
  return { item: S.itemOut(store, saved) };
}

// 与后端 BATCHABLE_FIELDS 同一口径：标识字段（name/code/barcode）不进白名单
const BATCHABLE_FIELDS = new Set([
  "quantity", "unit", "min_stock", "status", "condition",
  "category_id", "location_id", "tags",
  "purchase_date", "purchase_price", "currency", "purchase_from",
  "warranty_until", "expected_life_months", "custodian_user_id",
]);

function batchUpdateItems(ctx: Ctx): Row {
  const { store } = ctx;
  const body = ctx.body || {};
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) bad("请选择要修改的物品");
  if (new Set(ids).size !== ids.length) bad("物品列表里有重复项");
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body.fields || {})) {
    if (BATCHABLE_FIELDS.has(k)) fields[k] = v;
  }
  if (!Object.keys(fields).length) bad("没有可批量修改的字段");
  const user = currentUser(store);
  const now = nowIso();
  let updated = 0;
  for (const id of ids) {
    const row = store.get("items", id);
    if (!row || row._deleted) notFound("物品不存在");
    store.write("items", {
      ...row,
      ...fields,
      updated_by: user.id,
      updated_at: now,
      version: Number(row.version || 1) + 1,
    });
    event(store, id, "updated", "批量修改");
    updated += 1;
  }
  audit(store, "item.batch_update", `批量修改 ${updated} 件物品`, "item", ids[0]);
  return { ok: true, updated, fields: Object.keys(fields).sort() };
}

function deleteItem(ctx: Ctx, id: string): Row {
  const { store } = ctx;
  const row = store.get("items", id);
  if (!row) notFound("物品不存在");
  const hard = ctx.query.get("hard") === "true";
  if (hard) {
    // 与后端 hard delete 同一口径：有未归还的借出就拦下。
    const openLoan = store
      .all("loans")
      .find((l) => l.item_id === id && !l.returned_at && !l._deleted);
    if (openLoan) throw new ApiError(409, "物品还有未归还的借出记录，归还后再彻底删除");
    // 子表清场（走 remove 留墓碑，同步引擎照常推给服务器）。
    // 附件连 blob 一起删；本机模式的文件就在 IndexedDB 里。
    for (const a of store.all("attachments").filter((x) => x.item_id === id)) {
      if (a.blob_id) void store.deleteBlob(a.blob_id as string);
      store.remove("attachments", a.id);
    }
    // events 不清：与后端一致，生命周期历史作为档案保留（孤儿事件
    // 只在按物品读取时可见，不会出现在任何列表里）
    for (const t of ["components", "batches", "maintenance", "loans"] as const) {
      for (const child of store.all(t).filter((x) => x.item_id === id)) {
        store.remove(t, child.id);
      }
    }
  }
  // 本机模式硬删 = 连墓碑都不留（purge）：没有服务器要同步，墓碑只会
  // 永远挂在「已删除」视图里。同步模式仍走 remove——墓碑就是删除协议。
  if (hard && getMode() === "local") store.purge("items", id);
  else store.remove("items", id);
  audit(
    store,
    hard ? "item.delete.hard" : "item.delete",
    hard ? `永久删除物品：${row.name}` : `删除物品：${row.name}`,
    "item",
    id,
    describeItem(row),
    null
  );
  return { ok: true, hard };
}

// --- batches ----------------------------------------------------------------
/** 与后端 `GET /items/{id}/batches` 一致：到期早的在前，没有到期日的沉底。 */
function batchList(store: LocalStore, itemId: string): Row[] {
  return store
    .all("batches")
    .filter((b) => b.item_id === itemId)
    .sort((a, b) => {
      const ea = (a.expires_on as string) || "";
      const eb = (b.expires_on as string) || "";
      if (!ea && !eb) return String(a.created_at).localeCompare(String(b.created_at));
      if (!ea) return 1;
      if (!eb) return -1;
      return ea.localeCompare(eb);
    })
    .map((b) => S.batchOut(store, b));
}

function saveBatch(ctx: Ctx, itemId: string, id?: string): Row {
  const { store } = ctx;
  const body = ctx.body || {};
  const item = store.get("items", itemId);
  if (!item) notFound("物品不存在");
  const existing = id ? store.get("batches", id) : null;
  if (id && (!existing || existing.item_id !== itemId)) notFound("批次不存在");

  // PATCH 语义：只改传了的字段。用 hasOwnProperty 而不是 `body.x ?? old`，
  // 否则显式传 null（清空到期日）会被当成"没传"。
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const pick = (key: string, fallback: unknown) => (has(key) ? body[key] : fallback);

  const produced = pick("produced_on", existing?.produced_on || null) || null;
  const expires = pick("expires_on", existing?.expires_on || null) || null;
  if (produced && expires && String(expires) < String(produced)) {
    bad("过期日期不能早于生产日期");
  }

  const locationId = pick("location_id", existing?.location_id || null) || null;
  if (locationId && !store.get("locations", locationId)) notFound("存放位置不存在");

  let quantity = Number(existing?.quantity ?? 1);
  if (has("quantity")) {
    const parsed = Number(body.quantity);
    if (!Number.isFinite(parsed) || parsed < 0) bad("数量必须是不小于 0 的数字");
    quantity = parsed;
  }

  const row: Row = {
    ...(existing || {
      id: uuid(),
      family_id: store.meta.family_id,
      item_id: itemId,
      created_at: nowIso(),
      version: 1,
    }),
    batch_no: str(pick("batch_no", existing?.batch_no || "")).slice(0, 64),
    quantity,
    unit: str(pick("unit", existing?.unit || "")).slice(0, 16),
    produced_on: produced,
    expires_on: expires,
    location_id: locationId,
    supplier: str(pick("supplier", existing?.supplier || "")).slice(0, 160),
    note: str(pick("note", existing?.note || "")),
    updated_at: nowIso(),
    version: Number(existing?.version || 0) + 1,
  };
  const saved = store.write("batches", row);
  event(
    store,
    itemId,
    existing ? "batch_updated" : "batch_added",
    `${existing ? "更新" : "新增"}批次：${saved.batch_no || "未命名"}` +
      (saved.expires_on ? `，${saved.expires_on} 到期` : ""),
    { batch_id: saved.id }
  );
  audit(
    store,
    existing ? "batch.update" : "batch.create",
    `${existing ? "修改" : "新增"}批次：${item.name} ${saved.batch_no}`.trim(),
    "batch",
    saved.id
  );
  return { batch: S.batchOut(store, saved) };
}

function deleteBatch(ctx: Ctx, id: string): void {
  const { store } = ctx;
  const row = store.get("batches", id);
  if (!row) notFound("批次不存在");
  store.remove("batches", id);
  event(store, row.item_id, "batch_removed", `删除批次：${row.batch_no || "未命名"}`, {
    batch_id: id,
  });
  audit(store, "batch.delete", `删除批次：${row.batch_no || id}`, "batch", id);
}

// --- catalog ----------------------------------------------------------------
function listLocations(store: LocalStore): Row {
  const rows = store.all("locations").filter((r) => r.family_id === store.meta.family_id);
  const counts = new Map<string, number>();
  for (const item of familyItems(store)) {
    if (item.location_id) counts.set(item.location_id, (counts.get(item.location_id) || 0) + 1);
  }
  return {
    items: rows
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(String(b.name)))
      .map((r) => S.locationOut(r, S.locationPath(store, r.id), counts.get(r.id) || 0)),
  };
}

function saveLocation(ctx: Ctx, id?: string): Row {
  const { store } = ctx;
  const body = ctx.body || {};
  const name = str(body.name).trim();
  if (!name) bad("请填写地点名称");
  if (id) {
    const row = store.get("locations", id);
    if (!row) notFound("地点不存在");
    if (body.parent_id === id) bad("不能把地点挂到自己下面");
    const saved = store.write("locations", {
      ...row,
      ...body,
      name,
      updated_at: nowIso(),
    });
    audit(store, "location.update", `编辑地点：${name}`, "location", id);
    return { location: S.locationOut(saved) };
  }
  const row: Row = {
    id: uuid(),
    family_id: store.meta.family_id,
    parent_id: body.parent_id || null,
    name,
    kind: str(body.kind, "container") || "container",
    icon: str(body.icon, "box") || "box",
    note: str(body.note),
    sort_order: num(body.sort_order, 0) || 0,
    created_at: nowIso(),
  };
  const saved = store.write("locations", row);
  audit(store, "location.create", `新增地点：${name}`, "location", saved.id);
  return { location: S.locationOut(saved) };
}

function deleteLocation(ctx: Ctx, id: string): void {
  const { store } = ctx;
  const row = store.get("locations", id);
  if (!row) notFound("地点不存在");
  const hasChild = store.all("locations").some((l) => l.parent_id === id);
  if (hasChild) bad("请先删除或移动这个地点下的子地点");
  const used = familyItems(store).filter((i) => i.location_id === id).length;
  if (used > 0) bad(`还有 ${used} 件物品在这个地点，请先移走`);
  store.remove("locations", id);
  audit(store, "location.delete", `删除地点：${row.name}`, "location", id);
}

function listCategories(store: LocalStore): Row {
  const rows = store.all("categories").filter((r) => r.family_id === store.meta.family_id);
  const counts = new Map<string, number>();
  for (const item of familyItems(store)) {
    if (item.category_id) counts.set(item.category_id, (counts.get(item.category_id) || 0) + 1);
  }
  return {
    items: rows
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((r) => ({ ...S.categoryOut(r), item_count: counts.get(r.id) || 0 })),
  };
}

function saveCategory(ctx: Ctx, id?: string): Row {
  const { store } = ctx;
  const body = ctx.body || {};
  const name = str(body.name).trim();
  if (!name) bad("请填写分类名称");
  if (id) {
    const row = store.get("categories", id);
    if (!row) notFound("分类不存在");
    const saved = store.write("categories", { ...row, ...body, name, updated_at: nowIso() });
    audit(store, "category.update", `编辑分类：${name}`, "category", id);
    return { category: S.categoryOut(saved) };
  }
  const row: Row = {
    id: uuid(),
    family_id: store.meta.family_id,
    parent_id: body.parent_id || null,
    name,
    icon: str(body.icon, "box") || "box",
    color: str(body.color, "#64748b") || "#64748b",
    sort_order: num(body.sort_order, 0) || 0,
    created_at: nowIso(),
  };
  const saved = store.write("categories", row);
  audit(store, "category.create", `新增分类：${name}`, "category", saved.id);
  return { category: S.categoryOut(saved) };
}

function deleteCategory(ctx: Ctx, id: string): void {
  const { store } = ctx;
  const row = store.get("categories", id);
  if (!row) notFound("分类不存在");
  if (store.all("categories").some((c) => c.parent_id === id)) bad("请先处理子分类");
  const used = familyItems(store).filter((i) => i.category_id === id).length;
  if (used > 0) bad(`还有 ${used} 件物品属于这个分类，请先改分类`);
  store.remove("categories", id);
  audit(store, "category.delete", `删除分类：${row.name}`, "category", id);
}

// --- maintenance ------------------------------------------------------------
/**
 * 待办维护导出 .ics（与后端 /maintenance/calendar.ics 同一格式）：
 * UID 稳定（task id），重复导入不堆积；VALARM -PT9H 约等于提前一天傍晚提醒。
 * 浏览器端拿到文本后由维护页触发下载。
 */
function maintenanceIcs(store: LocalStore): string {
  const BS = String.fromCharCode(92);
  const CRLF = String.fromCharCode(13, 10);
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const icsEscape = (s: string): string =>
    s
      .split(BS)
      .join(BS + BS)
      .split(";")
      .join(BS + ";")
      .split(",")
      .join(BS + ",")
      .split(CRLF)
      .join(BS + "n")
      .split(LF)
      .join(BS + "n")
      .split(CR)
      .join("");
  const items = new Map(store.all("items").map((i) => [i.id, i]));
  const tasks = store
    .all("maintenance")
    .filter(
      (t) =>
        t.family_id === store.meta.family_id &&
        t.status === "pending" &&
        !t._deleted
    );
  // 旧版本建的任务可能没有 next_due_at。日历文件不能静默漏掉它们：
  // 按导出次日生成一条全天提醒，并在描述里说明这是兜底日期。
  const now = new Date();
  const fallback = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HomeLedger//Maintenance//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:HomeLedger 维护",
  ];
  for (const t of tasks) {
    const item = items.get(t.item_id as string);
    const raw = t.next_due_at ? new Date(String(t.next_due_at)) : null;
    const assumed = !raw || isNaN(raw.getTime());
    const due = assumed ? fallback : raw;
    const y = due.getFullYear();
    const m = String(due.getMonth() + 1).padStart(2, "0");
    const d = String(due.getDate()).padStart(2, "0");
    const end = new Date(due.getTime() + 86_400_000);
    const endS = `${end.getFullYear()}${String(end.getMonth() + 1).padStart(2, "0")}${String(end.getDate()).padStart(2, "0")}`;
    const summary = item ? `维护：${item.name} · ${t.title}` : `维护：${t.title}`;
    const desc = [
      item?.code ? `物品编号 ${item.code}` : "",
      assumed ? "此任务未设置到期日；已按导出次日生成提醒。" : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:homeledger-maintenance-${t.id}@homeledger`,
      `DTSTART;VALUE=DATE:${y}${m}${d}`,
      `DTEND;VALUE=DATE:${endS}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEscape(summary)}`,
      "TRIGGER:-PT9H",
      "END:VALARM",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}

function listMaintenance(ctx: Ctx): Row {
  const { store, query } = ctx;
  const status = query.get("status");
  const overdue = query.get("overdue") === "true";
  const upcoming = Number(query.get("upcoming_days") || 0);
  let rows = store
    .all("maintenance")
    .filter((m) => m.family_id === store.meta.family_id)
    .map((m) => S.maintenanceOut(store, m));

  const all = rows;
  if (status) rows = rows.filter((m) => m.status === status);
  if (overdue) rows = rows.filter((m) => m.overdue);
  if (upcoming > 0) {
    rows = rows.filter(
      (m) => m.status === "pending" && m.due_in_days !== null && m.due_in_days >= 0 && m.due_in_days <= upcoming
    );
  }
  rows.sort((a, b) => {
    const av = a.next_due_at ? String(a.next_due_at) : "9999";
    const bv = b.next_due_at ? String(b.next_due_at) : "9999";
    return av.localeCompare(bv);
  });

  const pending = all.filter((m) => m.status === "pending");
  return {
    items: rows,
    counts: {
      pending: pending.length,
      overdue: pending.filter((m) => m.overdue).length,
      week: pending.filter((m) => m.due_in_days !== null && m.due_in_days >= 0 && m.due_in_days <= 7).length,
      month: pending.filter((m) => m.due_in_days !== null && m.due_in_days >= 0 && m.due_in_days <= 30).length,
      done: all.filter((m) => m.status === "done").length,
    },
  };
}

function saveMaintenance(ctx: Ctx, id?: string): Row {
  const { store } = ctx;
  const body = ctx.body || {};
  const itemId = str(body.item_id);
  if (!store.get("items", itemId)) bad("请选择关联物品");
  if (id) {
    const row = store.get("maintenance", id);
    if (!row) notFound("维护任务不存在");
    // 前端更新接口用 due_at（与服务端 PATCH 一致）；本机行里存的是
    // next_due_at，不能把 due_at 原样 spread 进去，否则到期日永远不生效。
    const patch: Row = { ...body };
    if ("due_at" in body) {
      patch.next_due_at = body.due_at || null;
      delete patch.due_at;
    }
    const saved = store.write("maintenance", { ...row, ...patch, updated_at: nowIso() });
    audit(store, "maintenance.update", `编辑维护：${saved.title}`, "maintenance", id);
    return { task: S.maintenanceOut(store, saved) };
  }
  const title = str(body.title).trim();
  if (!title) bad("请填写任务名称");
  // 与服务端 create_task 对齐：没填首次到期日时默认今天，而不是留下
  // next_due_at=null。后者会让本机维护页显示「无期限」，日历导出也会
  // 把这条待办当成没有日期而跳过。
  const requestedDue = body.due_at ?? body.next_due_at;
  const row: Row = {
    id: uuid(),
    family_id: store.meta.family_id,
    item_id: itemId,
    title,
    task_type: str(body.task_type, "maintenance") || "maintenance",
    interval_days: num(body.interval_days),
    next_due_at: requestedDue ? String(requestedDue) : nowIso(),
    last_completed_at: null,
    assignee_id: body.assignee_id || null,
    status: "pending",
    priority: str(body.priority, "normal") || "normal",
    notes: str(body.notes),
    estimated_cost: num(body.estimated_cost),
    created_at: nowIso(),
  };
  const saved = store.write("maintenance", row);
  event(store, itemId, "maintenance", `新增维护任务：${title}`);
  audit(store, "maintenance.create", `新增维护：${title}`, "maintenance", saved.id);
  return { task: S.maintenanceOut(store, saved) };
}

function completeMaintenance(ctx: Ctx, id: string): Row {
  const { store } = ctx;
  const row = store.get("maintenance", id);
  if (!row) notFound("维护任务不存在");
  const body = ctx.body || {};
  const now = nowIso();
  let next: string | null = null;
  if (row.interval_days) {
    const d = new Date();
    d.setDate(d.getDate() + Number(row.interval_days));
    next = d.toISOString().slice(0, 10);
  } else if (body.next_due_at) {
    next = body.next_due_at;
  }
  const saved = store.write("maintenance", {
    ...row,
    status: next ? "pending" : "done",
    last_completed_at: now,
    next_due_at: next,
    notes: body.notes !== undefined ? str(body.notes) : row.notes,
    estimated_cost: body.cost !== undefined ? num(body.cost, row.estimated_cost) : row.estimated_cost,
    updated_at: now,
  });
  event(store, row.item_id, "maintenance_done", `完成维护：${row.title}`);
  audit(store, "maintenance.complete", `完成维护：${row.title}`, "maintenance", id);
  return { task: S.maintenanceOut(store, saved) };
}

function skipMaintenance(ctx: Ctx, id: string): Row {
  // 与后端 skip 同口径：顺延一个周期、不记完成；一次性任务没有「下一次」
  const { store } = ctx;
  const row = store.get("maintenance", id);
  if (!row) notFound("任务不存在");
  if (!row.interval_days) throw new ApiError(409, "一次性任务没有周期可跳过，直接完成或删除即可");
  const base = new Date((row.next_due_at as string) || nowIso());
  do {
    base.setDate(base.getDate() + Number(row.interval_days));
  } while (base.getTime() <= Date.now());
  const saved = store.write("maintenance", {
    ...row,
    status: "pending",
    next_due_at: base.toISOString().slice(0, 10),
    updated_at: nowIso(),
  });
  event(store, row.item_id, "maintenance_skipped", `跳过一次：${row.title}`);
  audit(store, "maintenance.skip", `跳过一次维护任务：${row.title}`, "maintenance", id);
  return { task: S.maintenanceOut(store, saved) };
}

function deleteMaintenance(ctx: Ctx, id: string): void {
  const { store } = ctx;
  const row = store.get("maintenance", id);
  if (!row) notFound("维护任务不存在");
  store.remove("maintenance", id);
  audit(store, "maintenance.delete", `删除维护：${row.title}`, "maintenance", id);
}

// --- loans ------------------------------------------------------------------
function listLoans(ctx: Ctx): Row {
  const { store, query } = ctx;
  // 与后端对齐：参数叫 open_only，默认 true（只看未还）。
  // 之前读的是 `open` 且语义相反——同一个请求在本机和远程会返回不同集合。
  const openOnly = query.get("open_only") !== "false";
  let rows = store
    .all("loans")
    .filter((l) => l.family_id === store.meta.family_id)
    .map((l) => S.loanOut(store, l));
  if (openOnly) rows = rows.filter((l) => l.is_open);
  rows.sort((a, b) => String(b.lent_at).localeCompare(String(a.lent_at)));
  return { items: rows };
}

function createLoan(ctx: Ctx): Row {
  const { store } = ctx;
  const body = ctx.body || {};
  const itemId = str(body.item_id);
  const item = store.get("items", itemId);
  if (!item) bad("请选择要借出的物品");
  const borrower = str(body.borrower_name).trim();
  if (!borrower) bad("请填写借用人");
  const row: Row = {
    id: uuid(),
    family_id: store.meta.family_id,
    item_id: itemId,
    borrower_name: borrower,
    borrower_contact: str(body.borrower_contact),
    lent_at: nowIso(),
    due_at: body.due_at || null,
    returned_at: null,
    note: str(body.note),
  };
  const saved = store.write("loans", row);
  const updated = store.write("items", { ...item, status: "lent", updated_at: nowIso() });
  event(store, itemId, "loaned", `借出给 ${borrower}`);
  audit(store, "loan.create", `借出：${item.name} → ${borrower}`, "loan", saved.id);
  return { loan: S.loanOut(store, saved), item: S.itemOut(store, updated) };
}

function returnLoan(ctx: Ctx, id: string): Row {
  const { store } = ctx;
  const row = store.get("loans", id);
  if (!row) notFound("借出记录不存在");
  if (row.returned_at) throw new ApiError(409, "该记录已归还");
  const saved = store.write("loans", { ...row, returned_at: nowIso() });
  const item = store.get("items", row.item_id);
  if (item) {
    store.write("items", { ...item, status: "in_use", updated_at: nowIso() });
    event(store, item.id, "returned", `${row.borrower_name} 归还`);
  }
  audit(store, "loan.return", "物品归还", "loan", id);
  return { loan: S.loanOut(store, saved) };
}

// --- attachments ------------------------------------------------------------
async function uploadAttachment(ctx: Ctx): Promise<Row> {
  const { store, form } = ctx;
  if (!form) bad("请选择文件");
  const file = form.get("file");
  if (!(file instanceof File)) bad("请选择文件");
  const itemId = str(form.get("item_id")) || null;
  if (itemId && !store.get("items", itemId)) notFound("关联物品不存在");
  const kind = str(form.get("kind"), "other") || "other";
  const setCover = String(form.get("set_cover")) === "true";

  const image = await isImage(file);
  let blob: Blob = file;
  let thumb: string | null = null;
  let mime = file.type || "application/octet-stream";
  if (image) {
    try {
      const prepared = await prepareImage(file);
      blob = prepared.blob;
      thumb = prepared.thumb;
      mime = prepared.mime;
    } catch {
      // HEIC and friends that the WebView cannot decode: keep the original
      // rather than refusing the upload. The thumbnail stays empty and the
      // UI falls back to a file icon.
    }
  }

  const blobId = uuid();
  await store.putBlob(blobId, blob);
  const row: Row = {
    id: uuid(),
    family_id: store.meta.family_id,
    item_id: itemId,
    blob_id: blobId,
    kind,
    original_name: file.name,
    mime_type: mime,
    size_bytes: blob.size,
    is_image: image,
    thumb_data: thumb,
    created_at: nowIso(),
    pending_upload: true,
  };
  const saved = store.write("attachments", row);

  if (setCover && itemId) {
    const item = store.get("items", itemId);
    if (item) store.write("items", { ...item, cover_attachment_id: saved.id, updated_at: nowIso() });
  }
  if (itemId) event(store, itemId, "attachment", `上传附件：${file.name}`);
  return { attachment: S.attachmentOut(saved) };
}

function deleteAttachment(ctx: Ctx, id: string): void {
  const { store } = ctx;
  const row = store.get("attachments", id);
  if (!row) notFound("附件不存在");
  store.remove("attachments", id);
  for (const item of familyItems(store)) {
    if (item.cover_attachment_id === id) {
      store.write("items", { ...item, cover_attachment_id: null });
    }
  }
  if (row.blob_id) void store.deleteBlob(row.blob_id);
}

// --- audit / notifications ---------------------------------------------------
function listAudit(ctx: Ctx): Row {
  const { store, query } = ctx;
  const action = query.get("action") || "";
  const entityType = query.get("entity_type") || "";
  const actorId = query.get("actor_id") || "";
  const pageNo = Math.max(1, Number(query.get("page") || 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.get("page_size") || 30)));
  let rows = store.all("audits").filter((r) => r.family_id === store.meta.family_id);
  if (action) rows = rows.filter((r) => String(r.action).startsWith(action));
  // 与后端 list_audit 对齐：entity_type / actor_id 精确匹配
  if (entityType) rows = rows.filter((r) => r.entity_type === entityType);
  if (actorId) rows = rows.filter((r) => r.actor_id === actorId);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = rows.length;
  return S.page(
    rows.slice((pageNo - 1) * pageSize, pageNo * pageSize).map(S.auditOut),
    total,
    pageNo,
    pageSize
  );
}

function listNotifications(ctx: Ctx): Row {
  const { store, query } = ctx;
  // 与后端对齐：unread_only 过滤未读，limit 截断（壳上的铃铛只拉 40 条）
  const unreadOnly = query.get("unread_only") === "true";
  const limit = Number(query.get("limit") || 0);
  let rows = store
    .all("notifications")
    .filter((r) => r.family_id === store.meta.family_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const unread = rows.filter((r) => !r.read_at).length;
  if (unreadOnly) rows = rows.filter((r) => !r.read_at);
  if (limit > 0) rows = rows.slice(0, limit);
  return {
    items: rows.map(S.notificationOut),
    unread,
  };
}

function markNotificationsRead(ctx: Ctx): Row {
  const { store } = ctx;
  const body = ctx.body || {};
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
  const now = nowIso();
  for (const row of store.all("notifications")) {
    if (row.family_id !== store.meta.family_id) continue;
    if (ids.length && !ids.includes(row.id)) continue;
    if (!row.read_at) store.write("notifications", { ...row, read_at: now });
  }
  return { ok: true };
}

// --- dashboard --------------------------------------------------------------
function dashboard(store: LocalStore): Row {
  const rows = familyItems(store);
  const active = rows.filter((r) => !r.archived_at);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const byStatus: Record<string, number> = {};
  let totalValue = 0;
  for (const r of rows) byStatus[r.status || "stored"] = (byStatus[r.status || "stored"] || 0) + 1;
  for (const r of active) if (typeof r.purchase_price === "number") totalValue += r.purchase_price;

  const catRows = store.all("categories").filter((c) => c.family_id === store.meta.family_id);
  const locRows = store.all("locations").filter((l) => l.family_id === store.meta.family_id);
  const byCategory = catRows
    .map((c) => ({
      name: c.name,
      color: c.color || "#64748b",
      count: rows.filter((i) => i.category_id === c.id).length,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  const byLocation = locRows
    .map((l) => ({ name: l.name, count: rows.filter((i) => i.location_id === l.id).length }))
    .filter((l) => l.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const tasks = store
    .all("maintenance")
    .filter((m) => m.family_id === store.meta.family_id && m.status === "pending");
  const overdueTasks = tasks.filter((m) => m.next_due_at && new Date(m.next_due_at) < new Date()).length;
  const upcomingTasks = tasks.filter((m) => {
    if (!m.next_due_at) return false;
    const d = new Date(m.next_due_at);
    const in30 = new Date();
    in30.setDate(in30.getDate() + 30);
    return d >= new Date() && d <= in30;
  }).length;

  const recent = [...active]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 6);
  const events = store
    .all("events")
    .filter((e) => e.family_id === store.meta.family_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 8);

  const trend: { month: string; amount: number; count: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const inMonth = rows.filter((r) => String(r.purchase_date || "").startsWith(key));
    trend.push({
      month: key,
      amount: inMonth.reduce((s, r) => s + (Number(r.purchase_price) || 0), 0),
      count: inMonth.length,
    });
  }

  let storage = 0;
  for (const a of store.all("attachments")) storage += Number(a.size_bytes) || 0;

  // 批次临期：口径与后端 dashboard 完全一致——排除已删除物品的批次，
  // 30 天窗口取自 S.EXPIRING_DAYS，两边只有一处数字。
  const liveItemIds = new Set(rows.map((r) => r.id));
  const batchRows = store
    .all("batches")
    .filter((b) => b.family_id === store.meta.family_id && liveItemIds.has(b.item_id));
  const batchViews = batchRows.map((b) => S.batchOut(store, b));
  const expiringBatches = batchViews.filter((b) => b.expiry_state === "expiring");
  const expiredBatches = batchViews.filter((b) => b.expiry_state === "expired");
  const expiringList = [...expiredBatches, ...expiringBatches]
    .sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)))
    .slice(0, 6)
    .map((b) => {
      const item = store.get("items", b.item_id);
      return {
        ...b,
        item_name: item?.name || "",
        item_code: item?.code || "",
        item_unit: item?.unit || "件",
      };
    });

  return {
    total_items: rows.length,
    archived_items: rows.filter((r) => r.archived_at).length,
    total_value: totalValue,
    by_status: byStatus,
    by_category: byCategory,
    by_location: byLocation,
    warranty_expiring: rows.filter((r) => S.warrantyState(r.warranty_until) === "expiring").length,
    warranty_expired: rows.filter((r) => S.warrantyState(r.warranty_until) === "expired").length,
    overdue_tasks: overdueTasks,
    upcoming_tasks: upcomingTasks,
    open_loans: store
      .all("loans")
      .filter((l) => l.family_id === store.meta.family_id && !l.returned_at).length,
    // 与后端 dashboard 对齐：逾期借出与低库存都单独计数。
    overdue_loans: store
      .all("loans")
      .filter(
        (l) =>
          l.family_id === store.meta.family_id &&
          !l.returned_at &&
          l.due_at &&
          new Date(l.due_at).getTime() < Date.now()
      ).length,
    low_stock: active.filter(
      (r) => r.min_stock !== null && r.min_stock !== undefined && Number(r.quantity) <= Number(r.min_stock)
    ).length,
    // 明细与计数同一把尺子，缺口最大的排前面（与后端 order_by 一致）
    low_stock_list: active
      .filter((r) => r.min_stock !== null && r.min_stock !== undefined && Number(r.quantity) <= Number(r.min_stock))
      .sort(
        (a, b) =>
          Number(a.quantity) - Number(a.min_stock) - (Number(b.quantity) - Number(b.min_stock))
      )
      .slice(0, 8)
      .map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        quantity: r.quantity,
        min_stock: r.min_stock,
        unit: r.unit || "件",
      })),
    unread_notifications: store
      .all("notifications")
      .filter((n) => n.family_id === store.meta.family_id && !n.read_at).length,
    storage_bytes: storage,
    expiring_batches: expiringBatches.length,
    expired_batches: expiredBatches.length,
    expiring_list: expiringList,
    recent_items: recent.map((r) => {
      const cover = r.cover_attachment_id ? store.get("attachments", r.cover_attachment_id) : null;
      return {
        id: r.id,
        name: r.name,
        code: r.code,
        status: r.status,
        created_at: r.created_at,
        cover: cover?.thumb_data || null,
      };
    }),
    recent_events: events.map((e) => ({
      id: e.id,
      item_id: e.item_id,
      event_type: e.event_type,
      summary: e.summary,
      actor_name: e.actor_name,
      created_at: e.created_at,
    })),
    purchase_trend: trend,
  };
}

// --- scan -------------------------------------------------------------------
function scanLookup(ctx: Ctx): Row {
  const { store, query } = ctx;
  let raw = (query.get("code") || "").trim();
  if (raw.includes("code=")) raw = raw.split("code=").pop()!.split("&")[0];
  if (!raw) bad("请输入编号");
  const rows = familyItems(store);

  let matches: { kind: string; row: Row }[] = [];
  const byCode = rows.find((r) => r.code === raw);
  if (byCode) matches.push({ kind: "asset_code", row: byCode });
  if (!matches.length) {
    for (const r of rows) {
      if (r.barcode === raw) matches.push({ kind: "barcode", row: r });
      else if (r.serial_number === raw) matches.push({ kind: "serial", row: r });
    }
  }
  if (!matches.length) {
    // 名称模糊匹配，与后端 scan.py 同一套规则：精确标识符优先，都没命中才按名字找。
    // 桌面端没有相机，只能打字，只认编号等于让桌面用户没法查。
    const needle = raw.toLowerCase();
    const named = rows
      .filter((r) => String(r.name || "").toLowerCase().includes(needle))
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
      .slice(0, 20);
    for (const r of named) matches.push({ kind: "name", row: r });
  }
  if (!matches.length) {
    return {
      found: false,
      query: raw,
      message: "没有找到对应物品。可能是新物品，可直接创建。",
      suggest_create: true,
    };
  }
  const first = matches[0];
  const hints: string[] = [];
  if (first.kind === "barcode" && matches.length > 1) hints.push("该条码对应商品型号，可能有多件实物");
  if (first.kind === "name" && matches.length > 1) {
    hints.push(`${matches.length} 件物品的名称里包含「${raw}」，选一件打开`);
  }
  if (first.row.archived_at) hints.push("该物品已归档，如需继续使用请先恢复");
  return {
    found: true,
    matched_by: first.kind,
    ambiguous: matches.length > 1,
    archived: Boolean(first.row.archived_at),
    query: raw,
    item: {
      id: first.row.id,
      name: first.row.name,
      code: first.row.code,
      archived: Boolean(first.row.archived_at),
    },
    candidates: matches.map((m) => ({
      id: m.row.id,
      name: m.row.name,
      code: m.row.code,
      match: m.kind,
      status: m.row.status,
      location_id: m.row.location_id || null,
      archived: Boolean(m.row.archived_at),
    })),
    hint: hints.join("；") || null,
  };
}

// --- dispatch ---------------------------------------------------------------
export async function handle(ctx: Ctx): Promise<any> {
  const { store, method, path, query } = ctx;
  const parts = path.split("/").filter(Boolean);

  // auth / family
  if (path === "/auth/me" && method === "GET") return meResponse(store);
  if (path === "/auth/login" && method === "POST") return { ...meResponse(store), token: "local" };
  if (path === "/auth/register" && method === "POST") return { ...meResponse(store), token: "local" };
  if (path === "/auth/logout" && method === "POST") return { ok: true };
  if (path === "/auth/change-password" && method === "POST") {
    throw new ApiError(400, "本地模式没有服务器密码；如需保护数据请开启同步口令");
  }
  if (path === "/auth/me" && method === "PATCH") {
    const user = currentUser(store);
    let avatarData = user.avatar_data as string | undefined;
    if (ctx.body?.avatar_data !== undefined && ctx.body?.avatar_data !== null) {
      const incoming = String(ctx.body.avatar_data);
      if (incoming === "") avatarData = undefined;
      else if (incoming.startsWith("data:image/") && incoming.length <= 1_500_000) {
        avatarData = incoming;
      } else bad("头像只支持 1.5MB 内的 JPG / PNG / WebP");
    }
    const saved = store.write("users", {
      ...user,
      display_name: str(ctx.body?.display_name, user.display_name) || user.display_name,
      avatar_color: str(ctx.body?.avatar_color, user.avatar_color),
      avatar_data: avatarData,
      locale: str(ctx.body?.locale, user.locale) || "zh-CN",
    });
    store.patchMeta({ user_name: saved.display_name });
    // The membership row carries the replicated copy of the profile. Without
    // this touch, renaming yourself would stay on this device forever.
    const membership = store
      .all("memberships")
      .find((m) => m.user_id === saved.id && m.family_id === store.meta.family_id);
    if (membership) store.write("memberships", { ...membership });
    return { user: userOut(store) };
  }
  if (path === "/families" && method === "GET") return { items: [familyOut(store)] };
  if (path === "/families" && method === "POST") return { family: familyOut(store) };
  if (path === "/families/current" && method === "GET") return familyOut(store);
  if (path === "/families/current" && method === "PATCH") {
    const fam = currentFamilyRow(store);
    const name = str(ctx.body?.name, fam.name).trim() || fam.name;
    const saved = store.write("families", {
      ...fam,
      name,
      settings: { ...(fam.settings || {}), ...(ctx.body?.settings || {}) },
    });
    store.patchMeta({ family_name: name });
    return { family: { ...familyOut(store), name: saved.name } };
  }
  if (path === "/families/current/rotate-invite" && method === "POST") {
    const fam = currentFamilyRow(store);
    const code = "HL" + Math.random().toString(36).slice(2, 8).toUpperCase();
    store.write("families", { ...fam, invite_code: code, invite_expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
    return { invite_code: code, invite_expires_at: new Date(Date.now() + 5 * 60_000).toISOString() };
  }
  if (path === "/families/current/permission-meta") {
    return {
      roles: ROLE_PRESETS.map((r) => ({ ...r })),
      groups: PERMISSION_GROUPS.map((g) => ({
        name: g.name,
        items: g.keys.map((k) => ({ key: k, label: PERMISSION_LABELS[k] || k })),
      })),
      all: [...ALL_PERMISSIONS],
    };
  }
  if (path === "/families/current/members" && method === "GET") {
    return {
      items: store
        .all("memberships")
        .filter((m) => m.family_id === store.meta.family_id)
        .map((m) => S.memberOut(store, m)),
    };
  }
  if (path === "/families/current/members" && method === "POST") {
    throw new ApiError(400, "本地模式只能有一个成员。邀请家人请先连接同步服务器");
  }

  // locations
  if (path === "/locations" && method === "GET") return listLocations(store);
  if (path === "/locations" && method === "POST") return saveLocation(ctx);
  if (parts[0] === "locations" && parts.length === 2) {
    if (method === "PATCH") return saveLocation(ctx, parts[1]);
    if (method === "DELETE") {
      deleteLocation(ctx, parts[1]);
      return { ok: true };
    }
  }

  // categories
  if (path === "/categories" && method === "GET") return listCategories(store);
  if (path === "/categories" && method === "POST") return saveCategory(ctx);
  if (parts[0] === "categories" && parts.length === 2) {
    if (method === "PATCH") return saveCategory(ctx, parts[1]);
    if (method === "DELETE") {
      deleteCategory(ctx, parts[1]);
      return { ok: true };
    }
  }

  // items
  if (path === "/items" && method === "GET") return listItems(ctx);
  if (path === "/items" && method === "POST") return createItem(ctx);
  if (path === "/items/facets" && method === "GET") return facets(store);
  if (parts[0] === "items" && parts.length === 2) {
    // /items/batch-update 与 {item_id} 同为两段，先判静态段再落参数分支
    if (parts[1] === "batch-update" && method === "POST") return batchUpdateItems(ctx);
    if (parts[1] === "purge-deleted" && method === "POST") return purgeDeletedItems(ctx);
    if (method === "GET") return itemDetailWithQr(ctx, parts[1]);
    if (method === "PATCH") return updateItem(ctx, parts[1]);
    if (method === "DELETE") {
      return deleteItem(ctx, parts[1]);
    }
  }
  if (parts[0] === "items" && parts[2] === "archive" && method === "POST") {
    return archiveItem(ctx, parts[1], false);
  }
  if (parts[0] === "items" && parts[2] === "clone" && method === "POST") {
    return cloneItem(ctx, parts[1]);
  }
  if (parts[0] === "items" && parts[2] === "restore" && method === "POST") {
    // 墓碑物品走解墓碑恢复：write 回 _deleted=false 让同步引擎把复活推出去
    const raw = store.tables["items"].get(parts[1]);
    if (raw && raw._deleted) {
      const revived = store.write("items", {
        ...raw,
        _deleted: false,
        deleted_at: null,
        archived_at: null,
        updated_at: nowIso(),
      });
      event(store, parts[1], "restored", "恢复物品");
      audit(store, "item.restore", `恢复物品：${revived.name}`, "item", parts[1]);
      return { ok: true };
    }
    return archiveItem(ctx, parts[1], true);
  }
  if (parts[0] === "items" && parts[2] === "events" && method === "GET") {
    return {
      items: store
        .all("events")
        .filter((e) => e.item_id === parts[1])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map(S.eventOut),
    };
  }
  if (parts[0] === "items" && parts[2] === "components" && method === "POST") {
    const body = ctx.body || {};
    const item = store.get("items", parts[1]);
    if (!item) notFound("物品不存在");
    const row: Row = {
      id: uuid(),
      family_id: store.meta.family_id,
      item_id: parts[1],
      name: str(body.name).trim() || "部件",
      component_type: str(body.component_type, "part") || "part",
      serial_number: str(body.serial_number),
      quantity: num(body.quantity, 1) || 1,
      installed_at: body.installed_at || null,
      note: str(body.note),
      created_at: nowIso(),
    };
    const saved = store.write("components", row);
    event(store, parts[1], "component", `添加部件：${row.name}`);
    return { component: S.componentOut(saved) };
  }
  if (parts[0] === "items" && parts[2] === "components" && parts.length === 4 && method === "DELETE") {
    store.remove("components", parts[3]);
    return { ok: true };
  }
  if (parts[0] === "items" && parts[2] === "batches" && method === "GET") {
    if (!store.get("items", parts[1])) notFound("物品不存在");
    return { items: batchList(store, parts[1]) };
  }
  if (parts[0] === "items" && parts[2] === "batches" && method === "POST") {
    return saveBatch(ctx, parts[1]);
  }
  if (parts[0] === "batches" && parts.length === 2) {
    if (method === "PATCH") {
      const row = store.get("batches", parts[1]);
      if (!row) notFound("批次不存在");
      return saveBatch(ctx, row.item_id, parts[1]);
    }
    if (method === "DELETE") {
      deleteBatch(ctx, parts[1]);
      return { ok: true };
    }
  }
  if (parts[0] === "items" && parts[2] === "acl") {
    return { ok: true, acl: [] };
  }
  if (path === "/items/bulk" && method === "POST") {
    const body = ctx.body || {};
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    const action = str(body.action);
    let affected = 0;
    for (const id of ids) {
      const row = store.get("items", id);
      if (!row) continue;
      if (action === "archive") {
        store.write("items", { ...row, archived_at: nowIso(), status: "archived" });
        affected += 1;
      } else if (action === "restore") {
        store.write("items", { ...row, archived_at: null, status: "stored" });
        affected += 1;
      } else if (action === "delete") {
        store.remove("items", id);
        affected += 1;
      } else if (action === "location" || action === "category") {
        const key = action === "location" ? "location_id" : "category_id";
        store.write("items", { ...row, [key]: body.value || null });
        affected += 1;
      }
    }
    audit(store, "item.bulk", `批量操作 ${action}：${affected} 件`, "item", "");
    return { affected };
  }
  if (path === "/items/import" && method === "POST") {
    const rows = Array.isArray(ctx.body?.rows) ? ctx.body.rows : [];
    let created = 0;
    for (const raw of rows) {
      const name = str(raw.name).trim();
      if (!name) continue;
      createItem({
        ...ctx,
        body: {
          ...raw,
          category_id: raw.category_id || matchByName(store, "categories", raw.category),
          location_id: raw.location_id || matchByName(store, "locations", raw.location),
        },
      });
      created += 1;
    }
    audit(store, "item.import", `导入 ${created} 件物品`, "item", "");
    return { created, skipped: rows.length - created };
  }
  if (path === "/items/export.csv" && method === "GET") {
    return { csv: exportCsv(store) };
  }

  // maintenance
  if (path === "/maintenance" && method === "GET") return listMaintenance(ctx);
  if (path === "/maintenance/calendar.ics" && method === "GET") return maintenanceIcs(store);
  if (path === "/maintenance" && method === "POST") return saveMaintenance(ctx);
  if (parts[0] === "maintenance" && parts.length === 2) {
    if (method === "PATCH") return saveMaintenance(ctx, parts[1]);
    if (method === "DELETE") {
      deleteMaintenance(ctx, parts[1]);
      return { ok: true };
    }
  }
  if (parts[0] === "maintenance" && parts[2] === "complete" && method === "POST") {
    return completeMaintenance(ctx, parts[1]);
  }
  if (parts[0] === "maintenance" && parts[2] === "skip" && method === "POST") {
    return skipMaintenance(ctx, parts[1]);
  }

  // loans
  if (path === "/loans" && method === "GET") return listLoans(ctx);
  if (path === "/loans" && method === "POST") return createLoan(ctx);
  if (parts[0] === "loans" && parts[2] === "return" && method === "POST") {
    return returnLoan(ctx, parts[1]);
  }

  // attachments
  if (path === "/attachments" && method === "POST") return uploadAttachment(ctx);
  if (path === "/attachments" && method === "GET") {
    const itemId = query.get("item_id");
    const rows = store
      .all("attachments")
      .filter((a) => a.family_id === store.meta.family_id && (!itemId || a.item_id === itemId))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return { items: rows.map(S.attachmentOut) };
  }
  if (parts[0] === "attachments" && parts.length === 2 && method === "DELETE") {
    deleteAttachment(ctx, parts[1]);
    return { ok: true };
  }

  // system
  if (path === "/system/dashboard") return dashboard(store);
  if (path === "/system/health") {
    return { status: "ok", mode: "local", version: APP_VERSION, time: nowIso() };
  }
  if (path === "/system/info") {
    return {
      app_name: "HomeLedger",
      version: APP_VERSION,
      deployment: deploymentInfo(store),
      allow_registration: false,
      bootstrap_required: false,
    };
  }
  if (path === "/system/providers") {
    // 设置页的「部署」标签直接读 database.dialect / storage.backend /
    // notifications[].channel，字段名必须与服务端 /system/providers 保持一致。
    // 早期本机实现返回的是 name/capabilities 形式，打开该标签会在
    // providers.database.dialect.toUpperCase() 处抛错并触发错误边界。
    return {
      database: {
        dialect: "indexeddb",
        ok: true,
        concurrent_writers: false,
        recommended_mode: "local",
      },
      storage: {
        backend: "local",
        ok: true,
        root: "浏览器 / 应用本地存储",
      },
      backup: {
        backend: "export",
        ok: true,
        dir: "浏览器下载目录",
      },
      notifications: [{ ok: true, channel: "inapp" }],
      ai: {
        name: "none",
        supports_vision: false,
        leaves_device: false,
        privacy_notice: "本机模式不调用外部 AI，图片和文字不会离开设备",
      },
      deployment: deploymentInfo(store),
    };
  }
  if (path === "/system/backups" && method === "GET") {
    return {
      items: store
        .all("backups")
        .filter((b) => b.family_id === store.meta.family_id)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    };
  }
  if (path === "/system/backups" && method === "POST") {
    return { backup: await makeBackup(store) };
  }
  if (parts[0] === "system" && parts[1] === "backups" && parts.length === 3 && method === "DELETE") {
    // 路由是 /system/backups/<filename>，三段，不是四段。之前按四段匹配，
    // 这个分支永远不会命中，删除请求一路掉到末尾的 404。
    const filename = decodeURIComponent(parts[2]);
    // 路径里带的是文件名，不是行 id——本机备份的 id 是 uuid，两者不能混用。
    const row = store.all("backups").find((b) => b.filename === filename);
    if (!row) throw new ApiError(404, "备份不存在");
    // 走 remove() 而不是直接动 Map：只有它会写墓碑、标脏、触发同步。
    store.remove("backups", row.id);
    audit(store, "system.backup.delete", `删除备份记录：${filename}`, "backup", row.id);
    // file_removed 恒为 false：本机备份在创建时就下载到了系统下载目录，
    // 浏览器拿不到那个文件的句柄，删不了也不该假装删了。
    return { ok: true, record_removed: true, file_removed: false };
  }
  if (path === "/system/export.json") return exportSnapshot(store);

  if (path === "/audit") return listAudit(ctx);
  if (path === "/notifications" && method === "GET") return listNotifications(ctx);
  if (path === "/notifications/read" && method === "POST") return markNotificationsRead(ctx);

  // scan
  if (path === "/scan/lookup") return scanLookup(ctx);
  if (path === "/scan/ai/providers") {
    return { providers: [{ id: "none", label: "本机模式（不启用 AI）", available: false }], active: "none" };
  }
  if (path === "/scan/ocr" && method === "POST") {
    throw new ApiError(400, "本机模式没有接入 OCR 服务。可以在设置里连接服务器后使用");
  }

  throw new ApiError(404, `本机模式暂不支持该操作：${method} ${path}`);
}

function matchByName(store: LocalStore, table: "categories" | "locations", name: unknown): string | null {
  const key = str(name).trim();
  if (!key) return null;
  const hit = store.all(table).find((r) => r.name === key);
  return hit ? hit.id : null;
}

function exportCsv(store: LocalStore): string {
  const headers = [
    "编号", "名称", "分类", "位置", "数量", "单位", "状态", "品牌", "型号",
    "序列号", "条码", "购买日期", "价格", "保修至", "标签", "备注",
  ];
  const rows = familyItems(store).map((r) => {
    const cat = store.get("categories", r.category_id);
    const loc = store.get("locations", r.location_id);
    return [
      r.code, r.name, cat?.name || "", loc?.name || "", r.quantity ?? 1, r.unit || "件",
      r.status || "", r.brand || "", r.model || "", r.serial_number || "", r.barcode || "",
      r.purchase_date || "", r.purchase_price ?? "", r.warranty_until || "",
      (r.tags || []).join("|"), r.description || "",
    ];
  });
  const escape = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
}

// --- backup -----------------------------------------------------------------
export function exportSnapshot(store: LocalStore): Row {
  const data: Record<string, Row[]> = {};
  for (const table of Object.keys(store.tables) as (keyof typeof store.tables)[]) {
    data[table] = store.raw(table);
  }
  return {
    format: "homeledger-backup",
    version: 1,
    exported_at: nowIso(),
    device_id: store.meta.device_id,
    family: { id: store.meta.family_id, name: store.meta.family_name },
    tables: data,
  };
}

async function makeBackup(store: LocalStore): Promise<Row> {
  const json = JSON.stringify(exportSnapshot(store));
  const blob = new Blob([json], { type: "application/json" });
  const id = uuid();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // 时间戳只到秒，连点两次「立即备份」会撞名。撞名之后记录无法区分，
  // 删除时按文件名找到的可能是另一条。服务器那边用 O_EXCL 抢名字，这里
  // 没有文件系统可用，就按同样的规则补 -2、-3。
  let filename = `homeledger-${stamp}.json`;
  for (let n = 2; store.all("backups").some((b) => b.filename === filename); n += 1) {
    filename = `homeledger-${stamp}-${n}.json`;
  }

  // A local "backup" is a download: there is no server directory to write to,
  // and telling the user it exists somewhere without handing them the file
  // would be a lie they only discover when they need it.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  const row: Row = {
    id,
    family_id: store.meta.family_id,
    filename,
    size_bytes: blob.size,
    sha256: "",
    kind: "manual",
    status: "ready",
    note: "已导出到下载目录",
    includes_files: false,
    created_by: store.meta.user_id,
    created_at: nowIso(),
  };
  store.write("backups", row);
  audit(store, "system.backup", `导出快照：${filename}`, "backup", id);
  return row;
}

export { exportSnapshot as snapshot };
