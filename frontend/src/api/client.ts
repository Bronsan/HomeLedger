import { ApiError } from "./errors";
import { localApi, bootstrap } from "../local/api";
import { cachedAsset } from "../local/blobs";

export { ApiError };

const BASE = "/api/v1";
const TOKEN_KEY = "hl_token";
const FAMILY_KEY = "hl_family";
const MODE_KEY = "hl_mode";
const SERVER_KEY = "hl_server";

/**
 * Where this installation keeps its data.
 *
 *   local   — the device is the database. No server involved, ever.
 *   sync    — the device is still the database; changes replicate to a server
 *             end-to-end encrypted.
 *   remote  — the server is the database. This is the original thin-client
 *             mode and it still exists for a browser on the gateway box or a
 *             device that cannot hold a copy.
 *
 * The default depends on where the app runs: a packaged app starts local-first,
 * a browser starts as a thin client so an existing gateway deployment keeps
 * behaving exactly as before.
 */
export type Mode = "local" | "sync" | "remote";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getMode(): Mode {
  const stored = localStorage.getItem(MODE_KEY) as Mode | null;
  if (stored === "local" || stored === "sync" || stored === "remote") return stored;
  return isTauri() ? "local" : "remote";
}

export function setMode(mode: Mode): void {
  localStorage.setItem(MODE_KEY, mode);
  if (mode !== "remote") {
    // The local engine authenticates by device, not by password. A synthetic
    // token keeps the route guards (`if (!token) redirect to /login`) working
    // unchanged, and it never leaves this device.
    if (!localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, "local");
  }
  window.dispatchEvent(new CustomEvent("hl:mode-change", { detail: mode }));
}

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export const familyStore = {
  get: () => localStorage.getItem(FAMILY_KEY),
  set: (id: string) => localStorage.setItem(FAMILY_KEY, id),
  clear: () => localStorage.removeItem(FAMILY_KEY),
};

/**
 * The address of the server this device talks to in `remote` mode.
 *
 * A browser served *by* the gateway can keep using relative URLs — the
 * origin is the server. A packaged app cannot: its origin is
 * `tauri://localhost`, so `/api/v1/auth/me` would ask the local asset
 * handler for a file called `api/v1/auth/me` and get HTML back. Every request
 * in that environment has to carry the host, which is why this is stored
 * explicitly instead of inferred.
 */
export const serverStore = {
  get: (): string => {
    const stored = (localStorage.getItem(SERVER_KEY) || "").trim().replace(/\/+$/, "");
    if (stored) return stored;
    if (!isTauri() && /^https?:$/.test(location.protocol)) return location.origin;
    return "";
  },
  set: (url: string): string => {
    const clean = normalizeServer(url);
    if (clean !== serverStore.get()) {
      tokenStore.clear();
      familyStore.clear();
      window.dispatchEvent(new Event("hl:credentials-change"));
    }
    if (clean) localStorage.setItem(SERVER_KEY, clean);
    else localStorage.removeItem(SERVER_KEY);
    return clean;
  },
  clear: () => { serverStore.set(""); },
};

/** `192.168.1.5:8000` → `http://192.168.1.5:8000`; keeps https and paths. */
export function normalizeServer(raw: string): string {
  let v = (raw || "").trim().replace(/\/+$/, "");
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) {
    // Bare host or IP. Home gateways are almost always plain HTTP; assume it
    // rather than making the user type a scheme they do not care about.
    v = `http://${v}`;
  }
  try {
    const u = new URL(v);
    if (!u.hostname || !/^https?:$/.test(u.protocol) || u.username || u.password) return "";
    return u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
  } catch {
    return "";
  }
}

type Options = {
  method?: string;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  raw?: boolean;
  timeoutMs?: number;
};

