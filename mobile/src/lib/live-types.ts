export type LiveStatus =
  | "creating"
  | "provisioning_unknown"
  | "prepared"
  | "awaiting_media"
  | "live"
  | "unknown"
  | "ending"
  | "ended";
export type LiveConfig = {
  configured: boolean;
  provider: "livepeer";
  browser_ingest: "whip";
  native_ingest: "whip" | "external_encoder";
  poll_interval_seconds: number;
  detail: string;
};
export type LiveBroadcast = {
  id: string;
  request_id: string;
  title: string;
  description: string;
  provider: "livepeer";
  status: LiveStatus;
  live: boolean;
  record: boolean;
  playback_url: string | null;
  created_at: string;
  checked_at: string | null;
  ended_at: string | null;
  detail: string;
};
export type LiveIngest = {
  stream_id: string;
  whip_url: string;
  rtmp_server: string;
  stream_key: string;
  detail: string;
};
export type PublicLiveBroadcast = Omit<
  LiveBroadcast,
  "request_id" | "record" | "ended_at"
>;
export type LiveTransmitterHandle = { stopLocal: () => void };
export type LiveTransmitterProps = {
  enabled: boolean;
  canStart: boolean;
  busy: boolean;
  onStart: () => Promise<LiveIngest>;
  onStop: () => Promise<void>;
  onTransport: (message: string) => void;
};

export function verifiedLive(
  value: Pick<LiveBroadcast, "live" | "status" | "checked_at">,
  now = Date.now(),
) {
  const checked = value.checked_at ? Date.parse(value.checked_at) : NaN;
  return (
    value.live === true &&
    value.status === "live" &&
    Number.isFinite(checked) &&
    checked <= now + 5000 &&
    now - checked <= 20000
  );
}

export function liveStatusLabel(
  value: Pick<LiveBroadcast, "live" | "status" | "checked_at">,
  now = Date.now(),
) {
  if (verifiedLive(value, now)) return "LIVE · verified by Livepeer";
  const labels: Record<LiveStatus, string> = {
    creating: "Preparing broadcast",
    provisioning_unknown: "Setup needs review",
    prepared: "Ready to connect",
    awaiting_media: "Waiting for incoming media",
    live: "Checking live status",
    unknown: "Status not verified",
    ending: "Confirming broadcast ended",
    ended: "Broadcast ended",
  };
  return labels[value.status] || "Status not verified";
}

export function checkedLivePlayback(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 1000 ||
    /[%\\\r\n\t]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    const allowed =
      [
        "playback.livepeer.studio",
        "livepeercdn.studio",
        "livepeercdn.com",
        "lp-playback.studio",
      ].includes(url.hostname) ||
      url.hostname.endsWith(".livepeercdn.studio") ||
      url.hostname.endsWith(".lp-playback.studio");
    if (
      !allowed ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith(".m3u8") ||
      value.includes("..")
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function checkedWhipUrl(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^https:\/\/playback\.livepeer\.studio\/webrtc\/[A-Za-z0-9_-]{8,128}$/.test(
      value,
    )
  )
    throw new Error("The API returned an invalid Livepeer ingest endpoint.");
  return value;
}

export function checkedLivepeerEdge(value: string) {
  const url = new URL(value);
  // lp-playback.studio is the regional edge returned by the official
  // playback.livepeer.studio HEAD discovery (verified without a real key).
  const allowed = [
    "livepeer.studio",
    "livepeercdn.studio",
    "lp-playback.studio",
  ].some((host) => url.hostname === host || url.hostname.endsWith("." + host));
  if (
    url.protocol !== "https:" ||
    !allowed ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    /[\\\r\n]/.test(value)
  )
    throw new Error(
      "The provider returned an unsupported broadcast edge. Ask the administrator to verify its domain.",
    );
  return url;
}

export function checkedIngest(value: LiveIngest, id: string) {
  if (
    value.stream_id !== id ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value.stream_key) ||
    value.rtmp_server !== "rtmp://rtmp.livepeer.studio/live"
  )
    throw new Error("The API returned invalid encoder settings.");
  checkedWhipUrl(value.whip_url);
  if (!value.whip_url.endsWith("/" + value.stream_key))
    throw new Error("Encoder settings do not match this broadcast.");
  return value;
}

export async function boundedSdp(response: Response) {
  if (
    !response.ok ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/sdp")
  )
    throw new Error(
      "Livepeer did not accept the broadcast connection. Stop and retry.",
    );
  if (!response.body)
    throw new Error("The provider returned no broadcast answer.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 256 * 1024)
        throw new Error("The provider returned an oversized broadcast answer.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const value = new TextDecoder().decode(joined);
  if (!value.startsWith("v=0"))
    throw new Error("The provider returned an invalid broadcast answer.");
  return value;
}
