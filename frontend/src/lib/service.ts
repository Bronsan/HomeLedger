/**
 * 联网账号（服务服务器）会话。
 *
 * 它和 api/client.ts 里的 local / sync / remote 是两件事：
 *
 *   - 三种数据模式决定“物品数据放在哪”；
 *   - 这里决定“这台设备用谁的账号启动”，账号只用于用户管理与登录验证。
 *
 * 物品数据仍然留在本机。服务服务器地址可构建期注入，默认 nas.ltyfans.cn；
 * 端口确定后改 `VITE_SERVICE_BASE_URL` 重新构建即可，或在调试时写
 * localStorage 的 `hl_service_base` 覆盖。
 */

import { ApiError } from "../api/errors";

const ENTRY_KEY = "hl_entry";
const SERVICE_TOKEN_KEY = "hl_service_token";
const SERVICE_USER_KEY = "hl_service_user";
const SERVICE_BASE_KEY = "hl_service_base";
const SERVICE_TOKEN_BASE_KEY = "hl_service_token_base";
const DEFAULT_SERVICE_BASE = "https://nas.ltyfans.cn";
const BASE_PATH = "/api/v1";

export type EntryMode = "local" | "online";

export interface ServiceUser {
  id: string;
  email: string;
  display_name: string;
  avatar_color?: string;
  created_at?: string;
}

/**
 * 本次进程是否已经向服务服务器验证过。
 *
 * 用模块级变量而不是 sessionStorage：某些 WebView 会把 sessionStorage 跨
 * 进程恢复，那样“每次启动验证”就名存实亡。模块变量随页面加载重置，冷启动
 * 必然重新验证。
 */
let verifiedThisBoot = false;

/** 用户第一次启动时选了哪种使用方式。null = 还没选，必须先经过欢迎页。 */
export const entryStore = {
  get(): EntryMode | null {
    const value = localStorage.getItem(ENTRY_KEY);
    return value === "local" || value === "online" ? value : null;
  },
  set(mode: EntryMode): void {
    localStorage.setItem(ENTRY_KEY, mode);
    // 本机模式不做联网校验，清掉本次验证标记，避免切回来时误判。
    if (mode === "local") verifiedThisBoot = false;
    sessionChanged();
  },
  clear(): void {
    localStorage.removeItem(ENTRY_KEY);
    verifiedThisBoot = false;
    sessionChanged();
  },
};

function sessionChanged(): void {
  window.dispatchEvent(new Event("hl:service-session-change"));
}

export const serviceSession = {
  token(): string | null {
    const token = localStorage.getItem(SERVICE_TOKEN_KEY);
    // Old unbound credentials require a fresh login, never silent rebinding.
    if (token && localStorage.getItem(SERVICE_TOKEN_BASE_KEY) !== serviceBase()) return null;
    return token;
  },
  user(): ServiceUser | null {
    const raw = localStorage.getItem(SERVICE_USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ServiceUser;
    } catch {
      return null;
    }
  },
  /** 本次进程是否已经向服务服务器验证过。冷启动必须重新验证。 */
  verified(): boolean {
    return verifiedThisBoot && Boolean(serviceSession.token());
  },
  markVerified(): void {
    verifiedThisBoot = Boolean(serviceSession.token());
    sessionChanged();
  },
  set(token: string, user: ServiceUser): void {
    localStorage.setItem(SERVICE_TOKEN_KEY, token);
    localStorage.setItem(SERVICE_TOKEN_BASE_KEY, serviceBase());
    localStorage.setItem(SERVICE_USER_KEY, JSON.stringify(user));
    verifiedThisBoot = false;
    sessionChanged();
  },
  clear(): void {
    localStorage.removeItem(SERVICE_TOKEN_KEY);
    localStorage.removeItem(SERVICE_USER_KEY);
    localStorage.removeItem(SERVICE_TOKEN_BASE_KEY);
    verifiedThisBoot = false;
    sessionChanged();
  },
};

export function serviceBase(): string {
  const override = (localStorage.getItem(SERVICE_BASE_KEY) || "").trim();
  const configured = String(import.meta.env.VITE_SERVICE_BASE_URL || "").trim();
  const url = new URL(override || configured || DEFAULT_SERVICE_BASE);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new ApiError(0, "账号服务器必须使用 HTTPS（本机调试除外）");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * 当前阶段服务端只开放 QQ 邮箱。检查放在这里而不是输入框的 placeholder，
 * 是为了不在界面上提示用户“只能填 QQ 邮箱”。
 */
export function isAllowedServiceEmail(email: string): boolean {
  return /^[^@\s]+@qq\.com$/i.test(email.trim());
}

type ServiceOptions = {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
};

/**
 * 只访问服务服务器。绝不把物品数据、同步口令或家庭 ID 带过去。
 */
export async function serviceApi<T = unknown>(
  path: string,
  opts: ServiceOptions = {}
): Promise<T> {
  if (!/^\/auth\/(?:register|login|me|change-password)$/.test(path)) {
    throw new ApiError(400, "账号服务不提供此操作");
  }
  const base = serviceBase();
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = /\/(?:login|register)$/.test(path) ? null : serviceSession.token();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);

  let res: Response;
  try {
    res = await fetch(`${base}${BASE_PATH}${path}`, {
      method: opts.method || (body ? "POST" : "GET"),
      headers,
      body,
      signal: ctrl.signal,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ApiError(0, `连不上账号服务器 ${base}，检查网络后重试`, {
      reason: "unreachable",
    });
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* 204 / 非 JSON 响应 */
  }

  if (base !== serviceBase() || (token && token !== serviceSession.token())) {
    throw new ApiError(409, "账号服务器或会话已变更，请重试");
  }
  if (res.status === 401) {
    if (token) serviceSession.clear();
    throw new ApiError(401, "账号登录已过期，请重新登录");
  }

  if (!res.ok) {
    const detail = (payload as { detail?: unknown } | null)?.detail ?? payload;
    let message = `请求失败（${res.status}）`;
    if (typeof detail === "string" && detail) {
      message = detail;
    } else if (Array.isArray(detail) && detail[0] && typeof detail[0] === "object") {
      const first = detail[0] as { msg?: string; loc?: unknown[] };
      const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : "";
      message = `${field ? `${String(field)}：` : ""}${first.msg || message}`;
    }
    throw new ApiError(res.status, message, payload);
  }

  return payload as T;
}
