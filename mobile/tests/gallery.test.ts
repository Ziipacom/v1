import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  galleryIndex,
  galleryItems,
  galleryRotationAllowed,
} from "../src/lib/gallery.ts";
import type { Item } from "../src/lib/types.ts";

test("Gallery excludes drafts and hidden entries without mutating the server selection", () => {
  const base = {
    title: "Film",
    description: "",
    creator: "Creator",
    tags: [],
    category: "video",
  } as unknown as Item;
  const source = [
    { ...base, id: "published", visibility: "published" },
    { ...base, id: "private", visibility: "draft" },
    { ...base, id: "removed", visibility: "hidden" },
    { ...base, id: "preview", demo: true },
  ] as Item[];
  assert.deepEqual(
    galleryItems(source, "music", "Film").map((item) => item.id),
    ["published", "preview"],
  );
  assert.deepEqual(
    source.map((item) => item.id),
    ["published", "private", "removed", "preview"],
  );
  assert.deepEqual(galleryItems(source, "games", ""), []);
});

test("Gallery wraps manual and timed navigation safely", () => {
  assert.equal(galleryIndex(-1, 3), 2);
  assert.equal(galleryIndex(3, 3), 0);
  assert.equal(galleryIndex(8, 1), 0);
  assert.equal(galleryIndex(4, 0), 0);
});

test("Gallery rotation pauses for focus, visibility, user interaction and reduced motion", () => {
  const ready = {
    count: 3,
    enabled: true,
    focused: true,
    foreground: true,
    visible: true,
    hovering: false,
    controlFocused: false,
    reducedMotion: false,
  };
  assert.equal(galleryRotationAllowed(ready), true);
  for (const key of ["enabled", "focused", "foreground", "visible"] as const)
    assert.equal(
      galleryRotationAllowed({ ...ready, [key]: false }),
      false,
      key,
    );
  for (const key of ["hovering", "controlFocused", "reducedMotion"] as const)
    assert.equal(galleryRotationAllowed({ ...ready, [key]: true }), false, key);
  assert.equal(galleryRotationAllowed({ ...ready, count: 1 }), false);
  assert.equal(galleryRotationAllowed({ ...ready, count: 0 }), false);
});
