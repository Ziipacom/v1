import type { UploadFile } from "./api";
import type { Item } from "./types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A source-only Wallet handoff, never the unsaved edit or its soundtrack. */
export function sourceMintItem(
  item: Item | null | undefined,
  ownerId: number | undefined,
  dirty: boolean,
): Item | null {
  if (
    dirty ||
    !ownerId ||
    !item ||
    item.demo ||
    item.creator_id !== ownerId ||
    !uuid.test(item.id) ||
    !item.media_id ||
    !uuid.test(item.media_id) ||
    (item.visibility !== "draft" && item.visibility !== "published")
  )
    return null;
  return item;
}

/** Keep a model title as display text, never as an arbitrary device path. */
export function audioCreationSource(file: UploadFile, title: string) {
  if (file.mimeType !== "audio/wav" || file.size <= 0 || file.size > 1323044)
    throw new Error("Choose a valid generated WAV of up to 30 seconds.");
  const displayTitle =
    title
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 140) || "Ziipa audio creation";
  const name =
    displayTitle
      .replace(/[^a-z0-9 _-]/gi, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "ziipa-created-music";
  return { file: { ...file, name: `${name}.wav` }, title: displayTitle };
}
