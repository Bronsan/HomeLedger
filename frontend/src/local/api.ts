/**
 * Local request router.
 *
 * `api()` in `api/client.ts` sends everything here when the device is in
 * local-first mode. The path shapes are the same as the HTTP API so the
 * call sites did not have to change, but nothing leaves the process.
 */

import { ApiError } from "../api/errors";
import { LocalStore, store } from "./store";
import { seedLocalFamily } from "./seed";
import { handle } from "./handlers";

export interface LocalOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  raw?: boolean;
}

let ready: Promise<LocalStore> | null = null;

/** Opens the device database and creates a first-run family if needed. */
export function bootstrap(): Promise<LocalStore> {
  if (!ready) {
    ready = (async () => {
      const s = await store();
      if (!s.meta.seeded || !s.meta.family_id || !s.get("families", s.meta.family_id)) {
        seedLocalFamily(s, s.meta.family_name || "我的家");
        await s.flush();
      }
      return s;
    })();
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

export function rebootstrap(): void {
  ready = null;
}

export async function localApi<T = unknown>(path: string, opts: LocalOptions = {}): Promise<T> {
  const s = await bootstrap();
  const queryIndex = path.indexOf("?");
  const rawPath = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  const query = new URLSearchParams(queryIndex >= 0 ? path.slice(queryIndex + 1) : "");
  const method = (opts.method || (opts.body !== undefined || opts.form ? "POST" : "GET")).toUpperCase();

  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const result = await handle({
    store: s,
    method,
    path: rawPath,
    query,
    body: opts.body,
    form: opts.form || null,
  });

  if (opts.raw) return result as T;
  // Give the write-behind layer a chance to land before the caller navigates
  // away. Without this a user can create an item and hit reload inside the
  // 40 ms window and lose it.
  if (method !== "GET") {
    await s.flush();
    // Announce the write instead of importing the sync engine here: a direct
    // import would close a cycle (engine -> api -> engine) that ESM resolves
    // differently depending on the bundler.
    window.dispatchEvent(new CustomEvent("hl:local-write"));
  }
  return result as T;
}

export { ApiError };
