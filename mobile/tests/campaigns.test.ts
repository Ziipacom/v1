import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  campaignApprovalKey,
  campaignSourceEditKey,
  campaignCanApprove,
  campaignHasPublishedRendition,
  campaignArtifact,
  campaignRenditions,
  campaignNeedsPolling,
  campaignPreviewItem,
  campaignPublishingSource,
  destinationKey,
  parseCampaignSegments,
  campaignSegmentsText,
  type Campaign,
  type CampaignRendition,
} from "../src/lib/campaign-types.ts";
import type { Item } from "../src/lib/types.ts";
import type { MediaExport } from "../src/lib/share-types.ts";

const campaign = {
  id: "41343b70-df47-45c4-8731-23852ae4b03c",
  item_id: "41957e03-f1fd-45d5-bf71-dd91108ca640",
  name: "My campaign",
  title: "Reviewed copy",
  description: "Reviewed description",
  revision: 3,
  status: "review",
  schedule_at: "2026-10-20T18:00:00Z",
  review_hash: "a".repeat(64),
  approved_at: null,
  artifact: {
    media_id: "63b6e1a8-fb66-45eb-ae48-a498617e7221",
    render_id: "25bbb4c1-1e7a-4ce8-8ffa-743f1035c9bd",
    output_sha256: "b".repeat(64),
    input_fingerprint: "c".repeat(64),
  },
  destinations: [
    {
      provider: "youtube",
      target_id: "my-channel",
      privacy: "private",
      made_for_kids: false,
    },
  ],
} as Campaign;
const approval = () => ({
  key: campaignApprovalKey(campaign),
  previewed: true,
  ziipa: true,
  destinations: campaign.destinations.map(destinationKey),
});

test("approval requires a reviewed render and explicit consent to Ziipa and every destination", () => {
  assert.equal(campaignCanApprove(campaign, approval(), false), true);
  assert.equal(
    campaignCanApprove(campaign, { ...approval(), previewed: false }, false),
    false,
  );
  assert.equal(
    campaignCanApprove(campaign, { ...approval(), ziipa: false }, false),
    false,
  );
  assert.equal(
    campaignCanApprove(campaign, { ...approval(), destinations: [] }, false),
    false,
  );
  assert.equal(campaignCanApprove(campaign, approval(), true), false);
  for (const patch of [
    { artifact: null },
    { review_hash: null },
    { schedule_at: null },
    { approved_at: "2026-10-20T17:00:00Z" },
    { status: "completed" },
    { status: "cancelled" },
    { status: "paused" },
    { status: "scheduled" },
    { status: "blocked" },
    { status: "partial" },
  ])
    assert.equal(
      campaignCanApprove({ ...campaign, ...patch }, approval(), false),
      false,
    );
  const ziipaOnly = { ...campaign, destinations: [] };
  assert.equal(
    campaignCanApprove(
      ziipaOnly,
      { ...approval(), key: campaignApprovalKey(ziipaOnly), destinations: [] },
      false,
    ),
    true,
  );
});

test("source, revision, artifact, target, privacy, copy and schedule changes invalidate consent", () => {
  const mutations = [
    { revision: 4 },
    { item_id: "different-source" },
    { title: "Changed title" },
    { description: "Changed description" },
    { review_hash: "d".repeat(64) },
    { schedule_at: "2026-10-21T18:00:00Z" },
    { artifact: { ...campaign.artifact!, output_sha256: "e".repeat(64) } },
    {
      destinations: [
        { ...campaign.destinations[0], target_id: "other-channel" },
      ],
    },
    {
      destinations: [
        { ...campaign.destinations[0], privacy: "public" as const },
      ],
    },
    { destinations: [{ ...campaign.destinations[0], made_for_kids: true }] },
  ];
  for (const patch of mutations)
    assert.equal(
      campaignCanApprove({ ...campaign, ...patch }, approval(), false),
      false,
    );
});

