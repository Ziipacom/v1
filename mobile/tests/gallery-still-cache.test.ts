import assert from "node:assert/strict";
import test from "node:test";
import {
  createGalleryStillCache,
  galleryStillCacheKey,
  galleryStillCacheMaxAgeMs,
  galleryStillCacheMaxBytes,
  galleryStillCacheMaxEntries,
} from "../src/lib/gallery-still-cache.ts";
import type { Item } from "../src/lib/types.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV6sAAAAASUVORK5CYII=";
const item = (changes: Partial<Item> = {}): Item => ({
  id: "video",
  title: "Video",
  description: "",
  category: "video",
  creator: "Creator",
  tags: [],
  city: "",
  cover: "/brand/ziipa-background.png",
  media_id: "source",
  media_url: "/api/creator/media/source",
  content_type: "video/mp4",
  demo: false,
  label: "Creation",
  trim_start: 5,
  trim_end: 8,
  ...changes,
});

test("reuses a captured still across consumers without exposing its auth scope", () => {
  const cache = createGalleryStillCache();
  const lease = cache.activate("private-user-and-token");
  assert.equal(cache.get(lease, "clip"), null);
  assert.equal(cache.put(lease, "clip", png), true);
  assert.equal(cache.isActive(lease), true);
  assert.equal(cache.activate("private-user-and-token"), lease);
  assert.equal(cache.get(lease, "clip"), png);
  assert.deepEqual(Object.keys(lease), []);
  assert.equal(JSON.stringify(lease), "{}");
  assert.equal(Object.isFrozen(lease), true);
});

test("switching accounts rejects old reads, late writes and stale deletes", () => {
  const cache = createGalleryStillCache();
  const old = cache.activate("account-a");
  cache.put(old, "same-creation", png);
  const current = cache.activate("account-b");
  assert.equal(cache.isActive(old), false);
  assert.equal(cache.isActive(current), true);
  assert.equal(cache.get(current, "same-creation"), null);
  assert.equal(cache.get(old, "same-creation"), null);
  assert.equal(cache.put(old, "late-old-capture", png), false);
  assert.equal(cache.put(current, "same-creation", png), true);
  assert.equal(cache.delete(old, "same-creation"), false);
  assert.equal(cache.get(current, "same-creation"), png);
  assert.equal(cache.get(current, "late-old-capture"), null);
});

test("logout invalidates outstanding captures even if the same token logs in again", () => {
  const cache = createGalleryStillCache();
  const beforeLogout = cache.activate("same-token");
  cache.put(beforeLogout, "private", png);
  cache.clear();
  assert.equal(cache.isActive(beforeLogout), false);
  assert.equal(cache.put(beforeLogout, "late", png), false);
  const afterLogin = cache.activate("same-token");
  assert.notEqual(afterLogin, beforeLogout);
  assert.equal(cache.isActive(beforeLogout), false);
  assert.equal(cache.isActive(afterLogin), true);
  assert.equal(cache.get(afterLogin, "private"), null);
  assert.equal(cache.put(beforeLogout, "late", png), false);
  assert.equal(cache.get(beforeLogout, "private"), null);
  assert.equal(cache.get(afterLogin, "late"), null);
});

test("an anonymous scope cannot reuse a signed-in still", () => {
  const cache = createGalleryStillCache();
  const privateLease = cache.activate("private");
  cache.put(privateLease, "same-id", png);
  const anonymous = cache.activate(null);
  assert.equal(cache.get(anonymous, "same-id"), null);
  assert.equal(cache.put(privateLease, "same-id", png), false);
  assert.equal(cache.activate(null), anonymous);
});

test("least recently used capture is evicted at the entry limit", () => {
  const cache = createGalleryStillCache({ maxEntries: 2 });
  const lease = cache.activate(null);
  cache.put(lease, "a", png);
  cache.put(lease, "b", png);
  cache.get(lease, "a");
  cache.put(lease, "c", png);
  assert.equal(cache.get(lease, "b"), null);
  assert.equal(cache.get(lease, "a"), png);
  assert.equal(cache.get(lease, "c"), png);
});

test("UTF-16 byte budget includes keys and evicts older stills", () => {
  const entryBytes = 2 * (1 + png.length);
  const cache = createGalleryStillCache({ maxBytes: entryBytes * 2 - 1 });
  const lease = cache.activate(null);
  assert.equal(cache.put(lease, "a", png), true);
  assert.equal(cache.put(lease, "b", png), true);
  assert.equal(cache.get(lease, "a"), null);
  assert.equal(cache.get(lease, "b"), png);
  const oversizedKey = "x".repeat(entryBytes);
  assert.equal(cache.put(lease, oversizedKey, png), false);
  assert.equal(cache.get(lease, "b"), png);
});

test("expiry is based on capture time rather than extended by reading", () => {
  let time = 100;
  const cache = createGalleryStillCache({ now: () => time, maxAgeMs: 50 });
  const lease = cache.activate(null);
  cache.put(lease, "clip", png);
  time = 149;
  assert.equal(cache.get(lease, "clip"), png);
  time = 150;
  assert.equal(cache.get(lease, "clip"), null);
  assert.equal(cache.put(lease, "clip", png), true);
  time = 199;
  assert.equal(cache.get(lease, "clip"), png);
});

