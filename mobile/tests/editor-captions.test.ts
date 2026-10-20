import test from "node:test";
import assert from "node:assert/strict";
import { editorCaptions } from "../src/lib/editor-captions.ts";
import type { Item } from "../src/lib/types.ts";
const item = {
  captions: [
    { start: 2, end: 4, text: "One" },
    { start: 7, end: 9, text: "Two" },
  ],
} as Item;
test("retimes all original cues across reordered source cuts", () => {
  assert.deepEqual(
    editorCaptions(
      item,
      "One",
      [
        { id: "b", start: 6, end: 10 },
        { id: "a", start: 1, end: 5, speed: 2 },
      ],
      true,
      [],
    ),
    [
      { start: 1, end: 3, text: "Two" },
      { start: 4.5, end: 5.5, text: "One" },
    ],
  );
});
test("unchanged legacy drafts retain multiple caption cues", () =>
  assert.deepEqual(editorCaptions(item, "One", [], false, []), item.captions));
test("new caption covers the edited output without modifying source cues", () => {
  assert.deepEqual(
    editorCaptions(item, "New", [{ id: "a", start: 2, end: 8 }], true, []),
    [{ start: 0, end: 6, text: "New" }],
  );
  test("reopening and trimming a saved timeline retains the cue's source alignment", () => {
    const saved = {
      ...item,
      timeline: { version: 1, clips: [{ id: "a", start: 10, end: 20 }] },
      captions: [{ start: 3, end: 7, text: "Cue" }],
    } as Item;
    assert.deepEqual(
      editorCaptions(
        saved,
        "Cue",
        [{ id: "a", start: 12, end: 18, speed: 2 }],
        true,
        [],
      ),
      [{ start: 0.5, end: 2.5, text: "Cue" }],
    );
  });
  assert.equal(item.captions?.length, 2);
});
