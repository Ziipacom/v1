import type { SocialProvider } from "./types";

export type NetworkTab = "accounts" | "feed" | "people" | "outbox";
export type NetworkAccount = {
  audience?: { followers?: number | null; following?: number | null; updated_at?: string | null } | null;
  provider: SocialProvider;
  /** Public link revision invalidates imported snapshots after unlink/relink. */
  revision?: string | null;
  name: string;
  capability: string;
  status: "disconnected" | "linked" | "connected";
  handle: string;
  profile_url: string;
  configured: boolean;
  auth_type: "none" | "public_profile" | "oauth";
  can_sync: boolean;
  can_publish: boolean;
  capabilities: {
    profile_link: boolean;
    public_feed: boolean;
    following: boolean;
    private_feed: boolean;
    publish: boolean;
  };
  sync_status: "never" | "synced" | "error" | "not_available";
  last_synced_at: string | null;
  sync_error: string | null;
  media_count: number;
  people_count: number;
  connection_notice: string;
  import_targets?: { id: string; name: string; kind: string; url: string }[];
  selected_import_target_id?: string | null;
  import_requirements?: string[];
  import_detail?: string;
  /** Public metadata validity deadline; never an OAuth token expiry or credential. */
  snapshot_expires_at?: string | null;
};
export type NetworkMedia = {
  id: string;
  provider: SocialProvider;
  title: string;
  text: string;
  url: string;
  thumbnail_url?: string;
  author: string;
  handle: string;
  published_at?: string;
  kind: "post" | "image" | "video";
};
export type NetworkPerson = {
  id: string;
  provider: SocialProvider;
  name: string;
  handle: string;
  profile_url: string;
  avatar_url?: string;
  relationship: "following";
};
export type NetworkHub = {
  providers: NetworkAccount[];
  media: NetworkMedia[];
  people: NetworkPerson[];
  invite_url: string;
  notice: string;
};
export type ConnectResult = {
  status:
    "setup_required" | "authorization_required" | "browser_sign_in_required";
  auth_url: string | null;
  connect_via_portal?: string | null;
  detail: string;
  requirements?: string[];
};

export const networkInfo: Record<
  SocialProvider,
  {
    name: string;
    home: string;
    placeholder: string;
    scope: string;
    sync: string;
  }
> = {
  bluesky: {
    name: "Bluesky",
    home: "https://bsky.app",
    placeholder: "you.bsky.social",
    scope: "Posts · public following",
    sync: "Sync recent public posts and following from a Bluesky profile. Linking a public profile does not verify account ownership.",
  },
  instagram: {
    name: "Instagram",
    home: "https://www.instagram.com",
    placeholder: "@yourname",
    scope: "Public professional media · Reels",
    sync: "Read-only public imports require an authorized professional Instagram account and explicit account selection. Private home feeds and friend lists are not imported.",
  },
  tiktok: {
    name: "TikTok",
    home: "https://www.tiktok.com",
    placeholder: "@yourname",
    scope: "Your public videos",
    sync: "Public-video imports require approved Login Kit and Display API video.list consent. Posting permission does not grant read access, and private feeds or friends are not imported.",
  },
  facebook: {
    name: "Facebook",
    home: "https://www.facebook.com",
    placeholder: "Page name or profile URL",
    scope: "Managed Pages · public posts",
    sync: "Public imports require read-only permission for a managed Facebook Page and an explicit Page selection. Personal timelines and private friend lists are not imported.",
  },
  youtube: {
    name: "YouTube",
    home: "https://www.youtube.com",
    placeholder: "@yourchannel",
    scope: "Public channel video metadata",
    sync: "Link a public YouTube channel and explicitly sync its public uploads when the server adapter is ready. Private or unlisted videos and subscriptions are not imported. A saved link does not verify ownership.",
  },
  twitch: {
    name: "Twitch",
    home: "https://www.twitch.tv",
    placeholder: "yourchannel",
    scope: "Live channels · following",
    sync: "Twitch access needs approved OAuth scopes. Broadcasting also needs a live encoder and ingest service; recording a clip does not start a public stream.",
  },
};

