import { HelpLabel } from "../components/help-label";
import { useDesktopLayout } from "../components/desktop-layout";
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
import { Action, Field, Notice, Pill } from "../components/ui";
import { Sheet } from "../components/floating";
import { InfoTip } from "../components/info-tip";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { releaseNotes } from "../lib/release-notes";
import { horizontalMouseDrag } from "../lib/horizontal-mouse-drag";
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
  notificationProviderReadiness,
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
      accessibilityLabel={text}
      aria-checked={checked}
      aria-disabled={disabled}
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
          borderColor: checked ? color.purple : color.border,
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
  const { desktop } = useDesktopLayout();
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
  const [tab, setTab] = useState<
    "Activity" | "Preferences" | "Devices" | "App"
  >(route.params?.deliveryId ? "Activity" : route.params?.tab || "Activity");
  useEffect(() => {
    if (route.params?.deliveryId) setTab("Activity");
    else if (route.params?.tab) setTab(route.params.tab);
  }, [route.params?.deliveryId, route.params?.tab]);
  const [serviceOpen, setServiceOpen] = useState(false);
  const tabsScroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || !focused) return;
    const node = tabsScroll.current?.getScrollableNode() as HTMLElement | null;
    return node ? horizontalMouseDrag(node) : undefined;
  }, [focused]);
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
      <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" style={styles.screen} contentContainerStyle={styles.page}>
        <Notice text="Sign in to manage your notifications and registered devices." />
        <Action title="Sign in" onPress={() => navigation.navigate("Login")} />
      </ScrollView>
    );
  const deviceReady = !!(
    config?.enabled &&
    config.worker_ready &&
    (Platform.OS === "web" ? config.web_ready : config.expo_ready)
  );
  const blockedReason = !capability
    ? "Checking notification support…"
    : !capability.supported
      ? "Notifications are unavailable in this browser or app build."
      : capability.permission === "denied"
        ? "Allow notifications in your device or browser settings before enabling them here."
        : !preferences?.enabled
          ? "Turn on and save account notifications in Preferences first."
          : !deviceReady
            ? "Push delivery is temporarily unavailable. Your activity remains in Ziipa."
            : "";
  const permission =
    capability?.permission === "granted"
      ? "Allowed"
      : capability?.permission === "denied"
        ? "Blocked"
        : capability?.permission === "default" ||
            capability?.permission === "undetermined"
          ? "Not enabled"
          : capability?.permission === "unavailable"
            ? "Unavailable"
            : capability?.permission || "Checking…";
  const appVersion =
    Application.nativeApplicationVersion ||
    Constants.expoConfig?.version ||
    null;
  const appBuild = Application.nativeBuildVersion;
  const platformName =
    Platform.OS === "ios"
      ? "iOS"
      : Platform.OS === "android"
        ? "Android"
        : "Web";
  const accountPanel = (
    <View style={styles.panel}>
      <HelpLabel
        label="Account preferences"
        style={styles.heading}
        help="Choose which Ziipa updates you want. Device registration and operating-system permission are managed separately."
      />
      <Consent
        text="Push notifications"
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
                ? "Recordings and clips"
                : "Publishing updates"
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
      <Text style={styles.small}>
        Notifications use generic categories, not private media, creation titles
        or calendar notes.
      </Text>
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
  );
  const devicePanel = (
    <View style={styles.panel}>
      <HelpLabel
        label="This device"
        style={styles.heading}
        help="Register this phone or browser only after enabling account preferences and reviewing the device permission request."
      />
      <View style={[styles.between, { flexWrap: "wrap" }]}>
        <Text style={styles.body}>
          {platformName} · permission {permission}
        </Text>
        <InfoTip
          title="Notification permission"
          content={
            capability?.detail ||
            "Notification permission and saved account preferences are separate. Permission is requested only when you explicitly enable this device."
          }
        />
      </View>
      {blockedReason ? <Text style={styles.small}>{blockedReason}</Text> : null}
      {!preferences?.enabled ? (
        <Action
          secondary
          title="Account preferences"
          onPress={() => setTab("Preferences")}
        />
      ) : null}
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
          capability?.permission === "denied" ||
          !preferences?.enabled ||
          !capability?.supported ||
          !config?.enabled ||
          !config.worker_ready ||
          !(Platform.OS === "web" ? config.web_ready : config.expo_ready)
        }
        onPress={() => void mutate(register)}
      />
      <Text style={styles.small}>
        Removing a registration stops Ziipa sending to that device. You can
        manage system permission in your device or browser settings.
      </Text>
    </View>
  );
  const devicesPanel = (
    <View style={styles.panel}>
      <HelpLabel
        label="Registered devices"
        style={styles.heading}
        help="These are the devices registered to receive your Ziipa updates. Removing a registration does not change your phone or browser permission settings."
      />
      {devices.length === 0 && (
        <Text style={styles.body}>No devices registered for this account.</Text>
      )}
      {devices.map((device) => (
        <View key={device.id} style={{ gap: 8, paddingVertical: 12 }}>
          <Text style={styles.body}>
            {device.label || "Unnamed device"} ·{" "}
            {device.provider === "web" ? "Browser" : "Ziipa app"}
          </Text>
          <Text style={styles.small}>
            {notificationStatus(device.status)} · last registration{" "}
            {new Date(device.last_registered_at).toLocaleString()}
          </Text>
          <Action
            secondary
            title={`Remove ${device.label || "device"}`}
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
  );
  const receiptsPanel = (
    <View style={styles.panel}>
      <HelpLabel
        label="Activity"
        style={styles.heading}
        help="Receipts track notification attempts. Provider acceptance does not guarantee that a notification appeared on the device."
      />
      {deliveries.length === 0 && (
        <Text style={styles.body}>
          {error
            ? "Activity could not be loaded. Refresh to try again."
            : "No notifications yet."}
        </Text>
      )}
      {deliveries.map((delivery) => (
        <View key={delivery.id} style={{ gap: 8, paddingVertical: 12 }}>
          <Text style={styles.body}>
            {delivery.category === "calendar"
              ? "Calendar reminder"
              : delivery.category === "recordings"
                ? "Recording or clip update"
                : "Publishing update"}{" "}
            · {notificationStatus(delivery.status)}
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
  );
  return (
    <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled"
      style={styles.screen}
      contentContainerStyle={[
        styles.page,
        { width: "100%", maxWidth: 1200, alignSelf: "center" },
        desktop && { paddingHorizontal: 28 },
      ]}

    >
      <View style={[styles.between, { flexWrap: "wrap" }]}>
        {desktop ? (
          <Text style={[styles.heading, { fontSize: 26 }]}>
            Notifications & devices
          </Text>
        ) : (
          <Text style={styles.small}>Your Ziipa account</Text>
        )}
        <Action
          secondary
          title="Refresh"
          icon={RefreshCw}
          busy={busy}
          onPress={() => void load()}
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
        }}
      >
        <Text style={styles.small}>
          Account push:{" "}
          {preferences ? (preferences.enabled ? "On" : "Off") : "Checking…"}
        </Text>
        <Text style={styles.small}>This device: {permission}</Text>
        <InfoTip
          title="Notifications and permission"
          content="Account preferences choose which updates Ziipa may send. Each device must also be registered and have notification permission. Neither setting starts a camera, broadcast or publication."
        />
      </View>
      <ScrollView
        ref={tabsScroll}
        horizontal
        showsHorizontalScrollIndicator
        keyboardShouldPersistTaps="handled"
        style={{ width: "100%", flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
      >
        {(["Activity", "Preferences", "Devices", "App"] as const).map(
          (value) => (
            <Pill
              key={value}
              title={value}
              active={tab === value}
              onPress={() => setTab(value)}
            />
          ),
        )}
      </ScrollView>
      {!!error && <Notice error text={error} />}
      {!!message && <Notice text={message} />}
      {tab === "Activity" ? receiptsPanel : null}
      {tab === "Preferences" ? accountPanel : null}
      {tab === "Devices" ? (
        <>
          {devicePanel}
          {devicesPanel}
        </>
      ) : null}
      {tab === "App" ? (
        <>
          <View style={styles.panel}>
            <HelpLabel
              label="App information"
              style={styles.heading}
              help="Version and build come from this installed app or web bundle. Registered-device information is limited to what Ziipa already stores for notification delivery."
            />
            <Text style={styles.body}>
              Ziipa{appVersion ? ` ${appVersion}` : ""}
              {appBuild ? ` (${appBuild})` : ""}
            </Text>
            <Text style={styles.small}>Platform: {platformName}</Text>
            {Platform.OS !== "web" ? (
              <Text style={styles.small}>
                {Platform.OS === "ios" ? "iOS version" : "Android API level"}:{" "}
                {String(Platform.Version)}
              </Text>
            ) : null}
          </View>
          <View style={styles.panel}>
            <Text style={styles.heading}>Version notes</Text>
            {releaseNotes.map((release) => (
              <View key={release.version} style={{ gap: 8 }}>
                <Text style={[styles.label, { marginBottom: 0 }]}>
                  Ziipa {release.version}
                </Text>
                {release.changes.map((change) => (
                  <Text key={change} style={styles.body}>
                    • {change}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Notification service status"
        onPress={() => setServiceOpen(true)}
        style={{
          alignSelf: "flex-start",
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text style={styles.small}>Service status ›</Text>
      </Pressable>
      {serviceOpen ? (
        <Sheet
          title="Notification service"
          onClose={() => setServiceOpen(false)}
          maxWidth={620}
        >
          <Text style={styles.heading}>
            {deviceReady
              ? config?.readiness_protocol === 2
                ? "Push service available"
                : "Push configuration awaiting verification"
              : "Push service unavailable"}
          </Text>
          <Text style={styles.body}>
            Your in-app activity remains available even when push delivery is
            unavailable.
          </Text>
          {config ? (
            <View style={{ gap: 10 }}>
              <Text style={styles.small}>
                Push service: {config.enabled ? "Enabled" : "Not enabled"}
              </Text>
              <Text style={styles.small}>
                Processing: {config.worker_ready ? "Available" : "Unavailable"}
              </Text>
              <Text style={styles.small}>
                App delivery: {notificationProviderReadiness(config, "expo")}
              </Text>
              <Text style={styles.small}>
                Browser delivery: {notificationProviderReadiness(config, "web")}
              </Text>
            </View>
          ) : (
            <Text style={styles.small}>Refresh to load service status.</Text>
          )}
          <Text style={styles.small}>
            Provider acceptance does not confirm that a device displayed a
            notification.
          </Text>
        </Sheet>
      ) : null}
    </ScrollView>
  );
}
