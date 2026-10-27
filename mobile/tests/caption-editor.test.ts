import assert from "node:assert/strict";
import test from "node:test";
import {
  addCaptionDraft,
  applyCaptionDraft,
  captionDrafts,
  captionSourceLimit,
  parseCaptionTime,
} from "../src/lib/caption-editor.ts";
import { sourceCaptionsForEdit } from "../src/lib/auto-captions.ts";

const source = [
  { start: 1.125, end: 3.75, text: "Hello" },
  { start: 5, end: 8, text: "World" },
];

test("caption time fields accept seconds and clocks without unsafe number coercion", () => {
  assert.equal(parseCaptionTime("3.500"), 3.5);
  assert.equal(parseCaptionTime(" 0:03.500 "), 3.5);
  assert.equal(parseCaptionTime("1:02:03.045"), 3723.045);
  for (const value of [
    "",
    " ",
    "0x10",
    "1e3",
    "Infinity",
    "-1",
    "3 seconds",
    "0:60",
    "61:03",
    "1:00:60",
    "0:03.0001",
  ])
    assert.throws(() => parseCaptionTime(value), /Use seconds/);
});

test("manual apply preserves fractional source times and never mutates the accepted track", () => {
  const precise = [{ start: 0.123456789, end: 1.234567891, text: "First" }];
  const rows = captionDrafts(precise);
  rows[0].text = "  Corrected  ";
  assert.deepEqual(applyCaptionDraft(rows, 4), [
    { ...precise[0], text: "Corrected" },
  ]);
  assert.equal(precise[0].text, "First");
  assert.deepEqual(
    applyCaptionDraft([], 4),
    [],
    "an explicitly applied empty track stays empty",
  );
});

test("caption apply rejects blank, overlapping, unordered and out-of-source drafts", () => {
  const valid = captionDrafts(source);
  const edits = [
    valid.map((row, i) => (i ? row : { ...row, text: " " })),
    valid.map((row, i) => (i ? row : { ...row, text: "x".repeat(251) })),
    valid.map((row, i) => (i ? { ...row, start: "3" } : row)),
    valid.map((row, i) => (i ? row : { ...row, end: "1" })),
    valid.map((row, i) => (i ? { ...row, end: "9" } : row)),
    valid.map((row, i) => (i ? row : { ...row, start: "NaN" })),
    [valid[1], valid[0]],
  ];
  for (const rows of edits) assert.throws(() => applyCaptionDraft(rows, 8));
  for (const duration of [0, -1, NaN, Infinity])
    assert.throws(() => applyCaptionDraft(valid, duration), /duration/);
  assert.throws(() => applyCaptionDraft(Array(101).fill(valid[0]), 90), /100/);
  assert.throws(
    () =>
      applyCaptionDraft(
        captionDrafts([{ start: 89, end: 91, text: "Later" }]),
        240,
      ),
    /first 90 seconds/,
  );
  assert.equal(captionSourceLimit(240), 90);
  assert.equal(captionSourceLimit(8), 8);
  assert.deepEqual(
    applyCaptionDraft(valid, 8),
    source,
    "a failed draft must not change the original rows",
  );
});

test("new cues fit source gaps and retain stable identities after insertion or removal", () => {
  const original = captionDrafts(source);
  const rows = addCaptionDraft(original, 4, 9);
  assert.deepEqual(
    rows.map((row) => [row.start, row.end]),
    [
      ["1.125", "3.75"],
      ["4", "5"],
      ["5", "8"],
    ],
  );
  assert.equal(rows[0].id, original[0].id);
  assert.equal(rows[2].id, original[1].id);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  assert.equal(original.length, 2);
  const again = addCaptionDraft(
    rows.filter((row) => row.id !== original[0].id),
    0,
    9,
  );
  assert.equal(new Set(again.map((row) => row.id)).size, 3);
  assert.equal(again[1].id, rows[1].id);
  assert.throws(() => addCaptionDraft(original, 2, 9), /already covers/);
  assert.throws(
    () => addCaptionDraft(original, 9, 9),
    /inside the caption range/,
  );
  assert.throws(
    () => addCaptionDraft(original, NaN, 9),
    /inside the caption range/,
  );
  assert.throws(() => addCaptionDraft(original, 91, 240), /0 to 90/);
  assert.equal(addCaptionDraft(original, 8, 9).at(-1)?.end, "9");
  assert.throws(
    () =>
      addCaptionDraft(
        captionDrafts(
          Array.from({ length: 100 }, (_, n) => ({
            start: n * 0.5,
            end: n * 0.5 + 0.25,
            text: "x",
          })),
        ),
        89,
        90,
      ),
    /100/,
  );
});

test("applied manual captions follow the same reordered, repeated and accelerated source clips", () => {
  const rows = captionDrafts(source);
  rows[0].start = "0:01.125";
  rows[0].end = "0:03.750";
  rows[0].text = "Revised";
  const cues = applyCaptionDraft(rows, 10);
  assert.deepEqual(
    sourceCaptionsForEdit(cues, [
      { id: "second", start: 6, end: 10, speed: 2 },
      { id: "first", start: 0, end: 2 },
      { id: "again", start: 5, end: 8 },
    ]),
    [
      { start: 0, end: 1, text: "World" },
      { start: 3.125, end: 4, text: "Revised" },
      { start: 4, end: 7, text: "World" },
    ],
  );
  assert.deepEqual(source, [
    { start: 1.125, end: 3.75, text: "Hello" },
    { start: 5, end: 8, text: "World" },
  ]);
});
