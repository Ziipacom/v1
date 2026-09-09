import { request } from "./api";
import { validateOrigin, portalMode, authorizationHeaders } from "./config";
import { renderId, type RenderJob } from './render-types';
import type { Item } from "./types";
import {
  exportDownload,
  exportId,
  exportName,
  shareLimit,
  renderedExportId,
  unchangedRender,
  type MediaExport,
  type PreparedMedia,
} from "./share-types";

export async function prepareMediaShare(
  item: Item,
  token: string,
  renderedId?: string,
  isCurrent: () => boolean = () => true,
): Promise<PreparedMedia> {
  let id = exportId(item);
  function check() { if (!isCurrent()) throw new Error('Your account or selected creation changed. Prepare the media again.'); }
  check();
  const job = renderedId ? await request<RenderJob>(`/api/render/jobs/${renderId(renderedId)}`, token) : null;
  check();
  const info = await request<MediaExport>(
    renderedId ? `/api/render/jobs/${renderId(renderedId)}/export` : `/api/social/media/${id}/export`,
    token,
    {},
  );
  check();
  if (renderedId && job) id = renderedExportId(item, renderedId, job, info);
  const download = exportDownload(info, validateOrigin(), id, token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let blob: Blob;
  try {
    const response = await fetch(download.url, {
      headers: portalMode
        ? download.authenticated
          ? authorizationHeaders(token)
          : {}
        : download.headers,
      credentials:
        portalMode && download.authenticated
          ? "include"
          : "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body)
      throw new Error("The original media could not be downloaded.");
    const reader = response.body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (!isCurrent()) { await reader.cancel(); check(); }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > shareLimit) {
        await reader.cancel();
        throw new Error("The file exceeds the sharing limit.");
      }
      parts.push(new Uint8Array(part.value));
    }
    if (!size || size !== info.size) throw new Error("The downloaded media size is invalid.");
    blob = new Blob(parts, { type: info.content_type });
  } finally {
    clearTimeout(timeout);
  }
  check();
  const name = exportName(item, info.content_type);
  const file = new File([blob], name, { type: info.content_type });
  const localUrl = URL.createObjectURL(blob);
  let disposed = false;
  return {
    name,
    async share() {
      check();
      if (disposed) throw new Error("Prepare the media again before sharing.");
      if (renderedId) {
        const latest = await request<MediaExport>(`/api/render/jobs/${renderId(renderedId)}/export`, token, {});
        check();
        unchangedRender(info, latest);
      }
      if (disposed) throw new Error("Prepare the media again before sharing.");
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({ files: [file], title: item.title });
          return "opened";
        } catch (error) {
          if ((error as Error).name === "AbortError") return "cancelled";
          throw error;
        }
      }
      const link = document.createElement("a");
      link.href = localUrl;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      return "downloaded";
    },
    dispose() {
      if (!disposed) URL.revokeObjectURL(localUrl);
      disposed = true;
    },
  };
}
