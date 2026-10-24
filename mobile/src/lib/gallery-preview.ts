import { profilePreviewRange } from "./profile-preview.ts";
import type { Item } from "./types";

export const galleryStillSize = 360;
export const galleryStillTimeoutMs = 10000;

/** Prefer nearby retained frames before paying for a distant range/decode seek. */
export function galleryStillTimes(item: Item, duration: number) {
  const { start, end } = profilePreviewRange(item, duration);
  const span = end - start;
  return [
    ...new Set(
      [Math.min(span * 0.35, 1), Math.min(span * 0.65, 3), span * 0.85].map(
        (offset) => start + offset,
      ),
    ),
  ].filter((time) => Number.isFinite(time) && time >= start && time < end);
}

/** A conservative black-frame test, not scene recognition or content scoring. */
export function galleryFrameHasPicture(rgba: ArrayLike<number>) {
  if (rgba.length < 4 || rgba.length % 4) return false;
  let bright = 0,
    total = 0,
    pixels = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const light =
      rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722;
    total += light;
    if (light > 14) bright++;
    pixels++;
  }
  return pixels > 0 && bright / pixels >= 0.01 && total / pixels >= 4;
}
