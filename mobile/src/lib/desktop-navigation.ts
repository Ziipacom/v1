import type { Category, RootStack } from "./types";

/** This is a portal layout choice, never an authorization or native routing gate. */
export function isDesktopPortal(platform: string, width: number): boolean {
  return platform === "web" && Number.isFinite(width) && width >= 1024;
}

export type DesktopDestination = {
  screen: keyof RootStack;
  params?: Record<string, unknown>;
};

const screens = {
  explore: "Main",
  studio: "CreatorStudio",
  library: "CreatorStudio",
  create: "Composer",
  watch: "Watch",
  calendar: "Calendar",
  campaigns: "Campaigns",
  live: "Live",
  recordings: "Recordings",
  exports: "Exports",
  networks: "Connections",
  publishing: "Publishing",
  feeds: "Feeds",
  os: "MediaOS",
  wallet: "Utility",
  promote: "Utility",
  inbox: "Utility",
  messages: "Inbox",
  notifications: "NotificationMessages",
  profile: "Profile",
  dashboard: "Dashboard",
  store: "Store",
  updates: "Notifications",
  settings: "Settings",
  admin: "Administration",
} as const satisfies Record<string, keyof RootStack>;
type DesktopView = keyof typeof screens;
const categories: readonly Category[] = [
  "video",
  "music",
  "games",
  "live",
  "nft",
  "store",
];
const mediaTabs = [
  "Overview",
  "Library",
  "Memory",
  "Assistant",
  "Workflows",
  "Insights",
  "Agent",
] as const;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const control = /[\u0000-\u001f\u007f]/;
const invalid = Symbol("invalid desktop parameter");

function choice(value: unknown, allowed: readonly string[]) {
  if (value === undefined) return undefined;
  return typeof value === "string" && allowed.includes(value) ? value : invalid;
}
function identifier(value: unknown) {
  if (value === undefined) return undefined;
  return typeof value === "string" && uuid.test(value)
    ? value.toLowerCase()
    : invalid;
}
function searchText(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 160 || control.test(value))
    return invalid;
  // Search is deliberately plain text: never turn a pasted signed media URL,
  // bearer credential or explicit token assignment into browser history.
  if (
    /(?:https?|file|data|blob|javascript):|\bbearer\s+|\b(?:access_token|refresh_token|authorization|x-amz-signature)\s*[=:]/i.test(
      value,
    )
  )
    return invalid;
  try {
    encodeURIComponent(value);
  } catch {
    return invalid;
  }
  return value.trim() || undefined;
}

