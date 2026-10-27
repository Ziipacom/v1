import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryEntries,
  discoveryConnectionIdentity,
  discoveryPostUrl,
  discoveryThumbnailUrl,
  filterDiscoveryEntries,
  importedDiscoveryMedia,
  nextDiscoverySnapshotExpiry,
} from "../src/lib/discovery-feed.ts";
import { emptyNetworkHub, type NetworkMedia } from "../src/lib/network-hub.ts";
import { emptyPreferences, type Item } from "../src/lib/types.ts";
import type { SocialProvider } from "../src/lib/types.ts";

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
    can_sync: true,
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

const importedPost = (provider: SocialProvider): NetworkMedia =>
  post("shared", {
    id: "shared",
    provider,
    kind: "video",
    url:
      (
        {
          facebook: "https://www.facebook.com/123/posts/456",
          instagram: "https://www.instagram.com/reel/ABC_-123/",
          tiktok: "https://www.tiktok.com/@creator/video/1234567890",
          youtube: "https://www.youtube.com/watch?v=aBcDeFg_-12",
        } as Partial<Record<SocialProvider, string>>
      )[provider] || post().url,
    thumbnail_url:
      (
        {
          facebook:
            "https://scontent.xx.fbcdn.net/image.jpg?oh=public-signature&oe=public-expiry",
          instagram: "https://scontent.cdninstagram.com/image.jpg",
          tiktok:
            "https://p16-sign-sg.tiktokcdn.com/image.jpg?x-expires=123&x-signature=public",
          youtube: "https://i.ytimg.com/vi/aBcDeFg_-12/hqdefault.jpg",
        } as Partial<Record<SocialProvider, string>>
      )[provider] || post().thumbnail_url,
  });

test("Meta, TikTok, YouTube and Bluesky keep attributed identities distinct and require an eligible public-read connection", () => {
  const value = emptyNetworkHub();
  const providers: SocialProvider[] = [
    "facebook",
    "instagram",
    "tiktok",
    "youtube",
    "bluesky",
  ];
  value.media = providers.map(importedPost);
  for (const account of value.providers) {
    if (account.provider === "twitch") continue;
    Object.assign(account, {
      status: "connected",
      auth_type: "oauth",
      can_sync: true,
      snapshot_expires_at: new Date(Date.now() + 3600000).toISOString(),
      selected_import_target_id: "own-account",
      import_targets: [
        { id: "own-account", name: "My account", kind: "account", url: "" },
      ],
    });
    account.capabilities.public_feed = true;
  }
  const all = discoveryEntries([], value, emptyPreferences, 5);
  assert.equal(all.length, 5);
  assert.equal(new Set(all.map((entry) => entry.id)).size, 5);
  assert.equal(filterDiscoveryEntries(all, { query: "youtube" }).length, 1);
  assert.equal(filterDiscoveryEntries(all, { query: "instagram" }).length, 1);
  for (const account of value.providers) {
    if (account.provider === "twitch") continue;
    const before = discoveryConnectionIdentity(value.providers);
    account.can_sync = false;
    assert.notEqual(discoveryConnectionIdentity(value.providers), before);
    assert.equal(
      importedDiscoveryMedia(value).some(
        (row) => row.provider === account.provider,
      ),
      false,
    );
    account.can_sync = true;
    account.capabilities.public_feed = false;
    assert.equal(
      importedDiscoveryMedia(value).some(
        (row) => row.provider === account.provider,
      ),
      false,
    );
    account.capabilities.public_feed = true;
    account.status = "linked";
    account.auth_type = "public_profile";
    assert.equal(
      importedDiscoveryMedia(value).some(
        (row) => row.provider === account.provider,
      ),
      ["youtube", "bluesky"].includes(account.provider),
    );
  }
});

test("public snapshots expire locally, malformed deadlines and missing OAuth target consent stay hidden", () => {
  const value = emptyNetworkHub(),
    account = value.providers.find((row) => row.provider === "youtube")!;
  const now = Date.parse("2026-10-27T12:00:00Z");
  Object.assign(account, {
    status: "linked",
    auth_type: "public_profile",
    can_sync: true,
    snapshot_expires_at: "2026-10-27T13:00:00Z",
  });
  account.capabilities.public_feed = true;
  value.media = [importedPost("youtube")];
  assert.equal(importedDiscoveryMedia(value, now).length, 1);
  assert.equal(nextDiscoverySnapshotExpiry(value, now), now + 3600000);
  assert.equal(importedDiscoveryMedia(value, now + 3600000).length, 0);
  for (const snapshot_expires_at of [
    null,
    "invalid",
    "2026-10-28T12:00:01Z",
    "2026-10-27T13:00:00+09:00",
  ])
    assert.equal(
      importedDiscoveryMedia(
        { ...value, providers: [{ ...account, snapshot_expires_at }] },
        now,
      ).length,
      0,
    );
  const meta = {
    ...account,
    provider: "facebook" as const,
    status: "connected" as const,
    auth_type: "oauth" as const,
    selected_import_target_id: "foreign",
    import_targets: [{ id: "mine", name: "My Page", kind: "page", url: "" }],
  };
  assert.equal(
    importedDiscoveryMedia(
      { ...value, providers: [meta], media: [importedPost("facebook")] },
      now,
    ).length,
    0,
  );
  meta.selected_import_target_id = "mine";
  assert.equal(
    importedDiscoveryMedia(
      { ...value, providers: [meta], media: [importedPost("facebook")] },
      now,
    ).length,
    1,
  );
});

test("provider-specific original links reject profiles, redirects, tracking and credential-bearing alternatives", () => {
  for (const provider of [
    "facebook",
    "instagram",
    "tiktok",
    "youtube",
  ] as const) {
    const media = importedPost(provider);
    assert.equal(discoveryPostUrl(media), media.url);
    assert.equal(discoveryThumbnailUrl(media), media.thumbnail_url);
    for (const url of [
      media.url + "#token",
      media.url + (media.url.includes("?") ? "&" : "?") + "access_token=secret",
      media.url.replace("https://", "https://secret@"),
      media.url.replace("https://", "http://"),
      media.url.replace(".com", ".com.evil.test"),
      media.url.replace(".com", ".com:444"),
      "https://www.youtube.com/redirect?q=https://evil.test",
      "https://www.instagram.com/accounts/login/",
    ])
      assert.equal(
        discoveryPostUrl({ ...media, url }),
        null,
        `${provider}: ${url}`,
      );
    for (const thumbnail_url of [
      media.thumbnail_url! +
        (media.thumbnail_url!.includes("?") ? "&" : "?") +
        "access_token=secret",
      media.thumbnail_url!.replace("https://", "https://secret@"),
      "https://api.ziipa.com/api/creator/media/private",
      "https://cdninstagram.com.evil.test/image.jpg",
    ])
      assert.equal(discoveryThumbnailUrl({ ...media, thumbnail_url }), null);
  }
  const youtube = importedPost("youtube");
  assert.equal(
    discoveryPostUrl({ ...youtube, url: youtube.url + "&v=anotherId12" }),
    null,
  );
  assert.equal(
    discoveryPostUrl({
      ...youtube,
      url: "https://www.youtube.com/watch?v=short",
    }),
    null,
  );
  assert.equal(
    discoveryPostUrl({ ...youtube, url: "https://www.youtube.com/@channel" }),
    null,
  );
  assert.equal(discoveryPostUrl(importedPost("twitch")), null);
});
