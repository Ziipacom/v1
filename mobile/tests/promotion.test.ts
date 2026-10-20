import test from "node:test";
import assert from "node:assert/strict";
import {
  marketingTools,
  organicPromotionStatus,
  promotionProject,
  promotionSources,
} from "../src/lib/promotion.ts";
import type {
  CampaignConnection,
  CampaignProvider,
} from "../src/lib/campaign-types.ts";
import type { Item } from "../src/lib/types.ts";
const item: Item = {
  id: "e6584eac-ff76-4097-ac91-934247630329",
  media_id: "9c6fea43-3154-4dd2-a5a2-968e09e0e70b",
  title: "My video",
  creator: "Creator",
  creator_id: 4,
  description: "",
  category: "video",
  tags: [],
  city: "",
  cover: "",
  media_url: null,
  content_type: "video/mp4",
  visibility: "draft",
  demo: false,
  label: "Draft",
};
const provider: CampaignProvider = {
  provider: "youtube",
  name: "YouTube",
  configured: true,
  publish_ready: true,
  publish_implemented: true,
  requirements: [],
  detail: "",
};
const connection: CampaignConnection = {
  provider: "youtube",
  status: "authorized",
  targets: [{ id: "channel", name: "Channel", kind: "channel" }],
  selected_target_id: "channel",
  can_publish: true,
};
test("promotion sources exclude demos, hidden content, other owners and unsupported source media", () => {
  assert.deepEqual(
    promotionSources(
      [
        item,
        { ...item, id: "sample", demo: true },
        { ...item, visibility: "hidden" },
        { ...item, creator_id: 8 },
        { ...item, content_type: "audio/wav" },
      ],
      4,
    ),
    [item],
  );
  assert.deepEqual(promotionSources([item]), []);
});
test("organic readiness needs current implemented provider and exact authorized destination", () => {
  assert.equal(organicPromotionStatus(provider, connection).ready, true);
  assert.equal(organicPromotionStatus(undefined, connection).ready, false);
  assert.equal(
    organicPromotionStatus({ ...provider, publish_ready: false }, connection)
      .ready,
    false,
  );
  assert.equal(
    organicPromotionStatus(provider, {
      ...connection,
      status: "reauthorization_required",
    }).ready,
    false,
  );
  assert.equal(
    organicPromotionStatus(provider, {
      ...connection,
      selected_target_id: null,
    }).ready,
    false,
  );
  assert.equal(
    organicPromotionStatus(provider, {
      ...connection,
      selected_target_id: "unlisted",
    }).ready,
    false,
  );
});
test("saved promotion plan is only a private Media OS project, never a send/spend grant", () => {
  const project = promotionProject(
    {
      name: "Launch",
      objective: "Awareness",
      audience: "Consented community",
      message: "Watch our new film",
      tools: marketingTools.map((tool) => tool.id),
    },
    item,
  );
  assert.deepEqual(project.asset_ids, [item.id]);
  assert.ok(
    project.description.includes(
      "not a publishing, send or spend authorization",
    ),
  );
  assert.equal((project.description.match(/NOT INTEGRATED/g) || []).length, 4);
  assert.equal(project.description.length <= 3000, true);
  assert.deepEqual(Object.keys(project).sort(), [
    "asset_ids",
    "description",
    "name",
    "status",
  ]);
});
test("promotion brief validates bounded plain data without accepting arbitrary tools or hidden assets", () => {
  const brief = {
    name: "Launch",
    objective: "Release a creation",
    audience: "",
    message: "",
    tools: [],
  };
  assert.throws(() => promotionProject({ ...brief, tools: ["send_email"] }));
  assert.throws(() => promotionProject({ ...brief, name: "x".repeat(121) }));
  assert.throws(() =>
    promotionProject(brief, { ...item, visibility: "hidden" }),
  );
});
