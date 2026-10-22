import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  customOverlayText,
  hasAdvancedOverlays,
  overlayBox,
  overlayClipRange,
  overlayCoordinates,
  overlayLayoutSupported,
  overlayTimeRange,
  overlayVisibleAt,
  validateOverlays,
} from "../src/lib/editor-overlays.ts";
import type { Overlay } from "../src/lib/types.ts";

const legacy: Overlay = {
  id: "title",
  text: "My video",
  position: "center",
  theme: "purple",
};

test("free-positioned text uses the same Unicode wrapping contract as export", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL(
        "../../backend/fixtures/overlay-text-cases.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const entry of cases)
    assert.equal(customOverlayText(entry.text, entry.scale), entry.output);
});

test("old drafts retain full-edit visibility and exact preset box anchors", () => {
  const frame = { width: 900, height: 500 },
    measured = { width: 300, height: 60 };
  assert.deepEqual(overlayBox(legacy, frame, measured), {
    x: 300,
    y: 220,
    ...measured,
  });
  assert.equal(
    overlayBox({ ...legacy, position: "top" }, frame, measured).y,
    50,
  );
  assert.equal(
    overlayBox({ ...legacy, position: "bottom" }, frame, measured).y,
    350,
  );
  assert.equal(hasAdvancedOverlays([legacy]), false);
  assert.deepEqual(overlayCoordinates(legacy), { x: 0.5, y: 0.5 });
  assert.deepEqual(overlayTimeRange(legacy, 240), { start: 0, end: 240 });
  assert.equal(overlayVisibleAt(legacy, 239.9), true);
});

test("custom box center is contained and independent of letterbox origin", () => {
  const frame = { width: 900, height: 500 },
    measured = { width: 300, height: 60 };
  assert.deepEqual(overlayBox({ ...legacy, x: 0, y: 0 }, frame, measured), {
    x: 0,
    y: 0,
    ...measured,
  });
  assert.deepEqual(overlayBox({ ...legacy, x: 1, y: 1 }, frame, measured), {
    x: 600,
    y: 440,
    ...measured,
  });
  assert.deepEqual(overlayBox({ ...legacy, x: 0.3, y: 0.4 }, frame, measured), {
    x: 120,
    y: 170,
    ...measured,
  });
});

test("timed overlay is half-open on edited sequence seconds", () => {
  const layer = { ...legacy, start: 15, end: 30 };
  assert.equal(overlayVisibleAt(layer, 14.999), false);
  assert.equal(overlayVisibleAt(layer, 15), true);
  assert.equal(overlayVisibleAt(layer, 29.999), true);
  assert.equal(overlayVisibleAt(layer, 30), false);
  assert.equal(overlayVisibleAt(layer, NaN), false);
  assert.deepEqual(overlayTimeRange(layer, 20), { start: 15, end: 20 });
  assert.deepEqual(overlayTimeRange(layer, 0), { start: 0, end: 0 });
});

test("clip range respects reordered cuts and playback speed", () => {
  const clips = [
    { id: "later", start: 100, end: 140, speed: 2 as const },
    { id: "first", start: 0, end: 8, speed: 0.5 as const },
  ];
  assert.deepEqual(overlayClipRange(clips, "first"), {
    start: 20,
    end: 36,
    label: "Clip 2",
  });
  assert.equal(overlayClipRange(clips, "missing"), null);
});

test("invalid edits are rejected before upload or save", () => {
  for (const patch of [
    { x: 0.3 },
    { x: NaN, y: 0.5 },
    { x: -0.1, y: 0.5 },
    { x: 0.5, y: 1.1 },
    { scale: Infinity },
    { scale: 0.1 },
    { start: -1 },
    { start: 20, end: 20 },
    { end: NaN },
    { end: 86401 },
  ])
    assert.throws(() => validateOverlays([{ ...legacy, ...patch }]));
  validateOverlays([
    legacy,
    { ...legacy, x: 0.2, y: 0.8, scale: 2, start: 2, end: 240 },
  ]);
  validateOverlays([
    { ...legacy, x: null, y: null, start: null, end: null, scale: null },
  ]);
});

test("unknown and old API capabilities cannot silently discard advanced edits", () => {
  for (const config of [
    undefined,
    null,
    {},
    { overlay_layout: { version: 1 } },
  ])
    assert.equal(overlayLayoutSupported(config), false);
  const config = {
    overlay_layout: {
      version: 1,
      coordinates: "normalized_media_center",
      timing: "output",
      interval: "half_open",
      scale_min: 0.5,
      scale_max: 2,
      max_overlays: 8,
    },
  };
  assert.equal(overlayLayoutSupported(config), true);
  assert.equal(
    overlayLayoutSupported({
      overlay_layout: { ...config.overlay_layout, timing: "source" },
    }),
    false,
  );
  assert.equal(hasAdvancedOverlays([{ ...legacy, start: 0 }]), true);
});
