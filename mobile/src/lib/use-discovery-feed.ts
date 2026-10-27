import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Linking } from "react-native";
import { useZiipa } from "../provider";
import {
  discoveryConnectionIdentity,
  discoveryEntries,
  discoveryPostUrl,
} from "./discovery-feed";
import type { NetworkHub, NetworkMedia } from "./network-hub";
import { useNetworkSnapshotExpiry } from "./use-network-snapshot-expiry";

// A non-security ordering seed shared by mounted Discover/Gallery surfaces.
// It holds no media, account identifier, token, or persisted profile preference.
let sessionSeed = Math.floor(Math.random() * 0x100000000) >>> 0;
const listeners = new Set<() => void>();
const snapshot = () => sessionSeed;
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};
function reshuffle() {
  sessionSeed = (sessionSeed + 0x9e3779b9) >>> 0;
  for (const notify of listeners) notify();
}

export function useDiscoveryFeed() {
  const { data, api, session, guest, refresh, refreshing } = useZiipa();
  const seed = useSyncExternalStore(subscribe, snapshot, snapshot);
  const connectionIdentity = discoveryConnectionIdentity(
    data.connections || [],
  );
  const identity = useMemo(
    () => ({}),
    [session?.access_token, guest, connectionIdentity],
  );
  const current = useRef(identity);
  current.current = identity;
  const epoch = useRef(0);
  const [openError, setOpenError] = useState<{
    identity: object;
    text: string;
  } | null>(null);
  const [network, setNetwork] = useState<{
    identity: object;
    hub: NetworkHub | null;
    loading: boolean;
    error: string;
  } | null>(null);
  const visible = network?.identity === identity ? network : null;
  const expiryKey = useNetworkSnapshotExpiry(visible?.hub || null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      epoch.current++;
    };
  }, []);
  const loadNetwork = useCallback(async () => {
    if (guest || !session || !active.current || current.current !== identity)
      return;
    const run = ++epoch.current;
    setNetwork((old) => ({
      identity,
      hub: old?.identity === identity ? old.hub : null,
      loading: true,
      error: "",
    }));
    try {
      const hub = await api<NetworkHub>("/api/social/hub");
      if (
        active.current &&
        current.current === identity &&
        epoch.current === run
      )
        setNetwork({ identity, hub, loading: false, error: "" });
    } catch {
      if (
        active.current &&
        current.current === identity &&
        epoch.current === run
      )
        setNetwork((old) => ({
          identity,
          hub: old?.identity === identity ? old.hub : null,
          loading: false,
          error:
            old?.identity === identity && old.hub
              ? "Connected-network posts could not refresh. Your last imported snapshot is kept; Ziipa creations remain available."
              : "Connected-network posts could not load. Ziipa creations remain available; open Networks to check your links.",
        }));
    }
  }, [api, identity, guest, session?.access_token]);
  useFocusEffect(
    useCallback(() => {
      void loadNetwork();
      return () => {
        epoch.current++;
      };
    }, [loadNetwork]),
  );
  const entries = useMemo(
    () =>
      discoveryEntries(
        data.items,
        visible?.hub || null,
        data.preferences,
        seed,
        guest,
      ),
    [data.items, data.preferences, visible?.hub, seed, guest, expiryKey],
  );
  const refreshFeed = useCallback(async () => {
    if (!active.current || current.current !== identity) return;
    setOpenError(null);
    reshuffle();
    await Promise.allSettled([refresh(), loadNetwork()]);
  }, [refresh, loadNetwork]);
  const openNetwork = useCallback(
    async (media: NetworkMedia) => {
      if (current.current !== identity) return;
      setOpenError(null);
      const url = discoveryPostUrl(media);
      if (!url) {
        setOpenError({
          identity,
          text: "This network post has no supported public link.",
        });
        return;
      }
      try {
        await Linking.openURL(url);
      } catch {
        if (current.current === identity && active.current)
          setOpenError({
            identity,
            text: "The original network post could not open. Try again or open Connected networks.",
          });
      }
    },
    [identity],
  );
  return {
    entries,
    seed,
    refreshing: refreshing || !!visible?.loading,
    networkError:
      (openError?.identity === identity ? openError.text : "") ||
      visible?.error ||
      "",
    networkCount: entries.filter((entry) => entry.source === "network").length,
    refreshFeed,
    openNetwork,
  };
}
