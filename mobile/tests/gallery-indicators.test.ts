import test from "node:test";
import assert from "node:assert/strict";
import { galleryIndicators } from "../src/lib/gallery.ts";

test("indicator slots stay bounded while every portfolio position remains reachable", () => {
  for (const count of [1, 2, 3, 4, 5, 12, 100]) {
    for (let current = 0; current < count; current++) {
      const bars = galleryIndicators(count, current);
      assert.equal(bars.length, Math.min(3, count));
      assert.equal(bars.filter((bar) => bar.active).length, 1);
      assert.equal(bars.find((bar) => bar.active)?.index, current);
      assert.equal(new Set(bars.map((bar) => bar.index)).size, bars.length);
      assert.ok(bars.every((bar) => bar.index >= 0 && bar.index < count));
    }
  }
});

test("empty galleries have no bars and the final short window wraps safely", () => {
  assert.deepEqual(galleryIndicators(0, 0), []);
  assert.deepEqual(
    galleryIndicators(5, 4).map((bar) => bar.index),
    [3, 4, 0],
  );
  assert.equal(galleryIndicators(5, 5).find((bar) => bar.active)?.index, 0);
});
