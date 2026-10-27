import test from "node:test";
import assert from "node:assert/strict";
import {
  clearDraftMedia,
  isRetainedDraftMedia,
  localPlaybackSource,
  rememberLocalMedia,
  retainDraftMedia,
  releaseDraftMedia,
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

test("saving a detached soundtrack releases only its final saved draft lease", async () => {
  const uri = "blob:removed-audio";
  let disposed = 0;
  rememberLocalMedia(uri);
  retainDraftMedia("draft-one:soundtrack", uri, async () => {
    disposed++;
  });
  retainDraftMedia("draft-two:soundtrack", uri);
  releaseDraftMedia("draft-one:soundtrack");
  await Promise.resolve();
  assert.equal(disposed, 0);
  assert.equal(isRetainedDraftMedia(uri), true);
  releaseDraftMedia("draft-two:soundtrack");
  await Promise.resolve();
  assert.equal(disposed, 1);
  assert.equal(localPlaybackSource(uri, true), null);
  releaseDraftMedia("draft-two:soundtrack");
  clearDraftMedia();
  await Promise.resolve();
  assert.equal(disposed, 1);
});
