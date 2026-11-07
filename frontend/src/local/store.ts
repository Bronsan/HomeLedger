/**
 * The device database.
 *
 * Every HomeLedger client — desktop, phone, browser tab — owns a full copy of
 * the family data and works against it. There is no request/response cycle
 * between the UI and "the data"; there is a store in this tab and a background
 * replication loop.
 *
 * Storage is IndexedDB rather than SQLite on purpose. The same code has to run
 * inside a Tauri WebView on Android, iOS, Windows and Linux and inside a plain
 * browser tab, and IndexedDB is the only database all of them actually have.
 * The data volumes involved (a household: thousands of rows) fit comfortably
 * in memory, so queries are plain array scans over the resident maps and the
 * disk layer only has to be durable, not clever.
 *
 * Layout:
 *   records  { k: "items/<id>", v: row }
 *   meta     { k: "state", v: LocalMeta }
 *   blobs    { k: "<blob id>", v: Blob }
 *   outbox   { k: "items/<id>", hlc }      // rows awaiting push
 */

export type Row = Record<string, any>;

export const TABLES = [
  "families",
  "users",
  "memberships",
  "locations",
  "categories",
  "items",
  "components",
  "batches",
  "attachments",
  "maintenance",
  "events",
  "loans",
  "audits",
  "notifications",
  "backups",
] as const;

export type Table = (typeof TABLES)[number];

export interface StoredKey {
  kdf: "argon2id";
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
  wrapped_dek: string;
  verifier: string;
  /** Set once the user has entered the passphrase on this device. */
  unlocked?: boolean;
  /**
   * The unwrapped data key, base64. Kept so the device does not ask for the
   * passphrase every time the tab reloads.
   *
   * This is not a downgrade in practice: local mode already stores the same
   * records as plaintext on the same disk, so an attacker who can read this
   * can read the library anyway. It *would* matter on a shared machine, which
   * is why the setting can be turned off (and cleared) per device.
   */
  dek?: string;
}

export interface LocalMeta {
  schema: number;
  family_id: string;
  family_name: string;
  invite_code: string;
  user_id: string;
  user_name: string;
  device_id: string;
  device_name: string;
  device_kind: string;
  /** Replication cursor: the highest remote sequence this device has applied. */
  cursor: number;
  last_sync_at: string | null;
  last_sync_error: string;
  /** balanced = list fields are plaintext on the server; strict = everything. */
  privacy: "balanced" | "strict";
  server_url: string;
  sync_enabled: boolean;
  /** One local library may only replicate to this server and household. */
  sync_binding?: { server_url: string; family_id: string };
  e2ee: StoredKey | null;
  created_at: string;
  seeded: boolean;
}

export interface StoredBlob {
  id: string;
  blob: Blob;
}

const DB_NAME = "homeledger";
const DB_VERSION = 1;
const S_RECORDS = "records";
const S_META = "meta";
const S_BLOBS = "blobs";
const S_OUTBOX = "outbox";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境不支持 IndexedDB，无法使用本地数据"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S_RECORDS)) db.createObjectStore(S_RECORDS, { keyPath: "k" });
      if (!db.objectStoreNames.contains(S_META)) db.createObjectStore(S_META, { keyPath: "k" });
      if (!db.objectStoreNames.contains(S_BLOBS)) db.createObjectStore(S_BLOBS, { keyPath: "k" });
      if (!db.objectStoreNames.contains(S_OUTBOX)) db.createObjectStore(S_OUTBOX, { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("打开本地数据库失败"));
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("本地事务被中止"));
  });
}

function randomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function uuid(): string {
  return randomId();
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Hybrid logical clock.
 *
 * Wall clocks disagree, especially on phones that have been asleep. An HLC
 * keeps a physical component so timestamps stay sortable and human readable,
 * plus a logical counter that preserves causality when two writes land in the
 * same millisecond or when a device receives a timestamp from the future.
 *
 * Encoded so plain string comparison orders correctly:
 *   <10 chars base36 physical>-<3 chars base36 counter>-<device suffix>
 */
export class HybridClock {
  private physical = 0;
  private counter = 0;
  constructor(private suffix: string) {}

  next(): string {
    const wall = Date.now();
    if (wall > this.physical) {
      this.physical = wall;
      this.counter = 0;
    } else {
      this.counter += 1;
      if (this.counter > 0xfff) {
        this.physical += 1;
        this.counter = 0;
      }
    }
    return this.encode();
  }

  observe(remote: string): void {
    const [p, c] = remote.split("-");
    const t = parseInt(p, 36);
    const n = parseInt(c, 36);
    if (!Number.isFinite(t) || !Number.isFinite(n)) return;
    if (t > this.physical) {
      this.physical = t;
      this.counter = n;
    } else if (t === this.physical && n > this.counter) {
      this.counter = n;
    }
  }

  private encode(): string {
    return `${this.physical.toString(36).padStart(10, "0")}-${this.counter
      .toString(36)
      .padStart(3, "0")}-${this.suffix}`;
  }
}

const DEFAULT_META = (): LocalMeta => {
  const deviceId = randomId();
  return {
    schema: 1,
    family_id: "",
    family_name: "",
    invite_code: "",
    user_id: "",
    user_name: "",
    device_id: deviceId,
    device_name: defaultDeviceName(),
    device_kind: defaultDeviceKind(),
    cursor: 0,
    last_sync_at: null,
    last_sync_error: "",
    privacy: "balanced",
    server_url: "",
    sync_enabled: false,
    e2ee: null,
    created_at: nowIso(),
    seeded: false,
  };
};

function defaultDeviceKind(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Android|iPhone|iPad|Mobile/i.test(ua)) return "mobile";
  if (typeof (window as any).__TAURI_INTERNALS__ !== "undefined") return "desktop";
  return "web";
}

function defaultDeviceName(): string {
  const kind = defaultDeviceKind();
  if (kind === "mobile") return "手机";
  if (kind === "desktop") return "电脑";
  return "浏览器";
}

export class LocalStore {
  tables!: Record<Table, Map<string, Row>>;
  meta!: LocalMeta;
  clock!: HybridClock;
  /** "table/id" -> hlc of the local write that has not been pushed yet. */
  dirty = new Map<string, string>();

  private db!: IDBDatabase;
  private pendingRecords = new Map<string, Row | null>();
  private pendingOutbox = new Map<string, string | null>();
  private pendingMeta = false;
  private flushTimer: number | null = null;
  private listeners = new Set<() => void>();

  async open(): Promise<void> {
    this.db = await openDb();
    const tables = {} as Record<Table, Map<string, Row>>;
    for (const t of TABLES) tables[t] = new Map();
    this.tables = tables;

    const records = await reqAsPromise(
      this.db.transaction(S_RECORDS, "readonly").objectStore(S_RECORDS).getAll()
    );
    for (const entry of records as { k: string; v: Row }[]) {
      const [table, id] = splitKey(entry.k);
      if (table && tables[table]) tables[table].set(id, entry.v);
    }

    const metaEntry = await reqAsPromise(
      this.db.transaction(S_META, "readonly").objectStore(S_META).get("state")
    );
    this.meta = { ...DEFAULT_META(), ...((metaEntry as any)?.v || {}) };

    const outbox = await reqAsPromise(
      this.db.transaction(S_OUTBOX, "readonly").objectStore(S_OUTBOX).getAll()
    );
    for (const entry of outbox as { k: string; hlc: string }[]) this.dirty.set(entry.k, entry.hlc);

    this.clock = new HybridClock(this.meta.device_id.slice(0, 8));
    // Rows written on another device may carry a clock ahead of ours. Starting
    // from the highest one we have seen keeps new local edits sorted after it.
    for (const t of TABLES) {
      for (const row of tables[t].values()) {
        if (typeof row._hlc === "string") this.clock.observe(row._hlc);
      }
    }
  }

  // -- reads -------------------------------------------------------------
  all(table: Table): Row[] {
    const out: Row[] = [];
    for (const row of this.tables[table].values()) {
      if (!row._deleted) out.push(row);
    }
    return out;
  }

  raw(table: Table): Row[] {
    return Array.from(this.tables[table].values());
  }

  get(table: Table, id: string): Row | null {
    const row = this.tables[table].get(id);
    if (!row || row._deleted) return null;
    return row;
  }

  getRaw(table: Table, id: string): Row | null {
    return this.tables[table].get(id) || null;
  }

