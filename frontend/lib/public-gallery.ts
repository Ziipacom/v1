export type PublicGalleryItem = {
  id: string;
  title: string;
  description: string;
  category: string;
  creator: string;
  tags: string[];
  cover: string | null;
  media_url: string;
  content_type: string;
  created_at: string;
};

export type PublicGallery = {
  slug: string;
  name: string;
  avatar_url: string | null;
  cover_url: string | null;
  items: PublicGalleryItem[];
  next_cursor: string | null;
  unavailable_count: number;
};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const publicGallerySlug = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 3 &&
  value.length <= 40 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export const publicGalleryItemId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum)
    throw new Error("Invalid public gallery response.");
  return value;
}

function artwork(
  value: unknown,
  slug: string,
  kind: "avatar" | "cover",
): string | null {
  if (value === null || value === "") return null;
  const path = text(value, 300);
  if (
    kind === "cover" &&
    [
      "/media/studio.jpg",
      "/media/dj.jpg",
      "/media/gaming.jpg",
      "/media/ocean.jpg",
      "/media/sintel.png",
      "/brand/ziipa-background.png",
    ].includes(path)
  )
    return path;
  const prefix = `/api/public/galleries/${slug}/artwork/${kind}/`;
  if (!path.startsWith(prefix) || !uuid.test(path.slice(prefix.length)))
    throw new Error("Invalid public artwork.");
  return path;
}

/** Anonymous pages accept only the gallery's revocable same-origin media paths. */
export function parsePublicGalleryItem(
  value: unknown,
  slug: string,
): PublicGalleryItem {
  if (!publicGallerySlug(slug) || !value || typeof value !== "object")
    throw new Error("Invalid public creation.");
  const row = value as Record<string, unknown>;
  if (
    !publicGalleryItemId(row.id) ||
    row.visibility !== "published" ||
    row.demo !== false
  )
    throw new Error("Invalid public creation.");
  const path = `/api/public/galleries/${slug}/items/${row.id}/media`;
  if (
    row.media_url !== path ||
    (row.cover !== null && row.cover !== "" && row.cover !== path)
  )
    throw new Error("Invalid public media.");
  const contentType = text(row.content_type, 100);
  if (!/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(contentType))
    throw new Error("Unsupported public media.");
  if (!Array.isArray(row.tags) || row.tags.length > 12)
    throw new Error("Invalid public tags.");
  return {
    id: row.id,
    title: text(row.title, 140),
    description: text(row.description, 4000),
    category: text(row.category, 40),
    creator: text(row.creator, 100),
    tags: row.tags.map((tag) => text(tag, 40)),
    cover: row.cover ? path : null,
    media_url: path,
    content_type: contentType,
    created_at: text(row.created_at, 80),
  };
}

export function parsePublicGallery(
  value: unknown,
  slug: string,
): PublicGallery {
  if (!publicGallerySlug(slug) || !value || typeof value !== "object")
    throw new Error("Invalid public gallery.");
  const row = value as Record<string, unknown>;
  if (row.slug !== slug || !Array.isArray(row.items) || row.items.length > 24)
    throw new Error("Invalid public gallery.");
  const cursor = row.next_cursor === null ? null : text(row.next_cursor, 180);
  if (cursor !== null && !/^[A-Za-z0-9_=-]+$/.test(cursor))
    throw new Error("Invalid public gallery cursor.");
  const unavailable = row.unavailable_count ?? 0;
  if (
    typeof unavailable !== "number" ||
    !Number.isSafeInteger(unavailable) ||
    unavailable < 0
  )
    throw new Error("Invalid public gallery status.");
  return {
    slug,
    name: text(row.name, 100),
    avatar_url: artwork(row.avatar_url, slug, "avatar"),
    cover_url: artwork(row.cover_url, slug, "cover"),
    items: row.items.map((item) => parsePublicGalleryItem(item, slug)),
    next_cursor: cursor,
    unavailable_count: unavailable,
  };
}

export function mergePublicGalleryItems(
  before: PublicGalleryItem[],
  next: PublicGalleryItem[],
) {
  const ids = new Set(before.map((item) => item.id));
  const result = [...before];
  for (const item of next)
    if (!ids.has(item.id)) {
      ids.add(item.id);
      result.push(item);
    }
  return result;
}

export function publicCreationLink(slug: string, itemId?: string): string {
  if (
    !publicGallerySlug(slug) ||
    (itemId !== undefined && !publicGalleryItemId(itemId))
  )
    throw new Error("Invalid public gallery link.");
  return `/g/${slug}${itemId ? `?post=${itemId}` : ""}`;
}
