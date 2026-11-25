import type { CampaignConnection, CampaignProvider } from "./campaign-types";
import type { Item, SocialProvider } from "./types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const marketingTools = [
  {
    id: "mailchimp",
    name: "Mailchimp email",
    kind: "Email marketing",
    docs: "https://mailchimp.com/developer/marketing/guides/access-user-data-oauth-2/",
  },
  {
    id: "meta_ads",
    name: "Meta Ads",
    kind: "Paid Facebook / Instagram",
    docs: "https://developers.facebook.com/docs/marketing-apis/",
  },
  {
    id: "google_ads",
    name: "Google Ads / YouTube",
    kind: "Paid video promotion",
    docs: "https://developers.google.com/google-ads/api/docs/oauth/overview",
  },
  {
    id: "tiktok_ads",
    name: "TikTok Ads",
    kind: "Paid TikTok promotion",
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
  if (!provider?.publish_implemented || !provider.configured || provider.publish_ready !== true)
    return { ready: false, label: "Publishing unavailable" };
  if (!connection || connection.status !== "authorized")
    return { ready: false, label: "Connect your account" };
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
    throw new Error("Choose a supported provider.");
  if (
    source &&
    (!uuid.test(source.id) || source.demo || source.visibility === "hidden")
  )
    throw new Error("Choose an available owned creation.");
  const providers = selected
    .map((id) => marketingTools.find((tool) => tool.id === id)!.name)
    .join(", ");
  const audience = brief.audience.trim();
  const message = brief.message.trim();
  const description = [
    "Private promotion brief",
    `Objective · ${brief.objective}`,
    audience && `Audience · ${audience}`,
    message && `Message · ${message}`,
    source && `Creation · ${source.title}`,
    providers && `Providers · ${providers}`,
  ]
    .filter(Boolean)
    .join("\n\n");
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
