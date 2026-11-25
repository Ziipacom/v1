export const internalBetaScope = "ios-internal-testflight";
export const externalBetaScope = "ios-external-testflight";
export const androidPlayInternalScope = "android-play-internal";
// Keep the reviewed preview name compatible with the deployed store profile.
export const playInternalBetaScope = androidPlayInternalScope;
export const externalBetaPrivacyUrl = "https://ziipa.com/privacy-beta";
export const externalBetaNotice =
  "Limited iPhone beta · existing Ziipa accounts only (18+). Saved uploads and edits use your live account. Token Wallet supports test networks only, subject to service setup. New network imports and remote push are unavailable. Video rendering is unavailable.";
export const internalBetaNotice =
  "Private iPhone beta · existing accounts only. Your live Ziipa account stores saved uploads and edits. Token Wallet supports test networks only, subject to service setup. New network imports and remote push are unavailable. Video rendering is unavailable; device acceptance is pending. External testing and public release are not approved.";
export const androidPlayInternalNotice =
  "Private Google Play beta · existing Ziipa accounts only (18+). Saved uploads and edits use your live account. Token Wallet supports test networks only, subject to service setup. New network imports, remote push and live purchases are unavailable. Merchandise test checkout requires sandbox setup.";
export const playInternalBetaNotice = androidPlayInternalNotice;

export function isIosInternalBeta(platform: string, scope: string | undefined) {
  return platform === "ios" && scope === internalBetaScope;
}

export function isIosExternalBeta(platform: string, scope: string | undefined) {
  return platform === "ios" && scope === externalBetaScope;
}

export function isIosLimitedBeta(platform: string, scope: string | undefined) {
  return isIosInternalBeta(platform, scope) || isIosExternalBeta(platform, scope);
}

export function isAndroidPlayInternalBeta(platform: string, scope: string | undefined) {
  return platform === "android" && scope === androidPlayInternalScope;
}

export function isLimitedStoreBeta(platform: string, scope: string | undefined) {
  return isIosLimitedBeta(platform, scope) || isAndroidPlayInternalBeta(platform, scope);
}

export function isPlayInternalBeta(platform: string, scope: string | undefined) {
  return isAndroidPlayInternalBeta(platform, scope);
}

export type InternalBetaAction =
  "registration" | "wallet" | "network-publish" | "network-import" | "remote-push" | "purchase";
export function assertInternalBetaAction(
  locked: boolean,
  action: InternalBetaAction,
) {
  // Wallet testing is explicitly available in the next beta. Its connector and
  // backend independently enforce test networks and external approval.
  if (!locked || action === "wallet" || action === "network-publish") return;
  const message = {
    registration:
      "This private beta supports existing Ziipa accounts only.",
    wallet:
      "Wallet pairing, signatures and transactions are unavailable in this limited native beta.",
    "network-import":
      "New network connections, authorization and imports are unavailable in this limited native beta. Existing authorizations can still be disconnected.",
    "remote-push":
      "Remote push enrollment is unavailable in this limited native beta. In-app notifications and privacy preferences remain available.",
    purchase:
      "Purchases are unavailable in this limited native beta. Proposed service packages can be reviewed without buying.",
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
  if (method.toUpperCase() !== "GET" && canonical === "/api/services/purchase-context")
    assertInternalBetaAction(true, "purchase");
  if (/^\/api\/(?:mobile\/)?auth\/register$/.test(canonical))
    assertInternalBetaAction(true, "registration");
  if (
    method.toUpperCase() === "POST" &&
    canonical === "/api/notifications/devices"
  )
    assertInternalBetaAction(true, "remote-push");
  // Web3 endpoints are available for explicit testnet wallet testing. Keep all
  // unrelated beta restrictions and ambiguous-route checks in place.
  if (
    /^\/api\/social\/oauth(?:\/|$)/.test(canonical) ||
    /^\/api\/social\/[^/]+\/(?:connect|link|import-target|sync)(?:\/|$)/.test(
      canonical,
    )
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
