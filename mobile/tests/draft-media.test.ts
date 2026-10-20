import test from "node:test";
import assert from "node:assert/strict";
import {
  clearDraftMedia,
  isRetainedDraftMedia,
  localPlaybackSource,
  rememberLocalMedia,
  retainDraftMedia,
} from "../src/lib/local-media.ts";
test("shared guest soundtrack remains playable until its final draft reference clears", async () => {
  const a = "blob:ziipa-a",
    b = "blob:ziipa-b";
  let freedA = 0,
    freedB = 0;
  rememberLocalMedia(a);
  rememberLocalMedia(b);
  retainDraftMedia("draft-a", a, async () => {
    freedA++;
  });
  retainDraftMedia("draft-b", a);
  retainDraftMedia("draft-a", b, async () => {
    freedB++;
  });
  assert.equal(isRetainedDraftMedia(a), true);
  assert.deepEqual(localPlaybackSource(a, true), { uri: a });
  assert.equal(freedA, 0);
  clearDraftMedia();
  await Promise.resolve();
  assert.equal(freedA, 1);
  assert.equal(freedB, 1);
  assert.equal(localPlaybackSource(a, true), null);
  clearDraftMedia();
  assert.equal(freedA, 1);
});
test("remote metadata cannot retain or authorize a device URI", () => {
  assert.throws(() =>
    retainDraftMedia("remote", "file:///private/never-selected.wav"),
  );
  assert.equal(
    localPlaybackSource("file:///private/never-selected.wav", true),
    null,
  );
});
