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
import { Action, Notice, Pill } from "./ui";
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
        setMessage(
          "Ziipa push notifications are off for your account. Browser/OS permissions and existing device registrations are unchanged.",
        );
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
      setMessage(
        "Device preference saved. This does not change other devices or grant any permissions.",
      );
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
    <View style={{ gap: 20 }}>
      {!!error && <Notice error text={error} />}
      {!!device.error && <Notice error text={device.error} />}
      {!!message && <Notice text={message} />}
      <View style={[styles.panel, desktop && workspace.panel]}>
        <View style={styles.row}>
          <Monitor size={21} color={color.lime} />
          <Text accessibilityRole="header" style={styles.heading}>
            Appearance
          </Text>
        </View>
        <Text style={styles.small}>
          Choose Ziipa's interface theme. Videos, editing canvases and text
          overlays keep their actual media colors.
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(["system", "dark", "light"] as AppearancePreference[]).map(
            (appearance) => (
              <Pill
                key={appearance}
                title={
                  appearance === "system"
                    ? "Use device setting"
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
        <Text style={styles.small}>
          Appearance and playback preferences stay on this device/browser. They
          are not synced to your Ziipa account.
        </Text>
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
            [
              "autoplay",
              "Autoplay media in feeds and galleries",
              "When off, press Play for each creation.",
            ],
            [
              "startMuted",
              "Start feed media muted",
              "Choose the starting audio state when you move to another creation. Your browser may still require a Play gesture.",
            ],
            [
              "reduceMotion",
              "Reduce motion",
              "Limit gallery animation and automatic transitions. Your system's reduced-motion preference is always respected.",
            ],
          ] as const
        ).map(([key, label, detail]) => (
          <View key={key} style={{ gap: 4 }}>
            <View style={styles.between}>
              <Text style={[styles.body, { flex: 1 }]}>{label}</Text>
              <Switch
                accessibilityLabel={label}
                value={device.preferences[key]}
                disabled={!device.ready || deviceBusy}
                trackColor={{ true: color.purple }}
                onValueChange={(value) => void saveDevice({ [key]: value })}
              />
            </View>
            <Text style={styles.small}>{detail}</Text>
          </View>
        ))}
      </View>
      <View style={[styles.panel, desktop && workspace.panel]}>
        <View style={styles.row}>
          <Bell size={21} color={color.lime} />
          <Text accessibilityRole="header" style={styles.heading}>
            Notifications
          </Text>
        </View>
        <View style={styles.between}>
          <Text style={[styles.body, { flex: 1 }]}>
            Push updates for my account
          </Text>
          <Switch
            accessibilityLabel="Push notifications for my account"
            value={preferences?.enabled === true}
            disabled={!session || !preferences || loading || busy}
            trackColor={{ true: color.purple }}
            onValueChange={(value) => {
              if (value) navigation.navigate("Notifications");
              else void turnOffPush();
            }}
          />
        </View>
        <Text style={styles.small}>
          {!session
            ? "Sign in to manage account notifications."
            : loading
              ? "Checking your saved preferences…"
              : preferences
                ? `${preferences.enabled ? "On" : "Off"} · ${preferences.categories.length ? preferences.categories.join(", ") : "No categories selected"}. ${devices ? `${devices.filter((value) => value.status === "active").length} registered device(s).` : "Device readiness unavailable."}`
                : "Notification settings are unavailable. Refresh before changing them."}
        </Text>
        <Text style={styles.small}>
          Turning on opens category consent and explicit “Enable on this device”
          setup. This switch never requests browser/OS permission or registers a
          device automatically.
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Action
            title="Categories & device permissions"
            icon={Bell}
            secondary
            disabled={busy}
            onPress={() => navigation.navigate("Notifications")}
          />
          <Action
            title="Refresh notification status"
            icon={RefreshCw}
            secondary
            busy={loading}
            disabled={!session || busy}
            onPress={() => void load()}
          />
        </View>
        <Action
          title={
            Platform.OS === "web"
              ? "Browser permission help"
              : "Open device permission settings"
          }
          icon={Settings}
          secondary
          onPress={() => {
            if (Platform.OS === "web")
              setMessage(
                "Use the site-controls icon beside your browser address to review Notifications, Camera and Microphone. Ziipa only asks for a permission when you explicitly use its related feature.",
              );
            else
              void Linking.openSettings().catch(() =>
                setError(
                  "Open your device Settings app, choose Ziipa, and review permissions there.",
                ),
              );
          }}
        />
      </View>
    </View>
  );
}
