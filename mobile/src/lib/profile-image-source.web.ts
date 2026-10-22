import { useEffect, useMemo, useRef, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import { coverSource, localImages } from "./assets";
import { apiOrigin, canonicalApiOrigin, portalMode } from "./config";
import { privateProfileImageLease, trustedProfileImagePath } from "./private-profile-image";

/** RN Web Image ignores source.headers, so bearer sessions use an owned blob lease. */
export function useProfileImageSource(path?: string | null, token?: string): ImageSourcePropType | null {
  const identity = useMemo(() => ({}), [path, token]);
  const owned = path ? trustedProfileImagePath(path, [apiOrigin, canonicalApiOrigin]) : null;
  const authenticated = !portalMode && !!owned && !!token;
  const [foreground, setForeground] = useState(typeof document === "undefined" || document.visibilityState !== "hidden");
  const [loaded, setLoaded] = useState<{ identity: object; source: ImageSourcePropType } | null>(null);
  const resource = useRef<{ abort: () => void; dispose: () => void } | null>(null);
  const base = useMemo(() => {
    if (!path) return null;
    if (localImages[path]) return coverSource(path);
    return token && owned ? coverSource(path, token) : null;
  }, [path, token, owned]);
  useEffect(() => {
    const visibility = () => {
      const visible = document.visibilityState !== "hidden";
      if (!visible) {
        resource.current?.abort();
        resource.current?.dispose();
        // Foreground can render before passive effects recreate this lease.
        // Never hand Image a URL that this handler has already revoked.
        setLoaded(null);
      }
      setForeground(visible);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!authenticated || !foreground || !path || !token) return;
    let current = true;
    const controller = new AbortController();
    let lease: Awaited<ReturnType<typeof privateProfileImageLease>> | undefined;
    const handle = { abort: () => controller.abort(), dispose: () => lease?.dispose() };
    resource.current = handle;
    setLoaded(null);
    void privateProfileImageLease({ path, token, apiOrigin,
      trustedOrigins: [apiOrigin, canonicalApiOrigin], signal: controller.signal,
    }).then((value) => {
      lease = value;
      if (!current || controller.signal.aborted) { value.dispose(); return; }
      setLoaded({ identity, source: { uri: value.uri } });
    }).catch(() => {
      // The caller retains its initial/brand fallback; never retry with an unauthenticated URL.
      if (current && !controller.signal.aborted) setLoaded(null);
    });
    return () => {
      current = false;
      controller.abort();
      lease?.dispose();
      if (resource.current === handle) resource.current = null;
    };
  }, [authenticated, foreground, identity, path, token]);
  if (authenticated) return foreground && loaded?.identity === identity ? loaded.source : null;
  return base;
}
