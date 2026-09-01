import { Platform } from "react-native";

// EXPO_PUBLIC values are bundled and must never contain secrets.
export const apiOrigin = (
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "web" && typeof globalThis.location !== "undefined"
    ? globalThis.location.origin
    : "") ||
  (__DEV__
    ? Platform.OS === "android"
      ? "http://10.0.2.2:8018"
      : "http://127.0.0.1:8018"
    : "")
).replace(/\/$/, "");
export const demoEnabled =
  __DEV__ || process.env.EXPO_PUBLIC_ENABLE_DEMO === "true";
export const conceptsEnabled =
  __DEV__ || process.env.EXPO_PUBLIC_ENABLE_CONCEPTS === "true";
export const policyVersion = "2026-08-31";
export const legalUrls = {
  privacy: process.env.EXPO_PUBLIC_PRIVACY_URL || "",
  terms: process.env.EXPO_PUBLIC_TERMS_URL || "",
  community: process.env.EXPO_PUBLIC_COMMUNITY_URL || "",
};
export const supportEmail =
  process.env.EXPO_PUBLIC_SUPPORT_EMAIL || "hello@ziipa.com";

export function validateOrigin(origin = apiOrigin) {
  if (!origin)
    throw new Error("A Ziipa API address is required for this build.");
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Use an API origin without credentials, a path, or query parameters.",
    );
  if (url.protocol !== "https:" && !(__DEV__ && url.protocol === "http:"))
    throw new Error("Release builds require a secure HTTPS API.");
  return url.origin;
}
