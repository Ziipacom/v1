import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { request } from "../lib/api";
import { color, font, useTheme } from "../theme";

type PlatformStatus = {
  maintenance_mode: boolean;
  signup_paused: boolean;
  banner: string;
};

/** Public, plain-text operator notice; authorization always stays on the API. */
export function PlatformNotice() {
  useTheme();
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  useEffect(() => {
    let live = true;
    let loading = false;
    async function refresh() {
      if (loading || AppState.currentState === "background") return;
      loading = true;
      try {
        const next = await request<PlatformStatus>("/api/platform/status");
        if (live) setStatus(next);
      } catch {
        // An older API or a temporary outage must not prevent opening Studio.
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      live = false;
      clearInterval(timer);
      listener.remove();
    };
  }, []);
  const message = status?.banner || (status?.maintenance_mode
    ? "Ziipa maintenance: creator changes are temporarily paused."
    : status?.signup_paused ? "New Ziipa registrations are temporarily paused." : "");
  if (!message) return null;
  return <View accessibilityRole="alert" style={{ backgroundColor: color.panel, paddingHorizontal: 18, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: color.purple }}>
    <Text style={{ color: color.text, fontFamily: font.medium, fontSize: 13 }}>{message}</Text>
  </View>;
}
