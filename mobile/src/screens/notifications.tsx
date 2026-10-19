import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Bell, Check, RefreshCw, ShieldCheck } from "lucide-react-native";
import { Action, Field, Notice } from "../components/ui";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import { creatorRequest } from "../lib/creator-request";
import {
  pushCapability,
  registerPushDevice,
  type PushCapability,
} from "../lib/notification-client";
import {
  notificationCategories,
  notificationPreferenceInput,
  notificationRoot,
  notificationStatus,
  type NotificationCategory,
  type PushConfig,
  type PushDelivery,
  type PushDevice,
  type PushPreferences,
} from "../lib/notification-types";
import type { RootStack } from "../lib/types";
import { color, styles } from "../theme";

type Props = NativeStackScreenProps<RootStack, "Notifications">;
function Consent({
  text,
  checked,
  disabled,
  onPress,
}: {
  text: string;
  checked: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, { gap: 12, paddingVertical: 10 }]}
    >
      <View
        style={{
          width: 25,
          height: 25,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: color.lime,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: checked ? color.purple : "transparent",
        }}
      >
        {checked && <Check color="white" size={18} />}
      </View>
      <Text style={[styles.body, { flex: 1 }]}>{text}</Text>
    </Pressable>
  );
}
export function NotificationsScreen(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedNotificationsScreen
      key={`${session?.access_token || "guest"}:${props.route.params?.deliveryId || ""}`}
      {...props}
    />
  );
}
function ScopedNotificationsScreen({ navigation, route }: Props) {
  const { session, guest, api } = useZiipa();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const capture = useOperationScope(
    session?.access_token || "guest",
    focused && foreground,
  );
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [preferences, setPreferences] = useState<PushPreferences | null>(null);
  const [capability, setCapability] = useState<PushCapability | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [deliveries, setDeliveries] = useState<PushDelivery[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [categories, setCategories] = useState<NotificationCategory[]>([]);
  const [accountConsent, setAccountConsent] = useState(false);
  const [deviceConsent, setDeviceConsent] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mutation = useRef(false);
  const loading = useRef(false);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (value) => {
      if (value === "active") setForeground(true);
      else if (value === "background" || Platform.OS === "web")
        setForeground(false);
    });
    return () => listener.remove();
  }, []);
  const load = useCallback(async () => {
    if (!session || guest || mutation.current || loading.current) return;
    loading.current = true;
    const valid = capture();
    setBusy(true);
    setError("");
    try {
      if (route.params?.deliveryId) {
        try {
          await api(
            `${notificationRoot}/deliveries/${route.params.deliveryId}/opened`,
            {},
          );
        } catch {
          if (valid())
            setMessage(
              "The tapped receipt is unavailable for this account. Your notification settings are still available below.",
            );
        }
        if (!valid()) return;
      }
      const [configuration, settings, installed, receipts, supported] =
        await Promise.all([
          api<PushConfig>(`${notificationRoot}/config`),
          api<PushPreferences>(`${notificationRoot}/preferences`),
          api<PushDevice[]>(`${notificationRoot}/devices`),
          api<PushDelivery[]>(`${notificationRoot}/deliveries`),
          pushCapability(),
        ]);
      if (!valid()) return;
      setConfig(configuration);
      setPreferences(settings);
      setDevices(installed);
      setDeliveries(receipts);
      setCapability(supported);
      setEnabled(settings.enabled);
      setCategories(settings.categories);
      setAccountConsent(false);
      setDeviceConsent(false);
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "Notifications could not be loaded.",
        );
    } finally {
      loading.current = false;
      setBusy(false);
    }
  }, [api, capture, guest, route.params?.deliveryId, session]);
  useEffect(() => {
    if (focused && foreground) void load();
  }, [focused, foreground, load]);
  async function mutate(action: (valid: () => boolean) => Promise<void>) {
    if (busy || mutation.current || loading.current || !session) return;
    mutation.current = true;
    const valid = capture();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action(valid);
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "This notification action could not complete.",
        );
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function save(valid: () => boolean) {
    if (!preferences || !session) return;
    const fields = notificationPreferenceInput(
      enabled,
      categories,
      preferences.revision,
      accountConsent,
    );
    const result = await creatorRequest<PushPreferences>(
      `${notificationRoot}/preferences`,
      session.access_token,
      "PUT",
      fields,
    );
    if (!valid()) return;
    setPreferences(result);
    setEnabled(result.enabled);
    setCategories(result.categories);
    setAccountConsent(false);
    setMessage(
      result.enabled
        ? "Your category preferences are saved. Register this device separately to receive push."
        : "Push is disabled for your account. Browser or OS permissions are managed separately in device settings.",
    );
  }
  async function register(valid: () => boolean) {
    if (!config || !deviceConsent || !preferences?.enabled)
      throw new Error(
        "Enable your account preferences and explicitly consent to register this device first.",
      );
    const registration = await registerPushDevice(config, label, valid);
    if (!valid()) return;
    const device = await api<PushDevice>(
      `${notificationRoot}/devices`,
      registration,
    );
    if (!valid()) return;
    const supported = await pushCapability();
    if (!valid()) return;
    setDevices((previous) => [
      device,
      ...previous.filter((entry) => entry.id !== device.id),
    ]);
    setCapability(supported);
    setDeviceConsent(false);
    setMessage(
      "This device is registered. Registration and provider acceptance do not prove a notification was displayed. Delivery receipts appear below when actual events occur.",
    );
  }
  if (!session || guest)
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
        <Notice text="Sign in to manage private Ziipa updates. No notification permission has been requested." />
        <Action title="Sign in" onPress={() => navigation.navigate("Login")} />
      </ScrollView>
    );
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.page}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.eyebrow}>YOUR ATTENTION, YOUR CHOICE</Text>
      <Text style={styles.title}>Private updates</Text>
      <Notice text="Push is optional. Notifications contain only a generic update category, never private media, calendar notes or post titles. They never start a camera, stream or publication." />
      {!!error && <Notice text={error} error />}
      {!!message && <Notice text={message} />}
      {config && (
        <View style={styles.panel}>
          <Text style={styles.heading}>Delivery readiness</Text>
          <Text style={styles.body}>{config.notice}</Text>
          <Text style={styles.small}>
            Server {config.enabled ? "enabled" : "disabled"} · worker{" "}
            {config.worker_ready ? "ready" : "not ready"} · native{" "}
            {config.expo_ready ? "configured" : "needs setup"} · browser{" "}
            {config.web_ready ? "configured" : "needs setup"}
          </Text>
        </View>
      )}
      <View style={styles.panel}>
        <Text style={styles.heading}>Your account preferences</Text>
        <Consent
          text="Enable push updates for my account"
          checked={enabled}
          disabled={busy}
          onPress={() => {
            setEnabled(!enabled);
            setAccountConsent(false);
          }}
        />
        {notificationCategories.map((category) => (
          <Consent
            key={category}
            text={
              category === "calendar"
                ? "Calendar reminders"
                : category === "recordings"
                  ? "Recording and clip workflow updates"
                  : "Campaign progress and delivery updates"
            }
            checked={categories.includes(category)}
            disabled={busy}
            onPress={() => {
              setCategories((previous) =>
                previous.includes(category)
                  ? previous.filter((value) => value !== category)
                  : [...previous, category],
              );
              setAccountConsent(false);
            }}
          />
        ))}
        {enabled && (
          <Consent
            text="I consent to these selected notification categories. I can disable them at any time."
            checked={accountConsent}
            disabled={busy}
            onPress={() => setAccountConsent(!accountConsent)}
          />
        )}
        <Action
          title="Save notification preferences"
          icon={ShieldCheck}
          disabled={
            busy ||
            !preferences ||
            (enabled && (!accountConsent || !categories.length))
          }
          onPress={() => void mutate(save)}
        />
      </View>
      <View style={styles.panel}>
        <Text style={styles.heading}>This device</Text>
        <Text style={styles.body}>
          {capability?.detail ||
            "Checking notification capabilities without requesting permission…"}
        </Text>
        <Text style={styles.small}>
          OS/browser permission: {capability?.permission || "not checked"}. A
          new native binary is required for the notification module; Expo Go and
          an older APK cannot add it by reloading.
        </Text>
        {Platform.OS === "web" && (
          <Text style={styles.small}>
            Browser taps open the Ziipa portal. They are not recorded as opened
            until you review a receipt inside Studio. Some browsers require
            opening Studio directly in a tab before enabling notifications.
          </Text>
        )}
        <Field
          label="Device name (optional)"
          value={label}
          onChangeText={setLabel}
          maxLength={60}
          editable={!busy}
          placeholder="My phone or work browser"
        />
        <Consent
          text="Enable notifications on this device and save its push subscription to my Ziipa account."
          checked={deviceConsent}
          disabled={busy}
          onPress={() => setDeviceConsent(!deviceConsent)}
        />
        <Action
          title="Enable on this device"
          icon={Bell}
          disabled={
            busy ||
            !deviceConsent ||
            !preferences?.enabled ||
            !capability?.supported ||
            !config?.enabled ||
            !config.worker_ready ||
            !(Platform.OS === "web" ? config.web_ready : config.expo_ready)
          }
          onPress={() => void mutate(register)}
        />
        <Text style={styles.small}>
          Revoking a device below stops Ziipa sending to it; browser/OS
          permission may remain granted. Tokens are never shown or copied into
          this screen.
        </Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.heading}>Registered devices</Text>
        {devices.length === 0 && (
          <Text style={styles.body}>
            No devices registered for this account.
          </Text>
        )}
        {devices.map((device) => (
          <View key={device.id} style={{ gap: 8, paddingVertical: 12 }}>
            <Text style={styles.body}>
              {device.label} · {device.provider}
            </Text>
            <Text style={styles.small}>
              {notificationStatus(device.status)} · last registration{" "}
              {new Date(device.last_registered_at).toLocaleString()}
            </Text>
            <Action
              secondary
              title={`Revoke ${device.label}`}
              disabled={busy || device.status === "revoked"}
              onPress={() =>
                void mutate(async (valid) => {
                  await creatorRequest(
                    `${notificationRoot}/devices/${device.id}?revision=${device.revision}`,
                    session.access_token,
                    "DELETE",
                  );
                  if (valid()) {
                    setDevices((previous) =>
                      previous.map((value) =>
                        value.id === device.id
                          ? { ...value, status: "revoked" }
                          : value,
                      ),
                    );
                    setMessage(
                      "Device revoked. This does not change its browser/OS permission.",
                    );
                  }
                })
              }
            />
          </View>
        ))}
      </View>
      <View style={styles.panel}>
        <Text style={styles.heading}>Delivery receipts</Text>
        <Text style={styles.small}>
          Provider acceptance is not proof of display or reading. These are
          actual backend receipts; no sample notifications are generated.
        </Text>
        {deliveries.length === 0 && (
          <Text style={styles.body}>No delivery receipts yet.</Text>
        )}
        {deliveries.map((delivery) => (
          <View key={delivery.id} style={{ gap: 8, paddingVertical: 12 }}>
            <Text style={styles.body}>
              {delivery.category} · {notificationStatus(delivery.status)}
            </Text>
            <Text style={styles.small}>
              {delivery.provider} ·{" "}
              {new Date(delivery.created_at).toLocaleString()}
              {delivery.provider_accepted_at
                ? ` · provider accepted ${new Date(delivery.provider_accepted_at).toLocaleString()}`
                : ""}
              {delivery.opened_at
                ? ` · opened ${new Date(delivery.opened_at).toLocaleString()}`
                : ""}
            </Text>
            {!!delivery.detail && (
              <Text style={styles.small}>{delivery.detail}</Text>
            )}
            {!delivery.opened_at && (
              <Action
                secondary
                title="Review this receipt"
                disabled={busy}
                onPress={() =>
                  void mutate(async (valid) => {
                    await api(
                      `${notificationRoot}/deliveries/${delivery.id}/opened`,
                      {},
                    );
                    if (valid())
                      navigation.navigate(
                        delivery.category === "calendar"
                          ? "Calendar"
                          : delivery.category === "recordings"
                            ? "Recordings"
                            : "Campaigns",
                      );
                  })
                }
              />
            )}
          </View>
        ))}
      </View>
      <Action
        title="Refresh notification status"
        secondary
        icon={RefreshCw}
        busy={busy}
        onPress={() => void load()}
      />
    </ScrollView>
  );
}
