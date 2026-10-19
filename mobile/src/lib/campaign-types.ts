import type { Caption, Item, SocialProvider } from "./types.ts";
import type { MediaExport } from "./share-types.ts";

export type CampaignPrivacy = "private" | "unlisted" | "public";
export type CampaignRendition =
  "original" | "portrait" | "square" | "landscape";
export const campaignFormats: {
  id: CampaignRendition;
  title: string;
  detail: string;
}[] = [
  { id: "original", title: "Original", detail: "Keep source aspect ratio" },
  {
    id: "portrait",
    title: "Portrait · 9:16",
    detail: "720 × 1280 · fit with padding",
  },
  {
    id: "square",
    title: "Square · 1:1",
    detail: "720 × 720 · fit with padding",
  },
  {
    id: "landscape",
    title: "Landscape · 16:9",
    detail: "1280 × 720 · fit with padding",
  },
];
export type CampaignDestination = {
  provider: SocialProvider;
  target_id: string;
  privacy: CampaignPrivacy;
  made_for_kids: boolean;
  rendition?: CampaignRendition;
};
export type CampaignArtifact = {
  media_id: string;
  output_sha256: string;
  render_id: string;
  input_fingerprint: string;
  rendition?: CampaignRendition;
  output_width?: number;
  output_height?: number;
};
export type CampaignDelivery = {
  id: string;
  revision: number;
  provider: string;
  target_id: string;
  privacy: string;
  status: string;
  detail: string;
  publishing_job_id: string | null;
  external_id: string | null;
  external_url: string | null;
  attempts: number;
  rendition?: CampaignRendition;
  published_item_id?: string | null;
};
export type Campaign = {
  id: string;
  item_id: string;
  name: string;
  title: string;
  description: string;
  destinations: CampaignDestination[];
  renditions?: CampaignRendition[];
  ziipa_rendition?: CampaignRendition;
  render_jobs?: Partial<Record<CampaignRendition, string>>;
  artifacts?: Partial<Record<CampaignRendition, CampaignArtifact>>;
  published_items?: Partial<Record<CampaignRendition, string>>;
  schedule_at: string | null;
  rights_confirmed: boolean;
  soundtrack_rights_confirmed: boolean;
  request_transcription: boolean;
  generate_copy: boolean;
  transcription_consent: boolean;
  manual_transcript: string;
  manual_segments: Caption[];
  revision: number;
  status: string;
  detail: string;
  render_job_id: string | null;
  artifact: CampaignArtifact | null;
  review_hash: string | null;
  approved_at: string | null;
  ziipa_published_at?: string | null;
  published_item_id?: string | null;
  transcript: {
    status: string;
    text: string;
    segments: Caption[];
    engine: string | null;
    detail: string;
  };
  transcript_hash?: string | null;
  generated_copy?: {
    status: string;
    title?: string;
    description?: string;
    detail?: string;
    engine?: string;
  } | null;
  deliveries: CampaignDelivery[];
  created_at: string;
  updated_at: string;
};
export type CampaignConfig = {
  enabled?: boolean;
  worker_ready?: boolean;
  can_run?: boolean;
  can_prepare?: boolean;
  background_publishing_ready?: boolean;
  detail?: string;
  requirements?: string[];
  [key: string]: unknown;
};
export type CampaignProvider = {
  provider: SocialProvider;
  name: string;
  configured: boolean;
  publish_ready?: boolean;
  publish_implemented: boolean;
  allowed_privacy?: string[];
  requirements: string[];
  delivery_requirements?: string[];
  detail: string;
};
export type CampaignConnection = {
  provider: SocialProvider;
  status: string;
  targets: { id: string; name: string; kind: string }[];
  selected_target_id: string | null;
  can_publish: boolean;
};
export const campaignRoot = "/api/os/campaigns";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/i;

