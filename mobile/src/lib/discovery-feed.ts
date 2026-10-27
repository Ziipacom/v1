import { inCreativeWorld, searchItems } from "./domain.ts";
import {
  safeNetworkUrl,
  type NetworkHub,
  type NetworkMedia,
} from "./network-hub.ts";
import type { Category, Item, Preferences } from "./types";

export type DiscoveryEntry =
  | { id: string; source: "ziipa"; item: Item }
  | { id: string; source: "network"; media: NetworkMedia };

/** Only public connection identity fields participate, never provider secrets. */
export function discoveryConnectionIdentity(
  connections: readonly unknown[],
): string {
  return JSON.stringify(
    connections
      .flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const row = value as Record<string, unknown>;
        if (row.provider !== "bluesky") return [];
        return [
          [
            "provider",
            "status",
            "handle",
            "profile_url",
            "auth_type",
            "revision",
          ].map((key) =>
            typeof row[key] === "string"
              ? (row[key] as string).slice(0, 500)
              : "",
          ),
        ];
      })
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

/** The existing public-import adapter returns post links, not owned Ziipa video URLs. */
export function discoveryPostUrl(media: NetworkMedia): string | null {
  if (media.provider !== "bluesky" || typeof media.url !== "string")
    return null;
  const safe = safeNetworkUrl("bluesky", media.url);
  if (!safe) return null;
  const url = new URL(safe);
  return !url.search &&
    !url.hash &&
    !url.pathname.includes("%") &&
    /^\/profile\/[^/]+\/post\/[A-Za-z0-9._~:-]{1,128}$/.test(url.pathname)
    ? safe
    : null;
}

export function discoveryThumbnailUrl(media: NetworkMedia): string | null {
  if (
    media.provider !== "bluesky" ||
    typeof media.thumbnail_url !== "string" ||
    media.thumbnail_url.length > 1500
  )
    return null;
  try {
    const url = new URL(media.thumbnail_url);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      ["cdn.bsky.app", "video.bsky.app"].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Use only the signed-in account's already imported, permitted public snapshot. */
export function importedDiscoveryMedia(hub: NetworkHub | null): NetworkMedia[] {
  if (!hub || !Array.isArray(hub.providers) || !Array.isArray(hub.media))
    return [];
  const linked = hub.providers.some(
    (provider) =>
      !!provider &&
      provider.provider === "bluesky" &&
      ["linked", "connected"].includes(provider.status) &&
      ["public_profile", "oauth"].includes(provider.auth_type),
  );
  if (!linked) return [];
  const seen = new Set<string>();
  return hub.media.slice(0, 180).flatMap((media) => {
    if (
      !media ||
      media.provider !== "bluesky" ||
      typeof media.id !== "string" ||
      !media.id ||
      media.id.length > 500 ||
      !["post", "image", "video"].includes(media.kind) ||
      !discoveryPostUrl(media) ||
      seen.has(media.id)
    )
      return [];
    seen.add(media.id);
    return [
      {
        ...media,
        title: typeof media.title === "string" ? media.title.slice(0, 100) : "",
        text: typeof media.text === "string" ? media.text.slice(0, 3000) : "",
        author:
          typeof media.author === "string" ? media.author.slice(0, 300) : "",
        handle:
          typeof media.handle === "string" ? media.handle.slice(0, 300) : "",
        thumbnail_url: discoveryThumbnailUrl(media) || undefined,
      },
    ];
  });
}

/** Rank by stable identity so filter/data refreshes do not reshuffle existing peers. */
function rank(id: string, seed: number): number {
  let value = (2166136261 ^ seed) >>> 0;
  for (let n = 0; n < id.length; n++)
    value = Math.imul(value ^ id.charCodeAt(n), 16777619);
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

export function discoveryEntries(
  items: readonly Item[],
  hub: NetworkHub | null,
  preferences: Preferences,
  seed: number,
  includeSamples = false,
): DiscoveryEntry[] {
  const seen = new Set<string>();
  const published: DiscoveryEntry[] = items.flatMap((item) => {
    if (
      (item.demo ? !includeSamples : item.visibility !== "published") ||
      item.visibility === "draft" ||
      item.visibility === "hidden" ||
      seen.has(item.id)
    )
      return [];
    seen.add(item.id);
    return [{ id: `ziipa:${item.id}`, source: "ziipa" as const, item }];
  });
  const muted = preferences.muted_words
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  const network: DiscoveryEntry[] = importedDiscoveryMedia(hub).flatMap(
    (media) => {
      const text =
        `${media.title} ${media.text} ${media.author} ${media.handle}`.toLowerCase();
      if (
        preferences.blocked_creators.includes(media.author) ||
        preferences.blocked_creators.includes(media.handle) ||
        muted.some((word) => text.includes(word))
      )
        return [];
      return [
        {
          id: `network:${media.provider}:${media.id}`,
          source: "network" as const,
          media,
        },
      ];
    },
  );
  return [...published, ...network].sort(
    (a, b) => rank(a.id, seed) - rank(b.id, seed) || a.id.localeCompare(b.id),
  );
}

export function filterDiscoveryEntries(
  entries: readonly DiscoveryEntry[],
  options: {
    category?: Category | "all";
    query?: string;
    savedIds?: readonly string[];
  },
): DiscoveryEntry[] {
  const query = (options.query || "").trim().toLowerCase();
  return entries.filter((entry) => {
    if (entry.source === "ziipa")
      return (
        (!options.category ||
          options.category === "all" ||
          inCreativeWorld(entry.item, options.category)) &&
        (!options.savedIds || options.savedIds.includes(entry.item.id)) &&
        searchItems([entry.item], query).length > 0
      );
    if (options.savedIds) return false;
    if (
      options.category &&
      options.category !== "all" &&
      !(
        (options.category === "video" || options.category === "music") &&
        entry.media.kind === "video"
      )
    )
      return false;
    return (
      !query ||
      `${entry.media.title} ${entry.media.text} ${entry.media.author} ${entry.media.handle} bluesky`
        .toLowerCase()
        .includes(query)
    );
  });
}
