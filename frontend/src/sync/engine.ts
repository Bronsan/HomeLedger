/**
 * Replication client.
 *
 * The device is the source of truth for its own copy; this module's only job
 * is to make copies converge. It never blocks the UI: writes land locally
 * first and are pushed on a timer, and a failed push is a status line, not a
 * lost edit.
 *
 * Ordering rules
 *
 *   - Each record carries an HLC. The server keeps the highest one it has seen
 *     and hands back its own copy when a push is stale, so two devices that
 *     edited the same row while offline converge in one round trip.
 *   - Deletes are tombstones, not row removal, because "absent" and "deleted"
 *     must not look the same to a device that was offline.
 *
 * Privacy rules
 *
 *   - `meta` is plaintext and deliberately boring: enough to render a list.
 *   - everything else goes into `secret`, encrypted with the family DEK that
 *     never leaves the devices.
 */

import {
  KeyBundle,
  createKeyBundle,
  decryptBlob,
  decryptJson,
  encryptBlob,
  encryptJson,
  fromBase64,
  toBase64,
  unlockKeyBundle,
} from "../local/crypto";
import { bootstrap } from "../local/api";
import { LocalStore, Row, Table, nowIso, splitKey, store } from "../local/store";
import { getMode, normalizeServer, serverStore, setMode } from "../api/client";
import { entryStore, serviceSession } from "../lib/service";
import { subscribeChanges, reconnectChanges } from "../lib/live";

const TOKEN_KEY = "hl_sync_token";
const FAMILY_KEY = "hl_sync_family";
const EMAIL_KEY = "hl_sync_email";
const URL_KEY = "hl_sync_url";

export interface SyncState {
  configured: boolean;
  connected: boolean;
  unlocked: boolean;
  running: boolean;
  pending: number;
  last_sync_at: string | null;
  error: string;
  server_url: string;
  account: string;
}

type Listener = (state: SyncState) => void;

let listeners: Set<Listener> = new Set();
let running = false;
let lastError = "";
let dek: Uint8Array | null = null;
let timer: number | null = null;
let debounce: number | null = null;
let queue: Promise<void> = Promise.resolve();
let generation = 0;
let keyLocked = false;
let pairing = false;
const controllers = new Set<AbortController>();
let liveUnsubscribe: (() => void) | null = null;
const onOnline = () => scheduleSync(0);

type Context = { base: string; token: string; family: string; epoch: number; pairing?: boolean };
function entryAllowed(): boolean {
  return entryStore.get() !== "online" || serviceSession.verified();
}
function assertContext(ctx: Context): void {
  if (ctx.epoch !== generation || !entryAllowed() || (!ctx.pairing &&
      (getMode() !== "sync" || ctx.base !== baseUrl() || ctx.token !== localStorage.getItem(TOKEN_KEY) ||
       ctx.family !== localStorage.getItem(FAMILY_KEY)))) {
    throw new Error("同步已暂停或连接已变更");
  }
}
function context(s: LocalStore): Context {
  const ctx = { base: baseUrl(), token: localStorage.getItem(TOKEN_KEY) || "",
    family: localStorage.getItem(FAMILY_KEY) || "", epoch: generation };
  assertContext(ctx);
  const binding = s.meta.sync_binding;
  if (!s.meta.sync_enabled || !ctx.base || !ctx.token || !ctx.family || !binding ||
      binding.server_url !== ctx.base || binding.family_id !== ctx.family) {
    throw new Error("同步目标尚未验证，请重新连接原服务器及家庭");
  }
  return ctx;
}
/** Credentials for server-only reads (QR links) that do not touch replication. */
function sessionContext(): Context {
  const ctx = { base: baseUrl(), token: localStorage.getItem(TOKEN_KEY) || "",
    family: localStorage.getItem(FAMILY_KEY) || "", epoch: generation };
  assertContext(ctx);
  if (!ctx.base || !ctx.token || !ctx.family) throw new Error("尚未连接服务器");
  return ctx;
}
function bundleOnly(bundle: KeyBundle): KeyBundle {
  const { kdf, salt, memory_kib, iterations, parallelism, wrapped_dek, verifier } = bundle;
  return { kdf, salt, memory_kib, iterations, parallelism, wrapped_dek, verifier };
}

