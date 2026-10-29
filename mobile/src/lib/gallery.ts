import { inCreativeWorld, searchItems } from "./domain.ts";
import type { Category, Item } from "./types";

/** Gallery is a discovery surface, never a shortcut to someone's private tray. */
export function galleryItems(
  items: Item[],
  category: Category | "all",
  query: string,
) {
  return searchItems(items, query).filter(
    (item) =>
      item.visibility !== "draft" &&
      item.visibility !== "hidden" &&
      (category === "all" || inCreativeWorld(item, category)),
  );
}

export function galleryIndex(index: number, count: number) {
  return count > 0 ? ((index % count) + count) % count : 0;
}

/** Three moving indicator slots; the portfolio itself is never truncated. */
export function galleryIndicators(count: number, index: number) {
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  const current = galleryIndex(index, count);
  const first = Math.floor(current / 3) * 3;
  return Array.from({ length: Math.min(3, count) }, (_, slot) => ({
    slot,
    index: (first + slot) % count,
    active: slot === current % 3,
  }));
}

/** Keep three visual slots without duplicating a creation to fill empty space. */
export function galleryNeighbors(items: readonly Item[], index: number) {
  const current = galleryIndex(index, items.length);
  return {
    left:
      items.length > 2 ? items[galleryIndex(current - 1, items.length)] : null,
    right:
      items.length > 1 ? items[galleryIndex(current + 1, items.length)] : null,
  };
}

export function galleryRotationAllowed(state: {
  count: number;
  enabled: boolean;
  focused: boolean;
  foreground: boolean;
  visible: boolean;
  hovering: boolean;
  controlFocused: boolean;
  reducedMotion: boolean;
}) {
  return (
    state.count > 1 &&
    state.enabled &&
    state.focused &&
    state.foreground &&
    state.visible &&
    !state.hovering &&
    !state.controlFocused &&
    !state.reducedMotion
  );
}
