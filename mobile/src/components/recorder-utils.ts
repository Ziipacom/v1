// Kept independent of camera APIs so limits and MIME handling can be tested.
export const recordingSeconds = 120;
export const recordingBytes = 100 * 1024 * 1024;
export const recordingBitrate = 2_000_000;

export function recordingTime(seconds: number) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

export function recordingFormat(mime: string) {
  const type = mime.toLowerCase().split(";")[0].trim();
  if (type === "video/mp4") return { mimeType: type, extension: "mp4" };
  if (type === "video/webm") return { mimeType: type, extension: "webm" };
  if (type === "video/quicktime") return { mimeType: type, extension: "mov" };
  throw new Error(
    "This camera produced an unsupported video format. Try a current Chrome or Safari browser.",
  );
}

export function validateRecordingSize(size: number) {
  if (!Number.isFinite(size) || size <= 0)
    throw new Error(
      "No video was captured. Record a longer clip and try again.",
    );
  if (size > recordingBytes)
    throw new Error("This recording exceeds 100 MB. Retake a shorter clip.");
}

export function cameraError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera or microphone access was denied. Allow both in your browser's site permissions, then try again.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError")
    return "No camera or microphone was found. Connect both devices and try again.";
  if (name === "NotReadableError" || name === "TrackStartError")
    return "The camera or microphone is busy. Close other apps using it, then try again.";
  if (name === "OverconstrainedError")
    return "This camera cannot use the requested settings. Try the other camera.";
  return error instanceof Error
    ? error.message
    : "The camera could not start. Try again.";
}
