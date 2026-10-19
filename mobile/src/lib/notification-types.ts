export const notificationRoot = "/api/notifications";
export const notificationCategories = [
  "calendar",
  "recordings",
  "campaigns",
] as const;
export type NotificationCategory = (typeof notificationCategories)[number];
export type PushConfig = {
  enabled: boolean;
  worker_ready: boolean;
  expo_ready: boolean;
  web_ready: boolean;
  vapid_public_key: string | null;
  categories: NotificationCategory[];
  notice: string;
};
export type PushPreferences = {
  enabled: boolean;
  categories: NotificationCategory[];
  revision: number;
};
export type PushDevice = {
  id: string;
  provider: "expo" | "web";
  label: string;
  status: string;
  revision: number;
  created_at: string;
  last_registered_at: string;
};
export type PushDelivery = {
  id: string;
  category: NotificationCategory;
  provider: "expo" | "web";
  status: string;
  detail?: string;
  created_at: string;
  provider_accepted_at: string | null;
  opened_at: string | null;
};
export type PushRegistration = {
  installation_id: string;
  provider: "expo" | "web";
  label: string;
  consent: true;
  expo_token?: string;
  subscription?: {
    endpoint: string;
    expirationTime?: number | null;
    keys: { p256dh: string; auth: string };
  };
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function notificationOpened(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  return data.kind === "ziipa_notification" &&
    data.route === "Notifications" &&
    typeof data.delivery_id === "string" &&
    uuid.test(data.delivery_id) &&
    notificationCategories.includes(data.category as NotificationCategory)
    ? data.delivery_id
    : null;
}
export function notificationPreferenceInput(
  enabled: boolean,
  categories: NotificationCategory[],
  revision: number,
  consent: boolean,
) {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Refresh notification preferences before saving.");
  if (categories.some((category) => !notificationCategories.includes(category)))
    throw new Error("Choose supported Ziipa notification categories.");
  const selected = notificationCategories.filter((category) =>
    categories.includes(category),
  );
  if (enabled && (!consent || selected.length === 0))
    throw new Error(
      "Choose at least one category and explicitly consent before enabling notifications.",
    );
  return {
    enabled,
    categories: selected,
    revision,
    consent: enabled && consent,
  };
}
export function webPushKey(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value))
    throw new Error("Browser push is not configured with a valid public key.");
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4)
    throw new Error("Browser push is not configured with a valid public key.");
  return bytes;
}
export function webPushKeyMatches(
  value: ArrayBuffer | null | undefined,
  expected: Uint8Array,
) {
  if (!value) return false;
  const actual = new Uint8Array(value);
  return (
    actual.length === expected.length &&
    actual.every((byte, index) => byte === expected[index])
  );
}
export function notificationStatus(status: string) {
  const labels: Record<string, string> = {
    pending: "Queued",
    queued: "Queued",
    sending: "Sending",
    accepted: "Accepted by push provider",
    provider_accepted: "Accepted by push provider",
    delivered: "Provider delivery receipt",
    opened: "Opened in Ziipa",
    failed: "Delivery failed",
    blocked: "Delivery blocked",
    disabled: "Disabled",
    revoked: "Revoked",
    active: "Registered · delivery not yet verified",
    uncertain: "Delivery outcome unknown",
    skipped: "Not sent",
  };
  return labels[status] || status.replace(/_/g, " ");
}
