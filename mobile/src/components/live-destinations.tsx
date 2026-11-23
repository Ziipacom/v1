import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  Check,
  ChevronRight,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react-native";
import { Action, Field, Notice } from "./ui";
import { ApiError } from "../lib/api";
import { limitedStoreBeta } from "../lib/config";
import { verifiedLive, type LiveBroadcast } from "../lib/live-types";
import { useOperationScope } from "../lib/use-operation-scope";
import { useZiipa } from "../provider";
import { color, font, styles, themedStyles, useTheme } from "../theme";

type Provider =
  | "ziipa"
  | "twitch"
  | "youtube"
  | "facebook"
  | "instagram"
  | "tiktok"
  | "bluesky";
type Status =
  | "off"
  | "ready"
  | "starting"
  | "live"
  | "receiving"
  | "verification_unavailable"
  | "error"
  | "ended"
  | "setup_required"
  | "unavailable";
type Destination = {
  provider: Provider;
  name: string;
  mode: "built_in" | "connected" | "manual" | "link_only";
  status: Status;
  enabled: boolean;
  verified_at: string | null;
  target_id: string | null;
  target_name: string | null;
  can_enable: boolean;
  can_disable: boolean;
  detail: string;
  setup_url?: string;
};
type Snapshot = {
  destinations: Destination[];
  max_external_destinations: number;
};
type LegacyRelay = { status: string; channel_id: string; detail: string };
type LegacyAccount = {
  provider: string;
  status: string;
  selected_target_id: string | null;
  targets: { id: string; name: string }[];
};
type Editor = {
  provider: Provider;
  targetId: string | null;
  consent: boolean;
  ingestUrl: string;
  streamKey: string;
};
type Props = {
  broadcast: LiveBroadcast;
  focused: boolean;
  disabled: boolean;
  onConnections: () => void;
  onSavingChange?: (saving: boolean) => void;
};

const brands: {
  provider: Provider;
  name: string;
  mark: string;
  accent: string;
  mode: Destination["mode"];
}[] = [
  {
    provider: "ziipa",
    name: "Ziipa",
    mark: "Z",
    accent: "#4C2AC0",
    mode: "built_in",
  },
  {
    provider: "twitch",
    name: "Twitch",
    mark: "TW",
    accent: "#5936A0",
    mode: "connected",
  },
  {
    provider: "youtube",
    name: "YouTube",
    mark: "YT",
    accent: "#AD1D23",
    mode: "connected",
  },
  {
    provider: "facebook",
    name: "Facebook Pages",
    mark: "f",
    accent: "#155DAD",
    mode: "connected",
  },
  {
    provider: "instagram",
    name: "Instagram",
    mark: "IG",
    accent: "#A5316E",
    mode: "manual",
  },
  {
    provider: "tiktok",
    name: "TikTok",
    mark: "TT",
    accent: "#34303D",
    mode: "manual",
  },
  {
    provider: "bluesky",
    name: "Bluesky",
    mark: "BS",
    accent: "#1267B9",
    mode: "link_only",
  },
];

const statusText: Record<Status, string> = {
  off: "Off",
  ready: "Ready",
  starting: "Starting",
  live: "Live",
  receiving: "Receiving",
  verification_unavailable: "Unverified",
  error: "Needs attention",
  ended: "Ended",
  setup_required: "Setup required",
  unavailable: "Unavailable",
};

function isRelay(item: Destination) {
  return item.mode === "connected" || item.mode === "manual";
}

function localZiipaStatus(broadcast: LiveBroadcast): Status {
  if (verifiedLive(broadcast) && broadcast.playback_url) return "live";
  if (broadcast.status === "ended") return "ended";
  if (broadcast.status === "prepared") return "ready";
  if (broadcast.status === "awaiting_media") return "starting";
  return "verification_unavailable";
}

function shownStatus(
  item: Destination,
  broadcast: LiveBroadcast,
  stale: boolean,
): Status {
  if (item.provider === "ziipa") return localZiipaStatus(broadcast);
  if (item.status !== "live") return item.status;
  const checked = Date.parse(item.verified_at || "");
  const age = Date.now() - checked;
  return !stale && Number.isFinite(age) && age >= -5000 && age <= 20000
    ? "live"
    : "verification_unavailable";
}

