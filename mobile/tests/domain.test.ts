import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  matchesFeed,
  parseEditing,
  parsePrice,
  privateMediaPath,
  visibleCaption,
  inCreativeWorld,
  pageAtOffset,
  studioDiscoverItems,
  isPlayableMedia,
  trustedMediaPath,
} from "../src/lib/domain.ts";
import type { Item } from "../src/lib/types.ts";

const item = {
  category: "music",
  tags: ["studio", "music"],
  city: "New York",
  creator: "Ziipa Sessions",
} as Item;
test("portal media rebases only exact trusted API origins and exact owned-media paths", () => {
  const path = "/api/creator/media/4aeaf40c-2176-4980-9c42-410a2460abf4";
  assert.equal(trustedMediaPath(path, []), path);
  assert.equal(trustedMediaPath(`https://api.ziipa.com${path}`, ["https://api.ziipa.com"]), path);
  for (const bad of [`https://evil.test${path}`, `https://api.ziipa.com.evil.test${path}`, `https://api.ziipa.com:8443${path}`, `https://x:y@api.ziipa.com${path}`, `https://api.ziipa.com${path}?token=foo`, `https://api.ziipa.com${path}#x`, "file:///etc/passwd", "/api/creator/media/../secrets"])
    assert.equal(trustedMediaPath(bad, ["https://api.ziipa.com"]), null);
});
test("Music & Film includes video while other worlds stay separate", () => {
  assert.equal(inCreativeWorld({ ...item, category: "video" }, "music"), true);
  assert.equal(inCreativeWorld(item, "music"), true);
  assert.equal(inCreativeWorld({ ...item, category: "live" }, "music"), false);
  assert.equal(inCreativeWorld({ ...item, category: "nft" }, "store"), false);
});
test("vertical paging clamps overscroll and handles resize or an empty feed", () => {
  assert.equal(pageAtOffset(-80, 800, 3), 0);
  assert.equal(pageAtOffset(810, 800, 3), 1);
  assert.equal(pageAtOffset(3200, 800, 3), 2);
  assert.equal(pageAtOffset(450, 600, 3), 1);
  assert.equal(pageAtOffset(800, 0, 3), 0);
  assert.equal(pageAtOffset(800, 800, 0), 0);
});
test("Studio discovery prioritizes playable media without exposing drafts or mutating source order", () => {
  const photo = { ...item, id: "photo", media_url: null } as Item;
  const video = {
    ...item,
    id: "video",
    media_url: "/media/sintel-trailer.mp4",
  } as Item;
  const audio = {
    ...item,
    id: "audio",
    media_url: "/api/creator/media/example",
    content_type: "audio/mpeg",
  } as Item;
  const draft = { ...video, id: "private", visibility: "draft" } as Item;
  const hidden = { ...video, id: "removed", visibility: "hidden" } as Item;
  const source = [photo, draft, video, hidden, audio];
  assert.deepEqual(
    studioDiscoverItems(source).map((entry) => entry.id),
    ["video", "audio", "photo"],
  );
  assert.deepEqual(
    source.map((entry) => entry.id),
    ["photo", "private", "video", "removed", "audio"],
  );
  assert.deepEqual(studioDiscoverItems([]), []);
});
test("Studio does not activate the video player for documents, images or unavailable media", () => {
  const base = { ...item, media_url: "/api/creator/media/example" } as Item;
  assert.equal(isPlayableMedia({ ...base, content_type: "video/mp4" }), true);
  assert.equal(isPlayableMedia({ ...base, content_type: "image/jpeg" }), false);
  assert.equal(
    isPlayableMedia({ ...base, content_type: "application/pdf" }),
    false,
  );
  assert.equal(
    isPlayableMedia({ ...base, media_url: null, content_type: "video/mp4" }),
    false,
  );
  assert.equal(isPlayableMedia(base), false);
});
test("feed rules combine filters instead of broadening them", () => {
  assert.equal(
    matchesFeed(item, {
      category: "music",
      tag: "#STUDIO",
      city: "new",
      creator: "sessions",
    }),
    true,
  );
  assert.equal(
    matchesFeed(item, {
      category: "music",
      tag: "studio",
      city: "Lisbon",
      creator: "",
    }),
    false,
  );
  assert.equal(
    matchesFeed(item, { category: "all", tag: "mus", city: "", creator: "" }),
    false,
  );
});
test("editing rejects invalid or empty time ranges and computes timed captions", () => {
  for (const [start, end] of [
    ["NaN", ""],
    ["-1", "5"],
    ["5", "5"],
    ["0", "Infinity"],
    ["86401", ""],
  ])
    assert.throws(() => parseEditing(start, end, ""));
  assert.deepEqual(parseEditing("2", "8", " Hello ").captions, [
    { start: 2, end: 8, text: "Hello" },
  ]);
  assert.equal(
    visibleCaption([{ start: 2, end: 8, text: "Hello" }], 8),
    undefined,
  );
  assert.equal(
    visibleCaption([{ start: 2, end: 8, text: "Hello" }], 2),
    "Hello",
  );
});
test("authentication is never attached to an arbitrary media URL", () => {
  assert.equal(
    privateMediaPath("/api/creator/media/8c100347-2d40-47a3-8683-d04bf365012e"),
    true,
  );
  for (const path of [
    "https://attacker.example/video",
    "//attacker.example/video",
    "/api/creator/media/../me",
    "/api/creator/media/8c100347-2d40-47a3-8683-d04bf365012e?redirect=https://attacker.example",
  ])
    assert.equal(privateMediaPath(path), false);
});
test("listing prices preserve cents and reject invalid or excessive amounts", () => {
  assert.equal(parsePrice("12.01"), 1201);
  assert.equal(parsePrice("0.29"), 29);
  assert.equal(parsePrice(""), null);
  for (const value of ["12.345", "-1", "2e4", "1000001"])
    assert.throws(() => parsePrice(value));
});
