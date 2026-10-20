import type { CampaignConnection, CampaignProvider } from "./campaign-types";
import type { Item, SocialProvider } from "./types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const marketingTools = [
  {
    id: "mailchimp",
    name: "Mailchimp email",
    kind: "Email marketing",
    requirements:
      "A dedicated Marketing API connector, account authorization, a consented audience, unsubscribe/suppression handling and a reviewed send are required.",
    docs: "https://mailchimp.com/developer/marketing/guides/access-user-data-oauth-2/",
  },
  {
    id: "meta_ads",
    name: "Meta Ads",
    kind: "Paid Facebook / Instagram",
    requirements:
      "A separate Marketing API connector, eligible ad-account authorization, creative review and explicit budget/spend approval are required. A connected Page does not authorize advertising.",
    docs: "https://developers.facebook.com/docs/marketing-apis/",
  },
  {
    id: "google_ads",
    name: "Google Ads / YouTube",
    kind: "Paid video promotion",
    requirements:
      "A Google Ads connector, developer token, Ads authorization and customer selection, plus reviewed creative and an explicit budget, are required. YouTube upload access does not authorize ads.",
    docs: "https://developers.google.com/google-ads/api/docs/oauth/overview",
  },
  {
    id: "tiktok_ads",
    name: "TikTok Ads",
    kind: "Paid TikTok promotion",
    requirements:
      "A dedicated API for Business connector, advertiser authorization and approved creative/budget are required. Organic TikTok publishing does not authorize paid or Spark Ads.",
    docs: "https://business-api.tiktok.com/portal/docs",
  },
] as const;

export function promotionSources(items: Item[], ownerId?: number): Item[] {
  if (!ownerId) return [];
  return items.filter(
    (item) =>
      !item.demo &&
      item.creator_id === ownerId &&
      uuid.test(item.id) &&
      !!item.media_id &&
      uuid.test(item.media_id) &&
      item.content_type?.startsWith("video/") &&
      ["video", "music", "games"].includes(item.category) &&
      item.visibility !== "hidden",
  );
}

/** Social OAuth grants never imply paid advertising or email permission. */
export function organicPromotionStatus(
  provider?: CampaignProvider,
  connection?: CampaignConnection,
) {
  if (!provider) return { ready: false, label: "Readiness unavailable" };
  if (!provider.publish_implemented)
    return { ready: false, label: "Publishing adapter unavailable" };
  if (!provider.configured || provider.publish_ready !== true)
    return { ready: false, label: "Provider setup required" };
  if (!connection || connection.status !== "authorized")
    return { ready: false, label: "Account authorization needed" };
  if (
    !connection.selected_target_id ||
    connection.can_publish !== true ||
    !connection.targets.some(
      (target) => target.id === connection.selected_target_id,
    )
  )
    return { ready: false, label: "Select and review a destination" };
  return { ready: true, label: "Authorized · review each release" };
}

export type PromotionBrief = {
  name: string;
  objective: string;
  audience: string;
  message: string;
  tools: string[];
};
const objectives = new Set([
  "Awareness",
  "Grow an audience",
  "Release a creation",
  "Marketplace interest",
]);
export function promotionProject(brief: PromotionBrief, source?: Item) {
  const name = brief.name.trim();
  if (!name || name.length > 120)
    throw new Error(
      "Give your promotion brief a name of up to 120 characters.",
    );
  if (!objectives.has(brief.objective))
    throw new Error("Choose a promotion objective.");
  if (brief.audience.trim().length > 400 || brief.message.trim().length > 1000)
    throw new Error(
      "Keep audience notes under 400 characters and the message under 1,000.",
    );
  const selected = [...new Set(brief.tools)];
  if (selected.some((id) => !marketingTools.some((tool) => tool.id === id)))
    throw new Error("Choose a supported setup checklist.");
  if (
    source &&
    (!uuid.test(source.id) || source.demo || source.visibility === "hidden")
  )
    throw new Error("Choose an available owned creation.");
  const description = [
    "PROMOTION BRIEF · private planning project; not a publishing, send or spend authorization.",
    `Objective: ${brief.objective}`,
    `Audience: ${brief.audience.trim() || "To be reviewed"}`,
    `Message: ${brief.message.trim() || "To be reviewed"}`,
    `Creation: ${source?.title || "Choose a creation in the campaign workspace"}`,
    "Organic workflow: connect accounts → prepare versions → review actual exports and destinations → approve and schedule in Campaigns → check receipts.",
    ...selected.map((id) => {
      const tool = marketingTools.find((entry) => entry.id === id)!;
      return `${tool.name} — NOT INTEGRATED: ${tool.requirements}`;
    }),
    "No email is sent, no ad is activated and no budget is authorized by this brief. Paid providers may charge independently; no plan or billing changes are made here.",
  ].join("\n\n");
  if (description.length > 3000)
    throw new Error("Shorten the brief before saving.");
  return {
    name: `Promotion · ${name}`,
    description,
    status: "active",
    asset_ids: source ? [source.id] : [],
  };
}

export const organicProviderNames: Record<SocialProvider, string> = {
  bluesky: "Bluesky",
  facebook: "Facebook Pages",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  twitch: "Twitch",
};