test("preview verifies exact rendered bytes and uses only authenticated Ziipa playback", () => {
  const source = {
    id: campaign.item_id,
    title: "Original",
    demo: false,
    trim_start: 4,
    trim_end: 12,
    captions: [{ start: 4, end: 6, text: "Original caption" }],
    overlays: [{ id: "1", text: "overlay", theme: "light", position: "top" }],
    timeline: { version: 1, clips: [{ id: "cut", start: 4, end: 8, speed: 1 }] },
    visual_effect: "mono",
  } as Item;
  const info = {
    ...campaign.artifact,
    rendered: true,
    content_type: "video/mp4",
    size: 1234,
    url: "https://storage.example/leased-video?secret=not-retained",
  } as MediaExport;
  const preview = campaignPreviewItem(campaign, source, info);
  assert.equal(
    preview.media_url,
    `/api/creator/media/${campaign.artifact!.media_id}`,
  );
  assert.deepEqual(preview.captions, []);
  assert.deepEqual(preview.overlays, []);
  assert.equal(preview.trim_start, 0);
  assert.equal(preview.trim_end, null);
  assert.equal(preview.timeline, null);
  assert.equal(preview.visual_effect, "none");
  assert.equal(source.timeline?.clips[0].start, 4);
  assert.equal(source.visual_effect, "mono");
  assert.equal(preview.title, campaign.title);
  for (const patch of [
    { rendered: false },
    { media_id: "../other" },
    { render_id: "other-render" },
    { output_sha256: "f".repeat(64) },
    { input_fingerprint: "d".repeat(64) },
    { content_type: "text/html" },
    { size: 26 * 1024 * 1024 },
  ])
    assert.throws(() =>
      campaignPreviewItem(campaign, source, { ...info, ...patch }),
    );
  assert.throws(() =>
    campaignPreviewItem(campaign, { ...source, id: "other-source" }, info),
  );
  assert.throws(() =>
    campaignPreviewItem(campaign, { ...source, demo: true }, info),
  );
});

test("local source edit scope changes with cuts and effects but not rotating playback URLs", () => {
  const source = {
    id: campaign.item_id,
    creator_id: 1,
    media_id: "original",
    visibility: "draft",
    content_type: "video/mp4",
    timeline: { version: 1, clips: [{ id: "cut", start: 2, end: 5, speed: 1 }] },
    visual_effect: "warm",
  } as Item;
  const key = campaignSourceEditKey(source);
  assert.equal(key, campaignSourceEditKey({ ...source, media_url: "https://storage.example/new-lease" }));
  for (const patch of [
    { timeline: null },
    { timeline: { version: 1, clips: [{ id: "cut", start: 3, end: 5, speed: 1 }] } },
    { timeline: { version: 1, clips: [{ id: "cut", start: 2, end: 5, speed: 2 }] } },
    { visual_effect: "cool" },
    { media_id: "replacement" },
    { visibility: "hidden" },
    { captions: [{ start: 0, end: 1, text: "Changed" }] },
    { overlays: [{ id: "new", text: "Changed", theme: "dark", position: "top" }] },
  ] as Partial<Item>[])
    assert.notEqual(key, campaignSourceEditKey({ ...source, ...patch }));
  assert.notEqual(key, campaignSourceEditKey());
  assert.equal(campaignSourceEditKey({ id: "legacy" } as Item),
    campaignSourceEditKey({ id: "legacy", timeline: null, visual_effect: "none" } as Item));
});

test("manual transcript cues preserve text and reject ambiguous or out-of-bounds timing", () => {
  const cues = parseCampaignSegments(
    "0 --> 2.5 | First line\n2.5 --> 5 | Words | with punctuation",
  );
  assert.deepEqual(parseCampaignSegments(campaignSegmentsText(cues)), cues);
  assert.deepEqual(parseCampaignSegments(" \n"), []);
  for (const value of [
    "caption without timestamps",
    "3 --> 2 | Backwards",
    "0 --> 0 | Empty",
    "-1 --> 2 | Negative",
    "0 --> Infinity | Infinite",
    "0 --> 86401 | Too long",
    `0 --> 1 | ${"a".repeat(251)}`,
  ])
    assert.throws(() => parseCampaignSegments(value));
});

test("provider handoff uses the published rendition without rendering baked effects a second time", () => {
  assert.deepEqual(campaignPublishingSource(campaign), {
    itemId: campaign.item_id,
    renderId: campaign.artifact!.render_id,
  });
  const renderedPost = {
    ...campaign,
    published_item_id: "9940a9e9-6ef2-4e1b-bf4f-60ce51bb26ce",
  };
  assert.deepEqual(campaignPublishingSource(renderedPost), {
    itemId: renderedPost.published_item_id,
  });
  assert.deepEqual(campaignPublishingSource(null, campaign.item_id), {
    itemId: campaign.item_id,
    renderId: undefined,
  });
});

