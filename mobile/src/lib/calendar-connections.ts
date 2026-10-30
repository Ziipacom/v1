/** Only Ziipa may initiate calendar authorization; provider redirects happen
 * server-side after browser-session binding, never from an arbitrary API URL. */
export function calendarAuthorizationUrl(value: string, apiOrigin: string) {
  const origin = new URL(apiOrigin),
    target = new URL(value);
  const allowed = new Set([origin.origin]);
  if (
    origin.protocol === "https:" &&
    ["api.ziipa.com", "ziipa.com"].includes(origin.hostname)
  )
    allowed.add("https://ziipa.com");
  if (
    !allowed.has(target.origin) ||
    target.username ||
    target.password ||
    target.hash ||
    !(
      target.protocol === "https:" ||
      (target.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(target.hostname))
    )
  ) {
    throw new Error("The calendar authorization link could not be verified.");
  }
  const authorize =
    /^\/api\/os\/calendar\/connections\/oauth\/(google|microsoft)\/authorize$/.test(
      target.pathname,
    );
  const portal =
    target.pathname === "/studio/" &&
    target.searchParams.get("view") === "calendar";
  if (!(
    (authorize &&
      /^[A-Za-z0-9_-]{32,200}$/.test(
        target.searchParams.get("ticket") || "",
      )) ||
    portal
  )) {
    throw new Error("The calendar authorization link could not be verified.");
  }
  for (const key of target.searchParams.keys()) {
    if (!((authorize && key === "ticket") || (portal && key === "view")))
      throw new Error("Unexpected calendar authorization parameters.");
  }
  return target.href;
}
