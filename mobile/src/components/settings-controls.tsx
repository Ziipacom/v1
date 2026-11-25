import { useCallback, useEffect, useRef, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Linking, Platform, Switch, Text, View } from "react-native";
import {
  Bell,
  Monitor,
  RefreshCw,
  Settings,
  Volume2,
} from "lucide-react-native";
import { useDevicePreferences } from "./device-preferences";
import { Action, IconButton, Notice, Pill } from "./ui";
import { InfoTip } from "./info-tip";
import { useDesktopLayout } from "./desktop-layout";
import { workspace } from "./desktop-workspace";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import { creatorRequest } from "../lib/creator-request";
import {
  notificationPreferenceInput,
  notificationRoot,
  type PushDevice,
  type PushPreferences,
} from "../lib/notification-types";
import type {
  AppearancePreference,
  DevicePreferences,
} from "../lib/device-preferences";
import type { RootStack } from "../lib/types";
import { color, styles } from "../theme";

type Props = {
  navigation: Pick<NativeStackNavigationProp<RootStack>, "navigate">;
};
export function SettingsControls(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedSettingsControls key={session?.access_token || "guest"} {...props} />
  );
}
function ScopedSettingsControls({ navigation }: Props) {
  const { desktop } = useDesktopLayout();
  const { session, api } = useZiipa();
  const device = useDevicePreferences();
  const focused = useIsFocused();
  const capture = useOperationScope(session?.access_token || "guest", focused);
  const [preferences, setPreferences] = useState<PushPreferences | null>(null);
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const load = useCallback(async () => {
    if (!session || !focused || lock.current) return;
    const valid = capture();
    setLoading(true);
    setError("");
    setPreferences(null);
    setDevices(null);
    try {
      const [settings, registered] = await Promise.all([
        api<PushPreferences>(`${notificationRoot}/preferences`),
        api<PushDevice[]>(`${notificationRoot}/devices`),
      ]);
      if (valid()) {
        setPreferences(settings);
        setDevices(registered);
      }
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "Notification preferences could not load.",
        );
    } finally {
      if (valid()) setLoading(false);
    }
  }, [api, session?.access_token, focused, capture]);
  useEffect(() => {
    void load();
  }, [load]);
  async function turnOffPush() {
    if (!session || !preferences || lock.current || !focused) return;
    const valid = capture();
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await creatorRequest<PushPreferences>(
        `${notificationRoot}/preferences`,
        session.access_token,
        "PUT",
        notificationPreferenceInput(
          false,
          preferences.categories,
          preferences.revision,
          false,
        ),
      );
      if (valid()) {
        setPreferences(next);
        setMessage("Account notifications are off.");
      }
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "Notifications could not be disabled. Refresh and try again.",
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function saveDevice(patch: Partial<DevicePreferences>) {
    if (!device.ready || deviceBusy) return;
    setDeviceBusy(true);
    setError("");
    setMessage("");
    try {
      await device.update(patch);
      setMessage("Saved on this device.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This preference could not be saved on your device.",
      );
    } finally {
      setDeviceBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      {!!error && <Notice error text={error} />}
      {!!device.error && <Notice error text={device.error} />}
      {!!message && (
        <Text accessibilityLiveRegion="polite" style={styles.small}>
          {message}
        </Text>
      )}
      <View style={[styles.panel, desktop && workspace.panel]}>
        <View style={styles.row}>
          <Monitor size={21} color={color.lime} />
          <Text accessibilityRole="header" style={styles.heading}>
            Appearance
          </Text>
          <InfoTip
            title="appearance"
            content="Theme and playback preferences are saved on this device. Videos, editing canvases and overlays keep their actual colors."
          />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(["system", "dark", "light"] as AppearancePreference[]).map(
            (appearance) => (
              <Pill
                key={appearance}
                title={
                  appearance === "system"
                    ? "System"
                    : appearance === "dark"
                      ? "Dark"
                      : "Light"
                }
                active={device.preferences.appearance === appearance}
                onPress={() => {
                  if (device.ready && !deviceBusy)
                    void saveDevice({ appearance });
                }}
              />
            ),
          )}
        </View>
      </View>
      <View style={[styles.panel, desktop && workspace.panel]}>
        <View style={styles.row}>
          <Volume2 size={21} color={color.lime} />
          <Text accessibilityRole="header" style={styles.heading}>
            Playback & motion
          </Text>
        </View>
        {(
          [
            ["autoplay", "Autoplay", "When off, press Play for each creation."],
            [
              "startMuted",
              "Start muted",
              "Choose the starting audio state when you move to another creation. Your browser may still require a Play gesture.",
            ],
            [
              "reduceMotion",
              "Reduce motion",
              "Limit gallery animation and automatic transitions. Your system's reduced-motion preference is always respected.",
            ],
          ] as const
        ).map(([key, label, detail]) => (
          <View key={key} style={styles.between}>
            <Text style={[styles.body, { flex: 1 }]}>{label}</Text>
            <InfoTip title={label} content={detail} />
            <Switch
              accessibilityLabel={label}
              value={device.preferences[key]}
              disabled={!device.ready || deviceBusy}
              trackColor={{ true: color.purple }}
              onValueChange={(value) => void saveDevice({ [key]: value })}
            />
          </View>
        ))}
      </View>
      <View style={[styles.panel, desktop && workspace.panel]}>
        <View style={styles.row}>
          <Bell size={21} color={color.lime} />
          <Text
            accessibilityRole="header"
            style={[styles.heading, { flex: 1 }]}
          >
            Notifications
          </Text>
          <IconButton
            label="Refresh notification status"
            icon={RefreshCw}
            disabled={loading || !session || busy}
            onPress={() => void load()}
          />
        </View>
        <View style={styles.between}>
          <Text style={[styles.body, { flex: 1 }]}>Account push</Text>
          <InfoTip
            title="account push"
            content="Choose categories and enable your device in Notifications. This control doesn’t request permission or register a device."
          />
          <Switch
            accessibilityLabel="Push notifications for my account"
            value={preferences?.enabled === true}
            disabled={!session || !preferences || loading || busy}
            trackColor={{ true: color.purple }}
            onValueChange={(value) => {
              if (value)
                navigation.navigate("Notifications", { tab: "Preferences" });
              else void turnOffPush();
            }}
          />
        </View>
        <Text style={styles.small}>
          {!session
            ? "Sign in to manage notifications."
            : loading
              ? "Checking…"
              : preferences
                ? `${preferences.enabled ? "On" : "Off"} · ${devices ? devices.filter((value) => value.status === "active").length + " registered devices" : "Devices unavailable"}`
                : "Notifications unavailable"}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Action
            title="Manage notifications"
            icon={Bell}
            secondary
            disabled={busy}
            onPress={() =>
              navigation.navigate("Notifications", { tab: "Preferences" })
            }
          />
          {Platform.OS === "web" ? (
            <InfoTip
              title="browser permissions"
              content="Use the site controls beside your address bar to check Notifications, Camera and Microphone."
            />
          ) : (
            <IconButton
              icon={Settings}
              label="Open device permission settings"
              onPress={() => {
                void Linking.openSettings().catch(() =>
                  setError(
                    "Open your device Settings app, choose Ziipa, and review permissions there.",
                  ),
                );
              }}
            />
          )}
        </View>
      </View>
    </View>
  );
}
