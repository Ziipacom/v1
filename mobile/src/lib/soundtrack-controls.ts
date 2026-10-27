/** Matches the existing editor API's source-audio offset limit, in seconds. */
export const soundtrackStartMaximum = 86400;
export const audioPreviewSeekTimeoutMs = 10000;

export async function boundedAudioPreviewSeek(
  seek: Promise<void>,
  timeoutMs = audioPreviewSeekTimeoutMs,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      seek,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Audio seek timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function knownAudioDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** This trims the audio's beginning; it never delays audio on the edit timeline. */
export function validateSoundtrackStart(
  value: unknown,
  duration?: number | null,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > soundtrackStartMaximum
  ) {
    throw new Error("Enter an audio start from 0 to 86400 seconds.");
  }
  const known = knownAudioDuration(duration);
  if (known !== null && value >= known) {
    throw new Error(
      "Audio start must be before the end of the selected audio.",
    );
  }
  return value;
}

export function parseSoundtrackStart(
  text: string,
  duration?: number | null,
): number {
  const value = text.trim();
  if (!/^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(value)) {
    throw new Error(
      "Enter audio start in seconds, with up to 3 decimal places.",
    );
  }
  return validateSoundtrackStart(Number(value), duration);
}

/** Resume inside the selected region; replay or an out-of-region position restarts it. */
export function soundtrackPreviewPosition(
  start: number,
  currentTime: number,
  duration: number | null,
  finished: boolean,
): number {
  const offset = validateSoundtrackStart(start, duration);
  return finished ||
    !Number.isFinite(currentTime) ||
    currentTime < offset ||
    (duration !== null && currentTime >= duration)
    ? offset
    : currentTime;
}
