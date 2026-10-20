import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceMintItem,
  audioCreationSource,
} from "../src/lib/editor-source.ts";
import type { Item } from "../src/lib/types.ts";

const owned: Item = {
  id: "a4f4e229-bd42-4b00-91d4-ad5baed72058",
  media_id: "c735cb19-5784-4a39-817b-8e45ad429aaa",
  creator_id: 7,
  creator: "Creator",
  title: "Private source",
  category: "music",
  description: "",
  tags: [],
  city: "",
  cover: "",
  media_url: null,
  visibility: "draft",
  demo: false,
  label: "Draft",
};
test("source mint handoff permits owned saved private media without publication", () => {
  assert.equal(sourceMintItem(owned, 7, false), owned);
  assert.equal(
    sourceMintItem({ ...owned, visibility: "published" }, 7, false)?.media_id,
    owned.media_id,
  );
});
test("source mint handoff rejects dirty, hidden, sample, unowned and unsaved media", () => {
  assert.equal(sourceMintItem(owned, 7, true), null);
  assert.equal(
    sourceMintItem({ ...owned, visibility: "hidden" }, 7, false),
    null,
  );
  assert.equal(sourceMintItem({ ...owned, demo: true }, 7, false), null);
  assert.equal(sourceMintItem(owned, 8, false), null);
  assert.equal(sourceMintItem({ ...owned, media_id: null }, 7, false), null);
  assert.equal(sourceMintItem({ ...owned, id: "local-draft" }, 7, false), null);
});
test("no-upload audio source keeps the generated URI and gives it a safe title/file name", () => {
  const source = audioCreationSource(
    {
      uri: "blob:generated",
      name: "music.wav",
      mimeType: "audio/wav",
      size: 529244,
    },
    "Warm / Bell\n",
  );
  assert.equal(source.file.uri, "blob:generated");
  assert.equal(source.file.name, "Warm-Bell.wav");
  assert.equal(source.title, "Warm / Bell");
  assert.throws(() =>
    audioCreationSource({ ...source.file, mimeType: "video/mp4" }, "No"),
  );
  assert.throws(() =>
    audioCreationSource({ ...source.file, size: 1323045 }, "No"),
  );
});
