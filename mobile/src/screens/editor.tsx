import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { usePreventRemove } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Camera,
  Captions,
  Check,
  ChevronRight,
  Film,
  ImagePlus,
  Layers,
  Link2,
  Music2,
  Pause,
  Play,
  Radio,
  Save,
  Scissors,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from "lucide-react-native";
import { Action, Cover, Field, Notice, Pill } from "../components/ui";
import { FloatButton, worlds } from "../components/floating";
import { ReelMedia } from "../components/reel-media";
import { color, font, styles } from "../theme";
import { useZiipa } from "../provider";
import {
  creatorMimeType,
  uploadLimit,
  uploadMedia,
  type UploadFile,
} from "../lib/api";
import { inCreativeWorld, parseEditing, parsePrice } from "../lib/domain";
import {
  providerSupports,
  socialProvider,
  socialProviders,
} from "../lib/social";
import type {
  Category,
  Distribution,
  Item,
  ItemInput,
  Overlay,
  RootStack,
  SocialProvider,
} from "../lib/types";

const steps = [
  { name: "Media", Icon: Film },
  { name: "Edit", Icon: SlidersHorizontal },
  { name: "Overlay", Icon: Layers },
  { name: "Music", Icon: Music2 },
  { name: "Share", Icon: Share2 },
] as const;

