import { authorizationHeaders, portalMode, validateOrigin } from "./config";
import { ApiError } from "./api";

export type SoundCloudConfig = {
  implemented: true;
  enabled: boolean;
  configured: boolean;
  can_connect: boolean;
  connected: boolean;
  can_search: boolean;
  can_play_owned: boolean;
  can_import: false;
  native_oauth_supported: false;
  public_search_enabled: boolean;
  connect_via_portal: string | null;
  requirements: string[];
  detail: string;
  connection: {
    status: "authorized" | "disconnected" | "reauthorization_required";
    revision: number;
    username: string;
    profile_url: string | null;
  } | null;
};
export type SoundCloudTrack = {
  id: string;
  title: string;
  uploader: string;
  permalink_url: string;
  profile_url: string | null;
  duration_ms: number | null;
  sharing: "public" | "private";
  access: "playable" | "preview" | "blocked" | "unknown";
  owned: boolean;
  can_embed: boolean;
  can_import: false;
  license: string;
  attribution: "SoundCloud";
};
export type SoundCloudTracks = {
  scope: "mine" | "public";
  tracks: SoundCloudTrack[];
  has_more: boolean;
  notice: string;
};
export type SoundCloudPlayback = {
  mode: "widget" | "external";
  widget_url: string | null;
  permalink_url: string;
  attribution: "SoundCloud";
  detail: string;
};

export async function disconnectSoundCloud(token: string, revision: number) {
  if (!token || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Refresh the connection before disconnecting SoundCloud.");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(
      `${validateOrigin()}/api/music/soundcloud/connection?revision=${revision}`,
      {
        method: "DELETE",
        headers: authorizationHeaders(token),
        credentials: portalMode ? "include" : "omit",
        redirect: "error",
        signal: abort.signal,
      },
    );
    const value = (await response.json().catch(() => null)) as {
      disconnected?: boolean;
      provider_revoked?: boolean;
      detail?: string;
    } | null;
    if (!response.ok || !value?.disconnected)
      throw new ApiError(
        value?.detail ||
          "SoundCloud could not be disconnected. Refresh its status and try again.",
        response.status,
      );
    return value;
  } finally {
    clearTimeout(timer);
  }
}
