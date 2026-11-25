import assert from "node:assert/strict";
import test from "node:test";
import {
  appliedRemix,
  remixCreate,
  remixReceipt,
  remixSnapshot,
  type RemixSnapshot,
} from "../src/lib/remix.ts";
import type { Item } from "../src/lib/types.ts";

const source = "11111111-1111-4111-8111-111111111111",
  media = "22222222-2222-4222-8222-222222222222",
  request = "33333333-3333-4333-8333-333333333333",
  child = "44444444-4444-4444-8444-444444444444",
  job = "55555555-5555-4555-8555-555555555555";
const snapshot = (): RemixSnapshot => ({
  available: true,
  allowed_modes: ["stitch", "split_screen", "use_sound"],
  policy: null,
  attribution: null,
  children: [],
});
const input = () => ({
  request_id: request,
  mode: "stitch" as const,
  source_start: "0",
  source_seconds: "5",
  response_media_id: media,
  title: "My response",
  rights_confirmed: true,
});
test("remix snapshot retains only declared permitted modes and privacy-safe credits", () => {
  assert.deepEqual(remixSnapshot(snapshot()), snapshot());
  const credit = { id: source, title: "Original", creator: "Creator" };
  assert.deepEqual(
    remixSnapshot({
      ...snapshot(),
      attribution: { parent: credit, root: null },
    }).attribution,
    { parent: credit, root: null },
  );
  for (const patch of [
    { available: "true" },
    { allowed_modes: ["copy_all"] },
    { allowed_modes: ["stitch", "stitch"] },
    { policy: { revision: -1, audience: "everyone", modes: ["stitch"] } },
    {
      attribution: {
        parent: { ...credit, id: "https://evil.test" },
        root: null,
      },
    },
    { children: [null] },
  ])
    assert.throws(() => remixSnapshot({ ...snapshot(), ...patch }));
});
test("rights and matching worker availability are required before constructing a remix request", () => {
  assert.equal(remixCreate(input(), snapshot()).rights_confirmed, true);
  assert.throws(
    () => remixCreate({ ...input(), rights_confirmed: false }, snapshot()),
    /rights/,
  );
  assert.throws(
    () => remixCreate(input(), { ...snapshot(), available: false }),
    /not available/,
  );
  assert.throws(
    () => remixCreate(input(), { ...snapshot(), allowed_modes: ["use_sound"] }),
    /not available/,
  );
  for (const patch of [
    { request_id: "not-id" },
    { response_media_id: "file:///private" },
    { title: " " },
    { title: "x".repeat(141) },
  ])
    assert.throws(() => remixCreate({ ...input(), ...patch }, snapshot()));
});
test("stitch is restricted to 1–5 seconds and all ranges stay inside the published 90-second window", () => {
  assert.equal(
    remixCreate(
      { ...input(), source_start: "85", source_seconds: "5" },
      snapshot(),
    ).source_start,
    85,
  );
  for (const patch of [
    { source_seconds: ".2" },
    { source_seconds: "5.001" },
    { source_start: "86" },
    { source_start: "-1" },
    { source_start: "Infinity" },
    { source_seconds: "NaN" },
    { source_start: "" },
  ])
    assert.throws(() => remixCreate({ ...input(), ...patch }, snapshot()));
  for (const mode of ["split_screen", "use_sound"] as const) {
    assert.equal(
      remixCreate(
        { ...input(), mode, source_start: "89.8", source_seconds: ".2" },
        snapshot(),
      ).source_seconds,
      0.2,
    );
    assert.equal(
      remixCreate(
        { ...input(), mode, source_start: "60", source_seconds: "30" },
        snapshot(),
      ).source_seconds,
      30,
    );
    assert.throws(() =>
      remixCreate({ ...input(), mode, source_seconds: "30.01" }, snapshot()),
    );
  }
});
test("only actual declared receipts for the expected private project can update status", () => {
  for (const status of [
    "queued",
    "processing",
    "ready",
    "failed",
    "stale",
    "cancelled",
    "applied",
  ])
    assert.equal(
      remixReceipt(
        { item_id: child, job_id: job, status, detail: "Status" },
        child,
      ).status,
      status,
    );
  assert.throws(() =>
    remixReceipt(
      { item_id: child, job_id: job, status: "published", detail: "Status" },
      child,
    ),
  );
  assert.throws(() =>
    remixReceipt(
      { item_id: source, job_id: job, status: "ready", detail: "Status" },
      child,
    ),
  );
});
test("applying a remix requires the same source attribution and the signed-in owner's private draft", () => {
  const receipt = remixReceipt({
    item_id: child,
    job_id: job,
    status: "ready",
    detail: "Ready",
  });
  const item = {
    id: child,
    creator_id: 7,
    visibility: "draft",
    media_id: media,
    remix_of: source,
    title: "My remix",
    tags: [],
  } as unknown as Item;
  assert.equal(appliedRemix(item, receipt, 7, source), item);
  for (const patch of [
    { id: source },
    { creator_id: 8 },
    { visibility: "published" },
    { media_id: null },
    { remix_of: null },
  ])
    assert.throws(() =>
      appliedRemix({ ...item, ...patch }, receipt, 7, source),
    );
});