function extractMessage(detail: unknown, fallback: string): string {
  if (!detail) return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const first = detail[0];
    if (first && typeof first === "object" && "msg" in first) {
      const loc = (first as { loc?: unknown[] }).loc;
      const field = Array.isArray(loc) ? loc[loc.length - 1] : "";
      return `${field ? field + "：" : ""}${(first as { msg: string }).msg}`;
    }
    return fallback;
  }
  if (typeof detail === "object" && detail !== null) {
    const d = detail as Record<string, unknown>;
    if (typeof d.message === "string") return d.message;
    if (typeof d.detail === "string") return d.detail;
  }
  return fallback;
}

/**
 * 本机/同步模式下，命中这里的方法+路径**不进 localApi**，而是直达服务器。
 *
 * 判据：这条数据本来就只存在于服务器上（或只有服务器有权修改），
 * 本地既没有对应的表，也没有对应的 handler——走 localApi 只会得到
 * 「本机模式暂不支持该操作」。加新条目前先确认 local/handlers.ts 里
 * 真的没有、也不该有这条路径；本机有数据的路径不要放进来。
 */
const DIRECT_REMOTE: Array<{ method: string; pattern: RegExp; why: string }> = [
  {
    // 二维码 token 与它的作废只发生在服务器（qr_links 表在服务端，
    // 同步库里没有这张表）。作废之后已贴出去的标签才会真的失效。
    method: "DELETE",
    pattern: /^\/items\/[^/]+\/qr-link$/,
    why: "qr_links 只存在于服务器",
  },
  {
    // 成员记录是服务器的租户数据，同步模式里那份只是复制品；
    // 改角色 / 移除成员必须由服务器裁决（owner 不可降级等）。
    method: "PATCH",
    pattern: /^\/families\/current\/members\/[^/]+$/,
    why: "成员裁决在服务器",
  },
  {
    method: "DELETE",
    pattern: /^\/families\/current\/members\/[^/]+$/,
    why: "成员裁决在服务器",
  },
];

