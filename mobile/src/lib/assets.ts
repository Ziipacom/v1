import type { ImageSourcePropType } from "react-native";
import { trustedMediaPath } from "./domain";
import { apiOrigin, canonicalApiOrigin, authorizationHeaders } from "./config";
import { localPlaybackSource } from "./local-media";

export const logo = require("../../assets/brand/ziipa-logo.png");
export const background = require("../../assets/brand/ziipa-background.png");
export const localImages: Record<string, ImageSourcePropType> = {
  "/media/dj.jpg": require("../../assets/media/dj.jpg"),
  "/media/gaming.jpg": require("../../assets/media/gaming.jpg"),
  "/media/ocean.jpg": require("../../assets/media/ocean.jpg"),
  "/media/studio.jpg": require("../../assets/media/studio.jpg"),
  "/media/sintel.png": require("../../assets/media/sintel.png"),
  "/brand/ziipa-background.png": background,
};
export function coverSource(path: string, token?: string): ImageSourcePropType {
  if (localImages[path]) return localImages[path];
  const owned = trustedMediaPath(path, [apiOrigin, canonicalApiOrigin]);
  if (token && owned)
    return {
      uri: apiOrigin + owned,
      headers: authorizationHeaders(token),
    };
  return background;
}
export function playbackSource(path: string | null, token?: string, localDraft = false) {
  const local = localPlaybackSource(path, localDraft);
  if (local) return local;
  if (path === "/media/sintel-trailer.mp4")
    return require("../../assets/media/sintel-trailer.mp4") as number;
  const owned = path && trustedMediaPath(path, [apiOrigin, canonicalApiOrigin]);
  if (token && owned)
    return {
      uri: apiOrigin + owned,
      headers: authorizationHeaders(token),
      useCaching: false,
    };
  return null;
}
