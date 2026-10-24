import assert from "node:assert/strict";
import test from "node:test";
import {
  galleryFrameHasPicture,
  galleryStillSize,
  galleryStillTimeoutMs,
  galleryStillTimes,
} from "../src/lib/gallery-preview.ts";
import type { Item } from "../src/lib/types.ts";

const item = (changes: Partial<Item> = {}) =>
  ({ trim_start: 0, trim_end: null, ...changes }) as Item;

test("representative frames try nearby retained pixels before a distant black-intro fallback", () => {
  assert.deepEqual(galleryStillTimes(item(), 60), [1, 3, 51]);
  assert.deepEqual(
    galleryStillTimes(item({ trim_start: 10, trim_end: 20 }), 120),
    [11, 13, 18.5],
  );
  assert.deepEqual(
    galleryStillTimes(
      item({
        timeline: {
          version: 1,
          clips: [
            { id: "first", start: 40, end: 50 },
            { id: "later", start: 80, end: 90 },
          ],
        },
      }),
      120,
    ),
    [41, 43, 48.5],
  );
  for (const span of [0.0001, 0.1, 1, 1800]) {
    const times = galleryStillTimes(
      item({ trim_start: 5, trim_end: 5 + span }),
      7200,
    );
    assert.ok(times.length >= 1 && times.length <= 3);
    assert.ok(times.every((time) => time >= 5 && time < 5 + span));
  }
  assert.throws(() =>
    galleryStillTimes(item({ trim_start: 5, trim_end: 4 }), 60),
  );
  assert.throws(() => galleryStillTimes(item(), NaN));
  assert.equal(galleryStillSize, 360);
  assert.equal(galleryStillTimeoutMs, 10000);
});

test("long source samples start within the first retained second, never in discarded or later clips", () => {
  for (const duration of [60, 240, 7200]) {
    const start = 20;
    const times = galleryStillTimes(item({ trim_start: start }), duration);
    assert.ok(times[0] > start && times[0] <= start + 1);
    assert.ok(times[1] > times[0] && times[1] <= start + 3);
    assert.ok(times[2] > times[1] && times[2] < duration);
    assert.equal(times.length, 3);
  }
});

test("black-frame preference examines actual pixels and accepts dark but visible imagery without altering it", () => {
  assert.equal(
    galleryFrameHasPicture(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255])),
    false,
  );
  assert.equal(
    galleryFrameHasPicture(new Uint8ClampedArray([1, 2, 1, 255, 2, 1, 1, 255])),
    false,
  );
  assert.equal(
    galleryFrameHasPicture(
      new Uint8ClampedArray([22, 18, 25, 255, 0, 0, 0, 255]),
    ),
    true,
  );
  assert.equal(
    galleryFrameHasPicture(new Uint8ClampedArray([255, 255, 255, 0])),
    false,
  );
  assert.equal(galleryFrameHasPicture([]), false);
  const picture = new Uint8ClampedArray([200, 60, 20, 255, 20, 90, 160, 255]);
  const before = Array.from(picture);
  assert.equal(galleryFrameHasPicture(picture), true);
  assert.deepEqual(Array.from(picture), before);
});
