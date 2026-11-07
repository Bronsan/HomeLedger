/**
 * 实时变更提示。
 *
 * 服务器只推"哪个实体变了"，不推行内容；收到之后各自重新请求当前视图。
 * 这样这条通道丢掉任何一条消息都不会导致数据不一致，最多是晚一点看到。
 *
 * 三个实现细节值得先读：
 *
 * 1. **不用 `EventSource`**。它不能设置请求头，token 只能拼进 URL，而 URL 会
 *    出现在 nginx 访问日志、浏览器历史、以及任何一条 Referer 里。所以这里用
 *    `fetch` + `ReadableStream` 自己读流，代价是下面三十行 SSE 帧解析。
 *
 * 2. **页面隐藏时断开**。手机切到后台还挂着一条长连接，既耗电又白占服务端一个
 *    连接位。回到前台再连，反正丢掉的只是"提示"，不是数据。
 *
 * 3. **本机模式完全不连**。没有服务器可连，也不需要连——本机写入本来就即时。
 */

import { familyStore, getMode, serverStore, tokenStore } from "../api/client";

export interface ChangeEvent {
  type: "change";
  action: string;
  entities: string[];
  at: string;
}

type Listener = (event: ChangeEvent) => void;

interface Endpoint {
  url: string;
  token: string;
  family: string;
}

/** 同步模式用的是引擎自己那套凭据，和远程模式的 `hl_token` 不是一回事。 */
const SYNC_TOKEN = "hl_sync_token";
const SYNC_FAMILY = "hl_sync_family";
const SYNC_URL = "hl_sync_url";

function endpoint(): Endpoint | null {
  const mode = getMode();
  if (mode === "local") return null;

  if (mode === "remote") {
    const base = serverStore.get();
    const token = tokenStore.get();
    if (!base || !token || token === "local") return null;
    return { url: `${base}/api/v1/events/stream`, token, family: familyStore.get() || "" };
  }

  const base = (localStorage.getItem(SYNC_URL) || "").replace(/\/+$/, "");
  const token = localStorage.getItem(SYNC_TOKEN) || "";
  if (!base || !token) return null;
  return {
    url: `${base}/api/v1/events/stream`,
    token,
    family: localStorage.getItem(SYNC_FAMILY) || "",
  };
}

const listeners = new Set<Listener>();
let controller: AbortController | null = null;
let running = false;
let retry = 0;
let retryTimer: number | null = null;
/** 401 之后不再重试：凭据不对，重试只是拿服务器当靶子。 */
let forbidden = false;

const MAX_BACKOFF = 30_000;

function notify(event: ChangeEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* 一个订阅者抛错不该拖垮其他订阅者 */
    }
  }
}

/** Parse one SSE frame (`event: x\ndata: {...}`) — comments are heartbeats. */
function handleFrame(frame: string): void {
  let name = "message";
  const data: string[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  if (name === "ready") {
    retry = 0;
    return;
  }
  if (name !== "change" || !data.length) return;
  try {
    const parsed = JSON.parse(data.join("\n")) as ChangeEvent;
    if (parsed && Array.isArray(parsed.entities)) notify(parsed);
  } catch {
    /* 半截帧：忽略。下一次变更会再来一条 */
  }
}

async function connect(signal: AbortSignal): Promise<void> {
  const ep = endpoint();
  if (!ep) return;

  const res = await fetch(ep.url, {
    headers: {
      Authorization: `Bearer ${ep.token}`,
      ...(ep.family ? { "X-Family-Id": ep.family } : {}),
      Accept: "text/event-stream",
    },
    cache: "no-store",
    signal,
  });

  if (res.status === 401) {
    forbidden = true;
    return;
  }
  if (!res.ok || !res.body) throw new Error(`事件流不可用（${res.status}）`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE 规范允许 CRLF、LF、CR 三种行尾。我们自己的服务器只发 LF，但反代
  // 有可能改写行尾；按 `\r?\n\r?\n` 切帧，两种都能吃下，而按 "\n\n" 硬切
  // 在 CRLF 下会一条帧都切不出来——那种 bug 只在别人机器上出现。
  const SEP = /\r?\n\r?\n/;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = SEP.exec(buffer);
    while (cut) {
      handleFrame(buffer.slice(0, cut.index));
      buffer = buffer.slice(cut.index + cut[0].length);
      cut = SEP.exec(buffer);
    }
    // 防御性：服务端只发短帧，缓冲长到这个程度说明对面不是我们的流
    if (buffer.length > 64_000) buffer = "";
  }
}

function scheduleRetry(): void {
  if (forbidden || !listeners.size || document.hidden) return;
  if (retryTimer !== null) return;
  const wait = Math.min(1000 * 2 ** retry, MAX_BACKOFF);
  retry = Math.min(retry + 1, 6);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void loop();
  }, wait);
}

async function loop(): Promise<void> {
  if (running || forbidden || !listeners.size || document.hidden) return;
  if (!endpoint()) return;

  running = true;
  const ctrl = new AbortController();
  controller = ctrl;
  try {
    await connect(ctrl.signal);
  } catch (err) {
    // 主动断开（页面隐藏 / 最后一个订阅者走了）不算失败，不重连
    if ((err as Error)?.name !== "AbortError") scheduleRetry();
    return;
  } finally {
    running = false;
    if (controller === ctrl) controller = null;
  }
  // 走到这里说明服务器正常关闭了流（重启、空闲超时）：按退避重连
  scheduleRetry();
}

function start(): void {
  if (running || retryTimer !== null || forbidden) return;
  if (typeof window === "undefined") return;
  if (!document.hidden) void loop();
}

function stop(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  controller = null;
}

/**
 * Subscribe to change hints. Returns an unsubscribe function.
 *
 * The first subscriber opens the stream and the last one closes it, so a page
 * that is not mounted costs nothing.
 */
export function subscribeChanges(fn: Listener): () => void {
  listeners.add(fn);
  start();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) stop();
  };
}

/**
 * Drop the current connection and reconnect.
 *
 * Called after login, after switching family, and when the sync engine links a
 * server: the credentials changed, so the old stream is authenticated as
 * somebody else (or as nobody).
 */
export function reconnectChanges(): void {
  forbidden = false;
  retry = 0;
  stop();
  if (listeners.size) start();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else {
      // 回到前台：立刻重连，不等退避
      retry = 0;
      if (listeners.size) start();
    }
  });
}
