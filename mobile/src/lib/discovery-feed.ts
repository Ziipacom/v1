import { inCreativeWorld, searchItems } from "./domain.ts";
import {
  networkInfo,
  safeNetworkUrl,
  type NetworkHub,
  type NetworkMedia,
} from "./network-hub.ts";
import type { Category, Item, Preferences, SocialProvider } from "./types";

const importProviders = new Set<SocialProvider>([
  "bluesky",
  "facebook",
  "instagram",
  "tiktok",
  "youtube",
]);

export function discoveryProviderName(provider: SocialProvider): string {
  return networkInfo[provider]?.name || "Connected network";
}

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
        if (!importProviders.has(row.provider as SocialProvider)) return [];
        return [
          [
            "provider",
            "status",
            "handle",
            "profile_url",
            "auth_type",
            "revision",
            "snapshot_expires_at",
            "selected_import_target_id",
          ]
            .map((key) =>
              typeof row[key] === "string"
                ? (row[key] as string).slice(0, 500)
                : "",
            )
            .concat([
              String(row.can_sync === true),
              String(
                !!row.capabilities &&
                  typeof row.capabilities === "object" &&
                  (row.capabilities as Record<string, unknown>).public_feed ===
                    true,
              ),
            ]),
        ];
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/** The existing public-import adapter returns post links, not owned Ziipa video URLs. */
export function discoveryPostUrl(media: NetworkMedia): string | null {
  if (
    !importProviders.has(media.provider) ||
    typeof media.url !== "string" ||
    media.url.length > 1500 ||
    /[\\\s]/.test(media.url)
  )
    return null;
  const safe = safeNetworkUrl(media.provider, media.url);
  if (!safe) return null;
  const url = new URL(safe);
  if (url.hash || url.pathname.includes("%")) return null;
  if (media.provider === "youtube")
    return ["youtube.com", "www.youtube.com"].includes(url.hostname) &&
      url.pathname === "/watch" &&
      [...url.searchParams.keys()].length === 1 &&
      url.searchParams.getAll("v").length === 1 &&
      /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") || "")
      ? safe
      : null;
  if (media.provider === "facebook" && url.pathname === "/permalink.php")
    return [...url.searchParams.keys()].length === 2 &&
      url.searchParams.getAll("story_fbid").length === 1 &&
      url.searchParams.getAll("id").length === 1 &&
      /^[A-Za-z0-9]{1,150}$/.test(url.searchParams.get("story_fbid") || "") &&
      /^\d{1,50}$/.test(url.searchParams.get("id") || "")
      ? safe
      : null;
  if (url.search) return null;
  const patterns = {
    bluesky: /^\/profile\/[^/]+\/post\/[A-Za-z0-9._~:-]{1,128}$/,
    facebook: /^\/[A-Za-z0-9.]{1,100}\/posts\/[A-Za-z0-9]{1,150}\/?$/,
    instagram: /^\/(?:p|reel)\/[A-Za-z0-9_-]{1,100}\/?$/,
    tiktok: /^\/@[A-Za-z0-9_.]{1,24}\/video\/\d{1,50}\/?$/,
  };
  return patterns[media.provider as keyof typeof patterns]?.test(url.pathname)
    ? safe
    : null;
}

export function discoveryThumbnailUrl(media: NetworkMedia): string | null {
  if (
    !importProviders.has(media.provider) ||
    typeof media.thumbnail_url !== "string" ||
    media.thumbnail_url.length > 1500 ||
    /[\\\s]/.test(media.thumbnail_url)
  )
    return null;
  try {
    const url = new URL(media.thumbnail_url);
    const host = url.hostname;
    const suffix = (value: string) =>
      host === value || host.endsWith(`.${value}`);
    const supported =
      media.provider === "bluesky"
        ? ["cdn.bsky.app", "video.bsky.app"].includes(host)
        : media.provider === "youtube"
          ? ["i.ytimg.com", "i9.ytimg.com"].includes(host)
          : media.provider === "tiktok"
            ? suffix("tiktokcdn.com") || suffix("tiktokcdn-us.com")
            : media.provider === "facebook"
              ? suffix("fbcdn.net")
              : media.provider === "instagram" &&
                (suffix("cdninstagram.com") || suffix("fbcdn.net"));
    const credential = [...url.searchParams.keys()].some((key) =>
      /^(?:token|oauth_?token|access_?token|refresh_?token|id_?token|authorization|cookie|client_?secret|password|api_?key|credential|session)$/i.test(
        key,
      ),
    );
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !credential &&
      supported
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Use only the signed-in account's already imported, permitted public snapshot. */
export function discoverySnapshotExpiry(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
      value,
    )
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function nextDiscoverySnapshotExpiry(
  hub: NetworkHub | null,
  now = Date.now(),
): number | null {
  const deadlines = (Array.isArray(hub?.providers) ? hub.providers : [])
    .map((account) => discoverySnapshotExpiry(account.snapshot_expires_at))
    .filter((value): value is number => value !== null && value > now);
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function importedDiscoveryMedia(
  hub: NetworkHub | null,
  now = Date.now(),
): NetworkMedia[] {
  if (!hub || !Array.isArray(hub.providers) || !Array.isArray(hub.media))
    return [];
  const linked = new Set(
    hub.providers
      .filter(
        (account) =>
          !!account &&
          importProviders.has(account.provider) &&
          account.can_sync === true &&
          account.capabilities?.public_feed === true &&
          (account.provider === "bluesky" ||
            ((discoverySnapshotExpiry(account.snapshot_expires_at) || 0) >
              now &&
              (discoverySnapshotExpiry(account.snapshot_expires_at) ||
                Infinity) <=
                now + (account.provider === "tiktok" ? 21600000 : 86400000))) &&
          (!["facebook", "instagram", "tiktok"].includes(account.provider) ||
            (typeof account.selected_import_target_id === "string" &&
              account.import_targets?.some(
                (target) => target.id === account.selected_import_target_id,
              ))) &&
          ((account.status === "connected" && account.auth_type === "oauth") ||
            (["bluesky", "youtube"].includes(account.provider) &&
              account.status === "linked" &&
              account.auth_type === "public_profile")),
      )
      .map((account) => account.provider),
  );
  const seen = new Set<string>();
  return hub.media.slice(0, 180).flatMap((media) => {
    if (
      !media ||
      !linked.has(media.provider) ||
      typeof media.id !== "string" ||
      !media.id ||
      media.id.length > 500 ||
      !["post", "image", "video"].includes(media.kind) ||
      !discoveryPostUrl(media) ||
      seen.has(`${media.provider}:${media.id}`)
    )
      return [];
    seen.add(`${media.provider}:${media.id}`);
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
      `${entry.media.title} ${entry.media.text} ${entry.media.author} ${entry.media.handle} ${discoveryProviderName(entry.media.provider)}`
        .toLowerCase()
        .includes(query)
    );
  });
}
