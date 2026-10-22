import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system/legacy";
import { validateOrigin } from "./config";
import type { Session } from "./types";
import {
  ApiRequestError,
  OperationTimeoutError,
  withDeadline,
} from "./request-deadline";

export { ApiRequestError } from "./request-deadline";

const SESSION_KEY = "ziipa.native.session.v1";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function readSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Session;
    if (
      typeof value.access_token !== "string" ||
      !value.user?.id ||
      !Number.isFinite(Date.parse(value.expires_at)) ||
      Date.parse(value.expires_at) <= Date.now()
    )
      throw new Error("Expired");
    return value;
  } catch {
    await clearSession();
    return null;
  }
}
export const writeSession = (session: Session) =>
  SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
export const clearSession = () => SecureStore.deleteItemAsync(SESSION_KEY);

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = body.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail))
      return detail
        .map(
          (d) =>
            `${d.loc?.slice(-1)[0] || "Input"}: ${d.msg || "Invalid value"}`,
        )
        .join("\n");
  }
  return "The request could not be completed. Please try again.";
}
export async function request<T>(
  path: string,
  token?: string,
  data?: unknown,
): Promise<T> {
  if (!path.startsWith("/api/") || path.includes(".."))
    throw new Error("Invalid API path");
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
          signal: controller.signal,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(data === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: requestBody,
          credentials: "omit",
          redirect: "error",
        });
        if (!isActive()) throw timeoutError;
        if (!response.ok) failureStatus = response.status;
        const body = await response.json().catch(() => {
          if (response.ok) throw new Error("Invalid API response");
          return null;
        });
        if (!response.ok)
          throw new ApiError(errorMessage(body), response.status);
        return body as T;
      },
      path === "/api/web3/metadata" ? 120000 : 30000,
      timeoutError,
      () => controller.abort(),
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (failureStatus !== undefined)
      throw new ApiError(errorMessage(null), failureStatus);
    throw new ApiRequestError(
      data === undefined ? "unavailable" : "unconfirmed",
      error instanceof OperationTimeoutError,
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
const allowed = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/ogg",
]);
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
  const normalized = reported.toLowerCase().split(";")[0];
  if (allowed.has(normalized)) return normalized;
  const extension = name.toLowerCase().split(".").pop() || "";
  const inferred = extensionTypes[extension];
  if (inferred) return inferred;
  throw new Error(
    "Choose a common image, video, or audio file such as JPG, PNG, GIF, HEIC, MP4, MOV, WebM, MP3, WAV, M4A, AAC, FLAC, or OGG.",
  );
}
export async function uploadMedia(
  file: UploadFile,
  token: string,
  onProgress: (percent: number) => void,
) {
  if (!allowed.has(file.mimeType)) throw new Error("Unsupported creator file.");
  if (!file.size || file.size > uploadLimit)
    throw new Error("Choose a non-empty file no larger than 100 MB.");
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
  const timeoutError = new OperationTimeoutError(
    "The upload did not finish in time. Keep this edit and try again; this upload has not submitted a creation.",
  );
  let cancel: (() => Promise<void>) | undefined;
  let response;
  try {
    response = await withDeadline(
      (isActive) => {
        const task = FileSystem.createUploadTask(
          direct ? reservation.url : validateOrigin() + "/api/creator/media",
          file.uri,
          {
            httpMethod: direct ? "PUT" : "POST",
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
            headers: {
              ...(direct
                ? reservation.headers
                : {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": file.mimeType,
                  }),
            },
            sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
          },
          (event) => {
            if (!isActive()) return;
            onProgress(
              event.totalBytesExpectedToSend
                ? Math.round(
                    (event.totalBytesSent / event.totalBytesExpectedToSend) *
                      100,
                  )
                : 0,
            );
          },
        );
        cancel = () => task.cancelAsync();
        return task.uploadAsync();
      },
      180000,
      timeoutError,
      () => cancel?.(),
    );
  } catch (error) {
    if (error instanceof OperationTimeoutError) throw error;
    throw new Error(
      "Ziipa could not finish uploading this file. Keep this edit and check your connection before trying again.",
    );
  }
  if (!response) throw new Error("Upload was cancelled. Please try again.");
  let body = null;
  try {
    body = response.body ? JSON.parse(response.body) : null;
  } catch {
    /* Storage errors need not be JSON. */
  }
  if (response.status < 200 || response.status >= 300)
    throw new ApiError(errorMessage(body), response.status);
  if (!direct && (!body || typeof body.id !== "string"))
    throw new Error(
      "Ziipa did not confirm the uploaded file. Keep this edit and check your library before trying again.",
    );
  onProgress(100);
  return direct
    ? await request<{ id: string; url: string; content_type: string }>(
        `/api/creator/media/${reservation.id}/complete`,
        token,
        {},
      )
    : (body as { id: string; url: string; content_type: string });
}