function resolvedSetupUrl(item: Destination) {
  if (!item.setup_url) return null;
  const hosts =
    item.provider === "instagram"
      ? ["instagram.com", "www.instagram.com", "help.instagram.com"]
      : item.provider === "tiktok"
        ? [
            "tiktok.com",
            "www.tiktok.com",
            "livecenter.tiktok.com",
            "support.tiktok.com",
          ]
        : [];
  try {
    const url = new URL(item.setup_url);
    if (
      url.protocol === "https:" &&
      hosts.includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
    )
      return url.href;
  } catch {
    // An invalid or unexpected link is left out of the form.
  }
  return null;
}

function legacySnapshot(
  broadcast: LiveBroadcast,
  relay: LegacyRelay,
  accounts: LegacyAccount[],
): Snapshot {
  const account = accounts.find(
    (entry) => entry.provider === "twitch" && entry.status === "authorized",
  );
  const target = account?.targets.find(
    (entry) => entry.id === account.selected_target_id,
  );
  const ready = relay.status === "configured";
  const enabled = relay.status !== "detached";
  const connectedStatus =
    broadcast.status === "ended"
      ? "ended"
      : broadcast.status === "prepared"
        ? "ready"
        : "verification_unavailable";
  return {
    max_external_destinations: 1,
    destinations: brands.map(({ provider, name, mode }) => {
      const base = {
        provider,
        name,
        mode,
        verified_at: null,
        target_id: null,
        target_name: null,
        enabled: false,
        can_enable: false,
        can_disable: false,
      };
      if (provider === "ziipa")
        return {
          ...base,
          status: localZiipaStatus(broadcast),
          enabled: true,
          detail: "Public Live Feed",
        };
      if (provider === "twitch")
        return {
          ...base,
          enabled,
          target_id: target?.id ?? null,
          target_name:
            enabled && relay.channel_id !== target?.id
              ? relay.channel_id || null
              : (target?.name ?? null),
          status: enabled
            ? ready
              ? connectedStatus
              : "error"
            : target
              ? "off"
              : "setup_required",
          can_enable: !enabled && !!target,
          can_disable: enabled,
          detail:
            !target && !enabled
              ? "Connect a Twitch channel to add it."
              : relay.detail,
        };
      return {
        ...base,
        status: "unavailable",
        detail: "",
      };
    }),
  };
}

export function LiveDestinations(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedDestinations
      key={`${session?.access_token || "guest"}:${props.broadcast.id}`}
      {...props}
    />
  );
}

