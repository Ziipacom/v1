import type { CampaignRendition } from "./campaign-types";
import { renderedExportId, type MediaExport } from "./share-types.ts";
import type { RenderJob } from "./render-types";
import type { Item } from "./types";

export const recordingRoot = "/api/live/recordings";
export type RecordingConfig = {
  enabled: boolean;
  webhook_configured: boolean;
  worker_ready: boolean;
  max_bytes: number;
  max_duration_seconds: number;
  max_clips: number;
  automatic_publication: false;
  detail: string;
};
export type RecordingAutomation = {
  stream_id: string;
  revision: number;
  enabled: boolean;
  consent: boolean;
  clip_count: number;
  clip_seconds: number;
  rendition: CampaignRendition;
  detail: string;
};
export type RecordingClip = {
  item_id: string;
  render_id: string | null;
  status: string;
  detail: string;
  start: number;
  end: number;
  rendition: CampaignRendition;
};
export type RecordingReceipt = {
  id: string;
  stream_id: string;
  status:
    "queued" | "processing" | "ready" | "blocked" | "failed" | "cancelled";
  revision: number;
  title: string;
  detail: string;
  media_id: string | null;
  item_id: string | null;
  duration: number | null;
  size: number | null;
  clips: RecordingClip[];
  created_at: string;
  updated_at: string;
};
export function recordingAutomationInput(
  policy: RecordingAutomation,
  fields: {
    enabled: boolean;
    consent: boolean;
    count: string;
    seconds: string;
    rendition: CampaignRendition;
  },
  record: boolean,
) {
  if (!Number.isSafeInteger(policy.revision) || policy.revision < 0)
    throw new Error("Refresh the recording policy before saving.");
  if (fields.enabled && (!record || !fields.consent))
    throw new Error(
      "Recording must be enabled for this stream and you must explicitly approve private clip automation.",
    );
  if (!/^[1-3]$/.test(fields.count))
    throw new Error("Choose between one and three excerpts.");
  if (
    !/^\d+$/.test(fields.seconds) ||
    +fields.seconds < 15 ||
    +fields.seconds > 90
  )
    throw new Error("Each excerpt must be 15 to 90 seconds.");
  if (
    !["original", "portrait", "square", "landscape"].includes(fields.rendition)
  )
    throw new Error("Choose a supported clip format.");
  return {
    revision: policy.revision,
    enabled: fields.enabled,
    consent: fields.enabled && fields.consent,
    clip_count: +fields.count,
    clip_seconds: +fields.seconds,
    rendition: fields.rendition,
  };
}
export function recordingNeedsPolling(receipts: RecordingReceipt[]) {
  return receipts.some(
    (receipt) =>
      receipt.status === "queued" ||
      receipt.status === "processing" ||
      receipt.clips.some(
        (clip) => clip.status === "queued" || clip.status === "processing",
      ),
  );
}
export function recordingClipPreview(
  item: Item,
  clip: RecordingClip,
  job: RenderJob,
  info: MediaExport,
): Item {
  if (
    item.demo ||
    item.id !== clip.item_id ||
    item.visibility === "hidden" ||
    !clip.render_id ||
    clip.status !== "ready" ||
    !Number.isFinite(info.size) ||
    info.size <= 0 ||
    info.size > 25 * 1024 * 1024
  )
    throw new Error(
      "This clip has no current rendered preview. Refresh its receipt and saved edit.",
    );
  const mediaId = renderedExportId(item, clip.render_id, job, info);
  return {
    ...item,
    media_id: mediaId,
    media_url: `/api/creator/media/${mediaId}`,
    content_type: "video/mp4",
    trim_start: 0,
    trim_end: null,
    captions: [],
    overlays: [],
    soundtrack: null,
    timeline: null,
    visual_effect: "none",
  };
}