/** Closed route projection: unrecognized fields (including Item/session) vanish. */
function project(
  view: DesktopView,
  input: Record<string, unknown>,
): DesktopDestination | null {
  const params: Record<string, unknown> = {};
  let valid = true;
  const put = (key: string, value: unknown) => {
    if (value === invalid) valid = false;
    else if (value !== undefined) params[key] = value;
  };
  const id = (key: string) => put(key, identifier(input[key]));
  switch (view) {
    case "profile":
      if (input.creatorId !== undefined) {
        const value =
          typeof input.creatorId === "number"
            ? input.creatorId
            : typeof input.creatorId === "string" &&
                /^[1-9]\d{0,9}$/.test(input.creatorId)
              ? Number(input.creatorId)
              : NaN;
        if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
          valid = false;
        else params.creatorId = value;
      }
      break;
    case "store":
      put("tab", choice(input.tab, ["browse", "sell", "services"]));
      if (input.sellerId !== undefined) {
        if (
          typeof input.sellerId === "number" &&
          Number.isSafeInteger(input.sellerId) &&
          input.sellerId > 0
        )
          params.sellerId = input.sellerId;
        else if (
          typeof input.sellerId === "string" &&
          /^[1-9]\d{0,9}$/.test(input.sellerId)
        )
          params.sellerId = Number(input.sellerId);
        else valid = false;
      }
      break;
    case "explore":
    case "studio":
    case "library":
      put("category", choice(input.category, categories));
      put("query", searchText(input.query));
      if (view === "explore")
        put("collection", choice(input.collection, ["saved"]));
      else params.tab = view === "library" ? "library" : "overview";
      break;
    case "create":
      put("category", choice(input.category, categories));
      id("draftId");
      break;
    case "watch":
      put("category", choice(input.category, categories));
      id("itemId");
      break;
    case "calendar":
      id("eventId");
      id("streamId");
      id("campaignId");
      put("kind", choice(input.kind, ["reminder", "stream", "campaign"]));
      break;
    case "campaigns":
      id("itemId");
      id("campaignId");
      break;
    case "live":
      id("streamId");
      put("tab", choice(input.tab, ["watch", "broadcast"]));
      break;
    case "recordings":
      id("streamId");
      break;
    case "networks":
      put("tab", choice(input.tab, ["accounts", "feed", "people", "outbox"]));
      break;
    case "publishing":
      id("itemId");
      id("renderId");
      break;
    case "exports":
      id("itemId");
      if (params.itemId === undefined) valid = false;
      break;
    case "os":
      put("tab", choice(input.tab, mediaTabs));
      break;
    case "updates":
      id("deliveryId");
      break;
    case "wallet":
    case "promote":
    case "inbox":
      params.kind = view;
      break;
  }
  return valid
    ? {
        screen: screens[view],
        ...(Object.keys(params).length ? { params } : {}),
      }
    : null;
}

export function destinationFromSearch(
  search: string,
): DesktopDestination | null {
  if (typeof search !== "string" || !search || search.length > 4096)
    return null;
  try {
    if (control.test(decodeURIComponent(search.replace(/\+/g, " "))))
      return null;
    const query = new URLSearchParams(search);
    const seen = new Set<string>();
    const input: Record<string, string> = Object.create(null);
    for (const [key, value] of query) {
      if (seen.has(key)) return null;
      seen.add(key);
      input[key] = value;
    }
    const view = input.view;
    if (!Object.prototype.hasOwnProperty.call(screens, view)) return null;
    return project(view as DesktopView, input);
  } catch {
    return null;
  }
}

export function destinationSearch(
  screen: string,
  params?: Record<string, unknown>,
): string | null {
  if (
    params !== undefined &&
    (!params || typeof params !== "object" || Array.isArray(params))
  )
    return null;
  const input = { ...params };
  let view: DesktopView | undefined;
  if (screen === "Studio") {
    view = input.edit === true ? "library" : "studio";
  } else if (screen === "CreatorStudio") {
    if (choice(input.tab, ["overview", "library"]) === invalid) return null;
    view = input.tab === "library" ? "library" : "studio";
  } else if (screen === "Utility") {
    if (
      input.kind === "wallet" ||
      input.kind === "promote" ||
      input.kind === "inbox"
    )
      view = input.kind;
  } else {
    view = (Object.keys(screens) as DesktopView[]).find(
      (value) => screens[value] === screen,
    );
  }
  if (!view) return null;
  if (view === "create" && input.item !== undefined) {
    if (
      !input.item ||
      typeof input.item !== "object" ||
      Array.isArray(input.item)
    )
      return null;
    const draftId = identifier((input.item as Record<string, unknown>).id);
    if (
      draftId === invalid ||
      draftId === undefined ||
      (input.draftId !== undefined && identifier(input.draftId) !== draftId)
    )
      return null;
    input.draftId = draftId;
  }
  const destination = project(view, input);
  if (!destination) return null;
  const search = new URLSearchParams({ view });
  for (const [key, value] of Object.entries(destination.params || {})) {
    // These are already represented by their fixed view name.
    if ((screen === "CreatorStudio" || screen === "Studio") && key === "tab")
      continue;
    if (screen === "Utility" && key === "kind") continue;
    search.set(key, String(value));
  }
  return `?${search.toString()}`;
}
