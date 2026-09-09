import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { request } from "./api";
import { validateOrigin } from "./config";
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
  if (!FileSystem.cacheDirectory)
    throw new Error("Temporary storage is unavailable on this device.");
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
  const name = exportName(item, info.content_type);
  const directory = `${FileSystem.cacheDirectory}ziipa-share-${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const uri = directory + name;
  const task = FileSystem.createDownloadResumable(
    download.url,
    uri,
    { headers: download.headers },
    (progress) => {
      if (progress.totalBytesWritten > shareLimit) void task.cancelAsync();
    },
  );
  const timer = setTimeout(() => void task.cancelAsync(), 120000);
  try {
    const result = await task.downloadAsync();
    if (!result || result.status !== 200)
      throw new Error("The original media could not be downloaded.");
    const file = await FileSystem.getInfoAsync(uri);
    if (!file.exists || !file.size || file.size > shareLimit || file.size !== info.size)
      throw new Error("The downloaded media size is invalid.");
    check();
  } catch (error) {
    await FileSystem.deleteAsync(directory, { idempotent: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
      if (!(await Sharing.isAvailableAsync()))
        throw new Error("This device does not provide a media share sheet.");
      check();
      if (disposed) throw new Error("Prepare the media again before sharing.");
      await Sharing.shareAsync(uri, {
        mimeType: info.content_type,
        dialogTitle: "Post your Ziipa creation",
      });
      return "opened";
    },
    dispose() {
      if (!disposed)
        void FileSystem.deleteAsync(directory, { idempotent: true }).catch(
          () => {},
        );
      disposed = true;
    },
  };
}
