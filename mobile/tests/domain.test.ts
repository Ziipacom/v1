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
} from "../src/lib/domain.ts";
import type { Item } from "../src/lib/types.ts";

const item = {
  category: "music",
  tags: ["studio", "music"],
  city: "New York",
  creator: "Ziipa Sessions",
} as Item;
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
