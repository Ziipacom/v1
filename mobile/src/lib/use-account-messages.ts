import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useZiipa } from "../provider";
import { NotificationMessagesSession, emptyMessagesSnapshot, unreadNotificationsForSnapshot } from "./account-messages";

// This signal carries no account data. Hidden screens refresh when focused again.
const openedListeners = new Set<(source: NotificationMessagesSession) => void>();

export function useNotificationMessages() {
  const { api, session, guest } = useZiipa();
  const identity = !guest ? session?.access_token || null : null;
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [controller] = useState<NotificationMessagesSession>(() => new NotificationMessagesSession(() => {
    for (const listener of openedListeners) listener(controller);
  }));
  const snapshot = useCallback(() => controller.snapshot(identity), [controller, identity]);
  const state = useSyncExternalStore(controller.subscribe, snapshot, () => emptyMessagesSnapshot);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (value) => setForeground(value === "active"));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    controller.select(identity, api);
    if (identity && focused && foreground) void controller.refresh();
    return () => controller.clear();
  }, [controller, identity, api, focused, foreground]);
  const refresh = useCallback(async () => {
    if (identity && focused && foreground && controller.matches(identity)) await controller.refresh();
  }, [controller, identity, focused, foreground]);
  useEffect(() => {
    const listener = (source: NotificationMessagesSession) => { if (source !== controller) void refresh(); };
    openedListeners.add(listener);
    return () => { openedListeners.delete(listener); };
  }, [controller, refresh]);
  const markOpened = useCallback(async (id: string) => {
    if (!identity || !focused || !foreground || !controller.matches(identity)) return false;
    return controller.markOpened(id);
  }, [controller, identity, focused, foreground]);
  const unreadNotifications = unreadNotificationsForSnapshot(state);
  return { ...state, unreadNotifications, refresh, markOpened };
}

/** Account menus never mark receipts read or request notification permission. */
export function useAccountMessages(): { unreadNotifications: number | null; refresh: () => Promise<void> } {
  const { unreadNotifications, refresh } = useNotificationMessages();
  return { unreadNotifications, refresh };
}
