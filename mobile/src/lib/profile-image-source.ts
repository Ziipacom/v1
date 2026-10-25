import { useMemo } from "react";
import {
  Platform,
  type ImageSourcePropType,
  type ImageURISource,
} from "react-native";
import { coverSource, localImages } from "./assets";
import { apiOrigin, canonicalApiOrigin } from "./config";
import { trustedProfileImagePath } from "./private-profile-image";

/** Native Image supports authorization headers; only the closed owner path is allowed. */
export function useProfileImageSource(
  path?: string | null,
  token?: string,
): ImageSourcePropType | null {
  return useMemo(() => {
    if (!path) return null;
    if (localImages[path]) return coverSource(path);
    if (
      !token ||
      !trustedProfileImagePath(path, [apiOrigin, canonicalApiOrigin])
    )
      return null;
    const source = coverSource(path, token);
    // RN 0.86 Android forwards authenticated headers only from an array source.
    // The trusted owner path above guarantees this is a remote URI source.
    return Platform.OS === "android" ? [source as ImageURISource] : source;
  }, [path, token]);
}
