import { trustedMediaPath } from "./domain.ts";

export const privatePlaybackLimit = 100 * 1024 * 1024;
export const privatePlaybackTimeout = 60000;
type Options = {
  path: string;
  token: string;
  apiOrigin: string;
  trustedOrigins: string[];
  signal: AbortSignal;
};

export function privatePlaybackRequest({
  path,
  token,
  apiOrigin,
  trustedOrigins,
  signal,
}: Options) {
  const owned = trustedMediaPath(path, trustedOrigins);
  const origin = new URL(apiOrigin);
  if (
    !owned ||
    !trustedOrigins.includes(origin.origin) ||
    origin.origin !== apiOrigin ||
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    !token ||
    token.startsWith("ziipa-portal-cookie:") ||
    token.length > 256 ||
    /[\r\n\s]/.test(token)
  )
    throw new Error(
      "Media authentication is restricted to an exact trusted Ziipa media path.",
    );
  return {
    url: apiOrigin + owned,
    init: {
      method: "GET",
      headers: { Authorization: "Bearer " + token },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      // Only the Ziipa API chooses a signed R2 redirect. The Fetch standard
      // removes Authorization on cross-origin redirects; no cookies are sent.
      redirect: "follow",
      signal,
    } satisfies RequestInit,
  };
}

export async function privateMediaBlob(
  options: Options,
  fetcher: typeof fetch = fetch,
  limit = privatePlaybackLimit,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, privatePlaybackTimeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (options.signal.aborted) controller.abort();
    if (controller.signal.aborted) throw new Error("Media loading cancelled.");
    const request = privatePlaybackRequest({
      ...options,
      signal: controller.signal,
    });
    const response = await fetcher(request.url, request.init);
    if (!response.ok || !response.body)
      throw new Error("Media is unavailable or your session has expired.");
    const type = (response.headers.get("content-type") || "")
      .split(";")[0]
      .toLowerCase();
    if (
      !/^(video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|x-wav|mp4|aac|flac|ogg))$/.test(
        type,
      )
    )
      throw new Error("This response is not supported video or audio media.");
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > limit))
      throw new Error("This media exceeds the 100 MB playback limit.");
    reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (controller.signal.aborted)
        throw new Error("Media loading cancelled.");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit)
        throw new Error("This media exceeds the 100 MB playback limit.");
      chunks.push(new Uint8Array(chunk.value));
    }
    if (!size) throw new Error("This media file is empty.");
    return new Blob(chunks, { type });
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", cancel);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    controller.abort();
  }
}

/** No global cache: each identity/source owns its lease, disposed on replacement. */
export async function privateMediaLease(
  options: Options,
  fetcher: typeof fetch = fetch,
  urls = URL,
) {
  const blob = await privateMediaBlob(options, fetcher);
  if (options.signal.aborted) throw new Error("Media loading cancelled.");
  const uri = urls.createObjectURL(blob);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      urls.revokeObjectURL(uri);
      options.signal.removeEventListener("abort", dispose);
    }
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  if (options.signal.aborted) dispose();
  return { uri, dispose };
}
