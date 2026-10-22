import { trustedMediaPath } from "./domain.ts";

export const privateProfileImageLimit = 10 * 1024 * 1024;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
type Options = { path: string; token: string; apiOrigin: string; trustedOrigins: string[]; signal: AbortSignal };
type ImageFetcher = (url: string, init: RequestInit) => Promise<Response>;
type ImageUrls = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

/** The inline owner-image route never accepts signed URLs, queries or redirects. */
export function trustedProfileImagePath(path: string, origins: string[]) {
  const owned = trustedMediaPath(path, origins);
  return owned && /^\/api\/creator\/profile-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owned) ? owned : null;
}

export function privateProfileImageRequest(options: Options) {
  const owned = trustedProfileImagePath(options.path, options.trustedOrigins);
  const origin = new URL(options.apiOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (!owned || origin.origin !== options.apiOrigin || !options.trustedOrigins.includes(origin.origin) ||
      origin.username || origin.password || (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
      !options.token || options.token.length > 256 || /\s/.test(options.token) || options.token.startsWith("ziipa-portal-cookie:"))
    throw new Error("Profile image authentication requires a trusted Ziipa owner-image path.");
  return { url: options.apiOrigin + owned, init: {
    method: "GET", headers: { Authorization: `Bearer ${options.token}` },
    credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    redirect: "error", signal: options.signal,
  } satisfies RequestInit };
}

export async function privateProfileImageBlob(options: Options, fetcher: ImageFetcher = fetch, byteLimit = privateProfileImageLimit) {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > privateProfileImageLimit)
    throw new Error("Profile images have a 10 MB maximum size.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 30000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (options.signal.aborted) controller.abort();
    if (controller.signal.aborted) throw new Error("Profile image loading canceled.");
    const request = privateProfileImageRequest({ ...options, signal: controller.signal });
    const response = await fetcher(request.url, request.init);
    if (controller.signal.aborted) throw new Error("Profile image loading canceled.");
    if (!response.ok || !response.body || response.redirected || (response.url && response.url !== request.url))
      throw new Error("Your profile image is unavailable. Check your sign-in and connection.");
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!imageTypes.has(type)) throw new Error("This response is not a supported static profile image.");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > byteLimit))
      throw new Error("This profile image exceeds the supported size or is empty.");
    reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (controller.signal.aborted) throw new Error("Profile image loading canceled.");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > byteLimit) throw new Error("This profile image exceeds the 10 MB maximum size.");
      chunks.push(new Uint8Array(chunk.value));
    }
    if (!size) throw new Error("This profile image is empty.");
    return new Blob(chunks, { type });
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", cancel);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    controller.abort();
  }
}

/** Each caller owns its blob URL; account/source/background changes revoke it. */
export async function privateProfileImageLease(options: Options, fetcher: ImageFetcher = fetch, urls: ImageUrls = URL) {
  const blob = await privateProfileImageBlob(options, fetcher);
  if (options.signal.aborted) throw new Error("Profile image loading canceled.");
  const uri = urls.createObjectURL(blob);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    urls.revokeObjectURL(uri);
    options.signal.removeEventListener("abort", dispose);
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  if (options.signal.aborted) dispose();
  return { uri, dispose };
}
