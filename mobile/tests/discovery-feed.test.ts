import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryEntries,
  discoveryConnectionIdentity,
  discoveryPostUrl,
  discoveryThumbnailUrl,
  filterDiscoveryEntries,
  importedDiscoveryMedia,
} from "../src/lib/discovery-feed.ts";
import { emptyNetworkHub, type NetworkMedia } from "../src/lib/network-hub.ts";
import { emptyPreferences, type Item } from "../src/lib/types.ts";

const item = (id: string, patch: Partial<Item> = {}): Item => ({
  id,
  title: id,
  description: "A public creation",
  creator: `Creator ${id}`,
  creator_id: Number(id) || 1,
  category: "video",
  visibility: "published",
  demo: false,
  tags: [],
  city: "",
  label: "Post",
  media_url: `/api/creator/media/${id}`,
  content_type: "video/mp4",
  cover: "",
  ...patch,
});
const post = (
  id = "post",
  patch: Partial<NetworkMedia> = {},
): NetworkMedia => ({
  id: `at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/${id}`,
  provider: "bluesky",
  title: `Public ${id}`,
  text: "An imported public image",
  author: "Network creator",
  handle: "creator.bsky.social",
  kind: "image",
  url: `https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/${id}`,
  thumbnail_url: "https://cdn.bsky.app/img/feed_thumbnail/plain/example.jpg",
  ...patch,
});
const hub = (...media: NetworkMedia[]) => {
  const result = emptyNetworkHub();
  Object.assign(result.providers[0], {
    status: "linked",
    auth_type: "public_profile",
    sync_status: "synced",
  });
  result.media = media;
  return result;
};

test("Discover includes real published creations across owners and all media types, excluding private, hidden and demo records", () => {
  const source = [
    item("1"),
    item("2", { category: "games", creator_id: 2 }),
    item("3", { content_type: "image/jpeg", media_url: null }),
    item("4", { visibility: "draft" }),
    item("5", { visibility: "hidden" }),
    item("6", { visibility: undefined }),
    item("7", { demo: true }),
  ];
  const before = JSON.stringify(source);
  assert.deepEqual(
    discoveryEntries(source, null, emptyPreferences, 4)
      .map((entry) => entry.id)
      .sort(),
    ["ziipa:1", "ziipa:2", "ziipa:3"],
  );
  assert.equal(JSON.stringify(source), before);
  assert.equal(
    discoveryEntries(source, null, emptyPreferences, 4, true).some(
      (entry) => entry.id === "ziipa:7",
    ),
    true,
  );
});

test("connection cache identity changes only for non-secret public linkage fields", () => {
  const linked = hub(post()).providers;
  const original = discoveryConnectionIdentity(linked);
  assert.equal(
    discoveryConnectionIdentity(
      linked.map((row) => ({
        ...row,
        token: "never include this",
        client_secret: "also private",
        media_count: 50,
      })),
    ),
    original,
  );
  const changed = linked.map((row) =>
    row.provider === "bluesky"
      ? { ...row, handle: "different.bsky.social" }
      : row,
  );
  assert.notEqual(discoveryConnectionIdentity(changed), original);
  assert.equal(original.includes("never include"), false);
});

test("seeded discovery order stays stable across rerenders, input order and membership changes until a fresh seed", () => {
  const source = Array.from({ length: 24 }, (_, n) => item(String(n + 1)));
  const ids = (seed: number, list = source) =>
    discoveryEntries(list, null, emptyPreferences, seed).map(
      (entry) => entry.id,
    );
  const first = ids(42);
  assert.deepEqual(ids(42), first);
  assert.deepEqual(ids(42, [...source].reverse()), first);
  assert.deepEqual(
    ids(42, [...source, item("new")]).filter((id) => id !== "ziipa:new"),
    first,
  );
  assert.notDeepEqual(ids(43), first);
  assert.equal(new Set(first).size, source.length);
});

