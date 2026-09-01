import type { Caption, Category, FeedInput, Item } from "./types";

// The Figma music icon represents the combined Music & Film destination.
export function inCreativeWorld(item: Item, category: Category) {
  return category === "music"
    ? item.category === "music" || item.category === "video"
    : item.category === category;
}

export function pageAtOffset(offset: number, height: number, count: number) {
  if (height <= 0 || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(offset / height)));
}

export function matchesFeed(
  item: Item,
  rule: Pick<FeedInput, "category" | "tag" | "city" | "creator">,
) {
  return (
    (rule.category === "all" || item.category === rule.category) &&
    (!rule.tag.trim() ||
      item.tags.some(
        (t) =>
          t.toLowerCase() === rule.tag.replace(/^#/, "").trim().toLowerCase(),
      )) &&
    (!rule.city.trim() ||
      item.city.toLowerCase().includes(rule.city.trim().toLowerCase())) &&
    (!rule.creator.trim() ||
      item.creator.toLowerCase().includes(rule.creator.trim().toLowerCase()))
  );
}
export function searchItems(items: Item[], search: string) {
  const query = search.trim().toLowerCase();
  return items.filter((i) =>
    `${i.title} ${i.description} ${i.creator} ${i.tags.join(" ")}`
      .toLowerCase()
      .includes(query),
  );
}
export function parseEditing(start: string, end: string, caption: string) {
  const trim_start = start.trim() ? Number(start) : 0;
  const trim_end = end.trim() ? Number(end) : null;
  if (!Number.isFinite(trim_start) || trim_start < 0 || trim_start > 86400)
    throw new Error("Start must be between 0 and 86400 seconds.");
  if (
    trim_end !== null &&
    (!Number.isFinite(trim_end) || trim_end <= trim_start || trim_end > 86400)
  )
    throw new Error("End must be after start and no later than 86400 seconds.");
  if (caption.length > 250)
    throw new Error("Use up to 250 characters for the caption.");
  const captions: Caption[] = caption.trim()
    ? [
        {
          start: trim_start,
          end: trim_end ?? Math.min(trim_start + 6, 86400),
          text: caption.trim(),
        },
      ]
    : [];
  if (captions.some((c) => c.end <= c.start))
    throw new Error("Leave time after the start for a caption.");
  return { trim_start, trim_end, captions };
}
export function visibleCaption(captions: Caption[] = [], time: number) {
  return captions.find((c) => time >= c.start && time < c.end)?.text;
}
export function privateMediaPath(path: string) {
  return /^\/api\/creator\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    path,
  );
}
export function parsePrice(value: string) {
  if (!value.trim()) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value.trim()))
    throw new Error(
      "Price must be a positive amount with at most two decimal places.",
    );
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents > 100000000) throw new Error("Price exceeds the listing limit.");
  return cents;
}