  private touch(): void {
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // -- local writes ------------------------------------------------------
  write(table: Table, row: Row, markDirty = true): Row {
    const next: Row = { ...row, _hlc: this.clock.next() };
    this.tables[table].set(next.id, next);
    this.queueRecord(table, next.id);
    if (markDirty) this.markDirty(table, next.id, next._hlc);
    this.touch();
    return next;
  }

  remove(table: Table, id: string): void {
    const row = this.tables[table].get(id);
    if (!row) return;
    const next: Row = {
      ...row,
      _deleted: true,
      _hlc: this.clock.next(),
      updated_at: nowIso(),
    };
    this.tables[table].set(id, next);
    this.queueRecord(table, id);
    this.markDirty(table, id, next._hlc);
    this.touch();
  }

  /** 真正从表里移除（连墓碑都不留）。只该用在本机模式——没有服务器要
   * 同步，墓碑是纯粹的残留，永远挂在「已删除」视图里。 */
  purge(table: Table, id: string): void {
    if (!this.tables[table].has(id)) return;
    this.tables[table].delete(id);
    this.queueRecord(table, id);
    this.touch();
  }

  // -- replication writes ------------------------------------------------
  applyRemote(table: Table, row: Row, dirty = false): void {
    if (typeof row._hlc === "string") this.clock.observe(row._hlc);
    this.tables[table].set(row.id, row);
    this.queueRecord(table, row.id);
    if (dirty) this.markDirty(table, row.id, row._hlc);
    this.touch();
  }

  private markDirty(table: Table, id: string, hlc: string): void {
    const key = `${table}/${id}`;
    this.dirty.set(key, hlc);
    if (!this.pendingOutbox.has(key)) this.pendingOutbox.set(key, hlc);
    this.schedule();
  }

  clearDirty(entries: { table: Table; id: string; hlc: string }[]): void {
    for (const e of entries) {
      const key = `${e.table}/${e.id}`;
      if (this.dirty.get(key) === e.hlc) {
        this.dirty.delete(key);
        this.pendingOutbox.set(key, null);
      }
    }
    this.schedule();
  }

  // -- meta --------------------------------------------------------------
  patchMeta(patch: Partial<LocalMeta>): void {
    this.meta = { ...this.meta, ...patch };
    this.pendingMeta = true;
    this.schedule();
  }

  // -- blobs -------------------------------------------------------------
  async putBlob(id: string, blob: Blob): Promise<void> {
    const tx = this.db.transaction(S_BLOBS, "readwrite");
    tx.objectStore(S_BLOBS).put({ k: id, v: blob });
    await txDone(tx);
  }

  async getBlob(id: string): Promise<Blob | null> {
    const row = await reqAsPromise(
      this.db.transaction(S_BLOBS, "readonly").objectStore(S_BLOBS).get(id)
    );
    return ((row as any)?.v as Blob) || null;
  }

  async deleteBlob(id: string): Promise<void> {
    const tx = this.db.transaction(S_BLOBS, "readwrite");
    tx.objectStore(S_BLOBS).delete(id);
    await txDone(tx);
  }

  async allBlobIds(): Promise<string[]> {
    const keys = await reqAsPromise(
      this.db.transaction(S_BLOBS, "readonly").objectStore(S_BLOBS).getAllKeys()
    );
    return (keys as string[]) || [];
  }

  // -- persistence -------------------------------------------------------
  private queueRecord(table: Table, id: string): void {
    this.pendingRecords.set(`${table}/${id}`, this.tables[table].get(id) || null);
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer !== null) return;
    // Coalesce bursts (bulk import, attachment fan-out) into one transaction.
    // 40ms is below the threshold where a user can close the tab mid-edit
    // without noticing, and well above the rate of a typing-speed mutation.
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 40);
  }

  async flush(): Promise<void> {
    if (!this.pendingRecords.size && !this.pendingOutbox.size && !this.pendingMeta) return;
    const records = new Map(this.pendingRecords);
    const outbox = new Map(this.pendingOutbox);
    const meta = this.pendingMeta;
    this.pendingRecords.clear();
    this.pendingOutbox.clear();
    this.pendingMeta = false;

    const tx = this.db.transaction([S_RECORDS, S_OUTBOX, S_META], "readwrite");
    const rec = tx.objectStore(S_RECORDS);
    for (const [k, v] of records) {
      if (v) rec.put({ k, v });
      else rec.delete(k);
    }
    const ob = tx.objectStore(S_OUTBOX);
    for (const [k, hlc] of outbox) {
      if (hlc) ob.put({ k, hlc });
      else ob.delete(k);
    }
    if (meta) tx.objectStore(S_META).put({ k: "state", v: this.meta });
    await txDone(tx);
  }

  /**
   * Collapse catalog rows this device seeded with rows that arrived from the
   * server under the same name.
   *
   * Both devices start from the same taxonomy, so after the first pull the
   * store holds two of everything — two 「厨房」, two 「厨房电器」 — and every
   * picker in the UI offers both. The row that came from the server wins: it is
   * the one the rest of the household already files things under. The seeded
   * row is dropped and anything pointing at it is re-pointed.
   *
   * `seededIds` has to be captured *before* the pull. Afterwards nothing
   * distinguishes a row that was here first from one that just arrived, because
   * incoming rows are stamped with this device's family id like any other.
   *
   * The dropped row is deleted outright, not tombstoned: it was never pushed,
   * so a tombstone would only replicate a delete for a record the server has
   * never heard of.
   */
  mergeDuplicateCatalog(seededIds: { categories: string[]; locations: string[] }): number {
    let removed = 0;
    for (const table of ["locations", "categories"] as const) {
      const seeded = new Set(seededIds[table]);
      const key = (r: Row) => `${String(r.name || "").trim()}|${r.parent_id || ""}`;

      const incoming = new Map<string, Row>();
      for (const row of this.tables[table].values()) {
        if (row._deleted || seeded.has(row.id)) continue;
        if (!incoming.has(key(row))) incoming.set(key(row), row);
      }

      for (const row of [...this.tables[table].values()]) {
        if (row._deleted || !seeded.has(row.id)) continue;
        const twin = incoming.get(key(row));
        if (!twin || twin.id === row.id) continue;
        this.remapRefs(table, row.id, twin.id);
        this.tables[table].delete(row.id);
        this.queueRecord(table, row.id);
        removed += 1;
      }
    }
    if (removed) this.touch();
    return removed;
  }

  /** Point every reference to `from` at `to`. Used when a catalog row loses. */
  private remapRefs(table: Table, from: string, to: string): void {
    const field = table === "categories" ? "category_id" : "location_id";
    for (const item of [...this.tables.items.values()]) {
      if (item._deleted || item[field] !== from) continue;
      this.write("items", { ...item, [field]: to });
    }
    // 批次可以有自己的存放位置。漏掉这一处，合并分类/位置后这些批次会指向
    // 一个已经被丢弃的行，界面上表现为"位置空白"且再也选不回来。
    if (table === "locations") {
      for (const batch of [...this.tables.batches.values()]) {
        if (batch._deleted || batch.location_id !== from) continue;
        this.write("batches", { ...batch, location_id: to });
      }
    }
    for (const loc of [...this.tables.locations.values()]) {
      if (loc._deleted || loc.parent_id !== from) continue;
      this.write("locations", { ...loc, parent_id: to });
    }
    for (const cat of [...this.tables.categories.values()]) {
      if (cat._deleted || cat.parent_id !== from) continue;
      this.write("categories", { ...cat, parent_id: to });
    }
  }

  /**
   * Drops everything the user created but keeps this device's identity
   * (family, user, membership). Used when joining an existing family: the
   * local taxonomy was only a seed and would otherwise be uploaded as a
   * duplicate of the family's real one.
   */
  async clearContent(): Promise<void> {
    const CONTENT: Table[] = [
      "locations", "categories", "items", "components", "batches", "attachments",
      "maintenance", "events", "loans", "audits", "notifications", "backups",
    ];
    const tx = this.db.transaction([S_RECORDS, S_OUTBOX, S_BLOBS], "readwrite");
    const rec = tx.objectStore(S_RECORDS);
    const ob = tx.objectStore(S_OUTBOX);
    for (const table of CONTENT) {
      for (const id of this.tables[table].keys()) {
        rec.delete(`${table}/${id}`);
        ob.delete(`${table}/${id}`);
        this.dirty.delete(`${table}/${id}`);
      }
      this.tables[table].clear();
    }
    tx.objectStore(S_BLOBS).clear();
    await txDone(tx);
    this.touch();
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction([S_RECORDS, S_OUTBOX, S_META, S_BLOBS], "readwrite");
    tx.objectStore(S_RECORDS).clear();
    tx.objectStore(S_OUTBOX).clear();
    tx.objectStore(S_META).clear();
    tx.objectStore(S_BLOBS).clear();
    await txDone(tx);
    for (const t of TABLES) this.tables[t].clear();
    this.dirty.clear();
    this.meta = DEFAULT_META();
  }
}

export function splitKey(key: string): [Table | "", string] {
  const idx = key.indexOf("/");
  if (idx < 0) return ["", key];
  return [key.slice(0, idx) as Table, key.slice(idx + 1)];
}

let singleton: Promise<LocalStore> | null = null;

export function store(): Promise<LocalStore> {
  if (!singleton) {
    const s = new LocalStore();
    singleton = s.open().then(() => s);
    singleton.catch(() => {
      singleton = null;
    });
  }
  return singleton;
}

export async function resetStore(): Promise<void> {
  const s = await store();
  await s.clearAll();
}
