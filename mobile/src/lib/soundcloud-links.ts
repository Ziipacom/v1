/** A narrow WebView whitelist auto-opens outsiders in the OS before validation. */
export const soundCloudWidgetNavigationOrigins = ["*"] as const;

/** Official public links only. No private secret tokens, raw streams or embeds elsewhere. */
export function soundCloudPermalink(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://soundcloud.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function soundCloudWidgetUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://w.soundcloud.com" ||
      url.pathname !== "/player/" ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const expected = [
      "url",
      "auto_play",
      "show_comments",
      "show_reposts",
      "visual",
    ];
    const keys = [...url.searchParams.keys()];
    if (
      keys.length !== expected.length ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !expected.includes(key))
    )
      return null;
    if (
      !soundCloudPermalink(url.searchParams.get("url")) ||
      ["auto_play", "show_comments", "show_reposts", "visual"].some(
        (key) => url.searchParams.get(key) !== "false",
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function soundCloudAuthorizationUrl(value: unknown, origins: string[]) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    const ticket = url.searchParams.get("ticket");
    if (
      !origins.includes(url.origin) ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/api/music/soundcloud/oauth/authorize" ||
      [...url.searchParams.keys()].join() !== "ticket" ||
      !ticket ||
      !/^[A-Za-z0-9_-]{20,512}$/.test(ticket)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function soundCloudPortalUrl(value: unknown, origins: string[]) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      !origins.includes(url.origin) ||
      url.username ||
      url.password ||
      url.hash ||
      !["/portal", "/studio/index.html"].includes(url.pathname)
    )
      return null;
    const entries = [...url.searchParams.entries()];
    if (
      entries.some(([key, entry]) => key !== "view" || entry !== "networks") ||
      entries.length > 1
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function soundCloudTrackId(value: string) {
  return /^soundcloud:tracks:[1-9]\d{0,19}$/.test(value)
    ? encodeURIComponent(value)
    : null;
}