const hosts: Record<SocialProvider, string[]> = {
  bluesky: ["bsky.app"],
  instagram: ["instagram.com", "www.instagram.com"],
  tiktok: ["tiktok.com", "www.tiktok.com"],
  facebook: ["facebook.com", "www.facebook.com", "m.facebook.com"],
  youtube: ["youtube.com", "www.youtube.com", "youtu.be"],
  twitch: ["twitch.tv", "www.twitch.tv"],
};
export function safeNetworkUrl(provider: SocialProvider, value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !hosts[provider].includes(url.hostname.toLowerCase())
    )
      return null;
    if (/\/(?:l\.php|redirect|logout|intent)(?:\/|$)/i.test(url.pathname))
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function profileLink(provider: SocialProvider, value: string) {
  const input = value.trim();
  let handle = input.replace(/^@/, "");
  let facebookId = false;
  let youtubeChannel = false;
  if (input.includes("://")) {
    const safe = safeNetworkUrl(provider, input);
    if (!safe)
      throw new Error(
        `Use an HTTPS ${networkInfo[provider].name} profile URL.`,
      );
    const url = new URL(safe);
    if (url.hash || /[%\\\r\n\t]/.test(input))
      throw new Error("Use a plain profile link without tracking parameters.");
    const path = url.pathname.replace(/\/$/, "");
    if (provider === "facebook" && path === "/profile.php") {
      const ids = url.searchParams.getAll("id");
      if (
        [...url.searchParams.keys()].some((key) => key !== "id") ||
        ids.length !== 1 ||
        !/^[0-9]{1,30}$/.test(ids[0])
      )
        throw new Error(
          "Use the Facebook profile URL with only its numeric id parameter.",
        );
      handle = ids[0];
      facebookId = true;
    } else {
      if (url.search)
        throw new Error("Remove tracking parameters from the profile link.");
      const match =
        provider === "bluesky"
          ? /^\/profile\/([^/]+)$/.exec(path)
          : provider === "youtube"
            ? /^\/(?:@([^/]+)|channel\/([^/]+))$/.exec(path)
            : /^\/@?([^/]+)$/.exec(path);
      if (!match)
        throw new Error(
          "Use a profile or channel URL, not a post or login link.",
        );
      handle = match[1] || match[2];
      youtubeChannel = provider === "youtube" && !!match[2];
    }
  }
  if (provider === "bluesky") {
    handle = handle.toLowerCase();
    if (
      !/^(?:did:plc:[a-z2-7]{24}|(?:did:web:)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.test(
        handle,
      ) ||
      handle.length > 253
    )
      throw new Error("Use your full Bluesky handle, such as you.bsky.social.");
  } else if (
    provider === "youtube" &&
    (youtubeChannel || /^UC.{22}$/.test(handle))
  ) {
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(handle))
      throw new Error("Use a valid YouTube channel ID or @handle.");
    return {
      handle,
      profile_url: `${networkInfo.youtube.home}/channel/${handle}`,
    };
  } else {
    const patterns = {
      facebook: /^[A-Za-z0-9.]{1,100}$/,
      instagram: /^[A-Za-z0-9_.]{1,30}$/,
      tiktok: /^[A-Za-z0-9_.]{1,24}$/,
      twitch: /^[A-Za-z0-9_]{1,25}$/,
      youtube: /^[A-Za-z0-9_.-]{3,30}$/,
    };
    if (!patterns[provider].test(handle))
      throw new Error(`Enter a valid ${networkInfo[provider].name} handle.`);
    const reserved = {
      facebook: [
        "login",
        "settings",
        "watch",
        "reel",
        "reels",
        "groups",
        "share",
        "dialog",
        "sharer.php",
      ],
      instagram: ["accounts", "explore", "direct", "p", "reels", "reel"],
      tiktok: ["login", "search", "upload"],
      twitch: ["directory", "settings", "login", "videos"],
      youtube: ["watch", "feed", "playlist", "results", "shorts", "upload"],
    };
    handle = handle.toLowerCase();
    if (reserved[provider].includes(handle))
      throw new Error("Use a profile, not a platform login or content page.");
  }
  if (facebookId)
    return {
      handle,
      profile_url: `${networkInfo.facebook.home}/profile.php?id=${handle}`,
    };
  const prefix =
    provider === "bluesky"
      ? "/profile/"
      : provider === "youtube" || provider === "tiktok"
        ? "/@"
        : "/";
  return {
    handle,
    profile_url: `${networkInfo[provider].home}${prefix}${handle}`,
  };
}
export function emptyNetworkHub(): NetworkHub {
  return {
    providers: (Object.keys(networkInfo) as SocialProvider[]).map(
      (provider) => ({
        provider,
        name: networkInfo[provider].name,
        capability: networkInfo[provider].scope,
        status: "disconnected",
        handle: "",
        profile_url: "",
        configured: false,
        auth_type: "none",
        can_sync: false,
        can_publish: false,
        capabilities: {
          profile_link: true,
          public_feed: provider === "bluesky",
          following: provider === "bluesky",
          private_feed: false,
          publish: false,
        },
        sync_status: "never",
        last_synced_at: null,
        sync_error: null,
        media_count: 0,
        people_count: 0,
        connection_notice: networkInfo[provider].sync,
      }),
    ),
    media: [],
    people: [],
    invite_url: "https://ziipa.com",
    notice: "",
  };
}
