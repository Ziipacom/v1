import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  canSplitAt,
  clampClipEdge,
  deleteClip,
  formatTimelineTime,
  sequenceToSource,
  sourceToSequence,
  splitClip,
  totalDuration,
  trimClip,
  validateClips,
} from "../src/lib/editor-timeline.ts";
import type { TimelineClip } from "../src/lib/types.ts";

const clips: TimelineClip[] = [
  { id: "a", start: 10, end: 14 },
  { id: "b", start: 30, end: 33 },
];
const near = (actual: number | null | undefined, expected: number) =>
  assert.ok(
    actual !== null &&
      actual !== undefined &&
      Math.abs(actual - expected) < 0.00001,
    `${actual} != ${expected}`,
  );

test("timeline maps ordered source cuts to output time, including exact boundaries", () => {
  assert.equal(totalDuration(clips), 7);
  assert.deepEqual(sequenceToSource(clips, 0), {
    clip: clips[0],
    index: 0,
    sourceTime: 10,
  });
  assert.deepEqual(sequenceToSource(clips, 4), {
    clip: clips[1],
    index: 1,
    sourceTime: 30,
  });
  assert.equal(sequenceToSource(clips, 999)?.sourceTime, 33);
  assert.equal(sequenceToSource(clips, -3)?.sourceTime, 10);
  assert.equal(sequenceToSource([], 0), null);
  assert.equal(sequenceToSource(clips, NaN), null);
  assert.equal(sourceToSequence(clips, 31), 5);
  assert.equal(sourceToSequence(clips, 20), null);
});

test("repeated source ranges use the current clip identity instead of jumping backwards", () => {
  const repeated = [...clips, { id: "repeat", start: 10, end: 14 }];
  assert.equal(sourceToSequence(repeated, 12), 2);
  assert.equal(sourceToSequence(repeated, 12, "repeat"), 9);
  assert.equal(sourceToSequence(repeated, 31, "repeat"), null);
});

test("all persisted playback speeds preserve round trips and sequence duration", () => {
  for (const speed of [0.5, 1, 1.5, 2] as const) {
    const sequence: TimelineClip[] = [
      { id: "fast", start: 5, end: 11, speed },
      { id: "tail", start: 20, end: 24 },
    ];
    near(totalDuration(sequence), 6 / speed + 4);
    const position = sequenceToSource(sequence, 2 / speed);
    near(position?.sourceTime, 7);
    near(sourceToSequence(sequence, 7, "fast"), 2 / speed);
    assert.equal(sequenceToSource(sequence, 6 / speed)?.clip.id, "tail");
    validateClips(sequence);
  }
});

test("split is immutable, preserves speed and total time, and retains the left clip identity", () => {
  const original: TimelineClip[] = [{ id: "a", start: 10, end: 18, speed: 2 }];
  const before = JSON.stringify(original);
  const result = splitClip(original, 1.5, "new");
  assert.deepEqual(result, [
    { id: "a", start: 10, end: 13, speed: 2 },
    { id: "new", start: 13, end: 18, speed: 2 },
  ]);
  assert.equal(totalDuration(result), totalDuration(original));
  assert.equal(JSON.stringify(original), before);
  assert.equal(canSplitAt(original, 0.05), false);
  assert.throws(() => splitClip(original, 0.05, "new"));
  assert.throws(() => splitClip(original, 2, "a"));
  const maximum = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    start: 0,
    end: 1,
  }));
  assert.equal(canSplitAt(maximum, 0.5), false);
});

test("trim and delete preserve untouched clips and reject invalid edits", () => {
  const result = trimClip(clips, "a", 11, 13, 33);
  assert.deepEqual(result[0], { id: "a", start: 11, end: 13 });
  assert.deepEqual(clips[0], { id: "a", start: 10, end: 14 });
  assert.notEqual(result[1], clips[1]);
  assert.deepEqual(deleteClip(clips, "a"), [clips[1]]);
  assert.deepEqual(deleteClip([clips[0]], "a"), []);
  assert.throws(() => trimClip(clips, "a", 11, 11.1));
  assert.throws(() => trimClip(clips, "missing", 0, 1));
  assert.throws(() => trimClip(clips, "a", 0, 90));
  assert.throws(() => trimClip(clips, "b", 30, 34, 33));
  assert.throws(() => trimClip(clips, "b", NaN, 33));
});

test("trim handles clamp within source, minimum source length and remaining output budget", () => {
  const clip = { id: "a", start: 10, end: 14 };
  near(clampClipEdge(clip, "start", 99, 40).start, 13.8);
  assert.equal(clampClipEdge(clip, "start", -2, 40).start, 0);
  near(clampClipEdge(clip, "end", -2, 40).end, 10.2);
  assert.equal(clampClipEdge(clip, "end", 100, 30).end, 30);
  assert.equal(clampClipEdge(clip, "end", 100, 100, 6).end, 16);
  assert.equal(clampClipEdge(clip, "start", 0, 100, 6).start, 8);
  assert.deepEqual(clampClipEdge(clip, "start", NaN, 40), clip);
});

test("timeline validation and clock formatting fail safely at limits", () => {
  assert.throws(() =>
    validateClips([{ id: "a", start: 0, end: 46, speed: 0.5 }]),
  );
  assert.throws(() =>
    validateClips([
      { id: "a", start: 0, end: 1 },
      { id: "a", start: 2, end: 3 },
    ]),
  );
  assert.throws(() => validateClips([{ id: "a", start: -1, end: 1 }]));
  assert.throws(() => validateClips([{ id: "a", start: 1, end: Infinity }]));
  assert.equal(formatTimelineTime(59.99), "1:00.0");
  assert.equal(formatTimelineTime(0.2), "0:00.2");
  assert.equal(formatTimelineTime(NaN), "0:00.0");
});
