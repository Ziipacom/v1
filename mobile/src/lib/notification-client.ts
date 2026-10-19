import { Platform } from "react-native";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { portalMode } from "./config";
import {
  webPushKey,
  webPushKeyMatches,
  type PushConfig,
  type PushRegistration,
} from "./notification-types";

const installationKey = "ziipa.push.installation.v1";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type PushCapability = {
  supported: boolean;
  permission: string;
  detail: string;
};
function nativeProjectId() {
  const id: unknown =
    Constants.expoConfig?.extra?.eas?.projectId ||
    Constants.easConfig?.projectId;
  return typeof id === "string" && uuid.test(id) ? id : null;
}
export async function pushCapability(): Promise<PushCapability> {
  if (Platform.OS === "web") {
    const supported =
      typeof window !== "undefined" &&
      window.isSecureContext &&
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    return {
      supported,
      permission: supported ? Notification.permission : "unavailable",
      detail: supported
        ? "Browser permission and a registered device are separate from your account preferences."
        : "Browser push needs HTTPS (or localhost), Service Workers and a browser with Push API support. LAN HTTP previews cannot receive browser push.",
    };
  }
  if (Constants.executionEnvironment === "storeClient" || !nativeProjectId())
    return {
      supported: false,
      permission: "unavailable",
      detail:
        "Native push requires a new Ziipa development/release build, a configured EAS project and APNs/FCM credentials. Expo Go is not supported.",
    };
  try {
    const notifications = await import("expo-notifications");
    const permission = await notifications.getPermissionsAsync();
    return {
      supported: true,
      permission: permission.status,
      detail:
        "This build can request notification permission. Delivery still depends on configured APNs/FCM and the backend worker.",
    };
  } catch {
    return {
      supported: false,
      permission: "unavailable",
      detail:
        "This binary does not have the native notifications module. Install the new Ziipa build; refreshing JavaScript cannot add native capabilities.",
    };
  }
}
async function installationId() {
  const saved = await AsyncStorage.getItem(installationKey);
  if (saved && uuid.test(saved)) return saved;
  const id = Crypto.randomUUID();
  await AsyncStorage.setItem(installationKey, id);
  return id;
}
async function boundedPush<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Device push setup timed out. Check your connection and retry the explicit enable action.",
              ),
            ),
          25000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
/** Call only from the user's explicit Enable on this device action. */
export async function registerPushDevice(
  config: PushConfig,
  label: string,
  current: () => boolean,
): Promise<PushRegistration> {
  if (!config.enabled || !config.worker_ready)
    throw new Error("Push delivery is not enabled on the server.");
  const capability = await pushCapability();
  if (!current())
    throw new Error(
      "Your account or screen changed. No device was registered.",
    );
  if (!capability.supported) throw new Error(capability.detail);
  const name =
    label.trim() || `Ziipa ${Platform.OS === "web" ? "browser" : Platform.OS}`;
  if (name.length > 60)
    throw new Error("Use a device name of at most 60 characters.");
  if (Platform.OS === "web") {
    if (!config.web_ready)
      throw new Error("Browser push keys are not configured on the server.");
    const applicationServerKey = webPushKey(config.vapid_public_key);
    // Request permission before asynchronous service-worker setup can exhaust
    // the browser's user activation. This function is only called by a button.
    const permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
    if (permission !== "granted")
      throw new Error(
        "Browser notification permission was not granted. You can change it in browser site settings.",
      );
    if (!current())
      throw new Error("Your account changed. No device was registered.");
    // The origin and script path are fixed by this build, never notification data.
    const scope = portalMode ? "/studio/" : "/";
    const registration = await navigator.serviceWorker.register(
      `${scope}ziipa-push-sw.js`,
      { scope },
    );
    await boundedPush(navigator.serviceWorker.ready);
    if (!current())
      throw new Error("Your account changed. No device was registered.");
    const existing = await registration.pushManager.getSubscription();
    if (
      existing &&
      !webPushKeyMatches(
        existing.options.applicationServerKey,
        applicationServerKey,
      )
    )
      throw new Error(
        "This browser has a subscription for a different push key. Revoke its Ziipa device entry, reset this site's notification subscription in browser settings, then explicitly enable it again.",
      );
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as Uint8Array<ArrayBuffer>,
      }));
    const value = subscription.toJSON();
    if (!value.endpoint || !value.keys?.p256dh || !value.keys?.auth)
      throw new Error(
        "The browser did not return a complete push subscription.",
      );
    return {
      installation_id: await installationId(),
      provider: "web",
      label: name,
      consent: true,
      subscription: {
        endpoint: value.endpoint,
        expirationTime: value.expirationTime ?? null,
        keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
      },
    };
  }
  if (!config.expo_ready)
    throw new Error("Native push delivery is not configured on the server.");
  const projectId = nativeProjectId();
  if (!projectId) throw new Error("This Ziipa build has no EAS project ID.");
  const notifications = await import("expo-notifications");
  if (Platform.OS === "android")
    await notifications.setNotificationChannelAsync("ziipa-private-updates", {
      name: "Ziipa private updates",
      importance: notifications.AndroidImportance.DEFAULT,
      sound: null,
      showBadge: false,
    });
  if (!current())
    throw new Error(
      "Your account changed. Notification permission was not requested.",
    );
  let permission = await notifications.getPermissionsAsync();
  if (!permission.granted)
    permission = await notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: false,
        allowSound: false,
        allowProvisional: false,
      },
    });
  if (!permission.granted)
    throw new Error(
      "Notification permission was not granted. You can change it in device settings.",
    );
  if (!current())
    throw new Error("Your account changed. No device was registered.");
  let token: string;
  try {
    token = (
      await boundedPush(notifications.getExpoPushTokenAsync({ projectId }))
    ).data;
  } catch {
    // Expo errors can include raw provider response bodies. Never echo those
    // bodies (which may contain device tokens) into the app or diagnostic logs.
    throw new Error(
      "Native push registration could not complete. Check connectivity and this build's EAS/APNs/FCM configuration, then explicitly retry. Provider details were not displayed.",
    );
  }
  if (
    !/^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]{8,200}\]$/.test(token)
  )
    throw new Error(
      "The native push provider did not return a valid device token.",
    );
  return {
    installation_id: await installationId(),
    provider: "expo",
    label: name,
    consent: true,
    expo_token: token,
  };
}

export async function nativeNotificationListener(
  open: (data: unknown) => void,
): Promise<() => void> {
  if (
    Platform.OS === "web" ||
    Constants.executionEnvironment === "storeClient" ||
    !nativeProjectId()
  )
    return () => {};
  try {
    const notifications = await import("expo-notifications");
    // Do not surface private updates over the foreground app or play sounds.
    notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      }),
    });
    const previous = await notifications.getLastNotificationResponseAsync();
    if (previous) {
      open(previous.notification.request.content.data);
      await notifications.clearLastNotificationResponseAsync();
    }
    const listener = notifications.addNotificationResponseReceivedListener(
      (response) => open(response.notification.request.content.data),
    );
    return () => listener.remove();
  } catch {
    return () => {};
  }
}
