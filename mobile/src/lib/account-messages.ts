import { notificationCategories, notificationRoot, type PushDelivery } from "./notification-types.ts";

export type MessagesApi = (path: string, body?: unknown) => Promise<unknown>;
export type MessagesSnapshot = {
  deliveries: readonly PushDelivery[] | null;
  loading: boolean;
  markingId: string | null;
  error: string;
};
export const emptyMessagesSnapshot: MessagesSnapshot = {
  deliveries: null, loading: false, markingId: null, error: "",
};
const accepted = new Set(["provider_accepted", "accepted", "sent"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestamp = (value: unknown): value is string => typeof value === "string" &&
  value.length <= 50 && Number.isFinite(Date.parse(value));

/** A queue entry or an unverified provider ticket is never a new message. */
export function isUnreadNotification(row: PushDelivery) {
  return accepted.has(row.status) && timestamp(row.provider_accepted_at) && row.opened_at === null;
}
export function unreadNotificationCount(rows: readonly PushDelivery[]) {
  return rows.filter(isUnreadNotification).length;
}
export function unreadNotificationsForSnapshot(state: MessagesSnapshot): number | null {
  return state.deliveries === null || !!state.error || state.loading
    ? null : unreadNotificationCount(state.deliveries);
}
export function notificationMessageTitle(row: PushDelivery) {
  return { calendar: "Calendar reminder", recordings: "Recording update", campaigns: "Campaign update" }[row.category];
}
function receipt(value: unknown): PushDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The notification receipt could not be read.");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !uuid.test(row.id) ||
      !notificationCategories.includes(row.category as PushDelivery["category"]) ||
      !["web", "expo"].includes(row.provider as string) ||
      typeof row.status !== "string" || !row.status || row.status.length > 64 ||
      (row.detail != null && (typeof row.detail !== "string" || row.detail.length > 1000)) ||
      !timestamp(row.created_at) ||
      (row.provider_accepted_at !== null && !timestamp(row.provider_accepted_at)) ||
      (row.opened_at !== null && !timestamp(row.opened_at)))
    throw new Error("The notification receipt could not be read.");
  return {
    id: row.id, category: row.category as PushDelivery["category"],
    provider: row.provider as PushDelivery["provider"], status: row.status,
    detail: (row.detail as string | undefined) || "",
    created_at: row.created_at, provider_accepted_at: row.provider_accepted_at,
    opened_at: row.opened_at,
  };
}
export function notificationReceipts(value: unknown): PushDelivery[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Notification history is unavailable. Please refresh.");
  const rows = value.map(receipt);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Notification history is unavailable. Please refresh.");
  return rows;
}

/** In-memory, one-account state. Neither credentials nor receipts use device storage. */
export class NotificationMessagesSession {
  private identity: string | null = null;
  private api: MessagesApi | null = null;
  private epoch = 0;
  private state = emptyMessagesSnapshot;
  private pending: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private readonly changed?: () => void;
  constructor(changed?: () => void) { this.changed = changed; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = (identity: string | null) => identity && this.identity === identity ? this.state : emptyMessagesSnapshot;
  matches = (identity: string | null) => !!identity && this.identity === identity;
  private put(state: MessagesSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  select(identity: string | null, api: MessagesApi | null) {
    if (identity !== this.identity) {
      this.epoch++;
      this.pending = null;
      this.identity = identity;
      this.put(emptyMessagesSnapshot);
    }
    this.api = identity ? api : null;
  }
  clear() { this.select(null, null); }
  refresh = (): Promise<void> => {
    if (!this.identity || !this.api || this.state.markingId) return Promise.resolve();
    if (this.pending) return this.pending;
    const identity = this.identity, api = this.api, epoch = ++this.epoch;
    this.put({ ...this.state, loading: true, error: "" });
    const valid = () => this.identity === identity && this.epoch === epoch;
    const request = Promise.resolve().then(async () => {
      if (!valid()) return;
      try {
        const rows = notificationReceipts(await api(`${notificationRoot}/deliveries`));
        if (valid()) this.put({ deliveries: rows, loading: false, markingId: null, error: "" });
      } catch (cause) {
        if (valid()) this.put({ ...this.state, loading: false,
          error: cause instanceof Error ? cause.message : "Notifications could not be loaded. Please refresh." });
      } finally {
        if (this.pending === request) this.pending = null;
      }
    });
    this.pending = request;
    return request;
  };
  async markOpened(id: string): Promise<boolean> {
    const row = this.state.deliveries?.find((delivery) => delivery.id === id);
    if (!this.identity || !this.api || this.state.markingId || !row || !isUnreadNotification(row)) return false;
    const identity = this.identity, api = this.api, epoch = ++this.epoch;
    this.pending = null; // A GET begun before this explicit read must not restore an unread badge.
    this.put({ ...this.state, loading: false, markingId: id, error: "" });
    const valid = () => this.identity === identity && this.epoch === epoch;
    try {
      const opened = receipt(await api(`${notificationRoot}/deliveries/${id}/opened`, {}));
      if (opened.id !== id || !opened.opened_at) throw new Error("The read status was not confirmed. Please try again.");
      if (!valid()) return false;
      this.put({ ...this.state, deliveries: this.state.deliveries!.map((value) => value.id === id ? opened : value), markingId: null });
      this.changed?.();
      return true;
    } catch (cause) {
      if (valid()) this.put({ ...this.state, markingId: null,
        error: cause instanceof Error ? cause.message : "Read status could not be saved. Please try again." });
      return false;
    }
  }
}
