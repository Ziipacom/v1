export const internalBetaScope = "ios-internal-testflight";
export const externalBetaScope = "ios-external-testflight";
export const externalBetaPrivacyUrl = "https://ziipa.com/privacy-beta";
export const externalBetaNotice =
  "Limited iPhone beta · existing Ziipa accounts only (18+). Saved uploads and edits use your live account. Wallet actions, new network imports and remote push are unavailable. Video rendering is unavailable.";
export const internalBetaNotice =
  "Private iPhone beta · existing accounts only. Your live Ziipa account stores saved uploads and edits. Wallet actions, new network imports and remote push are unavailable. Video rendering is unavailable; device acceptance is pending. External testing and public release are not approved.";

export function isIosInternalBeta(platform: string, scope: string | undefined) {
  return platform === "ios" && scope === internalBetaScope;
}

export function isIosExternalBeta(platform: string, scope: string | undefined) {
  return platform === "ios" && scope === externalBetaScope;
}

export function isIosLimitedBeta(platform: string, scope: string | undefined) {
  return isIosInternalBeta(platform, scope) || isIosExternalBeta(platform, scope);
}

export type InternalBetaAction =
  "registration" | "wallet" | "network-import" | "remote-push";
export function assertInternalBetaAction(
  locked: boolean,
  action: InternalBetaAction,
) {
  if (!locked) return;
  const message = {
    registration:
      "This private iPhone beta supports existing Ziipa accounts only. New account registration is unavailable.",
    wallet:
      "Wallet pairing, signatures and transactions are unavailable in this private iPhone beta.",
    "network-import":
      "New network connections, authorization and imports are unavailable in this private iPhone beta. Existing authorizations can still be disconnected.",
    "remote-push":
      "Remote push enrollment is unavailable in this private iPhone beta. In-app notifications and privacy preferences remain available.",
  }[action];
  throw new Error(message);
}

/** Apply before every native transport, including the direct PUT/PATCH helpers. */
export function assertInternalBetaRequest(
  locked: boolean,
  path: string,
  method = "GET",
) {
  if (!locked) return;
  const route = path.split(/[?#]/, 1)[0];
  // Known API routes need no escaped path bytes. Reject ambiguous spellings
  // instead of allowing URL/server normalization to bypass a restricted route.
  if (/%|\\|\/\/|[\x00-\x20]/.test(route) || /\/\.{1,2}(?:\/|$)/.test(route))
    throw new Error("This private beta cannot use an ambiguous API route.");
  const canonical = route.replace(/\/$/, "").toLowerCase();
  if (/^\/api\/(?:mobile\/)?auth\/register$/.test(canonical))
    assertInternalBetaAction(true, "registration");
  if (
    method.toUpperCase() === "POST" &&
    canonical === "/api/notifications/devices"
  )
    assertInternalBetaAction(true, "remote-push");
  if (/^\/api\/web3(?:\/|$)/.test(canonical)) {
    // Unlinking a saved server association is privacy cleanup, not pairing.
    if (method.toUpperCase() === "GET" && canonical === "/api/web3/wallets")
      return;
    if (
      method.toUpperCase() === "POST" &&
      /^\/api\/web3\/wallets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/unlink$/.test(
        canonical,
      )
    )
      return;
    assertInternalBetaAction(true, "wallet");
  }
  if (
    /^\/api\/social\/oauth(?:\/|$)/.test(canonical) ||
    /^\/api\/social\/[^/]+\/(?:connect|link|import-target|sync)(?:\/|$)/.test(
      canonical,
    ) ||
    /^\/api\/publishing\/oauth(?:\/|$)/.test(canonical) ||
    /^\/api\/publishing\/connections\/[^/]+\/target(?:\/|$)/.test(canonical)
  )
    assertInternalBetaAction(true, "network-import");
  if (
    method.toUpperCase() !== "GET" &&
    /^\/api\/os\/workflows(?:\/|$)/.test(canonical)
  ) {
    // Existing workflow actions can perform Bluesky sync without using the
    // Connections screen. Keep pause/cancel/delete cleanup available.
    const cleanup =
      method.toUpperCase() === "DELETE" ||
      (method.toUpperCase() === "POST" &&
        /\/(?:pause|cancel)$/.test(canonical));
    if (!cleanup) assertInternalBetaAction(true, "network-import");
  }
}
