import { useMemo } from "react";
import type { ImageSourcePropType } from "react-native";
import { coverSource, localImages } from "./assets";
import { apiOrigin, canonicalApiOrigin } from "./config";
import { trustedProfileImagePath } from "./private-profile-image";

/** Native Image supports authorization headers; only the closed owner path is allowed. */
export function useProfileImageSource(path?: string | null, token?: string): ImageSourcePropType | null {
  return useMemo(() => {
    if (!path) return null;
    if (localImages[path]) return coverSource(path);
    return token && trustedProfileImagePath(path, [apiOrigin, canonicalApiOrigin]) ? coverSource(path, token) : null;
  }, [path, token]);
}
