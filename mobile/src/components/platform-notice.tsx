import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { request } from "../lib/api";
import { color, font, useTheme } from "../theme";
import {
  androidPlayInternal,
  iosExternalTestflight,
  iosLimitedTestflight,
} from "../lib/config";
import {
  androidPlayInternalNotice,
  externalBetaNotice,
  internalBetaNotice,
} from "../lib/internal-beta-policy";
import { InfoTip } from "./info-tip";

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
  const operatorMessage =
    status?.banner ||
    (status?.maintenance_mode
      ? "Ziipa maintenance: creator changes are temporarily paused."
      : status?.signup_paused
        ? "New Ziipa registrations are temporarily paused."
        : "");
  const betaDetails = androidPlayInternal
    ? androidPlayInternalNotice
    : iosLimitedTestflight
      ? iosExternalTestflight
        ? externalBetaNotice
        : internalBetaNotice
      : "";
  if (!betaDetails && !operatorMessage) return null;
  return (
    <View
      style={{
        backgroundColor: color.panel,
        paddingHorizontal: 16,
        paddingVertical: 3,
        borderBottomWidth: 1,
        borderBottomColor: color.border,
      }}
    >
      {!!betaDetails && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: color.lime,
            }}
          />
          <Text
            style={{
              color: color.text,
              fontFamily: font.semibold,
              fontSize: 12,
            }}
          >
            Beta
          </Text>
          <Text style={{ color: color.muted, fontSize: 12, flexShrink: 1 }}>
            Changes use your live account
          </Text>
          <InfoTip title="beta access" content={betaDetails} />
        </View>
      )}
      {!!operatorMessage && (
        <Text
          accessibilityRole="alert"
          style={{
            color: color.text,
            fontFamily: font.medium,
            fontSize: 13,
            paddingVertical: 5,
          }}
        >
          {operatorMessage}
        </Text>
      )}
    </View>
  );
}