test("clock reversal or invalid timestamps cannot preserve a capture indefinitely", () => {
  let time = 100;
  const cache = createGalleryStillCache({ now: () => time });
  const lease = cache.activate(null);
  cache.put(lease, "clip", png);
  time = 99;
  assert.equal(cache.get(lease, "clip"), null);
  time = Number.NaN;
  assert.equal(cache.put(lease, "clip", png), false);
});

test("deleting a broken image only removes its current-scope entry", () => {
  const cache = createGalleryStillCache();
  const lease = cache.activate(null);
  cache.put(lease, "broken", png);
  cache.put(lease, "good", png);
  assert.equal(cache.delete(lease, "broken"), true);
  assert.equal(cache.delete(lease, "broken"), false);
  assert.equal(cache.get(lease, "broken"), null);
  assert.equal(cache.get(lease, "good"), png);
});

test("rejects remote URLs, other image formats, malformed data and native references", () => {
  const cache = createGalleryStillCache();
  const lease = cache.activate(null);
  cache.put(lease, "good", png);
  for (const invalid of [
    "https://example.invalid/private.png?token=secret",
    "blob:private-video",
    png.replace("image/png", "image/gif"),
    "data:image/png;base64,not-a-png",
    "data:image/png;base64," + btoa("not a png".repeat(8)),
    png.slice(0, -8),
    { uri: png } as unknown as string,
    { width: 360, height: 200, release() {} } as unknown as string,
  ]) {
    assert.equal(cache.put(lease, "bad", invalid), false);
  }
  assert.equal(cache.get(lease, "bad"), null);
  assert.equal(cache.get(lease, "good"), png);
});

test("rejects animated PNG and a structurally invalid PNG", () => {
  const cache = createGalleryStillCache();
  const lease = cache.activate(null);
  const bytes = Buffer.from(png.split(",")[1], "base64");
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8);
  animation.write("acTL", 4);
  const animated = Buffer.concat([
    bytes.subarray(0, 33),
    animation,
    bytes.subarray(33),
  ]);
  assert.equal(
    cache.put(
      lease,
      "animated",
      "data:image/png;base64," + animated.toString("base64"),
    ),
    false,
  );
  bytes.writeUInt32BE(0, 16);
  assert.equal(
    cache.put(
      lease,
      "empty-width",
      "data:image/png;base64," + bytes.toString("base64"),
    ),
    false,
  );
});

test("cache limits cannot be disabled, made non-finite or raised past the hard bounds", () => {
  for (const options of [
    { maxEntries: 0 },
    { maxEntries: 1.5 },
    { maxEntries: galleryStillCacheMaxEntries + 1 },
    { maxBytes: Number.POSITIVE_INFINITY },
    { maxBytes: galleryStillCacheMaxBytes + 1 },
    { maxAgeMs: galleryStillCacheMaxAgeMs + 1 },
  ])
    assert.throws(() => createGalleryStillCache(options), RangeError);
});

test("cache key ignores unrelated metadata and never serializes unexpected credentials", () => {
  const original = item();
  assert.equal(
    galleryStillCacheKey(original),
    galleryStillCacheKey({
      ...original,
      title: "Renamed",
      creator: "Updated creator",
      access_token: "must-not-enter-key",
    } as Item),
  );
  assert.equal(
    galleryStillCacheKey(original).includes("must-not-enter-key"),
    false,
  );
  assert.equal(
    galleryStillCacheKey(original),
    galleryStillCacheKey({ ...original }),
  );
});

test("cache identity changes for a different source, cover, type or retained range", () => {
  const original = galleryStillCacheKey(item());
  for (const change of [
    { id: "other" },
    { media_id: "other-media" },
    { media_url: "/api/creator/media/other" },
    { cover: "/other.png" },
    { content_type: "image/png" },
    { demo: true },
    { trim_start: 6 },
    { trim_end: 7 },
  ])
    assert.notEqual(galleryStillCacheKey(item(change)), original);
});

test("first retained clip controls identity, not discarded trim or later clips", () => {
  const timeline: Item["timeline"] = {
    version: 1,
    clips: [
      { id: "first", start: 10, end: 15, speed: 1.5 },
      { id: "later", start: 20, end: 25 },
    ],
  };
  const original = galleryStillCacheKey(item({ timeline }));
  assert.equal(
    galleryStillCacheKey(item({ timeline, trim_start: 0, trim_end: 40 })),
    original,
  );
  assert.equal(
    galleryStillCacheKey(
      item({ timeline: { version: 1, clips: [timeline.clips[0]] } }),
    ),
    original,
  );
  for (const change of [{ start: 11 }, { end: 14 }, { speed: 2 as const }])
    assert.notEqual(
      galleryStillCacheKey(
        item({
          timeline: {
            version: 1,
            clips: [{ ...timeline.clips[0], ...change }],
          },
        }),
      ),
      original,
    );
});

test("invalid retained numbers cannot collide with the valid implicit range", () => {
  const valid = galleryStillCacheKey(item({ trim_start: 0, trim_end: null }));
  assert.notEqual(galleryStillCacheKey(item({ trim_end: Number.NaN })), valid);
  assert.notEqual(
    galleryStillCacheKey(item({ trim_end: Number.POSITIVE_INFINITY })),
    valid,
  );
});