export function campaignLabel(status: string) {
  return status
    .replace(/_/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
}

export function destinationKey(
  destination: Pick<CampaignDestination, "provider" | "target_id">,
) {
  return `${destination.provider}:${destination.target_id}`;
}

/** A published campaign post already contains its baked rendition. */
export function campaignPublishingSource(
  campaign: Campaign | null,
  sourceId?: string,
  rendition?: CampaignRendition,
) {
  const selected = rendition || campaign?.ziipa_rendition || "original";
  const published =
    campaign?.published_items?.[selected] ||
    (selected === (campaign?.ziipa_rendition || "original")
      ? campaign?.published_item_id
      : null);
  return published
    ? { itemId: published }
    : {
        itemId: campaign?.item_id || sourceId,
        renderId:
          campaign?.render_jobs?.[selected] ||
          campaignArtifact(campaign, selected)?.render_id,
      };
}

export function campaignRenditions(
  campaign: Campaign | null,
): CampaignRendition[] {
  return campaign?.renditions?.length
    ? campaign.renditions
    : [campaign?.ziipa_rendition || "original"];
}

export function campaignArtifact(
  campaign: Campaign | null,
  rendition: CampaignRendition,
) {
  return (
    campaign?.artifacts?.[rendition] ||
    (rendition === (campaign?.ziipa_rendition || "original")
      ? campaign?.artifact
      : null)
  );
}

export function campaignHasPublishedRendition(campaign: Campaign | null) {
  return !!(
    campaign?.published_item_id ||
    campaign?.ziipa_published_at ||
    Object.values(campaign?.published_items || {}).some(Boolean)
  );
}

/** Bind every local approval to exactly the server-reviewed rendition and plan. */
export function campaignApprovalKey(campaign: Campaign) {
  return JSON.stringify([
    campaign.id,
    campaign.revision,
    campaign.item_id,
    campaign.title,
    campaign.description,
    campaign.schedule_at,
    campaign.review_hash,
    campaign.artifact,
    campaign.destinations,
    campaign.renditions,
    campaign.ziipa_rendition,
    campaign.artifacts,
  ]);
}

export function campaignNeedsPolling(campaign: Campaign | null) {
  return (
    !!campaign &&
    [
      "queued",
      "preparing",
      "transcribing",
      "rendering",
      "processing",
      "approved",
      "scheduled",
      "running",
      "publishing",
      "delivering",
    ].includes(campaign.status)
  );
}

export function campaignCanApprove(
  campaign: Campaign,
  approval: {
    key: string;
    previewed: boolean;
    ziipa: boolean;
    destinations: string[];
    reviewedRenditions?: CampaignRendition[];
  },
  dirty: boolean,
) {
  return (
    !dirty &&
    !!campaign.artifact &&
    !!campaign.review_hash &&
    !!campaign.schedule_at &&
    !campaign.approved_at &&
    campaign.status === "review" &&
    approval.key === campaignApprovalKey(campaign) &&
    approval.previewed &&
    campaignRenditions(campaign).every(
      (format) => !!campaignArtifact(campaign, format),
    ) &&
    (!campaign.renditions ||
      campaignRenditions(campaign).every((format) =>
        approval.reviewedRenditions?.includes(format),
      )) &&
    approval.ziipa &&
    campaign.destinations.every((target) =>
      approval.destinations.includes(destinationKey(target)),
    )
  );
}

/** A lease must describe the reviewed output, never an original or another job. */
export function campaignPreviewItem(
  campaign: Campaign,
  source: Item,
  info: MediaExport,
  rendition: CampaignRendition = campaign.ziipa_rendition || "original",
): Item {
  const artifact = campaignArtifact(campaign, rendition);
  const exported = info as MediaExport & {
    rendition?: CampaignRendition;
    output_width?: number;
    output_height?: number;
  };
  const canvas =
    rendition === "portrait"
      ? [720, 1280]
      : rendition === "square"
        ? [720, 720]
        : rendition === "landscape"
          ? [1280, 720]
          : null;
  if (
    !artifact ||
    source.id !== campaign.item_id ||
    source.demo ||
    !uuid.test(artifact.media_id) ||
    !uuid.test(artifact.render_id) ||
    !digest.test(artifact.input_fingerprint) ||
    !digest.test(artifact.output_sha256) ||
    info.rendered !== true ||
    info.content_type !== "video/mp4" ||
    !Number.isFinite(info.size) ||
    info.size <= 0 ||
    info.size > 25 * 1024 * 1024 ||
    info.media_id !== artifact.media_id ||
    info.render_id !== artifact.render_id ||
    info.output_sha256 !== artifact.output_sha256 ||
    info.input_fingerprint !== artifact.input_fingerprint ||
    (exported.rendition !== undefined && exported.rendition !== rendition) ||
    (rendition !== "original" && exported.rendition !== rendition) ||
    (!!canvas &&
      (artifact.output_width !== canvas[0] ||
        artifact.output_height !== canvas[1] ||
        exported.output_width !== canvas[0] ||
        exported.output_height !== canvas[1])) ||
    (artifact.output_width !== undefined &&
      artifact.output_width !== exported.output_width) ||
    (artifact.output_height !== undefined &&
      artifact.output_height !== exported.output_height)
  )
    throw new Error(
      "The rendered preview changed. Refresh this campaign and review its current export.",
    );
  // Playback uses the authenticated media adapter. Signed storage URLs are never
  // persisted in campaign form state or given the account's bearer token.
  return {
    ...source,
    title: campaign.title,
    description: campaign.description,
    media_id: artifact.media_id,
    media_url: `/api/creator/media/${artifact.media_id}`,
    content_type: "video/mp4",
    trim_start: 0,
    trim_end: null,
    captions: [],
    overlays: [],
    soundtrack: null,
    demo: false,
  };
}

export function campaignSegmentsText(segments: Caption[]) {
  return segments
    .map((segment) => `${segment.start} --> ${segment.end} | ${segment.text}`)
    .join("\n");
}

export function parseCampaignSegments(value: string): Caption[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 100) throw new Error("Use up to 100 timed caption cues.");
  return lines.map((line, index) => {
    const match = line.match(
      /^(\d+(?:\.\d+)?)\s*-->\s*(\d+(?:\.\d+)?)\s*\|\s*(.+)$/,
    );
    if (!match)
      throw new Error(
        `Caption ${index + 1}: use start --> end | text, with times in seconds.`,
      );
    const start = Number(match[1]),
      end = Number(match[2]),
      text = match[3].trim();
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > 86400 ||
      !text ||
      text.length > 250
    )
      throw new Error(
        `Caption ${index + 1}: choose an increasing time range and 1–250 text characters.`,
      );
    return { start, end, text };
  });
}