function emit(): void {
  void snapshot().then((s) => listeners.forEach((fn) => fn(s)));
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  void snapshot().then(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function snapshot(): Promise<SyncState> {
  const s = await store();
  return {
    configured: Boolean(s.meta.sync_enabled && s.meta.server_url),
    connected: Boolean(localStorage.getItem(TOKEN_KEY) && localStorage.getItem(FAMILY_KEY)),
    unlocked: !keyLocked && Boolean(dek || s.meta.e2ee?.dek),
    running,
    pending: s.dirty.size,
    last_sync_at: s.meta.last_sync_at,
    error: lastError || s.meta.last_sync_error,
    server_url: s.meta.server_url,
    account: localStorage.getItem(EMAIL_KEY) || "",
  };
}

// --- HTTP to the sync server ------------------------------------------------
function baseUrl(): string {
  const raw = localStorage.getItem(URL_KEY) || "";
  return raw.replace(/\/+$/, "");
}

async function call<T>(path: string, init: RequestInit, ctx: Context): Promise<T> {
  assertContext(ctx);
  const ctrl = new AbortController();
  controllers.add(ctrl);
  const timeout = window.setTimeout(() => ctrl.abort(), 20_000);
  const headers = new Headers(init.headers);
  if (ctx.token) headers.set("Authorization", `Bearer ${ctx.token}`);
  if (ctx.family) headers.set("X-Family-Id", ctx.family);
  try {
    const res = await fetch(`${ctx.base}/api/v1${path}`, { ...init, headers,
      signal: ctrl.signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    assertContext(ctx);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      assertContext(ctx);
      if (res.status === 401 && !ctx.pairing) {
        localStorage.removeItem(TOKEN_KEY);
        stopAutoSync();
      }
      throw new Error(typeof body?.detail === "string" ? body.detail : `同步请求失败（${res.status}）`);
    }
    if (res.status === 204) return undefined as T;
    const value = (res.headers.get("content-type") || "").includes("application/json")
      ? await res.json() : await res.blob();
    assertContext(ctx);
    return value as T;
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error("同步请求已取消或超时");
    throw err;
  } finally {
    window.clearTimeout(timeout);
    controllers.delete(ctrl);
  }
}

// --- entity mapping ---------------------------------------------------------
interface EntityMap {
  entity: string;
  table: Table;
  meta: (row: Row) => Row;
  secret: (row: Row) => Row;
  build: (meta: Row, secret: Row | null) => Row;
}

const base = (meta: Row) => ({ id: meta.id, ...meta });

const MAPS: EntityMap[] = [
  {
    entity: "family",
    table: "families",
    meta: (r) => ({
      id: r.id,
      name: r.name,
      created_by: r.created_by,
      created_at: r.created_at,
      family_id: r.id,
    }),
    secret: (r) => ({ settings: r.settings || {}, invite_code: r.invite_code || "" }),
    build: (m, s) => ({
      ...base(m),
      settings: s?.settings || {},
      invite_code: s?.invite_code || "",
      deployment_mode: "local",
    }),
  },
  {
    entity: "location",
    table: "locations",
    meta: (r) => ({
      id: r.id,
      parent_id: r.parent_id ?? null,
      name: r.name,
      kind: r.kind,
      icon: r.icon,
      sort_order: r.sort_order ?? 0,
      created_at: r.created_at,
    }),
    secret: (r) => ({ note: r.note || "" }),
    build: (m, s) => ({ ...base(m), note: s?.note || "" }),
  },
  {
    entity: "category",
    table: "categories",
    meta: (r) => ({
      id: r.id,
      parent_id: r.parent_id ?? null,
      name: r.name,
      icon: r.icon,
      color: r.color,
      sort_order: r.sort_order ?? 0,
      created_at: r.created_at,
    }),
    secret: () => ({}),
    build: (m) => base(m),
  },
  {
    entity: "item",
    table: "items",
    meta: (r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      category_id: r.category_id ?? null,
      location_id: r.location_id ?? null,
      status: r.status,
      condition: r.condition,
      quantity: r.quantity,
      unit: r.unit,
      brand: r.brand || "",
      model: r.model || "",
      barcode: r.barcode || "",
      tags: r.tags || [],
      archived_at: r.archived_at || null,
      cover_attachment_id: r.cover_attachment_id || null,
      owner_user_id: r.owner_user_id || null,
      custodian_user_id: r.custodian_user_id || null,
      expected_life_months: r.expected_life_months ?? null,
      version: r.version ?? 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }),
    secret: (r) => ({
      description: r.description || "",
      serial_number: r.serial_number || "",
      barcode_type: r.barcode_type || "",
      purchase_date: r.purchase_date || null,
      purchase_price: r.purchase_price ?? null,
      currency: r.currency || "CNY",
      purchase_from: r.purchase_from || "",
      warranty_until: r.warranty_until || null,
      custom_fields: r.custom_fields || {},
      created_by: r.created_by || "",
      updated_by: r.updated_by || "",
    }),
    build: (m, s) => ({
      ...base(m),
      description: s?.description || "",
      serial_number: s?.serial_number || "",
      barcode_type: s?.barcode_type || "",
      purchase_date: s?.purchase_date ?? null,
      purchase_price: s?.purchase_price ?? null,
      currency: s?.currency || "CNY",
      purchase_from: s?.purchase_from || "",
      warranty_until: s?.warranty_until ?? null,
      custom_fields: s?.custom_fields || {},
      created_by: s?.created_by || "",
      updated_by: s?.updated_by || "",
    }),
  },
  {
    entity: "component",
    table: "components",
    meta: (r) => ({
      id: r.id,
      item_id: r.item_id,
      name: r.name,
      component_type: r.component_type,
      quantity: r.quantity ?? 1,
      created_at: r.created_at,
    }),
    secret: (r) => ({
      serial_number: r.serial_number || "",
      installed_at: r.installed_at ?? null,
      note: r.note || "",
    }),
    build: (m, s) => ({
      ...base(m),
      serial_number: s?.serial_number || "",
      installed_at: s?.installed_at ?? null,
      note: s?.note || "",
    }),
  },
  {
    entity: "batch",
    table: "batches",
    // Dates go into `secret`, not `meta`: `item.warranty_until` is secret for
    // the same reason. What someone keeps in the pantry and when it expires is
    // exactly the kind of thing the plaintext layer must not reveal.
    meta: (r) => ({
      id: r.id,
      item_id: r.item_id,
      batch_no: r.batch_no || "",
      quantity: r.quantity ?? 1,
      unit: r.unit || "",
      version: r.version ?? 1,
      created_at: r.created_at,
      updated_at: r.updated_at || r.created_at,
    }),
    secret: (r) => ({
      produced_on: r.produced_on ?? null,
      expires_on: r.expires_on ?? null,
      location_id: r.location_id ?? null,
      supplier: r.supplier || "",
      note: r.note || "",
      created_by: r.created_by || "",
      updated_by: r.updated_by || "",
    }),
    build: (m, s) => ({
      ...base(m),
      produced_on: s?.produced_on ?? null,
      expires_on: s?.expires_on ?? null,
      location_id: s?.location_id ?? null,
      supplier: s?.supplier || "",
      note: s?.note || "",
      created_by: s?.created_by || "",
      updated_by: s?.updated_by || "",
    }),
  },
  {
    entity: "maintenance",
    table: "maintenance",
    meta: (r) => ({
      id: r.id,
      item_id: r.item_id,
      title: r.title,
      task_type: r.task_type,
      status: r.status,
      next_due_at: r.next_due_at ?? null,
      interval_days: r.interval_days ?? null,
      priority: r.priority,
      assignee_id: r.assignee_id ?? null,
      created_at: r.created_at,
    }),
    secret: (r) => ({
      notes: r.notes || "",
      estimated_cost: r.estimated_cost ?? null,
      last_completed_at: r.last_completed_at ?? null,
    }),
    build: (m, s) => ({
      ...base(m),
      notes: s?.notes || "",
      estimated_cost: s?.estimated_cost ?? null,
      last_completed_at: s?.last_completed_at ?? null,
    }),
  },
  {
    entity: "loan",
    table: "loans",
    meta: (r) => ({
      id: r.id,
      item_id: r.item_id,
      borrower_name: r.borrower_name,
      lent_at: r.lent_at,
      due_at: r.due_at ?? null,
      returned_at: r.returned_at ?? null,
    }),
    secret: (r) => ({ borrower_contact: r.borrower_contact || "", note: r.note || "" }),
    build: (m, s) => ({
      ...base(m),
      borrower_contact: s?.borrower_contact || "",
      note: s?.note || "",
    }),
  },
  {
    entity: "attachment",
    table: "attachments",
    meta: (r) => ({
      id: r.id,
      item_id: r.item_id ?? null,
      kind: r.kind,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      is_image: Boolean(r.is_image),
      blob_id: r.blob_id,
      created_at: r.created_at,
    }),
    secret: (r) => ({ original_name: r.original_name, thumb_data: r.thumb_data || null }),
    build: (m, s) => ({
      ...base(m),
      original_name: s?.original_name || "附件",
      thumb_data: s?.thumb_data ?? null,
    }),
  },
  {
    entity: "event",
    table: "events",
    meta: (r) => ({
      id: r.id,
      item_id: r.item_id,
      event_type: r.event_type,
      created_at: r.created_at,
    }),
    secret: (r) => ({
      summary: r.summary,
      payload: r.payload || {},
      actor_name: r.actor_name || "",
    }),
    build: (m, s) => ({
      ...base(m),
      summary: s?.summary || "",
      payload: s?.payload || {},
      actor_name: s?.actor_name || "",
    }),
  },
];

const BY_TABLE = new Map<string, EntityMap>(MAPS.map((m) => [m.table, m]));
const BY_ENTITY = new Map<string, EntityMap>(MAPS.map((m) => [m.entity, m]));

// `member` is the one entity that spans two local tables: the profile lives in
// `users`, the role in `memberships`. Keeping them together is what makes
// "who is in this family" one record instead of two that can disagree.
const MEMBER = {
  entity: "member",
  meta: (r: Row, user: Row | null) => ({
    id: r.id,
    user_id: r.user_id,
    role: r.role,
    status: r.status,
    joined_at: r.joined_at,
    user_created_at: user?.created_at || r.joined_at,
  }),
  secret: (r: Row, user: Row | null) => ({
    nickname: r.nickname || "",
    permission_overrides: r.permission_overrides || {},
    display_name: user?.display_name || "",
    email: user?.email || "",
    avatar_color: user?.avatar_color || "#64748b",
  }),
};

function aad(entity: string, id: string): string {
  return `hl1|${entity}|${id}`;
}

function requireDek(s: LocalStore): Uint8Array {
  if (keyLocked) throw new Error("同步口令已锁定，请先解锁");
  if (!dek && s.meta.e2ee?.dek) dek = fromBase64(s.meta.e2ee.dek);
  if (!dek) throw new Error("同步口令尚未解锁");
  return dek;
}

// --- push -------------------------------------------------------------------
async function pushOnce(s: LocalStore, ctx: Context): Promise<void> {
  assertContext(ctx);
  const key = requireDek(s);
  const pending = Array.from(s.dirty.entries());
  if (!pending.length) return;

  const records: Row[] = [];
  const sent: { table: Table; id: string; hlc: string }[] = [];

  for (const [composite, hlc] of pending) {
    const [maybeTable, id] = splitKey(composite);
    if (!maybeTable) continue;
    const table = maybeTable as Table;
    const row = s.getRaw(table, id);
    if (!row || row._hlc !== hlc) continue;

    if (table === "families") {
      // The family row is one record shared by every device, so it has to be
      // keyed by the server's family id. Using each device's local id would
      // create one "family" per device and let them fight over the name.
      const remoteId = localStorage.getItem(FAMILY_KEY) || row.id;
      const map = BY_TABLE.get("families")!;
      records.push({
        entity: "family",
        id: remoteId,
        hlc: row._hlc,
        op: row._deleted ? "delete" : "upsert",
        meta: map.meta(row),
        secret: row._deleted ? null : encryptJson(key, map.secret(row), aad("family", remoteId)),
        blobs: [],
      });
      sent.push({ table, id, hlc });
      continue;
    }

    if (table === "memberships") {
      const user = s.get("users", row.user_id);
      records.push({
        entity: "member",
        id: row.id,
        hlc: row._hlc,
        op: row._deleted ? "delete" : "upsert",
        meta: MEMBER.meta(row, user),
        secret: row._deleted ? null : encryptJson(key, MEMBER.secret(row, user), aad("member", row.id)),
        blobs: [],
      });
      sent.push({ table, id, hlc });
      continue;
    }

    const map = BY_TABLE.get(table);
    if (!map) continue;
    records.push({
      entity: map.entity,
      id: row.id,
      hlc: row._hlc,
      op: row._deleted ? "delete" : "upsert",
      meta: map.meta(row),
      secret: row._deleted ? null : encryptJson(key, map.secret(row), aad(map.entity, row.id)),
      blobs: map.entity === "attachment" && row.blob_id ? [row.blob_id] : [],
    });
    sent.push({ table, id, hlc });
  }

  if (!records.length) return;

  // Attachment bytes go up before the record that points at them, so a device
  // that pulls the record can immediately fetch a blob that exists.
  await uploadBlobs(s, key, records, ctx);
  assertContext(ctx);

  const chunkSize = 200;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const res = await call<{ applied: number; resolved: Row[] }>("/sync/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: s.meta.device_id,
        device_name: s.meta.device_name,
        device_kind: s.meta.device_kind,
        app_version: "2.0.2-beta",
        records: chunk,
      }),
    }, ctx);
    assertContext(ctx);
    if (res.resolved?.length) applyRecords(s, res.resolved, key);
  }

  s.clearDirty(sent);
  await s.flush();
}