export function ComposerScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Composer">) {
  const existing = route.params?.item;
  const remix = route.params?.remix;
  const { data, session, guest, api, refresh, savePreviewDraft } = useZiipa();
  const [category, setCategory] = useState<Category>(
    existing?.category || remix?.category || route.params?.category || "music",
  );
  const samples = data.items.filter((i) => inCreativeWorld(i, category));
  const [sample, setSample] = useState<Item | undefined>(
    guest ? existing || samples[0] : undefined,
  );
  const [title, setTitle] = useState(
    existing?.title ||
      (remix ? `Inspired by ${remix.title}`.slice(0, 140) : ""),
  );
  const [description, setDescription] = useState(existing?.description || "");
  const [tags, setTags] = useState(existing?.tags.join(", ") || "");
  const [city, setCity] = useState(existing?.city || "");
  const [start, setStart] = useState(String(existing?.trim_start || 0));
  const [end, setEnd] = useState(
    existing?.trim_end ? String(existing.trim_end) : "",
  );
  const [caption, setCaption] = useState(existing?.captions?.[0]?.text || "");
  const [price, setPrice] = useState(
    existing?.price_cents != null
      ? (existing.price_cents / 100).toFixed(2)
      : "",
  );
  const [file, setFile] = useState<UploadFile | null>(null);
  const [mediaId, setMediaId] = useState(existing?.media_id || null);
  const [soundtrackFile, setSoundtrackFile] = useState<UploadFile | null>(null);
  const [soundtrackId, setSoundtrackId] = useState(
    existing?.soundtrack?.media_id || null,
  );
  const [soundtrackName, setSoundtrackName] = useState(
    existing?.soundtrack?.name || "",
  );
  const [soundtrackVolume, setSoundtrackVolume] = useState(
    String(Math.round((existing?.soundtrack?.volume ?? 0.7) * 100)),
  );
  const [overlayText, setOverlayText] = useState(
    existing?.overlays?.[0]?.text || "",
  );
  const [overlayPosition, setOverlayPosition] = useState<Overlay["position"]>(
    existing?.overlays?.[0]?.position || "center",
  );
  const [overlayTheme, setOverlayTheme] = useState<Overlay["theme"]>(
    existing?.overlays?.[0]?.theme || "purple",
  );
  const [targets, setTargets] = useState<SocialProvider[]>(
    existing?.distribution_targets || [],
  );
  const [tab, setTab] = useState<(typeof steps)[number]["name"]>("Media");
  const [paused, setPaused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Item | null>(null);
  const { height } = useWindowDimensions();
  usePreventRemove(busy, () =>
    Alert.alert(
      "Saving your creation",
      "Please wait for the upload or save to finish.",
    ),
  );
  const base: Item = (guest ? sample : existing) || {
    id: "new",
    title: "Your next creation",
    description: "",
    category,
    creator: session?.user.name || "Ziipa Studio",
    tags: [],
    city: "",
    cover: "/brand/ziipa-background.png",
    media_url: null,
    demo: guest,
    label: "Draft",
  };
  let editing = {
    trim_start: 0,
    trim_end: null as number | null,
    captions: [] as Item["captions"],
  };
  try {
    editing = parseEditing(start, end, caption);
  } catch {
    /* Invalid edits are explained when saved; the canvas keeps safe defaults. */
  }
  const canvas: Item = {
    ...base,
    ...editing,
    content_type: file?.mimeType || base.content_type,
    title: title || base.title,
    overlays: overlayText.trim()
      ? [
          {
            id: existing?.overlays?.[0]?.id || "primary-overlay",
            text: overlayText.trim(),
            position: overlayPosition,
            theme: overlayTheme,
          },
        ]
      : [],
  };
  function fileFromAsset(
    asset: {
      uri: string;
      name?: string | null;
      mimeType?: string | null;
      size?: number | null;
    },
    fallbackName = "ziipa-media",
  ) {
    const name = asset.name || fallbackName;
    return {
      uri: asset.uri,
      name,
      mimeType: creatorMimeType(name, asset.mimeType || ""),
      size: asset.size || 0,
    } satisfies UploadFile;
  }
  async function pick(kind: "media" | "soundtrack" = "media") {
    setError("");
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type:
          kind === "soundtrack" ? "audio/*" : ["image/*", "video/*", "audio/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const info =
        Platform.OS === "web" ? null : await FileSystem.getInfoAsync(asset.uri);
      const size =
        asset.size ?? (info?.exists && !info.isDirectory ? info.size : 0);
      if (!size || size > uploadLimit)
        throw new Error("Choose a non-empty file no larger than 100 MB.");
      const selected = fileFromAsset({ ...asset, size });
      if (kind === "soundtrack") {
        if (!selected.mimeType.startsWith("audio/"))
          throw new Error("Choose an audio file for the soundtrack.");
        setSoundtrackFile(selected);
        setSoundtrackId(null);
        setSoundtrackName(selected.name.replace(/\.[^.]+$/, ""));
      } else {
        setFile(selected);
        setMediaId(null);
        if (selected.mimeType.startsWith("video/")) setCategory("video");
        if (selected.mimeType.startsWith("audio/")) setCategory("music");
      }
      setSaved(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function camera() {
    setError("");
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw new Error(
          "Camera access was not granted. You can choose a file instead.",
        );
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images", "videos"],
        quality: 0.85,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const info =
        Platform.OS === "web" ? null : await FileSystem.getInfoAsync(asset.uri);
      const size =
        asset.fileSize || (info?.exists && !info.isDirectory ? info.size : 0);
      if (!size || size > uploadLimit)
        throw new Error("Choose a photo no larger than 100 MB.");
      const cameraFile = {
        uri: asset.uri,
        name:
          asset.fileName ||
          (asset.type === "video" ? "ziipa-video.mp4" : "ziipa-photo.jpg"),
        mimeType:
          asset.mimeType ||
          (asset.type === "video" ? "video/mp4" : "image/jpeg"),
        size,
      } satisfies UploadFile;
      setFile(cameraFile);
      setMediaId(null);
      setCategory(cameraFile.mimeType.startsWith("video/") ? "video" : "music");
      setSaved(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save(visibility: "draft" | "published") {
    setError("");
    setSaved(null);
    const parsedTags = [
      ...new Set(
        tags
          .split(",")
          .map((t) => t.trim().replace(/^#/, ""))
          .filter(Boolean),
      ),
    ];
    let parsed: ReturnType<typeof parseEditing>;
    let price_cents: number | null;
    try {
      if (!title.trim()) {
        setTab("Share");
        throw new Error("Give your creation a title.");
      }
      if (parsedTags.length > 12 || parsedTags.some((t) => t.length > 40))
        throw new Error("Use up to 12 tags, each under 40 characters.");
      parsed = parseEditing(start, end, caption);
      price_cents = category === "store" ? parsePrice(price) : null;
      if (!guest && visibility === "published" && !mediaId && !file)
        throw new Error(
          "Choose media before publishing, or save a private draft.",
        );
      if (!guest && !session)
        throw new Error("Sign in to save to your account.");
      const volume = Number(soundtrackVolume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100)
        throw new Error("Soundtrack volume must be between 0 and 100%.");
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      if (guest) {
        const draft: Item = {
          ...base,
          ...parsed,
          id: existing?.id || `preview-draft-${Date.now()}`,
          title: title.trim(),
          description,
          category,
          tags: parsedTags,
          city: city.trim(),
          price_cents,
          remix_of: remix?.id || existing?.remix_of || null,
          overlays: canvas.overlays,
          soundtrack: soundtrackName.trim()
            ? {
                media_id: null,
                name: soundtrackName.trim(),
                volume: Number(soundtrackVolume) / 100,
                start: 0,
              }
            : null,
          distribution_targets: targets,
          distribution: targets.map((provider) => ({
            id: `preview-${provider}`,
            item_id: existing?.id || "preview-draft",
            provider,
            status: data.connections.some(
              (connection) =>
                connection.provider === provider &&
                connection.status === "connected",
            )
              ? "queued"
              : "connection_required",
            detail: "Sample delivery plan · no external post was created.",
            external_url: "",
            updated_at: new Date().toISOString(),
          })),
          visibility: "draft",
          demo: true,
          label: "Sample draft",
        };
        savePreviewDraft(draft);
        setSaved(draft);
      } else {
        let selectedId = mediaId;
        if (file && !selectedId) {
          const uploaded = await uploadMedia(
            file,
            session!.access_token,
            setProgress,
          );
          selectedId = uploaded.id;
          setMediaId(selectedId);
        }
        let selectedSoundtrackId = soundtrackId;
        if (soundtrackFile && !selectedSoundtrackId) {
          const uploaded = await uploadMedia(
            soundtrackFile,
            session!.access_token,
            setProgress,
          );
          selectedSoundtrackId = uploaded.id;
          setSoundtrackId(selectedSoundtrackId);
        }
        const payload: ItemInput = {
          title: title.trim(),
          description,
          category,
          tags: parsedTags,
          city: city.trim(),
          media_id: selectedId,
          visibility,
          ...parsed,
          price_cents,
          remix_of: remix?.id || existing?.remix_of || null,
          overlays: canvas.overlays || [],
          soundtrack: soundtrackName.trim()
            ? {
                media_id: selectedSoundtrackId,
                name: soundtrackName.trim(),
                volume: Number(soundtrackVolume) / 100,
                start: 0,
              }
            : null,
          distribution_targets: targets,
        };
        const result = await api<Item>(
          existing ? `/api/creator/items/${existing.id}` : "/api/creator/items",
          payload,
        );
        await refresh();
        setSaved(result);
        if (visibility === "published" && targets.length) {
          const distribution = await api<Distribution[]>(
            `/api/creator/items/${result.id}/distribute`,
            { providers: targets },
          );
          setSaved({ ...result, distribution });
          await refresh();
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 35 }}
      >
        <View
          style={{
            height: Math.min(340, height * 0.43),
            margin: 14,
            marginBottom: 0,
            borderRadius: 22,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: "#574366",
          }}
        >
          {file?.mimeType.startsWith("image/") ? (
            <>
              <Image
                source={{ uri: file.uri }}
                style={{ flex: 1 }}
                contentFit="cover"
              />
              {!!caption && <Text style={eStyle.caption}>{caption}</Text>}
            </>
          ) : (
            <ReelMedia
              item={canvas}
              active
              paused={paused}
              muted
              localUri={file?.uri}
            />
          )}
          {!!overlayText.trim() && (
            <Text
              style={[
                eStyle.overlay,
                overlayPosition === "top"
                  ? { top: 62 }
                  : overlayPosition === "bottom"
                    ? { bottom: 64 }
                    : { top: "44%" },
                overlayTheme === "light"
                  ? { color: "#160F20", backgroundColor: "#FFFFFFE8" }
                  : overlayTheme === "lime"
                    ? { color: "#132000", backgroundColor: "#A6E21BE8" }
                    : overlayTheme === "purple"
                      ? { backgroundColor: "#5420ABE8" }
                      : { backgroundColor: "#09060EDB" },
              ]}
            >
              {overlayText.trim()}
            </Text>
          )}
          <View
            style={{
              position: "absolute",
              left: 13,
              right: 13,
              top: 10,
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Text style={eStyle.badge}>
              {guest ? "SAMPLE EDITOR" : "YOUR CREATION"}
            </Text>
            <FloatButton
              label={paused ? "Play editing preview" : "Pause editing preview"}
              icon={paused ? Play : Pause}
              size={37}
              onPress={() => setPaused(!paused)}
            />
          </View>
          <View
            style={{ position: "absolute", bottom: 12, left: 15, right: 15 }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: "white",
                fontFamily: font.semibold,
                fontSize: 19,
                textShadowColor: "#000",
                textShadowRadius: 4,
              }}
            >
              {title || "Your next creation"}
            </Text>
          </View>
        </View>
        <View
          style={{
            flexDirection: "row",
            paddingHorizontal: 13,
            borderBottomWidth: 1,
            borderColor: color.border,
            paddingVertical: 12,
          }}
        >
          {steps.map(({ name, Icon }, index) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={`${index + 1}. ${name}`}
              accessibilityState={{ selected: tab === name }}
              onPress={() => setTab(name)}
              style={{ flex: 1, alignItems: "center", gap: 5 }}
            >
              <View
                style={{
                  padding: 8,
                  borderRadius: 25,
                  backgroundColor: tab === name ? color.purple : "transparent",
                }}
              >
                <Icon size={20} color="white" strokeWidth={1.5} />
              </View>
              <Text
                style={{
                  fontFamily: font.regular,
                  fontSize: 10,
                  color: tab === name ? "white" : color.faint,
                }}
              >
                {name}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={{ padding: 20, gap: 16 }}>
          <View style={styles.between}>
            <Text style={styles.eyebrow}>
              STEP {steps.findIndex((step) => step.name === tab) + 1} OF{" "}
              {steps.length}
            </Text>
            <Text style={[styles.small, { color: color.text }]}>{tab}</Text>
          </View>
          {tab === "Media" && (
            <>
              {guest && (
                <>
                  <Text style={styles.small}>
                    Start with a sample or choose media from this device. Sample
                    files stay inside this preview.
                  </Text>
                  <ScrollView
                    showsVerticalScrollIndicator={false}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 9 }}
                  >
                    {samples.map((i) => (
                      <Pressable
                        key={i.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Use sample ${i.title}`}
                        onPress={() => {
                          setSample(i);
                          if (!title) setTitle(i.title);
                          setSaved(null);
                        }}
                        style={{
                          borderWidth: 2,
                          borderColor:
                            sample?.id === i.id ? color.lime : "transparent",
                          borderRadius: 15,
                          overflow: "hidden",
                        }}
                      >
                        <Cover item={i} style={{ height: 78, width: 98 }} />
                      </Pressable>
                    ))}
                  </ScrollView>
                </>
              )}
              <View style={styles.panel}>
                <View style={styles.row}>
                  <View style={eStyle.uploadIcon}>
                    <ImagePlus size={24} color={color.lime} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.heading, { fontSize: 19 }]}>
                      Add your media
                    </Text>
                    <Text style={styles.small}>
                      Images, video, audio, GIF, HEIC, MOV and more · up to 100
                      MB
                    </Text>
                  </View>
                </View>
                {!!file && (
                  <Text style={[styles.small, { color: color.text }]}>
                    {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                  </Text>
                )}
                {!file && !!mediaId && (
                  <Text style={styles.small}>Using your uploaded media</Text>
                )}
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Action
                      title="Upload file"
                      icon={Upload}
                      secondary
                      disabled={busy}
                      onPress={() => void pick()}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Action
                      title="Record"
                      icon={Camera}
                      secondary
                      disabled={busy}
                      onPress={() => void camera()}
                    />
                  </View>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Set up a live broadcast"
                  onPress={() => {
                    setCategory("live");
                    setTab("Share");
                  }}
                  style={[styles.row, { justifyContent: "center", padding: 8 }]}
                >
                  <Radio size={18} color="#FF707D" />
                  <Text style={[styles.small, { color: color.text }]}>
                    Create a live broadcast
                  </Text>
                </Pressable>
              </View>
              <Field
                label="Creation title"
                value={title}
                onChangeText={setTitle}
                maxLength={140}
                editable={!busy}
                placeholder="Give it a name"
              />
            </>
          )}
          {tab === "Edit" && (
            <>
              <View style={styles.row}>
                <Scissors size={20} color={color.lime} />
                <Text style={[styles.heading, { fontSize: 19 }]}>
                  Trim & captions
                </Text>
              </View>
              <Text style={styles.small}>
                Set the playback range in seconds. The source file stays
                unchanged.
              </Text>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Field
                    label="Start (seconds)"
                    value={start}
                    onChangeText={setStart}
                    keyboardType="decimal-pad"
                    maxLength={10}
                    editable={!busy}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Field
                    label="End (optional)"
                    value={end}
                    onChangeText={setEnd}
                    keyboardType="decimal-pad"
                    maxLength={10}
                    editable={!busy}
                  />
                </View>
              </View>
              <Text
                style={{
                  color: color.lime,
                  fontFamily: font.medium,
                  fontSize: 12,
                }}
              >
                {start || "0"}s → {end ? `${end}s` : "end of media"}
              </Text>
              <View style={styles.separator} />
              <View style={styles.row}>
                <Captions size={20} color={color.lime} />
                <Text style={[styles.heading, { fontSize: 19 }]}>
                  On-screen captions
                </Text>
              </View>
              <Field
                label="Caption"
                value={caption}
                onChangeText={setCaption}
                maxLength={250}
                multiline
                editable={!busy}
                placeholder="Put your story into words…"
              />
              <Text style={styles.small}>
                This caption is timed to the trim range and stays editable. Auto
                captions can be connected to a transcription worker later.
              </Text>
            </>
          )}
          {tab === "Overlay" && (
            <>
              <View style={styles.row}>
                <Sparkles size={20} color={color.lime} />
                <Text style={[styles.heading, { fontSize: 19 }]}>
                  Add an overlay
                </Text>
              </View>
              <Field
                label="Overlay text"
                value={overlayText}
                onChangeText={setOverlayText}
                placeholder="New episode · Watch now"
                maxLength={120}
                editable={!busy}
              />
              <Text style={styles.label}>Position</Text>
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {(["top", "center", "bottom"] as const).map((position) => (
                  <Pill
                    key={position}
                    title={position[0].toUpperCase() + position.slice(1)}
                    active={overlayPosition === position}
                    onPress={() => setOverlayPosition(position)}
                  />
                ))}
              </View>
              <Text style={styles.label}>Style</Text>
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {(["purple", "dark", "light", "lime"] as const).map((theme) => (
                  <Pill
                    key={theme}
                    title={theme[0].toUpperCase() + theme.slice(1)}
                    active={overlayTheme === theme}
                    onPress={() => setOverlayTheme(theme)}
                  />
                ))}
              </View>
              <Notice text="Overlay placement is saved non-destructively with the Ziipa creation. External delivery requires the render worker to burn it into exported media." />
            </>
          )}
          {tab === "Music" && (
            <>
              <View style={styles.row}>
                <Music2 size={20} color={color.lime} />
                <Text style={[styles.heading, { fontSize: 19 }]}>
                  Soundtrack
                </Text>
              </View>
              <Text style={styles.small}>
                Add music you own or are licensed to use. Ziipa keeps the source
                and mix settings together with this creation.
              </Text>
              <Action
                title={soundtrackFile ? "Replace audio" : "Choose audio"}
                icon={Music2}
                secondary
                onPress={() => void pick("soundtrack")}
              />
              {!!soundtrackFile && (
                <Notice
                  text={`${soundtrackFile.name} · ${(soundtrackFile.size / 1024 / 1024).toFixed(1)} MB`}
                />
              )}
              <Field
                label="Track title"
                value={soundtrackName}
                onChangeText={setSoundtrackName}
                maxLength={180}
                placeholder="Original audio"
                editable={!busy}
              />
              <Field
                label="Mix volume · 0–100%"
                value={soundtrackVolume}
                onChangeText={setSoundtrackVolume}
                keyboardType="number-pad"
                maxLength={3}
                editable={!busy}
              />
              <Notice text="Commercial music catalogues require track-by-track licensing. This uploader accepts creator-owned or licensed audio." />
            </>
          )}
          {tab === "Share" && (
            <>
              <View style={styles.row}>
                <Share2 size={20} color={color.lime} />
                <Text style={[styles.heading, { fontSize: 19 }]}>
                  Details & destinations
                </Text>
              </View>
              <Field
                label="Creation title"
                value={title}
                onChangeText={setTitle}
                maxLength={140}
                editable={!busy}
              />
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {worlds.map((w) => (
                  <Pill
                    key={w.id}
                    title={w.title}
                    active={inCreativeWorld({ ...base, category }, w.id)}
                    onPress={() => {
                      if (!busy) setCategory(w.id);
                    }}
                  />
                ))}
              </View>
              <Field
                label="Description"
                value={description}
                onChangeText={setDescription}
                maxLength={3000}
                multiline
                editable={!busy}
              />
              <Field
                label="Tags · separated by commas"
                value={tags}
                onChangeText={setTags}
                maxLength={490}
                editable={!busy}
              />
              <Field
                label="City (optional)"
                value={city}
                onChangeText={setCity}
                maxLength={80}
                editable={!busy}
              />
              {category === "store" && (
                <Field
                  label="Listing price (USD) · no checkout"
                  value={price}
                  onChangeText={setPrice}
                  keyboardType="decimal-pad"
                  maxLength={12}
                  editable={!busy}
                />
              )}
              <View style={styles.separator} />
              <View style={styles.between}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={[styles.heading, { fontSize: 20 }]}>
                    Publish to
                  </Text>
                  <Text style={styles.small}>
                    Ziipa is always the source. Choose every compatible
                    connected channel.
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Manage connected networks"
                  onPress={() => navigation.navigate("Connections")}
                  style={eStyle.connectButton}
                >
                  <Link2 size={19} color="white" />
                </Pressable>
              </View>
              <View style={eStyle.networkCard}>
                <View style={styles.row}>
                  <View
                    style={[
                      eStyle.networkIcon,
                      { backgroundColor: color.purple },
                    ]}
                  >
                    <Text style={eStyle.networkInitial}>Z</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Ziipa</Text>
                    <Text style={styles.small}>
                      Creator profile · discovery · wallet metadata
                    </Text>
                  </View>
                  <Check size={20} color={color.lime} />
                </View>
              </View>
              {socialProviders.map((provider) => {
                const connection = data.connections.find(
                  (item) => item.provider === provider.id,
                );
                const compatible = providerSupports(
                  provider.id,
                  category,
                  file?.mimeType || canvas.content_type,
                );
                const connected = connection?.status === "connected";
                const selected = targets.includes(provider.id);
                return (
                  <Pressable
                    key={provider.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{
                      checked: selected,
                      disabled: !compatible,
                    }}
                    accessibilityLabel={`Share to ${connection?.name || provider.id}`}
                    onPress={() => {
                      if (!compatible) return;
                      setTargets((current) =>
                        current.includes(provider.id)
                          ? current.filter((item) => item !== provider.id)
                          : [...current, provider.id],
                      );
                    }}
                    style={[
                      eStyle.networkCard,
                      selected && {
                        borderColor: color.purple,
                        backgroundColor: "#281540",
                      },
                      !compatible && { opacity: 0.48 },
                    ]}
                  >
                    <View style={styles.row}>
                      <View
                        style={[
                          eStyle.networkIcon,
                          { backgroundColor: provider.color },
                        ]}
                      >
                        <Text style={eStyle.networkInitial}>
                          {provider.short}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.label}>
                          {connection?.name || provider.id}
                        </Text>
                        <Text style={styles.small}>
                          {!compatible
                            ? "Not available for this media type"
                            : connected
                              ? connection.handle || provider.formats
                              : `Select now · connect before delivery`}
                        </Text>
                      </View>
                      <View
                        style={[
                          eStyle.check,
                          selected && {
                            backgroundColor: color.purple,
                            borderColor: "#8B59D2",
                          },
                        ]}
                      >
                        {selected && <Check size={15} color="white" />}
                      </View>
                    </View>
                  </Pressable>
                );
              })}
              {!!targets.length && (
                <Notice
                  text={`${targets.length} external ${targets.length === 1 ? "destination" : "destinations"} selected. Ziipa will keep a status record for each one.`}
                />
              )}
            </>
          )}
          {remix && (
            <Notice
              text={`Remix attribution: ${remix.title} by ${remix.creator}. ${guest ? "Sample media only." : "Bring your own licensed media; the source is not copied."}`}
            />
          )}
          {(category === "nft" || category === "live") && (
            <Text style={styles.small}>
              {category === "nft"
                ? "Save your own media as a private draft, then mint it through Wallet. Sample artwork cannot be minted."
                : "Save the broadcast setup as a draft, then connect a live provider in Connected networks."}
            </Text>
          )}
          {!!error && <Notice text={error} error />}
          {busy && (
            <Text accessibilityLiveRegion="polite" style={styles.small}>
              {file && !mediaId
                ? `Uploading… ${progress}%`
                : "Saving your creation…"}
            </Text>
          )}
          {saved && (
            <>
              <Notice
                text={
                  guest
                    ? "Sample draft saved for this session. Restarting clears sample edits; nothing is published."
                    : saved.visibility === "draft"
                      ? "Private draft saved to your account."
                      : "Creation published to this Ziipa server."
                }
              />
              <Action
                title="View creation"
                icon={Check}
                secondary
                onPress={() =>
                  navigation.navigate("Watch", {
                    itemId: saved.id,
                    category: saved.category,
                  })
                }
              />
              {!!saved.distribution?.length &&
                saved.distribution.map((job) => (
                  <Notice
                    key={job.id}
                    text={`${socialProvider(job.provider).short} · ${job.detail || job.status}`}
                    error={job.status === "failed"}
                  />
                ))}
              {!guest && saved.media_id && (
                <Action
                  title="Mint this media"
                  onPress={() =>
                    navigation.navigate("Utility", {
                      kind: "wallet",
                      item: saved,
                    })
                  }
                />
              )}
            </>
          )}
          {tab === "Share" ? (
            <>
              <Action
                title={
                  guest
                    ? targets.length
                      ? "Save & preview distribution"
                      : "Save sample draft"
                    : "Save private draft"
                }
                icon={Save}
                onPress={() => void save("draft")}
                busy={busy}
              />
              {!guest && (
                <Action
                  title={
                    targets.length
                      ? `Publish to Ziipa + ${targets.length}`
                      : "Publish to Ziipa"
                  }
                  secondary
                  icon={Upload}
                  onPress={() => void save("published")}
                  busy={busy}
                  disabled={
                    category === "live" ||
                    category === "nft" ||
                    existing?.visibility === "hidden"
                  }
                />
              )}
            </>
          ) : (
            <Action
              title={`Continue to ${steps[steps.findIndex((step) => step.name === tab) + 1]?.name}`}
              icon={ChevronRight}
              onPress={() => {
                const index = steps.findIndex((step) => step.name === tab);
                setTab(steps[Math.min(steps.length - 1, index + 1)].name);
              }}
            />
          )}
          <Text style={[styles.small, { textAlign: "center", fontSize: 11 }]}>
            {guest
              ? "Sample edits stay on this device until restart."
              : "Only share media you own or have permission to use."}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const eStyle = {
  badge: {
    color: "white",
    backgroundColor: "#110D1C99",
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 5,
    fontFamily: font.medium,
    fontSize: 9,
    letterSpacing: 1,
  },
  caption: {
    position: "absolute" as const,
    bottom: "33%" as const,
    alignSelf: "center" as const,
    maxWidth: "85%" as const,
    color: "white",
    backgroundColor: "#0009",
    padding: 8,
    fontFamily: font.medium,
    fontSize: 17,
  },
  overlay: {
    position: "absolute" as const,
    left: 28,
    right: 28,
    alignSelf: "center" as const,
    textAlign: "center" as const,
    color: "white",
    fontFamily: font.semibold,
    fontSize: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
  },
  uploadIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#2D1749",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  connectButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: color.purple,
  },
  networkCard: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 17,
    padding: 13,
    backgroundColor: color.panel,
  },
  networkIcon: {
    width: 39,
    height: 39,
    borderRadius: 20,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 1,
    borderColor: "#FFFFFF44",
  },
  networkInitial: {
    color: "white",
    fontFamily: font.bold,
    fontSize: 12,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#655A70",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
};