test("a published rendition stays immutable across pause and blocked delivery states", () => {
  assert.equal(campaignHasPublishedRendition(null), false);
  assert.equal(campaignHasPublishedRendition(campaign), false);
  for (const status of [
    "completed",
    "partial",
    "paused",
    "blocked",
    "needs_review",
  ]) {
    assert.equal(
      campaignHasPublishedRendition({
        ...campaign,
        status,
        published_item_id: "published-post",
      }),
      true,
    );
    assert.equal(
      campaignHasPublishedRendition({
        ...campaign,
        status,
        ziipa_published_at: "2026-10-20T18:00:00Z",
      }),
      true,
    );
  }
});

test("polling follows processing and delivery but does not keep retrying blocked or uncertain work", () => {
  for (const status of ["queued", "preparing", "scheduled", "delivering"])
    assert.equal(campaignNeedsPolling({ ...campaign, status }), true);
  for (const status of [
    "draft",
    "review",
    "paused",
    "cancelled",
    "blocked",
    "partial",
    "completed",
    "uncertain",
  ])
    assert.equal(campaignNeedsPolling({ ...campaign, status }), false);
});

test("every selected format needs its own actual artifact and playback review", () => {
  const portrait = {
    ...campaign.artifact!,
    media_id: "e733ac43-9ca1-4b11-98d5-e2f477059cfe",
    render_id: "44334c91-2e92-4b58-8ca5-d3464563e19b",
    rendition: "portrait" as const,
    output_width: 720,
    output_height: 1280,
  };
  const multi: Campaign = {
    ...campaign,
    renditions: ["original", "portrait"],
    ziipa_rendition: "original",
    artifacts: { original: campaign.artifact!, portrait },
    render_jobs: {
      original: campaign.artifact!.render_id,
      portrait: portrait.render_id,
    },
  };
  const approvals = {
    ...approval(),
    key: campaignApprovalKey(multi),
    reviewedRenditions: ["original"] as CampaignRendition[],
  };
  assert.equal(campaignCanApprove(multi, approvals, false), false);
  assert.equal(
    campaignCanApprove(
      multi,
      { ...approvals, reviewedRenditions: ["original", "portrait"] },
      false,
    ),
    true,
  );
  assert.equal(
    campaignCanApprove(
      { ...multi, artifacts: { original: campaign.artifact! } },
      { ...approvals, reviewedRenditions: ["original", "portrait"] },
      false,
    ),
    false,
  );
  assert.equal(
    campaignCanApprove(
      { ...multi, ziipa_rendition: "portrait" },
      { ...approvals, reviewedRenditions: ["original", "portrait"] },
      false,
    ),
    false,
  );
  assert.deepEqual(campaignRenditions(campaign), ["original"]);
  assert.equal(
    campaignArtifact(multi, "portrait")?.media_id,
    portrait.media_id,
  );
  const source = { id: campaign.item_id, demo: false } as Item;
  const exported = {
    ...portrait,
    content_type: "video/mp4",
    rendered: true,
    size: 1234,
    url: "/not-used",
  };
  assert.equal(
    campaignPreviewItem(multi, source, exported, "portrait").media_id,
    portrait.media_id,
  );
  assert.throws(() =>
    campaignPreviewItem(
      multi,
      source,
      { ...exported, rendition: "square" } as MediaExport,
      "portrait",
    ),
  );
  assert.throws(() =>
    campaignPreviewItem(
      multi,
      source,
      { ...exported, output_width: 1280 } as MediaExport,
      "portrait",
    ),
  );
});

test("provider handoff follows its private format derivative, not the public Ziipa rendition", () => {
  const multi: Campaign = {
    ...campaign,
    ziipa_rendition: "original",
    published_item_id: "public-original",
    published_items: {
      original: "public-original",
      portrait: "private-portrait",
    },
  };
  assert.deepEqual(campaignPublishingSource(multi, undefined, "portrait"), {
    itemId: "private-portrait",
  });
  assert.deepEqual(campaignPublishingSource(multi), {
    itemId: "public-original",
  });
});
