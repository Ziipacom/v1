import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  Check,
  ExternalLink,
  Link2,
  Play,
  RefreshCw,
  Unplug,
  X,
} from "lucide-react-native";
import { Action, Field, Notice, Pill } from "./ui";
import { SoundCloudWidget } from "./soundcloud-widget";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import { apiOrigin, canonicalApiOrigin } from "../lib/config";
import {
  disconnectSoundCloud,
  type SoundCloudConfig,
  type SoundCloudPlayback,
  type SoundCloudTrack,
  type SoundCloudTracks,
} from "../lib/soundcloud-api";
import {
  soundCloudAuthorizationUrl,
  soundCloudPermalink,
  soundCloudPortalUrl,
  soundCloudTrackId,
  soundCloudWidgetUrl,
} from "../lib/soundcloud-links";
import { soundCloudSearch } from "../lib/music-composer";
import { color, styles } from "../theme";

/** Provider listening is isolated from Ziipa's creator soundtrack/mixing pipeline. */
export function MusicSoundCloud({
  disabled = false,
  onListen,
}: {
  disabled?: boolean;
  onListen?: () => void;
}) {
  const { session, api } = useZiipa();
  const focused = useIsFocused();
  const capture = useOperationScope(session?.access_token || "guest", focused);
  const [config, setConfig] = useState<SoundCloudConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"mine" | "public">("mine");
  const [result, setResult] = useState<SoundCloudTracks | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false);
  const [authorization, setAuthorization] = useState<string | null>(null);
  const [disconnectReview, setDisconnectReview] = useState(false);
  const [widget, setWidget] = useState<{ url: string; title: string } | null>(
    null,
  );
  const lock = useRef(false);
  const blocked = disabled || loading;
  const origins = [apiOrigin, canonicalApiOrigin, "https://ziipa.com"];

  const refresh = useCallback(async () => {
    if (!session || !focused || lock.current) return;
    const current = capture();
    lock.current = true;
    setLoading(true);
    setError("");
    try {
      const value = await api<SoundCloudConfig>("/api/music/soundcloud/config");
      if (current()) {
        setConfig(value);
        setResult(null);
        setWidget(null);
        setAuthorization(null);
        setDisconnectReview(false);
      }
    } catch (cause) {
      if (current()) {
        setConfig(null);
        setError(
          cause instanceof Error
            ? cause.message
            : "SoundCloud readiness could not load.",
        );
      }
    } finally {
      lock.current = false;
      if (current()) setLoading(false);
    }
  }, [api, session?.access_token, focused, capture]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!focused) {
      setLoading(false);
      setWidget(null);
      setAuthorization(null);
    }
  }, [focused]);

  async function open(url: string | null) {
    if (!url || !focused) return;
    try {
      await Linking.openURL(url);
    } catch {
      setError(
        "The official page could not open. Check your browser and try again.",
      );
    }
  }
  async function connect() {
    if (blocked || lock.current || !session || !config?.can_connect || !consent)
      return;
    const current = capture();
    lock.current = true;
    setLoading(true);
    setError("");
    setWidget(null);
    try {
      const value = await api<{
        status: string;
        auth_url: string | null;
        connect_via_portal: string | null;
        detail: string;
      }>("/api/music/soundcloud/oauth/start", { consent: true });
      if (!current()) return;
      const url =
        value.status === "authorization_required"
          ? soundCloudAuthorizationUrl(value.auth_url, origins)
          : soundCloudPortalUrl(value.connect_via_portal, origins);
      if (!url)
        throw new Error(
          "Open Ziipa's portal to finish SoundCloud authorization; no unsafe sign-in link was opened.",
        );
      setAuthorization(url);
      setNotice(value.detail);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "SoundCloud authorization could not start.",
        );
    } finally {
      lock.current = false;
      if (current()) setLoading(false);
    }
  }
  async function search() {
    if (
      blocked ||
      lock.current ||
      !session ||
      !config?.can_search ||
      (scope === "public" && !config.public_search_enabled)
    )
      return;
    const current = capture();
    lock.current = true;
    setLoading(true);
    setError("");
    setWidget(null);
    try {
      const value = await api<SoundCloudTracks>(
        `/api/music/soundcloud/tracks?q=${encodeURIComponent(query.trim().slice(0, 140))}&scope=${scope}`,
      );
      if (current()) setResult(value);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "SoundCloud tracks could not load.",
        );
    } finally {
      lock.current = false;
      if (current()) setLoading(false);
    }
  }
  async function listen(track: SoundCloudTrack) {
    const id = soundCloudTrackId(track.id);
    if (
      blocked ||
      lock.current ||
      !id ||
      !track.owned ||
      !track.can_embed ||
      track.sharing !== "public" ||
      track.access !== "playable"
    )
      return;
    const current = capture();
    lock.current = true;
    setLoading(true);
    setError("");
    setWidget(null);
    onListen?.();
    try {
      const value = await api<SoundCloudPlayback>(
        `/api/music/soundcloud/tracks/${id}/playback`,
        { consent: true },
      );
      if (!current()) return;
      const url = soundCloudWidgetUrl(value.widget_url);
      const permalink = soundCloudPermalink(value.permalink_url);
      if (
        value.mode !== "widget" ||
        !url ||
        !permalink ||
        permalink !== soundCloudPermalink(track.permalink_url) ||
        soundCloudPermalink(new URL(url).searchParams.get("url")) !== permalink
      )
        throw new Error(
          "This track is available only on its official SoundCloud page. No stream was imported.",
        );
      setWidget({ url, title: track.title });
      setNotice(value.detail);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Official SoundCloud playback is unavailable.",
        );
    } finally {
      lock.current = false;
      if (current()) setLoading(false);
    }
  }
  async function disconnect() {
    if (
      blocked ||
      lock.current ||
      !session ||
      !disconnectReview ||
      !config?.connection
    )
      return;
    const current = capture();
    lock.current = true;
    setLoading(true);
    setError("");
    setWidget(null);
    try {
      const value = await disconnectSoundCloud(
        session.access_token,
        config.connection.revision,
      );
      if (current()) {
        setConfig(null);
        setResult(null);
        setAuthorization(null);
        setConsent(false);
        setDisconnectReview(false);
        setNotice(value.detail || "SoundCloud disconnected from Ziipa.");
      }
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Disconnect failed; refresh the current connection revision.",
        );
    } finally {
      lock.current = false;
      if (current()) setLoading(false);
    }
  }

  return (
    <View style={[styles.panel, { gap: 14 }]}>
      <View style={[styles.between, { flexWrap: "wrap" }]}>
        <Text style={[styles.heading, { fontSize: 18 }]}>SoundCloud</Text>
        <Action
          secondary
          title="Refresh SoundCloud"
          icon={RefreshCw}
          busy={loading}
          disabled={disabled || !session}
          onPress={() => void refresh()}
        />
      </View>
      <Notice text="Official SoundCloud discovery and listening are separate from your creation. Tracks cannot be downloaded, attached, remixed, added to the soundtrack, or sent to AI. A playable track is not a reuse license." />
      {!!error && <Notice error text={error} />}
      {!!notice && <Notice text={notice} />}
      <Text style={styles.small}>
        {!session
          ? "Sign in to Ziipa to check connection readiness. Official external search is still available."
          : config
            ? `${config.connected ? `Connected as ${config.connection?.username || "SoundCloud creator"}. ` : "Not connected. "}${config.detail}`
            : "SoundCloud service readiness has not been verified."}
      </Text>
      {!!config?.requirements.length && (
        <Text style={styles.small}>
          {config.requirements.slice(0, 8).join("\n")}
        </Text>
      )}
      {config?.can_connect && !config.connected && (
        <>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consent, disabled: blocked }}
            disabled={blocked}
            onPress={() => setConsent(!consent)}
            style={[styles.row, { paddingVertical: 8 }]}
          >
            <View
              style={{
                width: 23,
                height: 23,
                borderWidth: 1,
                borderColor: color.lime,
                borderRadius: 5,
                backgroundColor: consent ? color.purple : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {consent && <Check size={15} color={color.text} />}
            </View>
            <Text style={[styles.small, { flex: 1 }]}>
              Authorize SoundCloud account access for Ziipa's separate catalog
              and official player. No soundtrack import.
            </Text>
          </Pressable>
          <Action
            title="Prepare SoundCloud connection"
            icon={Link2}
            disabled={blocked || !consent}
            onPress={() => void connect()}
          />
        </>
      )}
      {!config?.connected &&
        !!config?.connect_via_portal &&
        !config.can_connect && (
          <Action
            title="Connect through Ziipa portal"
            secondary
            icon={ExternalLink}
            onPress={() =>
              void open(soundCloudPortalUrl(config.connect_via_portal, origins))
            }
            disabled={
              blocked ||
              !soundCloudPortalUrl(config.connect_via_portal, origins)
            }
          />
        )}
      {authorization && (
        <Action
          title="Continue official authorization"
          icon={ExternalLink}
          disabled={blocked}
          onPress={() => void open(authorization)}
        />
      )}
      {config?.connected && (
        <>
          <Action
            secondary
            title="Review disconnect"
            icon={Unplug}
            disabled={blocked}
            onPress={() => setDisconnectReview(!disconnectReview)}
          />
          {disconnectReview && (
            <View style={{ gap: 8 }}>
              <Notice text="Disconnecting removes this SoundCloud connection and closes its player. It does not delete SoundCloud content or any Ziipa audio. Refresh if this connection changed on another device." />
              <Action
                title="Confirm disconnect SoundCloud"
                disabled={blocked}
                onPress={() => void disconnect()}
              />
            </View>
          )}
        </>
      )}
      <Field
        label="Find tracks or creators"
        value={query}
        onChangeText={setQuery}
        maxLength={140}
        editable={!blocked}
        placeholder="Instrumental, genre, creator or your track title"
      />
      {config?.can_search && (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Pill
              title="My SoundCloud tracks"
              active={scope === "mine"}
              onPress={() => {
                if (!blocked) {
                  setScope("mine");
                  setResult(null);
                  setWidget(null);
                }
              }}
            />
            {config.public_search_enabled && (
              <Pill
                title="Public discovery"
                active={scope === "public"}
                onPress={() => {
                  if (!blocked) {
                    setScope("public");
                    setResult(null);
                    setWidget(null);
                  }
                }}
              />
            )}
          </View>
          <Action
            title={
              scope === "mine"
                ? "Search my SoundCloud catalog"
                : "Search public SoundCloud catalog"
            }
            disabled={blocked}
            onPress={() => void search()}
          />
        </>
      )}
      <Action
        title="Open official SoundCloud search"
        icon={ExternalLink}
        secondary
        disabled={blocked}
        onPress={() => void open(soundCloudSearch(query))}
      />
      {widget && (
        <View style={{ gap: 8 }}>
          <View style={styles.between}>
            <Text style={[styles.label, { flex: 1 }]}>
              Official SoundCloud player
            </Text>
            <Action
              secondary
              title="Close player"
              icon={X}
              onPress={() => setWidget(null)}
            />
          </View>
          <SoundCloudWidget url={widget.url} title={widget.title} />
          <Text style={styles.small}>
            SoundCloud · {widget.title} · playback belongs to SoundCloud, with
            its attribution and policies.
          </Text>
        </View>
      )}
      {result && (
        <View style={{ gap: 12 }}>
          <Text style={styles.small}>{result.notice}</Text>
          {!result.tracks.length && (
            <Text style={styles.small}>
              No SoundCloud tracks matched this search.
            </Text>
          )}
          {result.tracks.slice(0, 20).map((track) => (
            <View
              key={track.id}
              style={{
                gap: 8,
                paddingTop: 12,
                borderTopWidth: 1,
                borderColor: color.border,
              }}
            >
              <Text style={styles.label}>{track.title}</Text>
              <Text style={styles.small}>
                SoundCloud · {track.uploader} ·{" "}
                {track.duration_ms === null
                  ? "duration unavailable"
                  : `${Math.max(0, Math.round(track.duration_ms / 1000))}s`}{" "}
                · {track.sharing} · {track.access} · license:{" "}
                {track.license || "unspecified"}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {track.owned && track.can_embed && config?.can_play_owned && (
                  <Action
                    title="Open official player"
                    icon={Play}
                    disabled={blocked}
                    onPress={() => void listen(track)}
                  />
                )}
                <Action
                  secondary
                  title="View on SoundCloud"
                  icon={ExternalLink}
                  disabled={
                    blocked || !soundCloudPermalink(track.permalink_url)
                  }
                  onPress={() =>
                    void open(soundCloudPermalink(track.permalink_url))
                  }
                />
              </View>
            </View>
          ))}
          {result.has_more && (
            <Text style={styles.small}>
              More results are available on SoundCloud. Refine this search to
              find a particular track.
            </Text>
          )}
        </View>
      )}
      <Text style={styles.small}>
        No provider credentials or paid plan are enabled by this screen. New
        SoundCloud API applications may require an eligible Artist Pro account;
        without approved credentials, external official search remains
        available.
      </Text>
    </View>
  );
}
