import type { ConnectResult, NetworkAccount } from "./network-hub";
import type { SocialProvider } from "./types";

export const readImportProviders = new Set<SocialProvider>([
  "facebook",
  "instagram",
  "tiktok",
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function trustedOrigin(origin: string, allowLoopback: boolean): string {
  const url = new URL(origin);
  const local =
    allowLoopback && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  )
    throw new Error("Ziipa's network authorization address is unavailable.");
  return url.origin;
}

/** Launch only Ziipa's one-time read-consent ticket, never a provider-supplied redirect. */
export function importAuthorizationUrl(
  provider: SocialProvider,
  value: unknown,
  canonicalOrigin: string,
  allowLoopback = false,
): string {
  if (
    !readImportProviders.has(provider) ||
    typeof value !== "string" ||
    value.length > 600
  )
    throw new Error("This read-only authorization link is unavailable.");
  const url = new URL(value);
  if (
    ![
      "https://ziipa.com",
      trustedOrigin(canonicalOrigin, allowLoopback),
    ].includes(url.origin) ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/api/social/oauth/${provider}/authorize` ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.getAll("ticket").length !== 1 ||
    !/^[A-Za-z0-9_-]{54}$/.test(url.searchParams.get("ticket") || "") ||
    value !==
      `${url.origin}${url.pathname}?ticket=${url.searchParams.get("ticket")}`
  )
    throw new Error("This read-only authorization link is unavailable.");
  return url.href;
}

export function importPortalUrl(
  value: unknown,
  portalOrigin = "https://ziipa.com",
  allowLoopback = false,
): string {
  const origin = trustedOrigin(portalOrigin, allowLoopback);
  if (value !== `${origin}/portal`)
    throw new Error("Use the Ziipa portal to authorize public imports.");
  return `${origin}/portal`;
}

export function readImportConnect(value: unknown): ConnectResult {
  if (!value || typeof value !== "object")
    throw new Error(
      "Network authorization could not load. Refresh and try again.",
    );
  const row = value as Record<string, unknown>;
  if (
    ![
      "setup_required",
      "authorization_required",
      "browser_sign_in_required",
    ].includes(String(row.status)) ||
    typeof row.detail !== "string" ||
    row.detail.length > 4000 ||
    (row.auth_url !== null && typeof row.auth_url !== "string") ||
    (row.connect_via_portal != null &&
      typeof row.connect_via_portal !== "string") ||
    (row.requirements !== undefined &&
      (!Array.isArray(row.requirements) ||
        row.requirements.length > 15 ||
        row.requirements.some(
          (item) => typeof item !== "string" || item.length > 600,
        ))) ||
    (row.status !== "authorization_required" && row.auth_url !== null) ||
    (row.status === "authorization_required" &&
      typeof row.auth_url !== "string") ||
    (row.status === "browser_sign_in_required" &&
      typeof row.connect_via_portal !== "string") ||
    (row.status !== "browser_sign_in_required" &&
      row.connect_via_portal != null)
  )
    throw new Error(
      "Network authorization could not load. Refresh and try again.",
    );
  return row as unknown as ConnectResult;
}

/** Targets are server-returned choices; selecting one never starts a sync. */
export function importTargets(
  account: NetworkAccount,
): NonNullable<NetworkAccount["import_targets"]> {
  if (
    !readImportProviders.has(account.provider) ||
    account.status !== "connected" ||
    account.auth_type !== "oauth"
  )
    return [];
  const rows = account.import_targets;
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 50)
    throw new Error("Import targets could not load. Refresh network status.");
  const seen = new Set<string>();
  return rows.map((row) => {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 300 ||
      /[\s\x00-\x1f]/.test(row.id) ||
      typeof row.name !== "string" ||
      !row.name ||
      row.name.length > 300 ||
      typeof row.kind !== "string" ||
      row.kind.length > 80 ||
      typeof row.url !== "string" ||
      row.url.length > 1500 ||
      seen.has(row.id)
    )
      throw new Error("Import targets could not load. Refresh network status.");
    seen.add(row.id);
    return row;
  });
}

export function importTargetInput(account: NetworkAccount, targetId: string) {
  if (
    !account.revision ||
    !uuid.test(account.revision) ||
    !importTargets(account).some((target) => target.id === targetId)
  )
    throw new Error(
      "Refresh network status and select an available public import target.",
    );
  return { target_id: targetId, revision: account.revision };
}
