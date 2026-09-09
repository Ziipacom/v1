import { useEffect, useMemo, useRef, useState } from "react";
import { playbackSource } from "./assets";
import { localPlaybackSource } from "./local-media";
import { apiOrigin, canonicalApiOrigin, portalMode } from "./config";
import { trustedMediaPath } from "./domain";
import { privateMediaLease } from "./private-media";

export function usePlaybackSource(
  path: string | null,
  token?: string,
  localDraft = false,
  active = true,
  localUri?: string,
) {
  const identity = useMemo(() => ({}), [path, token, localDraft, localUri]);
  const [foreground, setForeground] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [loaded, setLoaded] = useState<{
    identity: object;
    source: { uri: string } | null;
    error: string;
  } | null>(null);
  const resource = useRef<{ abort: () => void; dispose: () => void } | null>(
    null,
  );
  const base = useMemo(
    () =>
      localPlaybackSource(localUri, true) ||
      playbackSource(path, token, localDraft),
    [path, token, localDraft, localUri],
  );
  const local =
    localPlaybackSource(localUri, true) ||
    localPlaybackSource(path, localDraft);
  const owned = path && trustedMediaPath(path, [apiOrigin, canonicalApiOrigin]);
  const authenticated = !portalMode && !local && !!owned && !!token;
  const enabled = active && foreground;
  useEffect(() => {
    const hide = () => {
      const visible = document.visibilityState !== "hidden";
      if (!visible) {
        resource.current?.abort();
        resource.current?.dispose();
      }
      setForeground(visible);
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  useEffect(() => {
    if (!authenticated || !enabled || !path || !token) return;
    let current = true;
    const controller = new AbortController();
    let lease: Awaited<ReturnType<typeof privateMediaLease>> | undefined;
    const handle = {
      abort: () => controller.abort(),
      dispose: () => lease?.dispose(),
    };
    resource.current = handle;
    setLoaded(null);
    void privateMediaLease({
      path,
      token,
      apiOrigin,
      trustedOrigins: [apiOrigin, canonicalApiOrigin],
      signal: controller.signal,
    })
      .then((value) => {
        lease = value;
        if (!current || controller.signal.aborted) {
          value.dispose();
          return;
        }
        setLoaded({ identity, source: { uri: value.uri }, error: "" });
      })
      .catch(() => {
        if (current && !controller.signal.aborted)
          setLoaded({
            identity,
            source: null,
            error:
              "Media could not load. Check your sign-in, connection, supported format and the 100 MB file limit.",
          });
      });
    return () => {
      current = false;
      controller.abort();
      lease?.dispose();
      if (resource.current === handle) resource.current = null;
    };
  }, [authenticated, enabled, identity, path, token]);
  // Mask old data synchronously on identity/source change, before effect cleanup.
  if (authenticated)
    return {
      source: enabled && loaded?.identity === identity ? loaded.source : null,
      loading: enabled && loaded?.identity !== identity,
      error: enabled && loaded?.identity === identity ? loaded.error : "",
    };
  // Same-origin portal playback keeps its existing HttpOnly cookie transport.
  return { source: base, loading: false, error: "" };
}
