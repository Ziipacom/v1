import type { Session } from "./types";
import { validateOrigin, portalMode, authorizationHeaders } from "./config";
import {
  ApiRequestError,
  OperationTimeoutError,
  withDeadline,
} from "./request-deadline";

export { ApiRequestError } from "./request-deadline";

// Browser bearer sessions stay in memory, never localStorage or cookies.
let saved: Session | null = null;
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function readSession() {
  if (portalMode) {
    try {
      const user = await request<Session["user"]>("/api/me");
      // A non-secret state marker; never sent as Authorization. The existing
      // HttpOnly website cookie remains the sole portal credential.
      return {
        access_token: `ziipa-portal-cookie:${user.id}:${Date.now()}`,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        user,
      };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await clearSession();
        return null;
      }
      throw error;
    }
  }
  return saved && Date.parse(saved.expires_at) > Date.now() ? saved : null;
}
export async function writeSession(session: Session) {
  saved = session;
}
export async function clearSession() {
  saved = null;
  if (portalMode) {
    if (window.parent === window) window.location.replace("/portal");
    else
      window.parent.postMessage(
        { source: "ziipa-studio", type: "signed-out" },
        window.location.origin,
      );
  }
}
export async function request<T>(
  path: string,
  token?: string,
  data?: unknown,
): Promise<T> {
  if (!path.startsWith("/api/") || path.includes(".."))
    throw new Error("Invalid API path");
  if (portalMode && path === "/api/mobile/auth/logout")
    path = "/api/auth/logout";
  const url = validateOrigin() + path;
  const requestBody = data === undefined ? undefined : JSON.stringify(data);
  const controller = new AbortController();
  const timeoutError = new OperationTimeoutError("The API request timed out.");
  let failureStatus: number | undefined;
  try {
    return await withDeadline(
      async (isActive) => {
        const response = await fetch(url, {
          method: data === undefined ? "GET" : "POST",
          headers: {
            ...authorizationHeaders(token),
            ...(data === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: requestBody,
          credentials: portalMode ? "include" : "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (!isActive()) throw timeoutError;
        if (!response.ok) failureStatus = response.status;
        const body = await response.json().catch(() => {
          if (response.ok) throw new Error("Invalid API response");
          return null;
        });
        if (!response.ok)
          throw new ApiError(
            typeof body?.detail === "string"
              ? body.detail
              : Array.isArray(body?.detail)
                ? body.detail.map((d: { msg: string }) => d.msg).join("\n")
                : "Request failed",
            response.status,
          );
        return body as T;
      },
      path === "/api/web3/metadata" ? 120000 : 30000,
      timeoutError,
      () => controller.abort(),
    );
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (failureStatus !== undefined)
      throw new ApiError("Request failed", failureStatus);
    throw new ApiRequestError(
      data === undefined ? "unavailable" : "unconfirmed",
      e instanceof OperationTimeoutError,
    );
  }
}
export type UploadFile = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
};
export const uploadLimit = 100 * 1024 * 1024;
const extensionTypes: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
};
export function creatorMimeType(name: string, reported = "") {
  const mime = reported.toLowerCase().split(";")[0];
  if (
    /^(image\/(jpeg|png|webp|gif|heic|heif)|video\/(mp4|quicktime|webm)|audio\/(mpeg|wav|mp4|aac|flac|ogg))$/.test(
      mime,
    )
  )
    return mime;
  const inferred = extensionTypes[name.toLowerCase().split(".").pop() || ""];
  if (inferred) return inferred;
  throw new Error(
    "Choose a common image, video, or audio file such as JPG, PNG, GIF, HEIC, MP4, MOV, WebM, MP3, WAV, M4A, AAC, FLAC, or OGG.",
  );
}
export async function uploadMedia(
  file: UploadFile,
  token: string,
  onProgress: (percent: number) => void,
): Promise<{ id: string; url: string; content_type: string }> {
  if (
    file.size > uploadLimit ||
    !/^(image\/(jpeg|png|webp|gif|heic|heif)|video\/(mp4|quicktime|webm)|audio\/(mpeg|wav|mp4|aac|flac|ogg))$/.test(
      file.mimeType,
    )
  )
    throw new Error(
      "Choose a supported image, video or audio file up to 100 MB.",
    );
  if (!file.uri.startsWith("blob:") && !file.uri.startsWith("data:"))
    throw new Error("Choose a file from this device.");
  onProgress(0);
  const localController = new AbortController();
  const readTimeout = new OperationTimeoutError(
    "Reading this file took too long. Choose it again and keep this edit open.",
  );
  const blob = await withDeadline(
    async (isActive) => {
      const response = await fetch(file.uri, {
        signal: localController.signal,
      });
      if (!isActive()) throw readTimeout;
      return response.blob();
    },
    30000,
    readTimeout,
    () => localController.abort(),
  ).catch((error: unknown) => {
    if (error instanceof OperationTimeoutError) throw error;
    throw new Error(
      "Ziipa could not read this file. Choose it again and keep this edit open.",
    );
  });
  if (blob.size > uploadLimit) throw new Error("File exceeds 100 MB.");
  const reservation = await request<{
    id?: string;
    mode: "api" | "direct";
    url: string;
    method: "POST" | "PUT";
    headers: Record<string, string>;
  }>("/api/creator/media/presign", token, {
    filename: file.name,
    content_type: file.mimeType,
    size: file.size,
  });
  const direct = reservation.mode === "direct";
  const controller = new AbortController();
  const timeoutError = new OperationTimeoutError(
    "The upload did not finish in time. Keep this edit and try again; this upload has not submitted a creation.",
  );
  const body = await withDeadline(
    async (isActive) => {
      const response = await fetch(
        direct ? reservation.url : validateOrigin() + "/api/creator/media",
        {
          method: direct ? "PUT" : "POST",
          headers: {
            ...(direct
              ? reservation.headers
              : {
                  ...authorizationHeaders(token),
                  "Content-Type": file.mimeType,
                }),
          },
          body: blob,
          credentials: portalMode && !direct ? "include" : "omit",
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (!isActive()) throw timeoutError;
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw new ApiError(
          typeof body?.detail === "string" ? body.detail : "Upload failed",
          response.status,
        );
      if (!direct && (!body || typeof body.id !== "string"))
        throw new Error(
          "Ziipa did not confirm the uploaded file. Keep this edit and check your library before trying again.",
        );
      return body;
    },
    180000,
    timeoutError,
    () => controller.abort(),
  ).catch((error: unknown) => {
    if (error instanceof ApiError || error instanceof OperationTimeoutError)
      throw error;
    throw new Error(
      "Ziipa could not finish uploading this file. Keep this edit and check your connection before trying again.",
    );
  });
  onProgress(100);
  return direct
    ? await request<{ id: string; url: string; content_type: string }>(
        `/api/creator/media/${reservation.id}/complete`,
        token,
        {},
      )
    : (body as { id: string; url: string; content_type: string });
}
