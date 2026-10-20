import assert from "node:assert/strict";
import test from "node:test";
import { creatorConnectionLabel, creatorLibrary, filterCreatorLibrary } from "../src/lib/desktop-creator.ts";
import type { Bootstrap, Item } from "../src/lib/types.ts";

const item = (id: string, changes: Partial<Item> = {}): Item => ({
  id, title: id, description: "An original clip", category: "video", creator: "Shared display name",
  tags: ["travel"], city: "", cover: "", media_url: null, demo: false, label: "Video", ...changes,
});
const data = (drafts: Item[], items: Item[], saved: string[] = []): Pick<Bootstrap, "drafts" | "items" | "preferences"> => ({
  drafts, items, preferences: { saved, liked: [], muted_words: [], blocked_creators: [], blocked_user_ids: [], show_demos: false },
});

test("personal library deduplicates private owner records without claiming other creators", () => {
  const entries = creatorLibrary(data(
    [item("owned", { creator_id: 7, visibility: "draft" })],
    [item("owned", { visibility: "published" }), item("saved", { creator_id: 9, visibility: "published" }), item("other", { creator_id: 9 })],
    ["owned", "saved"],
  ), 7);
  assert.equal(entries.length, 2);
  assert.equal(entries.find(e => e.item.id === "owned")?.item.visibility, "draft");
  assert.equal(entries.find(e => e.item.id === "saved")?.owned, false);
  assert.equal(entries.some(e => e.item.id === "other"), false);
});

test("public drafts/hidden entries and mismatched owner IDs never become editable library records", () => {
  const entries = creatorLibrary(data(
    [item("foreign", { creator_id: 9 })],
    [item("hidden", { visibility: "hidden" }), item("draft", { visibility: "draft" }), item("sample", { demo: true })],
    ["hidden", "draft", "sample"],
  ), 7);
  assert.deepEqual(entries, []);
  assert.deepEqual(creatorLibrary(data([item("private")], []), null), []);
});

test("real own published records retain ownership; sample records are never counted for signed-in users", () => {
  const entries = creatorLibrary(data([item("sample", { demo: true })], [item("mine", { creator_id: 7 })]), 7);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.owned, true);
  assert.equal(entries[0]?.item.visibility, "published");
});

test("library filters search/category/status together without altering shared data", () => {
  const original = data([item("Travel film", { visibility: "draft" }), item("Music", { category: "music", visibility: "published" })], []);
  const before = JSON.stringify(original);
  const entries = creatorLibrary(original, 7);
  assert.equal(filterCreatorLibrary(entries, " TRAVEL ", "music", "draft").length, 1);
  assert.equal(filterCreatorLibrary(entries, "", "all", "published").length, 1);
  assert.equal(filterCreatorLibrary(entries, "", "all", "saved").length, 0);
  assert.equal(JSON.stringify(original), before);
});

test("connection labels distinguish saved links and account authorization from publishing readiness", () => {
  const base = { provider: "twitch" as const, name: "Twitch", capability: "Channel", handle: "", configured: false };
  assert.equal(creatorConnectionLabel({ ...base, status: "linked" }), "Link saved · authorize to publish");
  assert.equal(creatorConnectionLabel({ ...base, status: "connected" }), "Authorized · provider setup needed");
  assert.equal(creatorConnectionLabel({ ...base, configured: true, status: "connected", can_publish: true }), "Authorized · review before posting");
});
