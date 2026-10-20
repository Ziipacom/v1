import { inCreativeWorld, searchItems } from "./domain.ts";
import type { Category, Item } from "./types";

/** Gallery is a discovery surface, never a shortcut to someone's private tray. */
export function galleryItems(items: Item[], category: Category, query: string) {
  return searchItems(items, query).filter(
    (item) =>
      item.visibility !== "draft" &&
      item.visibility !== "hidden" &&
      inCreativeWorld(item, category),
  );
}

export function galleryIndex(index: number, count: number) {
  return count > 0 ? ((index % count) + count) % count : 0;
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
