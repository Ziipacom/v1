import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  applyConfirmedEditorItem,
  createEditorSaveController,
  matchesEditorSubmission,
} from "../src/lib/editor-save.ts";
import type { Bootstrap, Item, ItemInput } from "../src/lib/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("same-turn Save and Publish taps share one in-flight write", async () => {
  const controller = createEditorSaveController();
  const upload = deferred<string>();
  const writes: string[] = [];
  const dependencies = {
    action: "published" as const,
    phase: () => {},
    prepare: () => upload.promise,
    write: async (source: string) => {
      writes.push(source);
      return { id: "acknowledged" };
    },
    confirmed: () => {},
    refresh: async () => {},
    isUnconfirmed: () => false,
  };
  const first = controller.run(dependencies);
  assert.deepEqual(await controller.run({ ...dependencies, action: "draft" }), {
    kind: "busy",
  });
  upload.resolve("owned-media");
  assert.equal((await first).kind, "confirmed");
  assert.deepEqual(writes, ["owned-media"]);
  assert.equal(controller.active, false);
});

test("acknowledged publication stays confirmed when the separate refresh fails", async () => {
  const events: string[] = [];
  const controller = createEditorSaveController();
  const result = await controller.run({
    action: "published",
    phase: (phase) => events.push(phase),
    prepare: async () => "prepared",
    write: async () => {
      events.push("POST acknowledged");
      return "saved-item";
    },
    confirmed: () => events.push("saved receipt visible"),
    refresh: async () => {
      events.push("GET refresh");
      throw new Error("offline");
    },
    isUnconfirmed: () => false,
  });
  assert.equal(result.kind, "confirmed");
  if (result.kind === "confirmed")
    assert.match(result.warnings.join(" "), /saved.*refresh failed/i);
  assert.ok(
    events.indexOf("saved receipt visible") < events.indexOf("GET refresh"),
  );
  assert.equal(
    events.filter((event) => event === "POST acknowledged").length,
    1,
  );
});

test("lost POST acknowledgement blocks replay; read-only confirmation unlocks future edits", async () => {
  const controller = createEditorSaveController();
  let writes = 0;
  const unconfirmed = new Error("connection lost");
  const dependencies = {
    action: "published" as const,
    phase: () => {},
    prepare: async () => "prepared",
    write: async () => {
      writes++;
      throw unconfirmed;
    },
    confirmed: () => assert.fail("No server acknowledgement"),
    refresh: async () =>
      assert.fail("Do not hide uncertainty with an automatic retry"),
    isUnconfirmed: (error: unknown) => error === unconfirmed,
  };
  assert.equal((await controller.run(dependencies)).kind, "unconfirmed");
  assert.deepEqual(await controller.run(dependencies), { kind: "blocked" });
  assert.equal(writes, 1);
  controller.confirmReadOnlyResult();
  assert.equal(controller.unconfirmed, false);
});

test("source upload failure never implies that an item was published", async () => {
  const controller = createEditorSaveController();
  const timeout = new Error("upload timeout");
  const result = await controller.run({
    action: "published",
    phase: () => {},
    prepare: async () => {
      throw timeout;
    },
    write: async () =>
      assert.fail("No item POST before source upload completes"),
    confirmed: () => assert.fail(),
    refresh: async () => {},
    isUnconfirmed: () => true,
  });
  assert.equal(result.kind, "failed");
  assert.equal(controller.unconfirmed, false);
});

test("unconfirmed distribution preserves Ziipa acknowledgement and never repeats network delivery", async () => {
  const controller = createEditorSaveController();
  let deliveryRequests = 0;
  let acknowledgements = 0;
  const result = await controller.run({
    action: "published",
    phase: () => {},
    prepare: async () => ({}),
    write: async () => "saved",
    confirmed: () => {
      acknowledgements++;
    },
    distribute: async () => {
      deliveryRequests++;
      throw new Error("delivery timeout");
    },
    refresh: async () => {},
    isUnconfirmed: () => true,
  });
  assert.equal(result.kind, "confirmed");
  if (result.kind === "confirmed")
    assert.equal(result.distributionUnconfirmed, true);
  assert.equal(acknowledgements, 1);
  assert.equal(deliveryRequests, 1);
});

test("read-only recovery requires owner, media, visibility and full submitted edit", () => {
  const payload = {
    title: "Clip",
    media_id: "source",
    visibility: "published",
    overlays: [{ id: "a", text: "Hi", x: 0.2 }],
    tags: ["music"],
  } as ItemInput;
  const item = { ...payload, id: "item", creator_id: 7, demo: false } as Item;
  assert.equal(matchesEditorSubmission(item, payload, 7), true);
  for (const changed of [
    { creator_id: 8 },
    { demo: true },
    { media_id: "other" },
    { visibility: "draft" },
    { overlays: [{ id: "a", text: "Hi", x: 0.8 }] },
    { tags: [] },
  ])
    assert.equal(
      matchesEditorSubmission({ ...item, ...changed } as Item, payload, 7),
      false,
    );
});

test("acknowledged owner edits appear locally even if refresh is offline; unrelated accounts cannot upsert", () => {
  const original = {
    id: "item",
    creator_id: 7,
    demo: false,
    visibility: "draft",
    title: "Original",
  } as Item;
  const other = {
    id: "other",
    creator_id: 8,
    demo: false,
    visibility: "published",
  } as Item;
  const state = {
    drafts: [original],
    items: [other],
    connections: [],
    distributions: [],
  } as unknown as Bootstrap;
  const published = {
    ...original,
    title: "Acknowledged",
    visibility: "published",
  } as Item;
  const updated = applyConfirmedEditorItem(state, published, 7);
  assert.equal(updated.drafts[0].title, "Acknowledged");
  assert.deepEqual(
    updated.items.map((item) => item.id),
    ["item", "other"],
  );
  assert.equal(state.drafts[0].title, "Original");
  assert.equal(applyConfirmedEditorItem(state, published, 8), state);
  assert.equal(
    applyConfirmedEditorItem(state, { ...published, demo: true }, 7),
    state,
  );
  const privateAgain = applyConfirmedEditorItem(updated, original, 7);
  assert.deepEqual(
    privateAgain.items.map((item) => item.id),
    ["other"],
  );
  assert.equal(
    privateAgain.drafts.filter((item) => item.id === "item").length,
    1,
  );
});
