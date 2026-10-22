import type { Category, Item } from "./types";
import { inCreativeWorld } from "./domain.ts";

export type ProfileCategory = Category | "all";
export type ProfileCardBounds = { top: number; height: number };
export type ProfileViewport = { top: number; height: number; gridTop: number };

export function profileCreations(
  items: readonly Item[],
  category: ProfileCategory,
) {
  return items.filter(
    (item) => category === "all" || inCreativeWorld(item, category),
  );
}

export function profileMediaKind(
  item: Item,
): "video" | "image" | "audio" | "none" {
  if (item.content_type?.startsWith("image/")) return "image";
  if (item.content_type?.startsWith("audio/")) return "audio";
  if (
    item.media_url &&
    (item.content_type?.startsWith("video/") ||
      item.media_url === "/media/sintel-trailer.mp4")
  )
    return "video";
  return "none";
}

export function profileCardVisible(
  bounds: ProfileCardBounds | undefined,
  viewport: ProfileViewport,
) {
  if (!bounds || bounds.height <= 0 || viewport.height <= 0) return false;
  const top = viewport.gridTop + bounds.top;
  const visible = Math.max(
    0,
    Math.min(top + bounds.height, viewport.top + viewport.height) -
      Math.max(top, viewport.top),
  );
  return visible / Math.min(bounds.height, viewport.height) >= 0.5;
}

/** One visible video at a time; choosing the closest center avoids a player per card. */
export function profileVideoSelection(
  items: readonly Item[],
  bounds: Record<string, ProfileCardBounds>,
  viewport: ProfileViewport,
) {
  const middle = viewport.top + viewport.height / 2;
  return (
    items
      .filter(
        (item) =>
          profileMediaKind(item) === "video" &&
          profileCardVisible(bounds[item.id], viewport),
      )
      .sort(
        (a, b) =>
          Math.abs(
            viewport.gridTop +
              bounds[a.id].top +
              bounds[a.id].height / 2 -
              middle,
          ) -
          Math.abs(
            viewport.gridTop +
              bounds[b.id].top +
              bounds[b.id].height / 2 -
              middle,
          ),
      )[0]?.id ?? null
  );
}

export function profilePreviewPolicy(input: {
  focused: boolean;
  foreground: boolean;
  ready: boolean;
  autoplay: boolean;
  reducedMotion: boolean;
  saveData: boolean;
  blocked: boolean;
}) {
  const mountVideo =
    input.focused &&
    input.foreground &&
    input.ready &&
    !input.saveData &&
    !input.blocked;
  return {
    mountVideo,
    autoplay: mountVideo && input.autoplay && !input.reducedMotion,
  };
}

/** Preview only retained media, never the discarded parts of a trimmed source. */
export function profilePreviewRange(item: Item, duration: number) {
  const clip = item.timeline?.clips[0];
  const start = clip?.start ?? item.trim_start ?? 0;
  const end = Math.min(clip?.end ?? item.trim_end ?? duration, duration);
  const speed = clip?.speed ?? 1;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(end) ||
    end <= start ||
    ![0.5, 1, 1.5, 2].includes(speed)
  )
    throw new Error(
      "This preview has an invalid saved playback range. Open the creation to review it.",
    );
  return { start, end, speed };
}

export function profilePreviewHasEdits(item: Item) {
  return (
    !!item.timeline?.clips.length ||
    !!item.overlays?.length ||
    !!item.captions?.length ||
    !!item.soundtrack ||
    (!!item.visual_effect && item.visual_effect !== "none")
  );
}
