import { useMemo } from "react";
import { Platform, type ImageSourcePropType } from "react-native";
import { apiOrigin, authorizationHeaders } from "./config";
import { storePhotoPath } from "./commerce";

export function useStorePhotoSource(path?: string, token?: string): ImageSourcePropType | null {
  return useMemo(() => {
    const safe = storePhotoPath(path);
    if (!safe || !token) return null;
    const source = { uri: apiOrigin + safe, headers: authorizationHeaders(token) };
    return Platform.OS === "android" ? [source] : source;
  }, [path, token]);
}
