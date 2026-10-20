import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  Text,
  View,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioSource,
} from "expo-audio";
import {
  Check,
  ExternalLink,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react-native";
import { Action, Field, Notice, Pill } from "./ui";
import { useDesktopLayout } from "./desktop-layout";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import { usePlaybackSource } from "../lib/media-playback";
import {
  generatedMusicFile,
  type GeneratedMusicFile,
} from "../lib/generated-music-file";
import {
  composeMusic,
  musicMoods,
  musicPlan,
  musicStyles,
  ownedAudioTracks,
  planMusicPrompt,
  soundCloudSearch,
  type MusicSettings,
  type MusicPlan,
  type OwnedAudio,
} from "../lib/music-composer";
import type { UploadFile } from "../lib/api";
import type { Library } from "../lib/media-os-types";
import { color, styles } from "../theme";

export type MusicWorkspaceProps = {
  busy?: boolean;
  selectedName?: string;
  selectedFile?: UploadFile | null;
  selectedMediaId?: string | null;
  /** Percentage, matching the editor's existing 0–100 soundtrack control. */
  volume: number;
  onVolumeChange: (percent: number) => void;
  onUpload: () => void;
  /** Called only for an explicit Play gesture, before audition playback starts. */
  onAuditionStart?: () => void;
  onUseOwned: (audio: { media_id: string; name: string }) => void;
  /** Parent owns this lease after attachment, until replacement/unmount. */
  onUseGenerated: (file: UploadFile, release: () => Promise<void>) => void;
};

type Audition = { name: string; path?: string; uri?: string };
type Generated = GeneratedMusicFile & { plan: MusicPlan; transferred: boolean };
const emptyLibrary = (): Library => ({ items: [], media: [] });
const initialSettings: MusicSettings = {
  prompt: "A calm lo-fi instrumental for a short creator video, 90 BPM",
  style: "lofi",
  mood: "calm",
  bpm: 90,
  duration: 20,
  variation: 0,
};

export function MusicWorkspace(props: MusicWorkspaceProps) {
  const { session } = useZiipa();
  return (
    <ScopedMusicWorkspace key={session?.access_token || "guest"} {...props} />
  );
}

function ScopedMusicWorkspace({
  busy = false,
  selectedName,
  selectedFile,
  selectedMediaId,
  volume,
  onVolumeChange,
  onUpload,
  onAuditionStart,
  onUseOwned,
  onUseGenerated,
}: MusicWorkspaceProps) {
  const { api, session } = useZiipa();
  const { desktop } = useDesktopLayout();
  const focused = useIsFocused();
  const capture = useOperationScope(session?.access_token || "guest", focused);
  const [tab, setTab] = useState<"library" | "discover" | "create">("library");
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [discovery, setDiscovery] = useState("");
  const [rights, setRights] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audition, setAudition] = useState<Audition | null>(null);
  const [settings, setSettings] = useState<MusicSettings>(initialSettings);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [attached, setAttached] = useState(false);
  const generatedRef = useRef<Generated | null>(null);
  const generationLock = useRef(false);
  const ownerId = session?.user.id || 0;
  const tracks = session
    ? ownedAudioTracks(library, ownerId).filter((track) =>
        `${track.name} ${track.media_id}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : [];
  const selected =
    audition ||
    (selectedFile
      ? { name: selectedName || selectedFile.name, uri: selectedFile.uri }
      : selectedMediaId
        ? {
            name: selectedName || "Selected soundtrack",
            path: `/api/creator/media/${selectedMediaId}`,
          }
        : null);
  const disabled = busy || generating;

  const load = useCallback(async () => {
    if (!session || !focused) return;
    const current = capture();
    setLoading(true);
    setError("");
    try {
      const result = await api<Library>("/api/os/library");
      if (current()) setLibrary(result);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Your owned audio could not load.",
        );
    } finally {
      if (current()) setLoading(false);
    }
  }, [api, session?.access_token, focused, capture]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setAudition(null);
    const held = generatedRef.current;
    // The parent released/replaced this attachment. Do not offer a stale URI.
    if (held?.transferred && selectedFile?.uri !== held.file.uri) {
      generatedRef.current = null;
      setGenerated(null);
      setAttached(false);
    }
  }, [selectedFile?.uri, selectedMediaId]);
  useEffect(() => {
    if (!focused) setGenerating(false);
  }, [focused]);
  useEffect(
    () => () => {
      const held = generatedRef.current;
      if (held && !held.transferred) void held.release().catch(() => {});
    },
    [],
  );

  async function generate() {
    if (disabled || generationLock.current) return;
    const current = capture();
    generationLock.current = true;
    setGenerating(true);
    setError("");
    setNotice("");
    let next: GeneratedMusicFile | undefined;
    try {
      // Let the progress message paint before this bounded, local CPU task.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      if (!current()) return;
      const nextSettings = generatedRef.current
        ? { ...settings, variation: (settings.variation + 1) % 10000 }
        : settings;
      const result = composeMusic(nextSettings);
      next = await generatedMusicFile(result.bytes);
      if (!current()) {
        await next.release();
        return;
      }
      const previous = generatedRef.current;
      if (previous && !previous.transferred) await previous.release();
      if (!current()) {
        await next.release();
        return;
      }
      const held: Generated = {
        ...next,
        plan: result.plan,
        transferred: false,
      };
      generatedRef.current = held;
      setSettings(nextSettings);
      setGenerated(held);
      setAttached(false);
      setAudition({
        name: `${result.plan.style} instrumental`,
        uri: next.file.uri,
      });
      setNotice(
        "Original synthesized WAV is ready to preview. It is local only until you attach it and save the draft.",
      );
      next = undefined;
    } catch (cause) {
      await next?.release().catch(() => {});
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Music could not be generated on this device.",
        );
    } finally {
      generationLock.current = false;
      if (current()) setGenerating(false);
    }
  }

  function attachGenerated() {
    const held = generatedRef.current;
    if (!held || held.transferred || disabled || !focused) return;
    try {
      onUseGenerated(held.file, held.release);
      held.transferred = true;
      setAttached(true);
      setNotice(
        "Generated music attached to this edit. Save the draft to upload it; publishing still requires its separate review.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Music could not be attached.",
      );
    }
  }
  function attachOwned(track: OwnedAudio) {
    if (!rights || track.rightsExpired || disabled || !focused || !session)
      return;
    onUseOwned({ media_id: track.media_id, name: track.name });
    setAudition({
      name: track.name,
      path: `/api/creator/media/${track.media_id}`,
    });
    setNotice(
      "Owned audio attached. Review the mix and save your draft before publishing.",
    );
  }
  async function discover() {
    setError("");
    try {
      await Linking.openURL(soundCloudSearch(discovery));
    } catch {
      setError("SoundCloud could not open. Try again in your browser.");
    }
  }
  const plan = musicPlan(settings);
  const safeVolume = Number.isFinite(volume)
    ? Math.max(0, Math.min(100, volume))
    : 70;
  return (
    <View style={{ gap: desktop ? 16 : 20 }}>
      <View style={[styles.between, { gap: 12, flexWrap: "wrap" }]}>
        <View style={{ gap: 5, flex: 1, minWidth: 180 }}>
          <Text style={[styles.heading, desktop && { fontSize: 19 }]}>
            Music workspace
          </Text>
          <Text style={styles.small}>
            Upload your own audio, find inspiration, or compose an original
            instrumental.
          </Text>
        </View>
        <Action
          secondary
          title="Upload audio"
          icon={Upload}
          disabled={disabled}
          onPress={onUpload}
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pill
          title="Your audio"
          active={tab === "library"}
          onPress={() => setTab("library")}
        />
        <Pill
          title="SoundCloud discovery"
          active={tab === "discover"}
          onPress={() => setTab("discover")}
        />
        <Pill
          title="Create music"
          active={tab === "create"}
          onPress={() => setTab("create")}
        />
      </View>
      {!!error && <Notice error text={error} />}
      {!!notice && <Notice text={notice} />}
      {selected && (
        <View style={[styles.panel, { gap: 12, padding: desktop ? 16 : 20 }]}>
          <Text style={styles.label}>Audition · {selected.name}</Text>
          <MusicAudition
            key={selected.uri || selected.path}
            audition={selected}
            volume={safeVolume}
            onAuditionStart={onAuditionStart}
          />
          <Field
            label="Soundtrack mix level (%)"
            value={String(Math.round(safeVolume))}
            keyboardType="number-pad"
            maxLength={3}
            editable={!disabled}
            onChangeText={(text) => {
              if (/^\d{1,3}$/.test(text) && Number(text) <= 100)
                onVolumeChange(Number(text));
            }}
          />
          <Text style={styles.small}>
            Preview volume uses the mix level. The final mix is applied when the
            saved edit is rendered.
          </Text>
        </View>
      )}
      {tab === "library" && (
        <View style={{ gap: 14 }}>
          <View style={[styles.between, { gap: 10 }]}>
            <Text style={[styles.heading, { fontSize: 18 }]}>
              Owned audio library
            </Text>
            <Action
              secondary
              title="Refresh audio"
              icon={RefreshCw}
              busy={loading}
              disabled={disabled || !session}
              onPress={() => void load()}
            />
          </View>
          <Field
            label="Search your audio"
            value={query}
            onChangeText={setQuery}
            maxLength={140}
            placeholder="Search by creation title or audio ID"
          />
          {!session ? (
            <Notice text="Sign in to search your private uploaded audio. You can still compose and audition local music without publishing it." />
          ) : loading ? (
            <View style={styles.row}>
              <ActivityIndicator color={color.lime} />
              <Text style={styles.small}>Loading owned audio…</Text>
            </View>
          ) : !tracks.length ? (
            <Notice
              text={
                query
                  ? "No owned audio matches this search."
                  : "No owned audio uploads yet. Upload an audio file to start your library."
              }
            />
          ) : (
            <>
              <Consent
                checked={rights}
                disabled={disabled}
                onChange={() => setRights((value) => !value)}
                label="I own this audio or have permission to use it in this creation."
              />
              {tracks.slice(0, 40).map((track) => (
                <View
                  key={track.media_id}
                  style={[
                    styles.panel,
                    { gap: 10, padding: desktop ? 16 : 20 },
                  ]}
                >
                  <View style={[styles.row, { gap: 10 }]}>
                    <Music2 size={22} color={color.lime} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.label}>{track.name}</Text>
                      <Text style={styles.small}>
                        {(track.size / 1024 / 1024).toFixed(1)} MB · owned
                        upload
                        {track.rightsExpired
                          ? " · recorded rights expired"
                          : ""}
                      </Text>
                    </View>
                  </View>
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                  >
                    <Action
                      secondary
                      title="Preview audio"
                      icon={Play}
                      disabled={disabled}
                      onPress={() =>
                        setAudition({
                          name: track.name,
                          path: `/api/creator/media/${track.media_id}`,
                        })
                      }
                    />
                    <Action
                      title={
                        selectedMediaId === track.media_id
                          ? "Use selected audio"
                          : "Use audio"
                      }
                      disabled={disabled || !rights || track.rightsExpired}
                      onPress={() => attachOwned(track)}
                    />
                  </View>
                </View>
              ))}
              {tracks.length > 40 && (
                <Text style={styles.small}>
                  Showing the first 40 matches. Narrow your search to find
                  another track.
                </Text>
              )}
            </>
          )}
          <Text style={styles.small}>
            An upload proves storage ownership, not a music license. Expired
            recorded rights must be updated in the library before reuse.
          </Text>
        </View>
      )}
      {tab === "discover" && (
        <View style={[styles.panel, { gap: 14 }]}>
          <Text style={[styles.heading, { fontSize: 18 }]}>
            Discover on SoundCloud
          </Text>
          <Field
            label="Find tracks or creators"
            value={discovery}
            onChangeText={setDiscovery}
            maxLength={140}
            placeholder="Ambient instrumental, creator, or genre"
          />
          <Action
            title="Search SoundCloud"
            icon={ExternalLink}
            secondary
            onPress={() => void discover()}
          />
          <Notice text="Opens official SoundCloud search outside Ziipa. This is not a connected account or an imported music catalog. No track is downloaded, attached, licensed or used for training." />
          <Text style={styles.small}>
            In-app SoundCloud search/playback requires a registered API
            application. New application credentials currently require Artist
            Pro; no paid plan or connection has been enabled. For reuse, obtain
            permission and upload your authorized source file.
          </Text>
        </View>
      )}
      {tab === "create" && (
        <View style={[styles.panel, { gap: 14 }]}>
          <View style={styles.row}>
            <Sparkles size={22} color={color.lime} />
            <Text style={[styles.heading, { fontSize: 18 }]}>
              Local music creator
            </Text>
          </View>
          <Notice text="Procedural composer · not a generative AI model. Prompt keywords suggest tempo, mood and arrangement; mathematical synthesis creates a real WAV on this device. No vocals, artist imitation, samples, paid API or external training." />
          <Field
            label="Describe your instrumental"
            value={settings.prompt}
            onChangeText={(prompt) =>
              setSettings((value) => ({ ...value, prompt }))
            }
            maxLength={500}
            multiline
            editable={!disabled}
            placeholder="Bright electronic instrumental, 120 BPM, for a travel video"
          />
          <Action
            secondary
            title="Plan from prompt"
            disabled={disabled}
            onPress={() => {
              setSettings((value) => planMusicPrompt(value.prompt, value));
              setNotice(
                "Arrangement updated from recognized keywords. Review the controls before creating audio.",
              );
            }}
          />
          <Text style={styles.label}>Arrangement</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {musicStyles.map((style) => (
              <Pill
                key={style}
                title={style}
                active={settings.style === style}
                onPress={() => {
                  if (!disabled) setSettings((value) => ({ ...value, style }));
                }}
              />
            ))}
          </View>
          <Text style={styles.label}>Mood</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {musicMoods.map((mood) => (
              <Pill
                key={mood}
                title={mood}
                active={settings.mood === mood}
                onPress={() => {
                  if (!disabled) setSettings((value) => ({ ...value, mood }));
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {[70, 90, 110, 130, 150].map((bpm) => (
              <Pill
                key={bpm}
                title={`${bpm} BPM`}
                active={settings.bpm === bpm}
                onPress={() => {
                  if (!disabled) setSettings((value) => ({ ...value, bpm }));
                }}
              />
            ))}
          </View>
          <Text style={styles.label}>Duration</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {[10, 20, 30].map((duration) => (
              <Pill
                key={duration}
                title={`${duration} seconds`}
                active={settings.duration === duration}
                onPress={() => {
                  if (!disabled)
                    setSettings((value) => ({ ...value, duration }));
                }}
              />
            ))}
          </View>
          <Text style={styles.small}>
            {plan.summary} · {plan.voices.join(", ")}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Action
              title={
                generated ? "Create another version" : "Create instrumental"
              }
              icon={Sparkles}
              busy={generating}
              disabled={busy}
              onPress={() => void generate()}
            />
            <Action
              secondary
              title="New variation"
              disabled={disabled}
              onPress={() =>
                setSettings((value) => ({
                  ...value,
                  variation: (value.variation + 1) % 10000,
                }))
              }
            />
          </View>
          <Text style={styles.small}>
            Variation {settings.variation + 1} · PCM WAV, mono 22.05 kHz · up to
            30 seconds. Changing controls does not alter an already generated
            version.
          </Text>
          {generated && (
            <View
              style={{
                gap: 10,
                paddingTop: 10,
                borderTopWidth: 1,
                borderColor: color.border,
              }}
            >
              <Text style={styles.label}>
                Generated version · {generated.plan.summary}
              </Text>
              <Text style={styles.small}>
                {(generated.file.size / 1024 / 1024).toFixed(1)} MB · original
                synthesized sound, no third-party samples. No claim of copyright
                exclusivity.
              </Text>
              <Action
                secondary
                title="Audition generated version"
                icon={Play}
                disabled={disabled}
                onPress={() =>
                  setAudition({
                    name: `${generated.plan.style} instrumental`,
                    uri: generated.file.uri,
                  })
                }
              />
              <Action
                title={
                  attached ? "Attached to this edit" : "Attach generated music"
                }
                icon={Check}
                disabled={disabled || attached}
                onPress={attachGenerated}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function Consent({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onChange}
      style={[styles.row, { gap: 10, paddingVertical: 8 }]}
    >
      <View
        style={{
          width: 23,
          height: 23,
          borderWidth: 1,
          borderColor: color.lime,
          borderRadius: 6,
          backgroundColor: checked ? color.purple : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Check size={16} color={color.text} />}
      </View>
      <Text style={[styles.small, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

function MusicAudition({
  audition,
  volume,
  onAuditionStart,
}: {
  audition: Audition;
  volume: number;
  onAuditionStart?: () => void;
}) {
  const { session } = useZiipa();
  const focused = useIsFocused();
  const { source, loading, error } = usePlaybackSource(
    audition.path || null,
    session?.access_token,
    false,
    focused,
    audition.uri,
  );
  if (!source)
    return (
      <Text style={error ? styles.error : styles.small}>
        {error ||
          (loading
            ? "Loading private audio…"
            : "Audio preview is unavailable. Choose or upload the audio again.")}
      </Text>
    );
  return (
    <AuditionPlayer
      source={source}
      volume={volume}
      onAuditionStart={onAuditionStart}
    />
  );
}

function AuditionPlayer({
  source,
  volume,
  onAuditionStart,
}: {
  source: AudioSource;
  volume: number;
  onAuditionStart?: () => void;
}) {
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const focused = useIsFocused();
  useEffect(() => {
    player.volume = Math.max(0, Math.min(1, volume / 100));
  }, [player, volume]);
  useEffect(() => {
    if (!focused) player.pause();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") player.pause();
    });
    return () => subscription.remove();
  }, [player, focused]);
  return (
    <View style={{ gap: 8 }}>
      <Action
        secondary
        title={status.playing ? "Pause audio" : "Play audio preview"}
        icon={status.playing ? Pause : Play}
        disabled={!status.isLoaded}
        onPress={() => {
          if (status.playing) player.pause();
          else {
            onAuditionStart?.();
            if (status.didJustFinish) void player.seekTo(0);
            player.play();
          }
        }}
      />
      <Text style={styles.small}>
        {Math.floor(status.currentTime)}s / {Math.floor(status.duration)}s ·
        explicit preview, no autoplay
      </Text>
    </View>
  );
}