async function uploadBlobs(s: LocalStore, key: Uint8Array, records: Row[], ctx: Context): Promise<void> {
  const ids = new Set<string>();
  for (const r of records) for (const b of r.blobs || []) ids.add(b);
  if (!ids.size) return;

  for (const blobId of ids) {
    const attachment = s
      .all("attachments")
      .find((a) => a.blob_id === blobId);
    if (!attachment || !attachment.pending_upload) continue;
    const blob = await s.getBlob(blobId);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const framed = encryptBlob(key, bytes);
    await call(`/sync/blob/${encodeURIComponent(blobId)}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" },
      body: framed as unknown as BodyInit,
    }, ctx);
    assertContext(ctx);
    const updated = { ...attachment, pending_upload: false };
    // Not a local edit: keep the HLC so this does not ping-pong.
    s.applyRemote("attachments", updated, false);
  }
}

// --- pull -------------------------------------------------------------------
async function pullOnce(s: LocalStore, ctx: Context): Promise<void> {
  assertContext(ctx);
  const key = requireDek(s);
  let cursor = s.meta.cursor || 0;
  for (;;) {
    const res = await call<{ records: Row[]; cursor: number; has_more: boolean }>(
      `/sync/pull?since=${cursor}&limit=200`, {}, ctx
    );
    assertContext(ctx);
    if (!Array.isArray(res.records) || !Number.isSafeInteger(res.cursor) || res.cursor < cursor ||
        (res.has_more && res.cursor === cursor)) throw new Error("服务器返回的同步游标不正确");
    if (!res.records.length) {
      if (res.cursor !== cursor) s.patchMeta({ cursor: res.cursor });
      break;
    }
    applyRecords(s, res.records, key);
    cursor = res.cursor;
    s.patchMeta({ cursor });
    await s.flush();
    if (!res.has_more) break;
  }
}

function applyRecords(s: LocalStore, records: Row[], key?: Uint8Array): void {
  const dekKey = key || (s.meta.e2ee?.dek ? fromBase64(s.meta.e2ee.dek) : null);
  for (const rec of records) {
    const entity = String(rec.entity || "");
    const id = String(rec.id || rec.entity_id || "");
    if (!entity || !id) continue;

    try {
      if (entity === "member") {
        applyMember(s, rec, dekKey);
        continue;
      }
      const map = BY_ENTITY.get(entity);
      if (!map) continue;
      if (entity === "family") {
        const target = s.meta.family_id;
        const localFamily = s.getRaw("families", target);
        if (localFamily && String(localFamily._hlc || "") >= String(rec.hlc || "")) continue;
        let famSecret: Row | null = null;
        if (rec.op !== "delete" && rec.secret && dekKey) {
          famSecret = decryptJson<Row>(dekKey, rec.secret, aad("family", id));
        }
        s.applyRemote("families", {
          ...map.build(rec.meta || {}, famSecret),
          id: target,
          family_id: target,
          _hlc: rec.hlc,
        });
        if (rec.meta?.name) s.patchMeta({ family_name: String(rec.meta.name) });
        continue;
      }
      const local = s.getRaw(map.table, id);
      if (local && String(local._hlc || "") >= String(rec.hlc || "")) continue;

      let secret: Row | null = null;
      if (rec.op !== "delete" && rec.secret && dekKey) {
        secret = decryptJson<Row>(dekKey, rec.secret, aad(entity, id));
      }
      const row: Row = {
        ...map.build(rec.meta || {}, secret),
        family_id: s.meta.family_id,
        _hlc: rec.hlc,
        _deleted: rec.op === "delete",
      };
      s.applyRemote(map.table, row);
    } catch (err) {
      // Leave the cursor unchanged; earlier applied records are idempotent on retry.
      throw new Error(`同步记录无法解密或应用（${entity}），未越过此页游标，请检查原设备和同步口令`);
    }
  }
}

function applyMember(s: LocalStore, rec: Row, key: Uint8Array | null): void {
  const id = String(rec.id);
  const local = s.getRaw("memberships", id);
  if (local && String(local._hlc || "") >= String(rec.hlc || "")) return;
  let secret: Row | null = null;
  if (rec.op !== "delete" && rec.secret && key) {
    secret = decryptJson<Row>(key, rec.secret, aad("member", id));
  }
  const meta = rec.meta || {};
  const userId = String(meta.user_id || "");
  if (userId) {
    const user = s.getRaw("users", userId);
    s.applyRemote("users", {
      ...(user || { id: userId }),
      id: userId,
      display_name: secret?.display_name || user?.display_name || "成员",
      email: secret?.email || user?.email || "",
      avatar_color: secret?.avatar_color || user?.avatar_color || "#64748b",
      is_active: meta.status !== "suspended",
      created_at: meta.user_created_at || user?.created_at || nowIso(),
      family_id: s.meta.family_id,
      _hlc: rec.hlc,
      _deleted: rec.op === "delete",
    });
  }
  s.applyRemote("memberships", {
    id,
    family_id: s.meta.family_id,
    user_id: userId,
    role: meta.role || "member",
    status: meta.status || "active",
    nickname: secret?.nickname || "",
    permission_overrides: secret?.permission_overrides || {},
    joined_at: meta.joined_at || nowIso(),
    _hlc: rec.hlc,
    _deleted: rec.op === "delete",
  });
}

// --- public API -------------------------------------------------------------
async function runOnce(s: LocalStore): Promise<void> {
  const ctx = context(s);
  await pushOnce(s, ctx);
  assertContext(ctx);
  await pullOnce(s, ctx);
  assertContext(ctx);
  s.patchMeta({ last_sync_at: nowIso(), last_sync_error: "" });
  lastError = "";
}

export function syncNow(opts: { quiet?: boolean } = {}): Promise<void> {
  // The chain must stay resolved after a failure. A rejected queue used to
  // skip every later job, so one offline tick disabled sync until reload.
  const job = queue.catch(() => undefined).then(async () => {
    const s = await bootstrap();
    if (running || keyLocked || !entryAllowed() || getMode() !== "sync") return;
    running = true;
    emit();
    try {
      await runOnce(s);
    } catch (err) {
      lastError = (err as Error).message;
      s.patchMeta({ last_sync_error: lastError });
      await s.flush().catch(() => undefined);
      throw err;
    } finally {
      running = false;
      emit();
    }
  });
  queue = job.catch(() => undefined);
  return opts.quiet ? job.catch(() => undefined) : job;
}

export function scheduleSync(delay = 2500): void {
  if (getMode() !== "sync" || !entryAllowed()) return;
  if (debounce !== null) window.clearTimeout(debounce);
  debounce = window.setTimeout(() => {
    debounce = null;
    void syncNow({ quiet: true });
  }, delay);
}

/**
 * 让"别的设备推上来一条"变成"这台设备马上拉一次"。
 *
 * 以前只有 60 秒的定时拉取，所以两台设备之间最长有一分钟的延迟——两个人在
 * 同一个房间里改同一件东西时，这个延迟会让人以为对方没保存。事件流把主路径
 * 变成 1 秒级，定时器退化成兜底。
 *
 * 自己的写入也会收到（服务器不做设备区分），于是会多一次空拉取。这是故意的：
 * 要区分"我推的"就得给每条记录带设备号并在服务端过滤，为一个空请求不值得。
 */
function hookLiveChanges(): void {
  if (liveUnsubscribe) return;
  liveUnsubscribe = subscribeChanges(() => scheduleSync(800));
}

export function startAutoSync(): void {
  stopAutoSync();
  if (getMode() !== "sync" || keyLocked || !entryAllowed()) return;
  // 60 秒只是兜底：正常情况下事件流会在 1 秒内触发一次同步。
  timer = window.setInterval(() => void syncNow({ quiet: true }), 60_000);
  window.addEventListener("online", onOnline);
  hookLiveChanges();
}

export function stopAutoSync(): void {
  // Invalidate every in-flight request/computation before releasing handles.
  generation += 1;
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  if (debounce !== null) window.clearTimeout(debounce);
  debounce = null;
  window.removeEventListener("online", onOnline);
  liveUnsubscribe?.();
  liveUnsubscribe = null;
  for (const controller of controllers) controller.abort();
  controllers.clear();
}

export interface LinkOptions {
  serverUrl: string;
  email: string;
  password: string;
  passphrase: string;
  createAccount?: boolean;
  familyName?: string;
}

type AuthResult = { token?: string; current_family_id?: string | null };

/**
 * Connects this device to a server.
 *
 * Two cases that look similar to the user but are very different underneath:
 *
 *   - the server has no key yet  → this device mints one and becomes the
 *     origin of the family's encryption
 *   - the server already has one → this device adopts it, which requires the
 *     same passphrase
 *
 * In both cases the local library is pushed afterwards, so "connect" never
 * silently discards what the user already has on the device.
 */
export async function linkServer(
  opts: LinkOptions
): Promise<{ joined: boolean; mergedCatalog: number }> {
  const s = await bootstrap();
  const url = normalizeServer(opts.serverUrl);
  if (!url) throw new Error("服务器地址格式不正确");
  if (!entryAllowed()) throw new Error("请先在欢迎页完成联网账号验证，再连接家庭服务器");
  stopAutoSync();

  // Candidate credentials live in memory only. Nothing touches storage until
  // the account and the family key have both been proven, so one wrong
  // passphrase cannot detach an installation that was working.
  const candidate: Context = { base: url, token: "", family: "", epoch: generation, pairing: true };
  let bundle: KeyBundle;
  let nextDek: Uint8Array;
  let token: string;
  let familyId: string;
  let joined = false;
  try {
    const auth = opts.createAccount
      ? await call<AuthResult>("/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: opts.email,
            password: opts.password,
            display_name: opts.email.split("@")[0],
            family_name: opts.familyName || s.meta.family_name || "我的家",
          }),
        }, candidate)
      : await call<AuthResult>("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: opts.email, password: opts.password }),
        }, candidate);

    token = String(auth?.token || "");
    familyId = String(auth?.current_family_id || "");
    if (!token) throw new Error("服务器没有返回可用凭据");
    if (!familyId) throw new Error("这个账号还没有加入任何家庭");
    candidate.token = token;
    candidate.family = familyId;

    const binding = s.meta.sync_binding;
    if (binding && (binding.server_url !== url || binding.family_id !== familyId)) {
      throw new Error("本机已绑定其他服务器或家庭，不能直接改连。请先导出备份；迁移请在新资料库导入备份后再连接，避免两个家庭的数据混合");
    }
    if (!binding && (s.meta.sync_enabled || (s.meta.cursor || 0) > 0)) {
      throw new Error("本机有旧版同步数据但未记录目标；请先导出本地备份，确认来源后再迁移");
    }

    const remoteKey = await call<{ configured: boolean } & KeyBundle>("/sync/key", {}, candidate);
    if (remoteKey.configured) {
      // The verifier inside the bundle proves the passphrase before any local
      // configuration is replaced.
      nextDek = await unlockKeyBundle(remoteKey, opts.passphrase);
      bundle = bundleOnly(remoteKey);
      joined = true;
    } else {
      const created = await createKeyBundle(opts.passphrase);
      nextDek = created.dek;
      bundle = bundleOnly(created.bundle);
      await call("/sync/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      }, candidate);
    }
  } catch (err) {
    // Nothing has been written: the previous pairing, if any, is still valid.
    if (s.meta.sync_enabled) void resumeSync();
    throw err;
  }

  // Which catalog rows were already here. Captured before the pull on purpose:
  // incoming rows are stamped with this device's family id like everything
  // else, so afterwards there is no way to tell them apart by inspection.
  const seededIds = {
    categories: s.all("categories").filter((r) => r.family_id === s.meta.family_id).map((r) => r.id),
    locations: s.all("locations").filter((r) => r.family_id === s.meta.family_id).map((r) => r.id),
  };
  let mergedCatalog = 0;
  let committed = false;

  pairing = true;
  try {
    // Remember the address outside the database too: the connect screen and
    // the direct mode need it before any local store is open.
    serverStore.set(url);
    generation += 1;
    const ctx: Context = { base: url, token, family: familyId, epoch: generation };
    localStorage.setItem(URL_KEY, url);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EMAIL_KEY, opts.email.trim().toLowerCase());
    localStorage.setItem(FAMILY_KEY, familyId);
    dek = nextDek;
    keyLocked = false;
    s.patchMeta({
      sync_enabled: true,
      server_url: url,
      sync_binding: { server_url: url, family_id: familyId },
      e2ee: { ...bundle, unlocked: true, dek: toBase64(nextDek) },
      last_sync_error: "",
    });
    committed = true;
    // 凭据换了，旧的事件流还挂在"没有身份"或者上一个账号上，必须重连。
    setMode("sync");
    reconnectChanges();
    await s.flush();

    // Data already on the server comes down first when joining, so a device
    // that already has data can see the destination catalog before deciding
    // which of its own rows are duplicates of it. Nothing local is cleared:
    // linking must never be a destructive migration.
    if (joined) await pullOnce(s, ctx);
    if (joined) {
      // Two devices that each started from the seed list now hold two of every
      // category and location. Merge them before pushing, or the duplicates
      // get written to the server and come back to everyone.
      mergedCatalog = s.mergeDuplicateCatalog(seededIds);
      if (mergedCatalog) await s.flush();
    }
    await pushOnce(s, ctx);
    if (joined) await pullOnce(s, ctx);
    s.patchMeta({ last_sync_at: nowIso() });
    await s.flush();
  } finally {
    pairing = false;
    if (committed) {
      // Even if the first round trip failed (offline, server busy), the pairing
      // itself is valid; the retry loop owns the remaining error.
      startAutoSync();
      emit();
    }
  }
  return { joined, mergedCatalog };
}

export async function unlock(passphrase: string): Promise<void> {
  const s = await bootstrap();
  if (!s.meta.e2ee) throw new Error("这台设备还没有配置同步");
  const next = await unlockKeyBundle(s.meta.e2ee, passphrase);
  dek = next;
  keyLocked = false;
  s.patchMeta({ e2ee: { ...bundleOnly(s.meta.e2ee), unlocked: true, dek: toBase64(next) } });
  await s.flush();
  startAutoSync();
  scheduleSync(600);
  emit();
}

/**
 * Forget the passphrase, not the data.
 *
 * The wrapped key bundle stays so unlocking needs only the passphrase again;
 * the DEK itself is removed from storage, which is what makes "locked" mean
 * locked after a reload rather than merely hidden in memory.
 */
export async function lock(): Promise<void> {
  const s = await bootstrap();
  stopAutoSync();
  dek = null;
  keyLocked = true;
  if (s.meta.e2ee) s.patchMeta({ e2ee: bundleOnly(s.meta.e2ee) });
  await s.flush();
  emit();
}

/**
 * Stop replicating from this device.
 *
 * Local data is kept in full. The recorded binding and cursor are kept too:
 * reconnecting to the same server and household resumes cleanly, while
 * pointing the library at a different one stays blocked until the user has
 * exported a backup — the one case where "just link it" could merge two
 * unrelated households.
 */
export async function unlinkServer(): Promise<void> {
  const s = await bootstrap();
  stopAutoSync();
  dek = null;
  keyLocked = true;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(FAMILY_KEY);
  localStorage.removeItem(EMAIL_KEY);
  localStorage.removeItem(URL_KEY);
  s.patchMeta({
    sync_enabled: false,
    server_url: "",
    last_sync_error: "",
    e2ee: s.meta.e2ee ? bundleOnly(s.meta.e2ee) : null,
  });
  setMode("local");
  reconnectChanges();
  await s.flush();
  emit();
}

/**
 * Ask the paired server for the URL a printed sticker should contain.
 *
 * Local-first devices render their own QR codes, so without this they would
 * print a `homeledger://` deep link that only works on a phone with the app
 * installed — exactly the thing the sticker is supposed to avoid. Returns null
 * when this device has no verified server, which is a legitimate state.
 */
export async function qrLinkFor(itemId: string): Promise<{
  url: string;
  token: string;
  reachable: boolean;
  lan_only: boolean;
} | null> {
  try {
    const s = await bootstrap();
    if (!entryAllowed() || getMode() !== "sync" || !s.meta.sync_enabled) return null;
    return await call(`/items/${encodeURIComponent(itemId)}/qr-link`, {}, sessionContext());
  } catch {
    // Offline, locked, or the item exists only on this device and has not
    // synced yet.
    return null;
  }
}

/** Health of the sticker viewer, for the settings card. Null when unpaired. */
export async function qrServiceStatus(): Promise<Record<string, unknown> | null> {
  try {
    const s = await bootstrap();
    if (!entryAllowed() || getMode() !== "sync" || !s.meta.sync_enabled) return null;
    return await call("/system/qr", {}, sessionContext());
  } catch {
    return null;
  }
}

/** Downloads and decrypts one attachment on demand. */
export async function fetchBlob(blobId: string): Promise<Blob | null> {
  const s = await bootstrap();
  const cached = await s.getBlob(blobId);
  if (cached) return cached;
  let ctx: Context;
  let key: Uint8Array;
  try {
    if (!entryAllowed() || getMode() !== "sync") return null;
    ctx = context(s);
    key = requireDek(s);
  } catch {
    return null;
  }
  try {
    const framedBlob = await call<Blob>(`/sync/blob/${encodeURIComponent(blobId)}`, {}, ctx);
    const framed = new Uint8Array(await framedBlob.arrayBuffer());
    const plain = decryptBlob(key, framed);
    const attachment = s.all("attachments").find((a) => a.blob_id === blobId);
    const blob = new Blob([plain as unknown as BlobPart], {
      type: attachment?.mime_type || "application/octet-stream",
    });
    await s.putBlob(blobId, blob);
    return blob;
  } catch {
    return null;
  }
}

/** Boots the sync loop for an installation that is already linked. */
export async function resumeSync(): Promise<void> {
  const s = await bootstrap();
  if (!entryAllowed() || getMode() !== "sync" || !s.meta.sync_enabled || !s.meta.sync_binding) return;
  if (keyLocked) {
    emit();
    return;
  }
  if (!dek && s.meta.e2ee?.dek) dek = fromBase64(s.meta.e2ee.dek);
  if (!dek) {
    emit();
    return;
  }
  if (timer !== null) {
    // Already looping. Do not restart it: startAutoSync aborts in-flight
    // requests, which would turn every session refresh into a failed sync.
    scheduleSync(1200);
    return;
  }
  startAutoSync();
  scheduleSync(1200);
}

// --- lifecycle wiring -------------------------------------------------------
function onLocalWrite(): void {
  if (getMode() === "sync") scheduleSync();
}

function onModeChange(): void {
  if (getMode() !== "sync") {
    stopAutoSync();
  } else if (!pairing) {
    void resumeSync();
  }
}

function onServiceSessionChange(): void {
  if (getMode() !== "sync") return;
  if (!entryAllowed()) {
    stopAutoSync();
    return;
  }
  void resumeSync();
}

function onCredentialsChange(): void {
  // The base URL or token changed underneath us; in-flight requests belong to
  // the old identity and must not commit their results.
  if (getMode() === "sync") stopAutoSync();
}

if (typeof window !== "undefined") {
  window.addEventListener("hl:local-write", onLocalWrite);
  window.addEventListener("hl:mode-change", onModeChange);
  window.addEventListener("hl:service-session-change", onServiceSessionChange);
  window.addEventListener("hl:credentials-change", onCredentialsChange);
}
