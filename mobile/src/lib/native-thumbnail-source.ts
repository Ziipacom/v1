import type { VideoSource } from "expo-video";
import { trustedMediaPath } from "./domain.ts";

export const nativeThumbnailSourceTimeoutMs = 5000;

type ThumbnailReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
};

export type NativeThumbnailResponse = {
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  body: {
    getReader(): ThumbnailReader;
    cancel(): Promise<void>;
  } | null;
};

/** Must be a streaming implementation, such as expo/fetch, rather than RN XHR. */
export type NativeThumbnailFetcher = (
  uri: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    signal: AbortSignal;
    credentials: "omit";
    redirect: "manual" | "error";
  },
) => Promise<NativeThumbnailResponse>;

function preparationError(name = "Error") {
  const error = new Error("Native thumbnail source unavailable");
  error.name = name;
  return error;
}

function urlWithoutCredentials(uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw preparationError();
  }
  const authority = uri.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (
    url.username ||
    url.password ||
    authority?.includes("@") ||
    uri.includes("#")
  )
    throw preparationError();
  return url;
}

function isSignedR2Url(uri: string) {
  const url = urlWithoutCredentials(uri);
  const authority = uri.match(/^https:\/\/([^/?#]*)/i)?.[1];
  return (
    url.protocol === "https:" &&
    !!authority &&
    !authority.includes(":") &&
    /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*\.r2\.cloudflarestorage\.com$/i.test(
      url.hostname,
    ) &&
    url.pathname.length > 1 &&
    url.searchParams.getAll("X-Amz-Signature").length === 1 &&
    /^[a-f\d]{64}$/i.test(url.searchParams.get("X-Amz-Signature") || "")
  );
}

function requestCancellation(cancel: () => Promise<void>) {
  try {
    // Cleanup must not extend the deadline if a native stream is unresponsive.
    void cancel().catch(() => undefined);
  } catch {
    // The response may already have closed after cancellation or EOF.
  }
}

/**
 * Resolve one authenticated private-media hop before a native thumbnail decoder
 * opens it. Redirects are inspected before a second request, so the account's
 * bearer never reaches storage. Only one media byte is consumed; the signed R2
 * capability stays in memory and is never paired with account headers.
 */
export async function prepareNativeThumbnailSource(
  source: VideoSource,
  signal: AbortSignal,
  fetcher: NativeThumbnailFetcher,
  trustedOrigins: readonly string[],
): Promise<VideoSource> {
  if (signal.aborted) throw preparationError("AbortError");
  if (source == null || typeof source === "number") return source;
  const uri = typeof source === "string" ? source : source.uri;
  if (typeof uri !== "string" || !uri) throw preparationError();
  const original = urlWithoutCredentials(uri);
  if (original.protocol === "file:" || original.protocol === "content:")
    return source;
  if (
    !["https:", "http:"].includes(original.protocol) ||
    !trustedOrigins.includes(original.origin) ||
    !trustedMediaPath(uri, [...trustedOrigins]) ||
    !/^\/api\/creator\/media\//.test(original.pathname)
  )
    throw preparationError();
  const headers = typeof source === "object" ? source.headers : undefined;
  const entries = Object.entries(headers || {});
  if (
    entries.length !== 1 ||
    entries[0][0].toLowerCase() !== "authorization" ||
    !/^Bearer [a-z\d._~+/-]+=*$/i.test(entries[0][1])
  )
    throw preparationError();

  const controller = new AbortController();
  let rejectAbort: (error: Error) => void = () => undefined;
  const canceled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (name: "AbortError" | "TimeoutError") => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectAbort(preparationError(name));
  };
  const onAbort = () => abort("AbortError");
  signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(
    () => abort("TimeoutError"),
    nativeThumbnailSourceTimeoutMs,
  );
  let response: NativeThumbnailResponse | undefined;
  let reader: ThumbnailReader | undefined;
  const assertActive = () => {
    if (signal.aborted || controller.signal.aborted)
      throw preparationError("AbortError");
  };
  const request = async (
    requestUri: string,
    headers: Record<string, string>,
    redirect: "manual" | "error",
  ) => {
    const pending = Promise.resolve().then(() => {
      assertActive();
      return fetcher(requestUri, {
        method: "GET",
        headers,
        signal: controller.signal,
        credentials: "omit",
        redirect,
      });
    });
    // A late/non-cooperative fetch must not leave a private response streaming.
    void pending.then(
      (late) => {
        if (controller.signal.aborted && late.body)
          requestCancellation(() => late.body!.cancel());
      },
      () => undefined,
    );
    const next = await Promise.race([pending, canceled]);
    assertActive();
    return next;
  };
  try {
    response = await request(
      uri,
      { Authorization: entries[0][1], Range: "bytes=0-0" },
      "manual",
    );
    // Manual fetch must expose the original response. Never trust an already
    // followed redirect or allow an authenticated request to pick a new origin.
    if (response.url !== uri) throw preparationError();
    let finalUri = uri;
    if (response.status === 307) {
      const location = response.headers.get("location");
      if (!location || !isSignedR2Url(location)) throw preparationError();
      const redirectBody = response.body;
      if (redirectBody) requestCancellation(() => redirectBody.cancel());
      response = undefined;
      finalUri = location;
      response = await request(finalUri, { Range: "bytes=0-0" }, "error");
      // The signed storage capability gets one request and cannot redirect.
      if (response.url !== finalUri) throw preparationError();
    }
    const range = response.headers.get("content-range");
    const rangeMatch = /^bytes 0-0\/([1-9]\d*)$/.exec(range || "");
    const length = response.headers.get("content-length");
    const mediaType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (
      response.status !== 206 ||
      !rangeMatch ||
      !Number.isSafeInteger(Number(rangeMatch[1])) ||
      (length !== null && length !== "1") ||
      !mediaType ||
      !["video/mp4", "video/webm", "video/quicktime"].includes(mediaType) ||
      !response.body
    )
      throw preparationError();
    reader = response.body.getReader();
    let bytes = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), canceled]);
      assertActive();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw preparationError();
      bytes += part.value.byteLength;
      if (bytes > 1) throw preparationError();
    }
    if (bytes !== 1) throw preparationError();
    assertActive();
    return finalUri === uri
      ? source
      : { uri: urlWithoutCredentials(finalUri).href, useCaching: false };
  } catch (error) {
    throw preparationError(
      error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
        ? error.name
        : "Error",
    );
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onAbort);
    if (reader) {
      const ownedReader = reader;
      requestCancellation(() => ownedReader.cancel());
      try {
        ownedReader.releaseLock();
      } catch {
        // Pending reads can remain while a native fetch handles cancellation.
      }
    } else if (response?.body) {
      const body = response.body;
      requestCancellation(() => body.cancel());
    }
    controller.abort();
  }
}
