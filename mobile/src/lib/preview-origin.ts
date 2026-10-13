type PreviewEnvironment = {
  development: boolean;
  web: boolean;
  portal: boolean;
  pageHostname: string;
};

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function isPrivateIPv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/** Keep the local browser preview on its loopback host; devices retain the LAN address. */
export function browserPreviewApiOrigin(
  configured: string,
  environment: PreviewEnvironment,
): string {
  const page = environment.pageHostname.toLowerCase();
  if (
    !environment.development ||
    !environment.web ||
    environment.portal ||
    !["localhost", "127.0.0.1", "[::1]"].includes(page)
  )
    return configured;
  try {
    const target = new URL(configured);
    // Preserve invalid settings so the existing origin validator rejects them.
    if (
      target.protocol !== "http:" ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash ||
      !(isLoopback(target.hostname) || isPrivateIPv4(target.hostname))
    )
      return configured;
    target.hostname = page;
    return target.origin;
  } catch {
    return configured;
  }
}