test("category, search and Saved filters retain randomized peer order without inventing saved network posts", () => {
  const entries = discoveryEntries(
    [
      item("film"),
      item("song", { category: "music" }),
      item("game", { category: "games" }),
    ],
    hub(post("clip", { kind: "video" }), post("photo")),
    emptyPreferences,
    17,
  );
  const music = filterDiscoveryEntries(entries, { category: "music" });
  assert.equal(music.length, 3);
  assert.deepEqual(
    music,
    entries.filter((entry) =>
      entry.source === "network"
        ? entry.media.kind === "video"
        : ["video", "music"].includes(entry.item.category),
    ),
  );
  assert.deepEqual(
    filterDiscoveryEntries(entries, { query: "NETWORK creator" }).map(
      (entry) => entry.source,
    ),
    ["network", "network"],
  );
  assert.deepEqual(
    filterDiscoveryEntries(entries, { savedIds: ["film"] }).map(
      (entry) => entry.id,
    ),
    ["ziipa:film"],
  );
  assert.deepEqual(filterDiscoveryEntries(entries, { savedIds: [] }), []);
});

test("only linked supported public snapshots appear; duplicate or unsupported network rows cannot become Ziipa items", () => {
  const linked = hub(
    post(),
    post(),
    post("other", {
      provider: "tiktok",
      url: "https://www.tiktok.com/@user/video/123",
    }),
  );
  assert.equal(importedDiscoveryMedia(linked).length, 1);
  const entries = discoveryEntries([item("post")], linked, emptyPreferences, 3);
  assert.equal(entries.length, 2);
  assert.equal(entries.filter((entry) => entry.source === "network").length, 1);
  Object.assign(linked.providers[0], {
    status: "disconnected",
    auth_type: "none",
  });
  assert.deepEqual(importedDiscoveryMedia(linked), []);
  assert.deepEqual(importedDiscoveryMedia(null), []);
});

test("imported posts honor local muted words and creator blocks without fabricated Ziipa identities", () => {
  const linked = hub(post());
  assert.deepEqual(
    discoveryEntries(
      [],
      linked,
      { ...emptyPreferences, muted_words: ["IMPORTED"] },
      1,
    ),
    [],
  );
  assert.deepEqual(
    discoveryEntries(
      [],
      linked,
      { ...emptyPreferences, blocked_creators: ["creator.bsky.social"] },
      1,
    ),
    [],
  );
  const [entry] = discoveryEntries([], linked, emptyPreferences, 1);
  assert.equal(entry.source, "network");
  assert.equal("item" in entry, false);
});

test("external post destinations and thumbnails are fixed public provider origins, never private API or arbitrary URLs", () => {
  const original = post();
  assert.equal(discoveryPostUrl(original), original.url);
  for (const url of [
    "http://bsky.app/profile/x/post/y",
    "https://evil.test/profile/x/post/y",
    "https://bsky.app.evil.test/profile/x/post/y",
    "https://user:password@bsky.app/profile/x/post/y",
    "https://bsky.app:444/profile/x/post/y",
    "https://bsky.app/profile/x/post/y?token=secret",
    "https://bsky.app/profile/x/post/y#fragment",
    "https://bsky.app/logout",
    "https://bsky.app/profile/x/post/%2fy",
    "file:///private/video.mp4",
  ]) {
    assert.equal(discoveryPostUrl(post("bad", { url })), null);
  }
  assert.equal(discoveryThumbnailUrl(original), original.thumbnail_url);
  for (const thumbnail_url of [
    "/api/creator/media/private",
    "http://cdn.bsky.app/x",
    "https://api.ziipa.com/api/creator/media/private",
    "https://cdn.bsky.app.evil.test/x",
    "https://secret@cdn.bsky.app/x",
    "https://cdn.bsky.app:444/x",
    "https://cdn.bsky.app/x#fragment",
  ]) {
    assert.equal(discoveryThumbnailUrl(post("bad", { thumbnail_url })), null);
  }
});
