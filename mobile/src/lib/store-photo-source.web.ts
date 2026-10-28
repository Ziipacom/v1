import { useEffect, useMemo, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import { apiOrigin, authorizationHeaders, portalMode } from "./config";
import { storePhotoPath } from "./commerce";

export function useStorePhotoSource(path?: string, token?: string): ImageSourcePropType | null {
  const key = token + ":" + path;
  const [result, setResult] = useState<{ key: string; uri: string } | null>(null);
  useEffect(() => {
    const safe = storePhotoPath(path);
    if (!safe || !token) return;
    let active = true,
      uri: string | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    void fetch(apiOrigin + safe, {
      headers: authorizationHeaders(token),
      credentials: portalMode ? "include" : "omit",
      redirect: "error",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (
          !response.ok ||
          !["image/jpeg", "image/png", "image/webp"].includes(
            response.headers.get("content-type")?.split(";")[0] || "",
          )
        )
          throw new Error("Product image unavailable");
        const length = Number(response.headers.get("content-length"));
        if (length > 10 * 1024 * 1024) throw new Error("Oversized product photo");
        const blob = await response.blob();
        if (!active || blob.size > 10 * 1024 * 1024) return;
        uri = URL.createObjectURL(blob);
        setResult({ key, uri });
      })
      .catch(() => {
        if (active) setResult(null);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      if (uri) URL.revokeObjectURL(uri);
    };
  }, [key, path, token]);
  return useMemo(() => result?.key === key ? { uri: result.uri } : null, [result, key]);
}
