import type { Item } from "./types";

declare const galleryStillLease: unique symbol;
/** An identity handle only: it contains no account identifier or credentials. */
export type GalleryStillCacheLease = Readonly<{
  [galleryStillLease]: true;
}>;

export const galleryStillCacheMaxEntries = 8;
export const galleryStillCacheMaxBytes = 4 * 1024 * 1024;
export const galleryStillCacheMaxAgeMs = 10 * 60 * 1000;

export type GalleryStillCache = {
  /** Only the auth provider activates a scope; reads and writes cannot do so. */
  activate(scope: string | null): GalleryStillCacheLease;
  isActive(lease: GalleryStillCacheLease): boolean;
  get(lease: GalleryStillCacheLease, key: string): string | null;
  put(lease: GalleryStillCacheLease, key: string, uri: string): boolean;
  delete(lease: GalleryStillCacheLease, key: string): boolean;
  /** Invalidates even outstanding jobs from a later login with the same token. */
  clear(): void;
};

/** A synchronous, memory-only cache for web canvas captures, never SharedRefs. */
export function createGalleryStillCache(
  options: {
    maxEntries?: number;
    maxBytes?: number;
    maxAgeMs?: number;
    now?: () => number;
  } = {},
): GalleryStillCache {
  const maxEntries = options.maxEntries ?? galleryStillCacheMaxEntries;
  const maxBytes = options.maxBytes ?? galleryStillCacheMaxBytes;
  const maxAgeMs = options.maxAgeMs ?? galleryStillCacheMaxAgeMs;
  for (const [value, ceiling] of [
    [maxEntries, galleryStillCacheMaxEntries],
    [maxBytes, galleryStillCacheMaxBytes],
    [maxAgeMs, galleryStillCacheMaxAgeMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling)
      throw new RangeError("Invalid still cache limit");
  }
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    { uri: string; bytes: number; capturedAt: number }
  >();
  let activeScope: string | null | undefined;
  let activeLease: GalleryStillCacheLease | null = null;
  let bytes = 0;
  const remove = (key: string) => {
    const previous = entries.get(key);
    if (!previous) return false;
    entries.delete(key);
    bytes -= previous.bytes;
    return true;
  };
  const clear = () => {
    entries.clear();
    bytes = 0;
    activeScope = undefined;
    activeLease = null;
  };
  return {
    activate(scope) {
      if (activeLease && scope === activeScope) return activeLease;
      clear();
      activeScope = scope;
      activeLease = Object.freeze({}) as GalleryStillCacheLease;
      return activeLease;
    },
    isActive(lease) {
      return activeLease !== null && lease === activeLease;
    },
    get(lease, key) {
      if (activeLease === null || lease !== activeLease) return null;
      const entry = entries.get(key);
      if (!entry) return null;
      const time = now();
      if (
        !Number.isFinite(time) ||
        time < entry.capturedAt ||
        time - entry.capturedAt >= maxAgeMs
      ) {
        remove(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.uri;
    },
    put(lease, key, uri) {
      if (
        activeLease === null ||
        lease !== activeLease ||
        typeof key !== "string" ||
        !key ||
        typeof uri !== "string"
      )
        return false;
      // Include both retained strings in the UTF-16 budget before decoding.
      const size = 2 * (key.length + uri.length);
      if (size > maxBytes || !staticPng(uri)) return false;
      const capturedAt = now();
      if (!Number.isFinite(capturedAt)) return false;
      remove(key);
      while (entries.size >= maxEntries || bytes + size > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
      entries.set(key, { uri, bytes: size, capturedAt });
      bytes += size;
      return true;
    },
    delete(lease, key) {
      return activeLease !== null && lease === activeLease && remove(key);
    },
    clear,
  };
}

/** Scope is deliberately separate; do not pass a token in the key or URI. */
export function galleryStillCacheKey(
  item: Pick<
    Item,
    | "id"
    | "media_id"
    | "media_url"
    | "cover"
    | "content_type"
    | "demo"
    | "trim_start"
    | "trim_end"
    | "timeline"
  >,
) {
  const clip = item.timeline?.clips[0];
  const number = (value: number | null) =>
    value === null || Number.isFinite(value) ? value : String(value);
  return JSON.stringify([
    "gallery-still-v1",
    item.id,
    item.media_id ?? null,
    item.media_url,
    item.cover,
    item.content_type ?? null,
    item.demo,
    number(clip?.start ?? item.trim_start ?? 0),
    number(clip?.end ?? item.trim_end ?? null),
    number(clip?.speed ?? 1),
  ]);
}

/** Reject URLs, other formats and animated PNGs; canvas captures are static PNG. */
function staticPng(uri: string) {
  const prefix = "data:image/png;base64,";
  if (!uri.startsWith(prefix)) return false;
  const payload = uri.slice(prefix.length);
  if (
    payload.length < 60 ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)
  )
    return false;
  let data: string;
  try {
    data = atob(payload);
  } catch {
    return false;
  }
  if (data.slice(0, 8) !== "\x89PNG\r\n\x1a\n") return false;
  const uint = (position: number) =>
    data.charCodeAt(position) * 0x1000000 +
    data.charCodeAt(position + 1) * 0x10000 +
    data.charCodeAt(position + 2) * 0x100 +
    data.charCodeAt(position + 3);
  let position = 8;
  let header = false;
  let pixels = false;
  while (position + 12 <= data.length) {
    const length = uint(position);
    const kind = data.slice(position + 4, position + 8);
    const end = position + 12 + length;
    if (end > data.length || /^(acTL|fcTL|fdAT)$/.test(kind)) return false;
    if (!header) {
      if (
        kind !== "IHDR" ||
        length !== 13 ||
        !uint(position + 8) ||
        !uint(position + 12)
      )
        return false;
      header = true;
    } else if (kind === "IHDR") return false;
    if (kind === "IDAT") pixels = true;
    if (kind === "IEND")
      return header && pixels && length === 0 && end === data.length;
    position = end;
  }
  return false;
}

export const webGalleryStillCache = createGalleryStillCache();
