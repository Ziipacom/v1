import type { Item } from "./types";
export type PreparedMedia = {
  name: string;
  share: () => Promise<"opened" | "downloaded" | "cancelled">;
  dispose: () => void;
};
export type MediaExport = { url: string; content_type: string; size: number; media_id?: string; render_id?: string; rendered?: boolean; input_fingerprint?: string; output_sha256?: string };
export const shareLimit = 100 * 1024 * 1024;
export function exportId(item: Item) {
  if (
    item.demo ||
    !item.media_id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.media_id)
  )
    throw new Error(
      "Save your own uploaded or recorded media to Ziipa before sharing the file.",
    );
  return item.media_id;
}
export function exportName(item: Item, mime: string) {
  const extensions: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
  };
  return `${item.title.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 64) || "ziipa-creation"}.${extensions[mime] || "bin"}`;
}
export function exportDownload(
  info: MediaExport,
  apiOrigin: string,
  mediaId: string,
  token: string,
) {
  if (!Number.isFinite(info.size) || info.size <= 0 || info.size > shareLimit)
    throw new Error("This file exceeds the 100 MB sharing limit.");
  if (info.url === `/api/creator/media/${mediaId}`)
    return {
      url: apiOrigin + info.url,
      headers: { Authorization: `Bearer ${token}` } as Record<string, string>,
      authenticated: true,
    };
  const url = new URL(info.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("The media download link is invalid.");
  // Signed storage URLs authorize themselves. Never send the Ziipa session to storage.
  // An absolute URL must be a storage URL, never an alternate API route.
  if (url.origin === new URL(apiOrigin).origin || url.hash)
    throw new Error("The media download link is invalid.");
  return { url: url.href, headers: {} as Record<string, string>, authenticated: false };
}

export function renderedExportId(item: Item, selectedId: string, job: {
  id: string; item_id: string; status: string; output_media_id: string | null; input_fingerprint: string;
}, info: MediaExport) {
  if (job.id !== selectedId || job.item_id !== item.id || job.status !== 'ready' ||
      !info.rendered || info.render_id !== selectedId || info.content_type !== 'video/mp4' ||
      info.media_id !== job.output_media_id || !info.media_id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(info.media_id) ||
      !/^[0-9a-f]{64}$/i.test(info.input_fingerprint || '') || info.input_fingerprint !== job.input_fingerprint ||
      !/^[0-9a-f]{64}$/i.test(info.output_sha256 || ''))
    throw new Error('This rendered export no longer matches the selected saved creation. Refresh your exports.');
  return info.media_id;
}

export function unchangedRender(before: MediaExport, after: MediaExport) {
  if (!after.rendered || before.media_id !== after.media_id || before.render_id !== after.render_id ||
      before.input_fingerprint !== after.input_fingerprint || before.output_sha256 !== after.output_sha256 ||
      before.size !== after.size || before.content_type !== after.content_type)
    throw new Error('The rendered export changed. Prepare it again before sharing.');
}
export function creationCaption(item: Item) {
  return [
    item.title,
    item.description,
    item.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");
}
