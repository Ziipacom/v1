import type { ImageSourcePropType } from "react-native";
import { privateMediaPath } from "./domain";
import { apiOrigin } from "./config";

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
  if (token && privateMediaPath(path))
    return {
      uri: apiOrigin + path,
      headers: { Authorization: `Bearer ${token}` },
    };
  return background;
}
export function playbackSource(path: string | null, token?: string) {
  if (path === "/media/sintel-trailer.mp4")
    return require("../../assets/media/sintel-trailer.mp4") as number;
  if (path && token && privateMediaPath(path))
    return {
      uri: apiOrigin + path,
      headers: { Authorization: `Bearer ${token}` },
      useCaching: false,
    };
  return null;
}
