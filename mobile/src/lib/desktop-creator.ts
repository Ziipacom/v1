import type { Bootstrap, Category, Item, SocialConnection } from "./types";

export type CreatorLibraryEntry = {
  item: Item;
  owned: boolean;
  saved: boolean;
};
export type CreatorLibraryStatus = "all" | "draft" | "published" | "hidden" | "saved";

/** Ownership comes from the server's private draft collection or numeric ID,
 * never an editable creator name. Public saved media retains its own author. */
export function creatorLibrary(
  data: Pick<Bootstrap, "drafts" | "items" | "preferences">,
  ownerId: number | null,
  guest = false,
): CreatorLibraryEntry[] {
  const saved = new Set(data.preferences.saved);
  const entries = new Map<string, CreatorLibraryEntry>();
  if (ownerId !== null || guest) {
    for (const item of data.drafts) {
      if ((!guest && item.demo) || (!guest && item.creator_id !== undefined && item.creator_id !== ownerId)) continue;
      entries.set(item.id, {
        item: item.visibility ? item : { ...item, visibility: "draft" },
        owned: true,
        saved: saved.has(item.id),
      });
    }
  }
  for (const item of data.items) {
    if (entries.has(item.id) || item.visibility === "draft" || item.visibility === "hidden" || (!guest && item.demo)) continue;
    const owned = ownerId !== null && item.creator_id === ownerId;
    if (!owned && !saved.has(item.id)) continue;
    entries.set(item.id, {
      item: item.visibility ? item : { ...item, visibility: "published" },
      owned,
      saved: saved.has(item.id),
    });
  }
  return [...entries.values()].sort((a, b) => {
    const first = a.item.created_at ? Date.parse(a.item.created_at) : 0;
    const second = b.item.created_at ? Date.parse(b.item.created_at) : 0;
    return (Number.isFinite(second) ? second : 0) - (Number.isFinite(first) ? first : 0);
  });
}

export function filterCreatorLibrary(
  entries: CreatorLibraryEntry[],
  query: string,
  category: Category | "all",
  status: CreatorLibraryStatus,
) {
  const search = query.trim().toLocaleLowerCase();
  return entries.filter(({ item, saved }) => {
    const categoryMatches = category === "all" || item.category === category || (category === "music" && item.category === "video");
    const statusMatches = status === "all" || (status === "saved" ? saved : item.visibility === status);
    return categoryMatches && statusMatches && (!search ||
      `${item.title} ${item.description} ${item.creator} ${item.tags.join(" ")}`.toLocaleLowerCase().includes(search));
  });
}

export function creatorConnectionLabel(connection: SocialConnection) {
  if (connection.status === "action_required") return "Action needed";
  if (connection.status === "linked") return "Link saved · authorize to publish";
  if (connection.status === "connected") {
    if (!connection.configured) return "Authorized · provider setup needed";
    return connection.can_publish === true ? "Authorized · review before posting" : "Authorized · check capabilities";
  }
  return connection.configured ? "Ready to connect" : "Provider setup needed";
}