function ScopedDestinations({
  broadcast,
  focused,
  disabled,
  onConnections,
  onSavingChange,
}: Props) {
  useTheme();
  const { api } = useZiipa();
  const capture = useOperationScope(broadcast.id, focused);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copiedWatchLink, setCopiedWatchLink] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState<Provider | null>(null);
  const backend = useRef<"current" | "legacy" | null>(null);
  const mounted = useRef(true);
  const reading = useRef(false);
  const writing = useRef(false);
  const mutation = useRef(0);
  const reportSaving = useRef(onSavingChange);
  const currentBroadcast = useRef(broadcast);
  reportSaving.current = onSavingChange;
  currentBroadcast.current = broadcast;
  const path = `/api/live/streams/${broadcast.id}/destinations`;
  const prepared = broadcast.status === "prepared";
  const active =
    broadcast.status === "awaiting_media" ||
    broadcast.status === "live" ||
    broadcast.status === "unknown" ||
    broadcast.status === "ending";

  const legacyLoad = useCallback(async () => {
    const [relay, accounts] = await Promise.all([
      api<LegacyRelay>(path + "/twitch"),
      api<{ connections: LegacyAccount[] }>("/api/publishing/connections"),
    ]);
    return legacySnapshot(
      currentBroadcast.current,
      relay,
      accounts.connections,
    );
  }, [api, path]);

  const refresh = useCallback(
    async (showBusy = false) => {
      if (!focused || reading.current || writing.current) return;
      const current = capture();
      const version = mutation.current;
      reading.current = true;
      if (showBusy) setChecking(true);
      try {
        let data: Snapshot;
        if (backend.current === "legacy") {
          data = await legacyLoad();
        } else {
          try {
            data = await api<Snapshot>(path);
            if (current()) backend.current = "current";
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404))
              throw error;
            data = await legacyLoad();
            if (current()) backend.current = "legacy";
          }
        }
        if (!current() || version !== mutation.current) return;
        setSnapshot(data);
        setLoadError(false);
      } catch {
        if (current() && version === mutation.current) setLoadError(true);
      } finally {
        reading.current = false;
        if (current() && showBusy) setChecking(false);
      }
    },
    [api, capture, focused, legacyLoad, path],
  );

  useEffect(() => {
    if (!focused) {
      setEditor(null);
      setChecking(false);
      return;
    }
    void refresh();
    if (!active) return;
    const interval = setInterval(() => void refresh(), 12000);
    return () => clearInterval(interval);
  }, [focused, active, refresh]);

  useEffect(() => {
    if (!prepared) setEditor(null);
  }, [prepared]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (writing.current) reportSaving.current?.(false);
    };
  }, []);

  async function change(item: Destination, enabled: boolean, form?: Editor) {
    if (
      !focused ||
      disabled ||
      writing.current ||
      (enabled &&
        (!prepared ||
          !item.can_enable ||
          !form?.consent ||
          form.targetId !== item.target_id)) ||
      (!enabled && !item.can_disable)
    )
      return;

    const current = capture();
    writing.current = true;
    mutation.current++;
    setEditor(null); // Discard credentials before starting the request.
    setActionError("");
    setSaving(item.provider);
    reportSaving.current?.(true);
    try {
      const selection = {
        enabled,
        consent: enabled,
        ...(enabled && form?.targetId
          ? { expected_target_id: form.targetId }
          : {}),
      };
      let data: Snapshot;
      if (backend.current === "legacy" && item.provider === "twitch") {
        await api<LegacyRelay>(path + "/twitch", selection);
        data = await legacyLoad();
      } else {
        data = await api<Snapshot>(path + "/selection", {
          ...selection,
          provider: item.provider,
          ...(enabled && item.mode === "manual" && form
            ? {
                ingest_url: form.ingestUrl.trim(),
                stream_key: form.streamKey.trim(),
              }
            : {}),
        });
      }
      if (!current()) return;
      setSnapshot(data);
      setLoadError(false);
    } catch (error) {
      if (!current()) return;
      const safeMessage =
        enabled && item.mode === "manual"
          ? `Could not confirm ${item.name}. Check your live access, ingest URL, and key, then refresh destinations before retrying.`
          : error instanceof ApiError && error.status === 409
            ? "The broadcast or network connection changed. Refresh destinations before trying again."
            : `Could not confirm the update to ${item.name}. Refresh destinations before retrying.`;
      setActionError(safeMessage);
      setLoadError(true);
    } finally {
      writing.current = false;
      if (mounted.current) {
        setSaving(null);
        reportSaving.current?.(false);
      }
    }
  }

  const rows = snapshot?.destinations ?? [];
  const selectedCount = rows.filter(
    (item) => isRelay(item) && item.enabled,
  ).length;
  const max = snapshot?.max_external_destinations ?? 0;
  const atLimit = selectedCount >= max;
  const locked = disabled || saving !== null;
  const canManageConnections = rows.some((item) => item.mode === "connected");

  return (
    <View style={styles.panel}>
      <View style={s.header}>
        <View style={s.identity}>
          <Text style={styles.heading}>Broadcast destinations</Text>
          {snapshot && max > 0 && (
            <Text style={styles.small}>
              {selectedCount}/{max} external destinations selected
            </Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh broadcast destinations"
          disabled={checking || saving !== null}
          onPress={() => void refresh(true)}
          style={({ pressed }) => [s.iconButton, pressed && s.pressed]}
        >
          <RefreshCw size={18} color={color.text} />
        </Pressable>
      </View>
      {!snapshot && !loadError && (
        <Text style={styles.small}>Loading destinations…</Text>
      )}
      {snapshot && backend.current === "legacy" && (
        <Text style={styles.small}>
          This server currently supports Ziipa and Twitch.
        </Text>
      )}
      {loadError && (
        <Notice
          error
          text="Destination status could not be refreshed. Try Refresh destinations for current confirmation."
        />
      )}
      {actionError && <Notice error text={actionError} />}
      {rows.map((item) => {
        const brand = brands.find(({ provider }) => provider === item.provider);
        const status = shownStatus(item, broadcast, loadError);
        const canRemove = item.enabled && item.can_disable;
        const canAdd =
          !loadError &&
          !item.enabled &&
          item.can_enable &&
          prepared &&
          !atLimit;
        const changes = isRelay(item) && (canRemove || canAdd);
        const expanded = editor?.provider === item.provider;
        const statusName =
          item.mode === "link_only"
            ? "Share link"
            : status === "live" && item.provider === "twitch"
              ? "Channel live"
              : statusText[status];
        const detail =
          status === "live" && item.provider !== "twitch"
            ? ""
            : !item.enabled && status === "off"
              ? ""
              : item.detail;
        return (
          <View key={item.provider} style={s.destination}>
            <View style={s.header}>
              <View
                style={[
                  s.mark,
                  { backgroundColor: brand?.accent || color.purple },
                ]}
              >
                <Text style={s.markText}>
                  {brand?.mark || item.name.slice(0, 2)}
                </Text>
              </View>
              <View style={s.identity}>
                <Text style={s.name}>{item.name}</Text>
                {item.target_name && (
                  <Text style={styles.small} numberOfLines={1}>
                    {item.target_name}
                  </Text>
                )}
              </View>
              <Text style={[s.status, status === "live" && s.live]}>
                {statusName}
              </Text>
              {changes && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    canRemove
                      ? `Remove ${item.name}`
                      : `${expanded ? "Close" : "Open"} ${item.name} setup`
                  }
                  accessibilityState={{
                    disabled: locked,
                    expanded: canRemove ? undefined : expanded,
                  }}
                  disabled={locked}
                  onPress={() => {
                    if (canRemove) {
                      void change(item, false);
                    } else if (expanded) {
                      setEditor(null);
                    } else {
                      setActionError("");
                      setEditor({
                        provider: item.provider,
                        targetId: item.target_id,
                        consent: false,
                        ingestUrl: "",
                        streamKey: "",
                      });
                    }
                  }}
                  style={({ pressed }) => [
                    s.iconButton,
                    (locked || pressed) && s.pressed,
                  ]}
                >
                  {canRemove || expanded ? (
                    <Minus size={18} color={color.text} />
                  ) : (
                    <Plus size={18} color={color.text} />
                  )}
                </Pressable>
              )}
            </View>
            {!!detail && <Text style={styles.small}>{detail}</Text>}
            {item.mode === "link_only" && localZiipaStatus(broadcast) === "live" && (
              <Action
                secondary
                title={copiedWatchLink ? "Watch link copied" : "Copy live watch link"}
                onPress={() => {
                  const watchUrl = `https://ziipa.com/studio/?view=live&watchId=${encodeURIComponent(broadcast.id)}`;
                  void Clipboard.setStringAsync(watchUrl).then(
                    (copied) => {
                      if (copied) setCopiedWatchLink(true);
                      else setActionError("Could not copy the live watch link.");
                    },
                    () => setActionError("Could not copy the live watch link."),
                  );
                }}
              />
            )}
            {editor && editor.provider === item.provider && prepared && (
              <View style={s.editor}>
                <Text style={s.name}>Add {item.name}</Text>
                {item.target_name && (
                  <Text style={styles.small}>{item.target_name}</Text>
                )}
                {item.mode === "manual" && (
                  <>
                    <Text style={styles.small}>
                      Ziipa sends your {item.name} RTMPS URL and key to its relay
                      for this broadcast. You may also need to approve Go Live
                      in {item.name}.
                    </Text>
                    {!!resolvedSetupUrl(item) && (
                      <Action
                        secondary
                        title={`Open ${item.name} setup`}
                        icon={ChevronRight}
                        disabled={locked}
                        onPress={() => {
                          const url = resolvedSetupUrl(item);
                          if (url)
                            void Linking.openURL(url).catch(() =>
                              setActionError(
                                `Could not open ${item.name} setup.`,
                              ),
                            );
                        }}
                      />
                    )}
                    <Field
                      label="RTMPS ingest URL"
                      value={editor.ingestUrl}
                      onChangeText={(ingestUrl) =>
                        setEditor((value) => value && { ...value, ingestUrl })
                      }
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      textContentType="none"
                      maxLength={1024}
                      editable={!locked}
                      secureTextEntry
                    />
                    <Field
                      label="Stream key"
                      value={editor.streamKey}
                      onChangeText={(streamKey) =>
                        setEditor((value) => value && { ...value, streamKey })
                      }
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      textContentType="none"
                      maxLength={1024}
                      editable={!locked}
                      secureTextEntry
                    />
                  </>
                )}
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{
                    checked: editor.consent,
                    disabled: locked,
                  }}
                  disabled={locked}
                  onPress={() =>
                    setEditor(
                      (value) => value && { ...value, consent: !value.consent },
                    )
                  }
                  style={s.consent}
                >
                  <View style={[s.checkbox, editor.consent && s.checked]}>
                    {editor.consent && (
                      <Check size={16} color={color.onAccent} />
                    )}
                  </View>
                  <Text style={[styles.body, s.consentCopy]}>
                    Share this public broadcast and its audio with {item.name}.
                    {" "}{item.name} may keep its own recording.
                  </Text>
                </Pressable>
                <View style={s.actions}>
                  <Action
                    title="Cancel"
                    secondary
                    onPress={() => setEditor(null)}
                  />
                  <Action
                    title={`Add ${item.name}`}
                    disabled={
                      locked ||
                      atLimit ||
                      !item.can_enable ||
                      !editor.consent ||
                      editor.targetId !== item.target_id ||
                      (item.mode === "manual" &&
                        (!editor.ingestUrl.trim().startsWith("rtmps://") ||
                          !editor.streamKey.trim()))
                    }
                    onPress={() => void change(item, true, editor)}
                  />
                </View>
              </View>
            )}
          </View>
        );
      })}
      {saving && (
        <Text accessibilityLiveRegion="polite" style={styles.small}>
          Updating destinations…
        </Text>
      )}
      {canManageConnections && prepared && (
        <>
          {limitedStoreBeta && (
            <Text style={styles.small}>
              Sign in with the same Ziipa account on the web. Connect your
              network and select its channel or Page, then return here.
            </Text>
          )}
          <Action
            title={
              limitedStoreBeta
                ? "Open connections on Ziipa web"
                : "Manage network connections"
            }
            secondary
            disabled={locked}
            onPress={() => {
              if (!limitedStoreBeta) {
                onConnections();
                return;
              }
              const current = capture();
              setActionError("");
              void Linking.openURL(
                "https://ziipa.com/studio/?view=publishing",
              ).catch(() => {
                if (current())
                  setActionError(
                    "Open ziipa.com in your browser and go to Publishing to connect a network.",
                  );
              });
            }}
          />
        </>
      )}
    </View>
  );
}

const s = themedStyles(() => ({
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: color.text, fontFamily: font.semibold, fontSize: 14 },
  destination: {
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.panel,
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 9,
    gap: 5,
  },
  status: {
    color: color.text,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: 14,
    fontFamily: font.semibold,
    fontSize: 11,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  live: { color: color.lime, borderColor: color.lime },
  mark: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  markText: { color: "#FFFFFF", fontSize: 11, fontFamily: font.semibold },
  iconButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderRadius: 22,
    borderColor: color.border,
    borderWidth: 1,
  },
  pressed: { opacity: 0.5 },
  editor: {
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderColor: color.border,
    borderWidth: 1,
  },
  consent: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  consentCopy: { flex: 1, color: color.text },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderColor: color.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  checked: { backgroundColor: color.purple, borderColor: color.purple },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
}));
