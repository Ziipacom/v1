import type { Session } from "./types";
import { validateOrigin } from "./config";

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
  return saved && Date.parse(saved.expires_at) > Date.now() ? saved : null;
}
export async function writeSession(session: Session) {
  saved = session;
}
export async function clearSession() {
  saved = null;
}
export async function request<T>(
  path: string,
  token?: string,
  data?: unknown,
): Promise<T> {
  if (!path.startsWith("/api/") || path.includes(".."))
    throw new Error("Invalid API path");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    path === "/api/web3/metadata" ? 120000 : 30000,
  );
  try {
    const response = await fetch(validateOrigin() + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new ApiError(
        typeof body?.detail === "string"
          ? body.detail
          : Array.isArray(body?.detail)
            ? body.detail.map((d: { msg: string }) => d.msg).join("\n")
            : "Request failed",
        response.status,
      );
    return body;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new Error(
      "Cannot reach Ziipa. Check that the API is running and this browser origin is allowed.",
    );
  } finally {
    clearTimeout(timer);
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
  const blob = await (await fetch(file.uri)).blob();
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
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(direct ? reservation.url : validateOrigin() + "/api/creator/media", {
      method: direct ? "PUT" : "POST",
      headers: {
        ...(direct ? reservation.headers : { Authorization: `Bearer ${token}`, "Content-Type": file.mimeType }),
      },
      body: blob,
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new ApiError(
        typeof body.detail === "string" ? body.detail : "Upload failed",
        response.status,
      );
    onProgress(100);
    return direct
      ? await request<{ id: string; url: string; content_type: string }>(
          `/api/creator/media/${reservation.id}/complete`, token, {},
        )
      : (body as { id: string; url: string; content_type: string });
  } finally {
    clearTimeout(timer);
  }
}