function matchesDirectRemote(method: string, rawPath: string): boolean {
  return DIRECT_REMOTE.some((r) => r.method === method && r.pattern.test(rawPath));
}

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const method = (opts.method || (opts.body !== undefined || opts.form ? "POST" : "GET")).toUpperCase();
  const queryIndex = path.indexOf("?");
  const rawPath = queryIndex >= 0 ? path.slice(0, queryIndex) : path;

  if (getMode() !== "remote") {
    // 白名单路径且这台设备配有服务器：走下面的远程分支，让服务器裁决。
    if (!(getMode() === "sync" && matchesDirectRemote(method, rawPath) && localStorage.getItem("hl_sync_url"))) {
      if (!tokenStore.get()) tokenStore.set("local");
      return localApi<T>(path, opts);
    }
  }

  const paired = getMode() === "sync";
  const base = paired ? localStorage.getItem("hl_sync_url") || "" : serverStore.get();
  if (!base) {
    // Not an exotic case: it is the state right after switching to server mode
    // on a fresh install. Saying so beats a blank screen or "Failed to fetch".
    throw new ApiError(0, "还没有填写服务器地址", { reason: "no-server" });
  }

  const headers: Record<string, string> = {};
  const token = paired ? localStorage.getItem("hl_sync_token") : tokenStore.get();
  if (token && token !== "local") headers.Authorization = `Bearer ${token}`;
  const family = paired ? localStorage.getItem("hl_sync_family") : familyStore.get();
  if (family) headers["X-Family-Id"] = family;

  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  // Every request gets a deadline. Without one a server that accepts the TCP
  // connection but never answers (a laptop resuming from sleep, a proxy that
  // swallowed the request) leaves the UI on a spinner forever — which is
  // exactly the "卡住" that made server mode look broken.
  //
  // Wired by hand rather than with AbortSignal.any/timeout: those are recent
  // additions, and the WebView that ships with an older Android or with
  // WebKitGTK on a distro does not always have them.
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? 15000);
  const relay = () => ctrl.abort();
  opts.signal?.addEventListener("abort", relay, { once: true });

  let res: Response;
  try {
    res = await fetch(`${base}${BASE}${path}`, {
      method: opts.method || (body ? "POST" : "GET"),
      headers,
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (timedOut) {
      throw new ApiError(0, `${base} 没有响应（超时）`, { reason: "timeout" });
    }
    throw new ApiError(0, `连不上 ${base}，检查服务器是否开着、是否在同一个网络`, {
      reason: "unreachable",
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", relay);
  }

  if (res.status === 401) {
    tokenStore.clear();
    if (!location.pathname.startsWith("/login") && !location.pathname.startsWith("/connect")) {
      location.href = "/login";
    }
    throw new ApiError(401, "登录已过期");
  }

  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {
      /* ignore */
    }
    const payload = (detail as { detail?: unknown })?.detail ?? detail;
    throw new ApiError(res.status, extractMessage(payload, `请求失败（${res.status}）`), payload);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

/**
 * Absolute URL for something the **browser** loads, not `fetch`.
 *
 * `<iframe>`, `<a download>` and `<img>` cannot set an `Authorization` header,
 * so the token has to ride in the query string. The backend accepts that for
 * exactly this reason (`deps._bearer`), and the header still wins when both
 * are present.
 */
export function authedUrl(path: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params);
  const mode = getMode();
  const base = mode === "remote" ? serverStore.get() : "";
  const token = mode === "remote" ? tokenStore.get() : "";
  if (mode === "remote" && token && token !== "local") search.set("token", token);
  if (mode === "remote" && familyStore.get()) search.set("family_id", familyStore.get()!);
  const query = search.toString();
  return `${base}${BASE}${path}${query ? `?${query}` : ""}`;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || v === false) return;
    sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Turns a stored asset reference into something an <img> can use.
 *
 * Local attachments become object URLs on demand; until the blob has been read
 * this returns the cached thumbnail or an empty string. Callers that need the
 * full image (the preview modal, opening a PDF) should use `resolveAsset()`.
 */
export function assetUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("http") || url.startsWith("data:")) return url;
  if (url.startsWith("local:")) return cachedAsset(url);
  if (getMode() !== "remote") return url;
  const token = tokenStore.get();
  const sep = url.includes("?") ? "&" : "?";
  // Same reason as `api()`: `tauri://localhost/api/v1/...` is not a file.
  const base = url.startsWith("/") ? serverStore.get() : "";
  const full = `${base}${url}`;
  const search = new URLSearchParams();
  if (token && token !== "local") search.set("token", token);
  if (familyStore.get()) search.set("family_id", familyStore.get()!);
  return search.size ? `${full}${sep}${search}` : full;
}

/**
 * Did this failure come from the network rather than from the server saying no?
 *
 * Status 0 is what `api()` throws when the request never got an HTTP answer —
 * no address, refused connection, timeout. The UI treats those as "backend
 * unreachable" and offers a retry instead of an empty list, which is the
 * difference between "server is off" and "you have no items".
 */
export function isConnectionError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0;
}

/** Warms the local engine so the first screen does not wait on IndexedDB. */
export function warmUp(): void {
  if (getMode() !== "remote") void bootstrap();
}

/** Probe a server before committing to it. Used by the connect screen. */
export async function probeServer(
  url: string,
  timeoutMs = 6000
): Promise<{ ok: boolean; version?: string; mode?: string; error?: string }> {
  const base = normalizeServer(url);
  if (!base) return { ok: false, error: "地址格式不对" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${BASE}/system/health`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `服务器返回 ${res.status}` };
    const data = (await res.json()) as { ok?: boolean; version?: string; mode?: string };
    if (!data?.ok) return { ok: false, error: "服务在，但数据库没起来" };
    return { ok: true, version: data.version, mode: data.mode };
  } catch {
    return { ok: false, error: "连不上，检查地址和网络" };
  } finally {
    clearTimeout(timer);
  }
}
