import test from "node:test";
import assert from "node:assert/strict";
import { sourceCaptionsForEdit, validateCaptionCues } from "../src/lib/auto-captions.ts";

const source = [
  { start: 1, end: 3, text: "Hello" },
  { start: 5, end: 8, text: "World" },
];
test("recognition requires actual ordered finite source timestamps", () => {
  for (const track of ["hello", [{ start: 1, end: 1, text: "x" }],
    [{ start: NaN, end: 3, text: "x" }], [{ start: 0, end: 91, text: "x" }],
    [source[1], source[0]], [{ start: 0, end: 1, text: " " }]])
    assert.throws(() => validateCaptionCues(track));
  assert.deepEqual(validateCaptionCues(source), source);
});
test("accepted captions follow reordered cuts, speed and partial cue boundaries", () => {
  const original = JSON.stringify(source);
  assert.deepEqual(sourceCaptionsForEdit(source, [
    { id: "second", start: 6, end: 10, speed: 2 },
    { id: "first", start: 0, end: 2 },
    { id: "again", start: 5, end: 8 },
  ]), [
    { start: 0, end: 1, text: "World" },
    { start: 3, end: 4, text: "Hello" },
    { start: 4, end: 7, text: "World" },
  ]);
  assert.equal(JSON.stringify(source), original);
  assert.deepEqual(sourceCaptionsForEdit(source, []), []);
  assert.deepEqual(sourceCaptionsForEdit(source), source);
});
test("repeated clips cannot bypass the persisted caption count limit", () => {
  const cues = Array.from({ length: 90 }, (_, n) => ({ start: n, end: n + 0.5, text: "x" }));
  assert.throws(() => sourceCaptionsForEdit(cues, [
    { id: "a", start: 0, end: 90 }, { id: "b", start: 0, end: 90 },
  ]), /100/);
});
