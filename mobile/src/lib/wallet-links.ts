/** Only a fresh WalletConnect v2 pairing URI may enter the MetaMask deeplink. */
export function metaMaskPairingLink(uri: string) {
  if (
    !/^wc:[0-9a-f]{64}@2\?/.test(uri) ||
    uri.length > 4096 ||
    /[\s\x00-\x1f]/.test(uri)
  )
    throw new Error("The wallet connection expired. Start a new connection.");
  const params = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
  if (
    !/^[0-9a-f]{64}$/.test(params.get("symKey") || "") ||
    params.get("relay-protocol") !== "irn"
  )
    throw new Error(
      "The wallet connection is invalid. Start a new connection.",
    );
  return "metamask://wc?uri=" + encodeURIComponent(uri);
}
