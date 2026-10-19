import test from "node:test";
import assert from "node:assert/strict";
import {
  recordingAutomationInput,
  recordingClipPreview,
  recordingNeedsPolling,
  type RecordingAutomation,
  type RecordingClip,
  type RecordingReceipt,
} from "../src/lib/recording-types.ts";
import type { Item } from "../src/lib/types.ts";
import type { RenderJob } from "../src/lib/render-types.ts";
import type { MediaExport } from "../src/lib/share-types.ts";
const policy = { revision: 0 } as RecordingAutomation;
const fields = {
  enabled: true,
  consent: true,
  count: "3",
  seconds: "30",
  rendition: "portrait" as const,
};
test("private excerpt automation requires recording rights consent, bounded lengths and optimistic revision", () => {
  assert.throws(() => recordingAutomationInput(policy, fields, false));
  assert.throws(() =>
    recordingAutomationInput(policy, { ...fields, consent: false }, true),
  );
  for (const invalid of [
    { count: "4" },
    { seconds: "14" },
    { seconds: "91" },
    { seconds: "3.5" },
  ])
    assert.throws(() =>
      recordingAutomationInput(policy, { ...fields, ...invalid }, true),
    );
  const result = recordingAutomationInput(policy, fields, true);
  assert.deepEqual(result, {
    revision: 0,
    enabled: true,
    consent: true,
    clip_count: 3,
    clip_seconds: 30,
    rendition: "portrait",
  });
  assert.equal("publish" in result, false);
  assert.equal("start" in result, false);
});
test("clip preview binds ready render to its owned source, clears baked effects and ignores signed URLs", () => {
  const item = {
    id: "item",
    demo: false,
    visibility: "draft",
    trim_start: 30,
    trim_end: 60,
    captions: [{ start: 1, end: 2, text: "Caption" }],
    overlays: [{ text: "Overlay" }],
    soundtrack: { media_id: "sound" },
  } as Item;
  const clip = {
    item_id: "item",
    render_id: "render",
    status: "ready",
  } as RecordingClip;
  const job = {
    id: "render",
    item_id: "item",
    status: "ready",
    output_media_id: "42ac7cb8-c30b-4465-8184-9a790830c15e",
    input_fingerprint: "a".repeat(64),
  } as RenderJob;
  const info = {
    media_id: job.output_media_id,
    render_id: job.id,
    rendered: true,
    content_type: "video/mp4",
    input_fingerprint: job.input_fingerprint,
    output_sha256: "b".repeat(64),
    size: 1000,
    url: "https://signed-storage.example/private?secret=lease",
  } as MediaExport;
  const preview = recordingClipPreview(item, clip, job, info);
  assert.equal(preview.media_url, `/api/creator/media/${job.output_media_id}`);
  assert.equal(preview.trim_start, 0);
  assert.equal(preview.trim_end, null);
  assert.deepEqual(preview.captions, []);
  assert.deepEqual(preview.overlays, []);
  assert.equal(preview.soundtrack, null);
  assert.equal(item.trim_start, 30);
  assert.throws(() =>
    recordingClipPreview(item, clip, { ...job, status: "stale" }, info),
  );
  assert.throws(() =>
    recordingClipPreview(item, { ...clip, item_id: "someone-else" }, job, info),
  );
  assert.throws(() =>
    recordingClipPreview(item, clip, job, {
      ...info,
      render_id: "replacement",
    }),
  );
  assert.throws(() =>
    recordingClipPreview(item, clip, job, { ...info, size: 100 * 1024 * 1024 }),
  );
});
test("recording polling follows pending actual jobs and stops at blocked or final receipts", () => {
  const receipt = { status: "ready", clips: [] } as unknown as RecordingReceipt;
  assert.equal(recordingNeedsPolling([receipt]), false);
  assert.equal(
    recordingNeedsPolling([{ ...receipt, status: "processing" }]),
    true,
  );
  assert.equal(
    recordingNeedsPolling([
      { ...receipt, clips: [{ status: "queued" } as RecordingClip] },
    ]),
    true,
  );
  assert.equal(
    recordingNeedsPolling([
      {
        ...receipt,
        status: "blocked",
        clips: [{ status: "failed" } as RecordingClip],
      },
    ]),
    false,
  );
});
