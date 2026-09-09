import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  emptyNetworkHub,
  profileLink,
  safeNetworkUrl,
} from "../src/lib/network-hub.ts";
import {
  exportDownload,
  exportId,
  exportName,
} from "../src/lib/share-types.ts";
import type { Item } from "../src/lib/types.ts";

test("profile links normalize known networks, numeric Facebook IDs and YouTube channels", () => {
  assert.equal(profileLink("instagram", "@Ziipacom").handle, "ziipacom");
  assert.equal(
    profileLink(
      "facebook",
      "https://www.facebook.com/profile.php?id=100069007428098",
    ).profile_url,
    "https://www.facebook.com/profile.php?id=100069007428098",
  );
  assert.equal(
    profileLink("bluesky", "https://bsky.app/profile/bsky.app").handle,
    "bsky.app",
  );
  assert.equal(
    profileLink("youtube", "UCabcdefghijklmnopqrstuv").profile_url,
    "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
  );
});
test("profile inputs reject off-platform URLs, login tools and ambiguous IDs", () => {
  for (const url of [
    "https://instagram.com.attacker.example/ziipa",
    "https://name:password@instagram.com/ziipa",
    "http://instagram.com/ziipa",
    "https://instagram.com/accounts",
    "https://instagram.com/ziipa?redirect=elsewhere",
    "https://instagram.com/%7Aii",
    "javascript:alert(1)",
  ])
    assert.throws(() => profileLink("instagram", url));
  for (const url of [
    "https://facebook.com/profile.php?id=12&id=34",
    "https://facebook.com/profile.php?id=x",
    "https://facebook.com/profile.php?id=12&next=evil",
  ])
    assert.throws(() => profileLink("facebook", url));
  assert.equal(
    safeNetworkUrl(
      "facebook",
      "https://facebook.com/l.php?u=https://example.com",
    ),
    null,
  );
});
test("new sample accounts never imply OAuth or delivery authorization", () => {
  const hub = emptyNetworkHub();
  assert.equal(hub.providers.length, 6);
  assert.equal(
    hub.providers.some(
      (provider) =>
        provider.status === "connected" ||
        provider.can_publish ||
        provider.configured,
    ),
    false,
  );
  assert.deepEqual(hub.people, []);
});
test("export authentication is attached only to the exact own-media API path", () => {
  const id = "8c100347-2d40-47a3-8683-d04bf365012e";
  const info = {
    size: 400,
    content_type: "video/mp4",
    url: `/api/creator/media/${id}`,
  };
  assert.equal(
    exportDownload(info, "http://localhost:8018", id, "secret").headers
      .Authorization,
    "Bearer secret",
  );
  assert.deepEqual(
    exportDownload(
      { ...info, url: "https://media.example/file?signature=xyz" },
      "https://api.ziipa.com",
      id,
      "secret",
    ).headers,
    {},
  );
  assert.throws(() =>
    exportDownload(
      { ...info, url: "http://untrusted.example/file" },
      "https://api.ziipa.com",
      id,
      "secret",
    ),
  );
  assert.throws(() =>
    exportDownload(
      { ...info, size: 101 * 1024 * 1024 },
      "https://api.ziipa.com",
      id,
      "secret",
    ),
  );
  assert.throws(() => exportId({ media_id: id, demo: true } as Item));
  assert.equal(
    exportName({ title: "../../private" } as Item, "video/mp4").includes("/"),
    false,
  );
});
