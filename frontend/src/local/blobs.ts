/**
 * Asset resolution.
 *
 * In local mode an attachment lives in IndexedDB, not behind a URL. Images in
 * lists use the thumbnail embedded in the row (a data URL) so they paint in
 * the same frame as the text. Full-size views need an object URL, which is
 * inherently async — `resolveAsset` is the one place that knows how to make
 * one, and it caches so reopening a photo does not re-read the blob.
 *
 * Object URLs are never revoked. A household library is thousands of images at
 * most and the cache is bounded by what the user actually opened; revoking on
 * unmount would break an <img> that is still on screen during a transition.
 */

import { store } from "./store";

const cache = new Map<string, string>();

export function isLocalAsset(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("local:");
}

/** Synchronous lookup. Returns "" when the blob has not been materialised. */
export function cachedAsset(url: string | null | undefined): string {
  if (!url) return "";
  if (!isLocalAsset(url)) return url;
  return cache.get(url.slice(6)) || "";
}

export async function resolveAsset(url: string | null | undefined): Promise<string> {
  if (!url) return "";
  if (!isLocalAsset(url)) return url;
  const id = url.slice(6);
  const hit = cache.get(id);
  if (hit) return hit;
  const s = await store();
  const blob = await s.getBlob(id);
  if (!blob) return "";
  const objectUrl = URL.createObjectURL(blob);
  cache.set(id, objectUrl);
  return objectUrl;
}

export function forgetAsset(id: string): void {
  const url = cache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    cache.delete(id);
  }
}
