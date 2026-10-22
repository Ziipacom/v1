import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  destinationFromSearch,
  destinationSearch,
  isDesktopPortal,
} from "../src/lib/desktop-navigation.ts";

const first = "a130b762-6812-4963-9ebd-5d103a24084e";
const second = "df8af080-7ba9-42b0-b959-26305b75ff6b";

test("desktop is a web-only finite breakpoint without changing compact or native routing", () => {
  assert.equal(isDesktopPortal("web", 1024), true);
  assert.equal(isDesktopPortal("web", 2560), true);
  for (const width of [0, -1, 390, 1023.99, Infinity, -Infinity, NaN])
    assert.equal(isDesktopPortal("web", width), false);
  for (const platform of ["android", "ios", "windows", "Web", ""])
    assert.equal(isDesktopPortal(platform, 1600), false);
});

test("desktop route views round-trip only their declared filters and identifiers", () => {
  const routes: [string, Record<string, unknown> | undefined][] = [
    [
      "Main",
      { category: "music", query: "  My café & film  ", collection: "saved" },
    ],
    ["CreatorStudio", { tab: "overview" }],
    ["CreatorStudio", { tab: "library", category: "video", query: "draft" }],
    ["Composer", { category: "nft", draftId: first }],
    ["Watch", { category: "games", itemId: first }],
    ["Calendar", { eventId: first, streamId: second, kind: "stream" }],
    ["Campaigns", { itemId: first, campaignId: second }],
    ["Live", { streamId: first, tab: "broadcast" }],
    ["Recordings", { streamId: first }],
    ["Exports", { itemId: first }],
    ["Connections", { tab: "outbox" }],
    ["Publishing", { itemId: first, renderId: second }],
    ["MediaOS", { tab: "Agent" }],
    ["Utility", { kind: "wallet" }],
    ["Utility", { kind: "promote" }],
    ["Utility", { kind: "inbox" }],
    ["Profile", undefined],
    ["Inbox", undefined],
    ["NotificationMessages", undefined],
    ["Notifications", { deliveryId: first }],
    ["Settings", undefined],
    ["Administration", undefined],
    ["Feeds", undefined],
  ];
  for (const [screen, params] of routes) {
    const url = destinationSearch(screen, params);
    assert.ok(url, screen);
    const destination = destinationFromSearch(url);
    assert.equal(destination?.screen, screen);
    assert.equal(
      destinationSearch(destination!.screen, destination!.params),
      url,
      screen,
    );
  }
  assert.equal(
    destinationFromSearch(destinationSearch("Main", routes[0][1])!)?.params
      ?.query,
    "My café & film",
  );
});

test("legacy Studio editing links retain library intent and exports require a source", () => {
  assert.equal(
    destinationSearch("Studio", { edit: true, category: "nft" }),
    "?view=library&category=nft",
  );
  assert.deepEqual(
    destinationFromSearch(destinationSearch("Studio", { edit: true })!),
    { screen: "CreatorStudio", params: { tab: "library" } },
  );
  assert.equal(destinationSearch("Studio"), "?view=studio");
  assert.equal(destinationSearch("Exports"), null);
  assert.equal(destinationFromSearch("?view=exports"), null);
  assert.deepEqual(destinationFromSearch(`?view=exports&itemId=${first}`), {
    screen: "Exports",
    params: { itemId: first },
  });
});

test("malformed, duplicate and unknown routes cannot select an unintended source", () => {
  for (const input of [
    "",
    "?view=unknown",
    "?view=__proto__",
    "?view=constructor",
    "?view=watch&itemId=not-a-uuid",
    "?view=watch&itemId=",
    "?view=watch&itemId=" + first + "&itemId=" + second,
    "?view=studio&view=admin",
    "?view=explore&query=%ZZ",
    "?view=explore&query=%ED%A0%80",
    "?view=explore&query=%00",
    "?view=explore&category=admin",
    "?view=explore&collection=private",
    "?view=os&tab=Root",
    "?view=networks&tab=token",
    "?view=calendar&kind=publish",
    "?view=explore&query=" + "x".repeat(161),
    "?view=explore&ignored=" + "x".repeat(4096),
  ]) {
    assert.equal(destinationFromSearch(input), null, input.slice(0, 100));
  }
  assert.equal(destinationSearch("Welcome"), null);
  assert.equal(destinationSearch("Post", { item: { id: first } }), null);
  assert.equal(destinationSearch("Utility", { kind: "admin" }), null);
  assert.equal(destinationSearch("CreatorStudio", { tab: "root" }), null);
  assert.equal(
    destinationSearch("CreatorStudio", { tab: { toString: () => "library" } }),
    null,
  );
  assert.equal(
    destinationSearch("Composer", { item: { id: first }, draftId: second }),
    null,
  );
  assert.equal(
    destinationSearch("Watch", { itemId: "https://evil.test/media" }),
    null,
  );
});

test("full owned-item routes serialize only an ID and never credentials or signed media", () => {
  const params = {
    item: {
      id: first,
      title: "private title",
      description: "private notes",
      media_url: "https://media.test/asset?signature=secret",
      captions: [{ text: "private transcript" }],
    },
    session: { access_token: "secret-bearer" },
    access_token: "secret-token",
    url: "https://evil.test",
    upload: { id: second },
  };
  assert.equal(
    destinationSearch("Composer", params),
    `?view=create&draftId=${first}`,
  );
  assert.deepEqual(
    destinationFromSearch(
      `?view=create&draftId=${first}&access_token=secret&url=https://evil.test&item=private`,
    ),
    { screen: "Composer", params: { draftId: first } },
  );
  assert.equal(destinationSearch("Administration", params), "?view=admin");
  assert.equal(
    destinationSearch("Main", { query: "public search", ...params }),
    "?view=explore&query=public+search",
  );
  for (const query of [
    "https://media.test/video?signature=secret",
    "blob:https://ziipa.com/id",
    "Bearer secret",
    "access_token=secret",
    "authorization: secret",
    "x-amz-signature=secret",
    "bad\nquery",
    "\ud800",
  ]) {
    assert.equal(destinationSearch("Main", { query }), null);
  }
  assert.equal(params.item.title, "private title");
  assert.equal(params.session.access_token, "secret-bearer");
});

test("fixed views do not grant permissions or accept route-supplied identity", () => {
  assert.deepEqual(
    destinationFromSearch("?view=admin&role=owner&is_admin=true&user=1"),
    { screen: "Administration" },
  );
  assert.deepEqual(
    destinationFromSearch("?view=wallet&kind=admin&returnTo=https://evil.test"),
    { screen: "Utility", params: { kind: "wallet" } },
  );
  assert.deepEqual(destinationFromSearch("?view=library&tab=overview"), {
    screen: "CreatorStudio",
    params: { tab: "library" },
  });
  assert.deepEqual(
    destinationFromSearch("?view=watch&itemId=" + first.toUpperCase()),
    { screen: "Watch", params: { itemId: first } },
  );
  assert.equal(
    destinationSearch("Main", { query: " ", category: "video" }),
    "?view=explore&category=video",
  );
  assert.equal(destinationSearch("Main", { collection: null }), null);
  assert.equal(
    destinationSearch("Main", [] as unknown as Record<string, unknown>),
    null,
  );
});
