import test from "node:test";
import assert from "node:assert/strict";
import { featuredGalleryPlayback } from "../src/lib/featured-gallery-playback.ts";

const active = {
  count: 3,
  hasCurrent: true,
  ready: true,
  autoplay: true,
  reducedMotion: false,
  focused: true,
  foreground: true,
  hovered: false,
  focusWithin: false,
  mediaPaused: false,
  explicitPlayback: false,
  rotationEnabled: true,
};

test("manual preview works with autoplay off or reduced motion without starting rotation", () => {
  for (const preference of [{ autoplay: false }, { reducedMotion: true }]) {
    const automatic = featuredGalleryPlayback({ ...active, ...preference });
    assert.equal(automatic.playbackPaused, true);
    assert.equal(automatic.rotationAllowed, false);
    const manual = featuredGalleryPlayback({ ...active, ...preference, explicitPlayback: true });
    assert.equal(manual.playbackPaused, false);
    assert.equal(manual.rotationAllowed, false);
  }
});

test("hover and keyboard focus suspend rotation without trapping explicit playback", () => {
  for (const interaction of [{ hovered: true }, { focusWithin: true }]) {
    const state = featuredGalleryPlayback({ ...active, ...interaction, explicitPlayback: true });
    assert.equal(state.playbackPaused, false);
    assert.equal(state.rotationAllowed, false);
  }
  assert.equal(featuredGalleryPlayback(active).rotationAllowed, true);
});

test("explicit play cannot override background, route blur, loading or pause intent", () => {
  for (const suspended of [{ foreground: false }, { focused: false }, { ready: false }, { hasCurrent: false }]) {
    const state = featuredGalleryPlayback({ ...active, ...suspended, explicitPlayback: true });
    assert.equal(state.playbackPaused, true);
    assert.equal(state.rotationAllowed, false);
  }
  assert.equal(featuredGalleryPlayback({ ...active, mediaPaused: true, explicitPlayback: true }).playbackPaused, true);
});

test("rotation and playback have independent user controls and one item never rotates", () => {
  const still = featuredGalleryPlayback({ ...active, rotationEnabled: false, explicitPlayback: true });
  assert.equal(still.playbackPaused, false);
  assert.equal(still.rotationAllowed, false);
  assert.equal(featuredGalleryPlayback({ ...active, count: 1 }).rotationAllowed, false);
});
