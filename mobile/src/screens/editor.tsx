import { useCallback, useEffect, useRef, useState } from "react";
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
import { maxCreationPhotos, pickCreatorMedia } from "../lib/creator-media-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as FileSystem from "expo-file-system/legacy";
import { useIsFocused, usePreventRemove } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Camera,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  Film,
  ImagePlus,
  Layers,
  Link2,
  Music2,
  Pause,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  Save,
  Scissors,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Volume2,
  VolumeX,
  SkipBack,
  Wallet,
} from "lucide-react-native";
import { Action, Cover, Field, Notice, Pill } from "../components/ui";
import { FloatButton, worlds } from "../components/floating";
import { AutomationAgentDock } from "../components/automation-agent-dock";
import { PhotoSteps } from "../components/photo-steps";
import {
  EditorPreview,
  EditorSoundtrack,
  type EditorFrame,
} from "../components/editor-preview";
import { EditorTimeline } from "../components/editor-timeline";
import { EditorOverlays } from "../components/editor-overlays";
import { EditorAutoCaptions } from "../components/editor-auto-captions";
import type { CaptionEditorDraftState } from "../lib/caption-editor";
import { EditorCanvasLayers } from "../components/editor-canvas-layers";
import { MusicWorkspace } from "../components/music-workspace";
import {
  canSplitAt,
  deleteClip,
  formatTimelineTime,
  sequenceToSource,
  sourceToSequence,
  splitClip,
  totalDuration,
  trimClip,
  validateClips,
} from "../lib/editor-timeline";
import { Recorder } from "../components/recorder";
import { useDesktopLayout } from "../components/desktop-layout";
import { color, font, styles, themedStyles } from "../theme";
import { useZiipa } from "../provider";
import {
  creatorMimeType,
  ApiError,
  ApiRequestError,
  uploadLimit,
  uploadMedia,
  type UploadFile,
} from "../lib/api";
import { editorCaptions } from "../lib/editor-captions";
import { validateSoundtrackStart } from "../lib/soundtrack-controls";
import {
  hasAdvancedOverlays,
  overlayLayoutSupported,
  overlayClipRange,
  validateOverlays,
  OVERLAY_API_REQUIRED,
} from "../lib/editor-overlays";
import { savedComposerParams } from "../lib/composer-navigation";
import {
  createEditorSaveController,
  creationPublishRestriction,
  creationPublishTargets,
  editorSaveLabel,
  matchesEditorSubmission,
  type EditorSavePhase,
} from "../lib/editor-save";
import {
  sourceCaptionsForEdit,
  validateCaptionCues,
} from "../lib/auto-captions";
import { audioCreationSource, isStudioMediaCategory, sourceMintItem } from "../lib/editor-source";
import { iosLimitedTestflight } from "../lib/config";
import { inCreativeWorld, parseEditing, parsePrice } from "../lib/domain";
import {
  rememberLocalMedia,
  forgetLocalMedia,
  retainDraftMedia,
  releaseDraftMedia,
  isRetainedDraftMedia,
} from "../lib/local-media";
import {
  providerSupports,
  socialProvider,
  socialProviders,
} from "../lib/social";
import type {
  Category,
  Bootstrap,
  Caption,
  Distribution,
  Item,
  ItemInput,
  Overlay,
  TimelineClip,
  VisualEffect,
  RootStack,
  SocialProvider,
} from "../lib/types";

const steps = [
  { name: "Media", Icon: Film },
  { name: "Edit", Icon: SlidersHorizontal },
  { name: "Overlay", Icon: Layers },
  { name: "Audio", Icon: Music2 },
  { name: "Save", Icon: Save },
  { name: "Share", Icon: Share2 },
] as const;

export function ComposerScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Composer">) {
  const { desktop } = useDesktopLayout();
  const insets = useSafeAreaInsets();
  const existing = route.params?.item?.category === "nft" ? undefined : route.params?.item;
  const persistedId = useRef(existing?.id);
  const remix = route.params?.remix?.category === "nft" ? undefined : route.params?.remix;
  const {
    data,
    session,
    guest,
    api,
    refresh,
    savePreviewDraft,
    recordSavedItem,
  } = useZiipa();
  const [overlayConfig, setOverlayConfig] = useState<unknown>(null);
  const [overlayConfigStatus, setOverlayConfigStatus] = useState<
    "checking" | "unavailable" | "unsupported" | "ready"
  >("checking");
  const overlayConfigEpoch = useRef(0);
  const reloadOverlayConfig = useCallback(async () => {
    const epoch = ++overlayConfigEpoch.current;
    setOverlayConfig(null);
    if (!session || guest) {
      setOverlayConfigStatus(guest ? "ready" : "unsupported");
      return;
    }
    setOverlayConfigStatus("checking");
    try {
      const result = await api("/api/creator/config");
      if (epoch !== overlayConfigEpoch.current) return;
      setOverlayConfig(result);
      setOverlayConfigStatus(
        overlayLayoutSupported(result) ? "ready" : "unsupported",
      );
    } catch (error) {
      if (epoch !== overlayConfigEpoch.current) return;
      setOverlayConfigStatus(
        (error as { status?: number }).status === 404
          ? "unsupported"
          : "unavailable",
      );
    }
  }, [api, session?.access_token, guest]);
  useEffect(() => {
    void reloadOverlayConfig();
    return () => {
      overlayConfigEpoch.current++;
    };
  }, [reloadOverlayConfig]);
  const advancedOverlaysSupported =
    guest || overlayLayoutSupported(overlayConfig);
  const originalUpload = !guest && session ? route.params?.upload : undefined;
  const seedCategory = remix?.category || route.params?.category;
  const [category, setCategory] = useState<Category>(
    existing?.category || (isStudioMediaCategory(seedCategory) ? seedCategory : "music"),
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
  // Auto recognition is source-relative; it remains separate from legacy
  // sequence-relative cues until a reviewed proposal is explicitly accepted.
  const [sourceCaptionTrack, setSourceCaptionTrack] = useState<
    Caption[] | null
  >(existing?.caption_source_cues || null);
  const [captionDraftState, setCaptionDraftState] =
    useState<CaptionEditorDraftState | null>(null);
  const captionDraftPending = captionDraftState !== null;
  const [price, setPrice] = useState(
    existing?.price_cents != null
      ? (existing.price_cents / 100).toFixed(2)
      : "",
  );
  const [file, setFile] = useState<UploadFile | null>(null);
  const [photos, setPhotos] = useState<
    { id?: string; file?: UploadFile; localUri?: string }[]
  >(() =>
    guest
      ? (existing?.local_photo_uris || [])
          .filter(isRetainedDraftMedia)
          .map((localUri) => ({ localUri }))
      : (existing?.photo_ids || []).map((id) => ({ id })),
  );
  const [photoIndex, setPhotoIndex] = useState(0);
  const generatedSource = useRef<{
    uri: string;
    release: () => Promise<void>;
  } | null>(null);
  const [musicPurpose, setMusicPurpose] = useState<"soundtrack" | "creation">(
    "soundtrack",
  );
  useEffect(
    () => () => {
      const held = generatedSource.current;
      if (held && !isRetainedDraftMedia(held.uri))
        void held.release().catch(() => {});
    },
    [],
  );
  const [recorderMode, setRecorderMode] = useState<"record" | "photo" | null>(
    null,
  );
  const capturedUris = useRef(new Set<string>());
  const selectedUris = useRef(new Set<string>());
  const retainedCaptureUris = useRef(new Set<string>());
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) setRecorderMode(null);
  }, [focused]);
  useEffect(
    () => () => {
      for (const uri of selectedUris.current) {
        if (!isRetainedDraftMedia(uri) && !retainedCaptureUris.current.has(uri)) forgetLocalMedia(uri);
      }
      for (const uri of capturedUris.current) {
        if (isRetainedDraftMedia(uri) || retainedCaptureUris.current.has(uri)) continue;
        if (Platform.OS === "web") URL.revokeObjectURL(uri);
        else
          void FileSystem.deleteAsync(uri, { idempotent: true }).catch(
            () => {},
          );
      }
    },
    [],
  );
  useEffect(() => {
    const active = new Set([file?.uri, ...photos.map((photo) => photo.localUri)]);
    for (const uri of selectedUris.current) {
      if (active.has(uri) || isRetainedDraftMedia(uri) || retainedCaptureUris.current.has(uri)) continue;
      forgetLocalMedia(uri);
      selectedUris.current.delete(uri);
    }
    for (const uri of capturedUris.current) {
      if (active.has(uri) || isRetainedDraftMedia(uri) || retainedCaptureUris.current.has(uri)) continue;
      if (Platform.OS === "web") URL.revokeObjectURL(uri);
      else
        void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      capturedUris.current.delete(uri);
    }
  }, [file, photos]);
  const [mediaId, setMediaId] = useState(
    existing?.media_id || originalUpload?.id || null,
  );
  const [soundtrackFile, setSoundtrackFile] = useState<UploadFile | null>(() =>
    existing?.demo &&
    existing.soundtrack?.local_uri &&
    isRetainedDraftMedia(existing.soundtrack.local_uri)
      ? {
          uri: existing.soundtrack.local_uri,
          name: existing.soundtrack.name,
          mimeType: "audio/wav",
          size: 0,
        }
      : null,
  );
  const [soundtrackStart, setSoundtrackStart] = useState(
    existing?.soundtrack?.start || 0,
  );
  const [soundtrackDuration, setSoundtrackDuration] = useState<number | null>(
    null,
  );
  const [soundtrackId, setSoundtrackId] = useState(
    existing?.soundtrack?.media_id || null,
  );
  const [soundtrackName, setSoundtrackName] = useState(
    existing?.soundtrack?.name || "",
  );
  const [soundtrackVolume, setSoundtrackVolume] = useState(
    String(Math.round((existing?.soundtrack?.volume ?? 0.7) * 100)),
  );
  const [overlays, setOverlays] = useState<Overlay[]>(existing?.overlays || []);
  const [selectedOverlay, setSelectedOverlay] = useState<string | null>(
    existing?.overlays?.[0]?.id || null,
  );
  const [visualEffect, setVisualEffect] = useState<VisualEffect>(
    existing?.visual_effect || "none",
  );
  const [clips, setClips] = useState<TimelineClip[]>(
    existing?.timeline?.clips || [],
  );
  const [timelineEdited, setTimelineEdited] = useState(!!existing?.timeline);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [seek, setSeek] = useState({ time: 0, nonce: 0 });
  const [selectedClip, setSelectedClip] = useState<string | null>(
    existing?.timeline?.clips[0]?.id || null,
  );
  const [frames, setFrames] = useState<EditorFrame[]>([]);
  const [canvasArea, setCanvasArea] = useState({ width: 320, height: 280 });
  const [sourceAspect, setSourceAspect] = useState(16 / 9);
  const receiveDimensions = useCallback((width: number, height: number) => {
    if (width > 0 && height > 0 && Number.isFinite(width / height))
      setSourceAspect(width / height);
  }, []);
  const [muted, setMuted] = useState(false);
  type EditState = {
    clips: TimelineClip[];
    timelineEdited: boolean;
    overlays: Overlay[];
    visualEffect: VisualEffect;
    caption: string;
    sourceCaptionTrack: Caption[] | null;
  };
  const [history, setHistory] = useState<{
    past: EditState[];
    future: EditState[];
  }>({ past: [], future: [] });
  const editSnapshot = {
    clips,
    timelineEdited,
    overlays,
    visualEffect,
    caption,
    sourceCaptionTrack,
  };
  function applyEdit(patch: Partial<EditState>) {
    if (busy) return;
    setHistory((h) => ({
      past: [...h.past.slice(-39), editSnapshot],
      future: [],
    }));
    restoreEdit({ ...editSnapshot, ...patch });
    setSaved(null);
  }
  function restoreEdit(state: EditState) {
    setClips(state.clips);
    setTimelineEdited(state.timelineEdited);
    setOverlays(state.overlays);
    setVisualEffect(state.visualEffect);
    setCaption(state.caption);
    setSourceCaptionTrack(state.sourceCaptionTrack);
  }
  function undoEdit(redo = false) {
    const stack = redo ? history.future : history.past;
    if (!stack.length || busy) return;
    const next = stack[stack.length - 1];
    setHistory(
      redo
        ? { past: [...history.past, editSnapshot], future: stack.slice(0, -1) }
        : {
            past: stack.slice(0, -1),
            future: [...history.future, editSnapshot],
          },
    );
    restoreEdit(next);
    setSelectedClip(next.clips[0]?.id || null);
    seekTo(0);
    setSaved(null);
  }
  function seekTo(time: number) {
    setCurrentTime(time);
    setSeek((value) => ({ time, nonce: value.nonce + 1 }));
  }
  const receiveDuration = useCallback(
    (value: number) => {
      if (!Number.isFinite(value) || value <= 0 || value > 86400) return;
      setDuration(value);
      setClips((current) =>
        current.length
          ? current
          : [
              {
                id: "clip-original",
                start: Number(start) || 0,
                end: Math.min(value, Number(end) || value),
              },
            ],
      );
      setSelectedClip((current) => current || "clip-original");
    },
    [start, end],
  );
  function resetSource() {
    setPhotos([]);
    setPhotoIndex(0);
    const held = generatedSource.current;
    generatedSource.current = null;
    if (held && !isRetainedDraftMedia(held.uri))
      void held.release().catch(() => {});
    setDuration(0);
    setFrames([]);
    setClips([]);
    setTimelineEdited(false);
    setSourceCaptionTrack(null);
    setCaptionDraftState(null);
    setCaption("");
    setHistory({ past: [], future: [] });
    setStart("0");
    setEnd("");
    seekTo(0);
    setPaused(true);
  }
  const selectedSoundtrackUris = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const uri of selectedSoundtrackUris.current)
        if (!isRetainedDraftMedia(uri)) void disposePickedAudio(uri);
    },
    [],
  );
  const generatedRelease = useRef<(() => Promise<void>) | null>(null);
  useEffect(
    () => () => {
      void generatedRelease.current?.().catch(() => {});
    },
    [],
  );
  function releaseSoundtrack() {
    void generatedRelease.current?.().catch(() => {});
    generatedRelease.current = null;
    if (
      soundtrackFile &&
      selectedSoundtrackUris.current.has(soundtrackFile.uri) &&
      !isRetainedDraftMedia(soundtrackFile.uri)
    ) {
      selectedSoundtrackUris.current.delete(soundtrackFile.uri);
      void disposePickedAudio(soundtrackFile.uri);
    }
  }
  const [targets, setTargets] = useState<SocialProvider[]>(
    existing?.distribution_targets || [],
  );
  const [socialNetworksExpanded, setSocialNetworksExpanded] = useState(false);
  const [tab, setTab] = useState<(typeof steps)[number]["name"]>(
    desktop && existing ? "Edit" : "Media",
  );
  const [paused, setPaused] = useState(true);
  const [busy, setBusy] = useState(false);
  type SaveButton =
    | "share-draft"
    | "share-publish"
    | "desktop-draft"
    | "caption-draft";
  type PendingSubmission = {
    payload: ItemInput;
    id: string | null;
    baselineIds: string[];
    cleanFingerprint: string;
    ownerToken: string;
  };
  const saveLock = useRef(false);
  const saveController = useRef(createEditorSaveController());
  const [activeSaveButton, setActiveSaveButton] = useState<SaveButton | null>(
    null,
  );
  const [savePhase, setSavePhase] = useState<EditorSavePhase>("checking");
  const [saveNotice, setSaveNotice] = useState("");
  const [pendingSubmission, setPendingSubmission] =
    useState<PendingSubmission | null>(null);
  const [recheckCandidates, setRecheckCandidates] = useState<Item[]>([]);
  const [rechecking, setRechecking] = useState(false);
  const recheckLock = useRef(false);
  const [deliveryNeedsReview, setDeliveryNeedsReview] = useState(false);
  const publishRestriction = creationPublishRestriction(category, existing?.visibility);
  const saveOwner = useRef(session?.access_token || (guest ? "guest" : null));
  saveOwner.current = session?.access_token || (guest ? "guest" : null);
  const saveGeneration = useRef(0);
  const saveMounted = useRef(true);
  const pickerRequest = useRef(0);
  useEffect(() => {
    saveMounted.current = true;
    saveGeneration.current++;
    saveController.current = createEditorSaveController();
    saveLock.current = false;
    recheckLock.current = false;
    setBusy(false);
    setSaved(null);
    setPendingSubmission(null);
    setRecheckCandidates([]);
    setActiveSaveButton(null);
    setRechecking(false);
    setSaveNotice("");
    setDeliveryNeedsReview(false);
    return () => {
      saveMounted.current = false;
      saveGeneration.current++;
    };
  }, [session?.access_token, guest]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Item | null>(null);
  const isExistingCreation = Boolean(existing || saved);
  const draftActionTitle = isExistingCreation ? "Re-Save Draft" : "Save Draft";
  const publishActionTitle = isExistingCreation
    ? "Re-Publish Creation"
    : "Publish Creation";
  const { height } = useWindowDimensions();
  const [mobileEditorHeight, setMobileEditorHeight] = useState(height);
  // Preserve the desktop warning for this editing session after narrowing the
  // portal. The compact/native layout itself remains unchanged.
  const [desktopEditingSession, setDesktopEditingSession] = useState(desktop);
  useEffect(() => {
    if (desktop) setDesktopEditingSession(true);
  }, [desktop]);
  const formSnapshot = {
    category,
    title,
    description,
    tags,
    city,
    start,
    end,
    caption,
    sourceCaptionTrack,
    price,
    mediaId,
    photos,
    file: file
      ? {
          uri: file.uri,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
        }
      : null,
    soundtrackId,
    soundtrackFile: soundtrackFile
      ? {
          uri: soundtrackFile.uri,
          name: soundtrackFile.name,
          size: soundtrackFile.size,
          mimeType: soundtrackFile.mimeType,
        }
      : null,
    soundtrackName,
    soundtrackVolume,
    soundtrackStart,
    overlays,
    visualEffect,
    timeline: timelineEdited
      ? { version: 1, clips }
      : (!file ? existing?.timeline : null) || null,
    targets: [...targets].sort(),
    sampleId: sample?.id || null,
    remixId: remix?.id || null,
  };
  const fingerprint = JSON.stringify(formSnapshot);
  const [cleanFingerprint, setCleanFingerprint] = useState(() =>
    !existing && (originalUpload || remix) ? "" : fingerprint,
  );
  const unsaved = fingerprint !== cleanFingerprint || captionDraftPending;
  const mintSource = sourceMintItem(saved || existing, session?.user.id, unsaved);
  usePreventRemove(
    busy && savePhase !== "refresh" && savePhase !== "distribution",
    () =>
      Alert.alert(
        "Saving your creation",
        "Please wait for the upload or save to finish.",
      ),
  );
  usePreventRemove(
    (desktop || desktopEditingSession) && unsaved && !busy,
    ({ data: action }) => {
      if (
        Platform.OS === "web" &&
        window.confirm("Leave this creation? Unsaved changes will be lost.")
      )
        navigation.dispatch(action.action);
    },
  );
  useEffect(() => {
    if (
      !(desktop || desktopEditingSession) ||
      Platform.OS !== "web" ||
      (!unsaved && !busy)
    )
      return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [desktop, desktopEditingSession, unsaved, busy]);
  const base: Item = (guest ? sample : existing) || {
    id: "new",
    title: "Your next creation",
    description: "",
    category,
    creator: session?.user.name || "Ziipa Studio",
    tags: [],
    city: "",
    cover: originalUpload?.content_type.startsWith("image/")
      ? `/api/creator/media/${originalUpload.id}`
      : "/brand/ziipa-background.png",
    media_url:
      originalUpload && !originalUpload.content_type.startsWith("image/")
        ? `/api/creator/media/${originalUpload.id}`
        : null,
    content_type: originalUpload?.content_type,
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
    captions:
      sourceCaptionTrack !== null
        ? (() => {
            try {
              return sourceCaptionsForEdit(
                sourceCaptionTrack,
                timelineEdited ? clips : undefined,
              );
            } catch {
              return [];
            } // Invalid text is reported on save, never rendered.
          })()
        : editorCaptions(
            file ? undefined : existing,
            caption,
            clips,
            timelineEdited,
            editing.captions || [],
          ),
    overlays: overlays.filter((layer) => layer.text.trim()),
    timeline: timelineEdited
      ? { version: 1, clips }
      : (!file ? existing?.timeline : null) || null,
    visual_effect: visualEffect,
  };
  const selectedPhoto = photos[photoIndex - 1];
  const photoPreview = selectedPhoto?.id
    ? { ...canvas, cover: `/api/creator/media/${selectedPhoto.id}`, media_url: null }
    : canvas;
  const mainLocalUri = file?.uri ||
    (guest && base.media_url && isRetainedDraftMedia(base.media_url) ? base.media_url : undefined);
  const photoPreviewUri = selectedPhoto ? selectedPhoto.localUri : mainLocalUri;
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
  async function pick(kind: "media" | "soundtrack" | "audioSource" = "media") {
    const owner = saveOwner.current;
    const generation = saveGeneration.current;
    const request = ++pickerRequest.current;
    const current = () =>
      saveMounted.current &&
      saveOwner.current === owner &&
      saveGeneration.current === generation &&
      pickerRequest.current === request;
    setError("");
    try {
      const result = await pickCreatorMedia(
        kind === "media" ? ["image/*", "video/*", "audio/*"] : ["audio/*"],
        kind === "media" ? "media" : false,
        current,
        kind === "media",
      );
      if (result.canceled || !current()) return;
      if (result.assets.length > maxCreationPhotos)
        throw new Error(`Choose up to ${maxCreationPhotos} photos.`);
      const files = await Promise.all(result.assets.map(async (asset) => {
        const info = asset.size == null && Platform.OS !== "web"
          ? await FileSystem.getInfoAsync(asset.uri)
          : null;
        const size = asset.size ?? (info?.exists && !info.isDirectory ? info.size : 0);
        if (!size || size > uploadLimit)
          throw new Error("Choose files no larger than 100 MB each.");
        return fileFromAsset({ ...asset, size });
      }));
      if (!current()) return;
      const [selected, ...additional] = files;
      if (!selected) return;
      if (additional.length && files.some((entry) => !entry.mimeType.startsWith("image/")))
        throw new Error("Choose up to 10 photos together, or select one video or audio file.");
      if (kind !== "media" && !selected.mimeType.startsWith("audio/"))
        throw new Error("Choose an audio file.");
      if (kind === "soundtrack") {
        if (!selected.mimeType.startsWith("audio/"))
          throw new Error("Choose an audio file for the soundtrack.");
        releaseSoundtrack();
        rememberLocalMedia(selected.uri);
        selectedSoundtrackUris.current.add(selected.uri);
        setSoundtrackFile(selected);
        setSoundtrackId(null);
        setSoundtrackStart(0);
        setSoundtrackDuration(null);
        setSoundtrackName(selected.name.replace(/\.[^.]+$/, ""));
      } else {
        resetSource();
        for (const entry of files) {
          rememberLocalMedia(entry.uri);
          selectedUris.current.add(entry.uri);
          if (Platform.OS === "web" && entry.uri.startsWith("blob:"))
            capturedUris.current.add(entry.uri);
        }
        setFile(selected);
        setPhotos(additional.map((entry) => ({ file: entry, localUri: entry.uri })));
        setMediaId(null);
        setTitle((current) => current || selected.name.replace(/\.[^.]+$/, ""));
        setTab("Edit");
        if (selected.mimeType.startsWith("video/")) setCategory("video");
        if (selected.mimeType.startsWith("audio/")) setCategory("music");
      }
      setSaved(null);
    } catch (e) {
      if (current()) setError((e as Error).message);
    }
  }
  function useRecording(cameraFile: UploadFile) {
    rememberLocalMedia(cameraFile.uri);
    selectedUris.current.add(cameraFile.uri);
    capturedUris.current.add(cameraFile.uri);
    const photo = cameraFile.mimeType.startsWith("image/");
    const append = photo && canvas.content_type?.startsWith("image/") && !!(file || mediaId || mainLocalUri);
    if (append && photos.length + 1 < maxCreationPhotos) {
      setPhotos([...photos, { file: cameraFile, localUri: cameraFile.uri }]);
      setPhotoIndex(photos.length + 1);
    } else if (!append) {
      resetSource();
      setFile(cameraFile);
      setMediaId(null);
      if (!photo) setCategory("video");
    }
    if (photo) setTitle((current) => current || cameraFile.name.replace(/\.[^.]+$/, ""));
    setSaved(null);
    setError("");
    setPaused(true);
    setRecorderMode(null);
    setTab("Edit");
  }
  async function save(
    visibility: "draft" | "published",
    button: SaveButton = "share-draft",
  ) {
    if (saveLock.current || recheckLock.current) return;
    if (saveController.current.unconfirmed || pendingSubmission) {
      setError(
        "The last save was not confirmed. Check its saved status before submitting again; your edits are still here.",
      );
      return;
    }
    if (visibility === "published" && (guest || publishRestriction)) return;
    const publishingToZiipaOnly = visibility === "published" && deliveryNeedsReview && targets.length > 0;
    const saveTargets = visibility === "published"
      ? creationPublishTargets(targets, deliveryNeedsReview)
      : targets;
    if (
      visibility === "published" &&
      saved?.visibility === "published" &&
      !unsaved
    )
      return;
    saveLock.current = true;
    const ownerToken = saveOwner.current;
    const generation = saveGeneration.current;
    const current = () =>
      saveMounted.current &&
      saveOwner.current === ownerToken &&
      saveGeneration.current === generation;
    const assertCurrent = () => {
      if (!current())
        throw new Error(
          "Your account changed. Reopen your creation before saving.",
        );
    };
    setError("");
    setSaveNotice("");
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
      if (captionDraftPending) {
        setTab("Overlay");
        throw new Error(
          "Apply or discard your caption draft before saving this creation.",
        );
      }
      if (!title.trim()) {
        setTab("Save");
        throw new Error("Give your creation a title.");
      }
      if (parsedTags.length > 12 || parsedTags.some((t) => t.length > 40))
        throw new Error("Use up to 12 tags, each under 40 characters.");
      validateOverlays(overlays);
      parsed = parseEditing(start, end, caption);
      if (timelineEdited) {
        validateClips(clips, duration || 86400);
        if (!clips.length)
          throw new Error("Add a clip to your timeline before saving.");
        parsed = {
          trim_start: 0,
          trim_end: null,
          captions: editorCaptions(existing, caption, clips, true, []),
        };
      } else if (
        !file &&
        caption === (existing?.captions?.[0]?.text || "") &&
        existing?.captions?.length
      )
        parsed.captions = existing.captions;
      if (sourceCaptionTrack !== null) {
        validateCaptionCues(sourceCaptionTrack);
        parsed.captions = sourceCaptionsForEdit(
          sourceCaptionTrack,
          timelineEdited ? clips : undefined,
        );
      }
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
      if (soundtrackName.trim() && (soundtrackFile || soundtrackId))
        validateSoundtrackStart(soundtrackStart, soundtrackDuration);
    } catch (e) {
      setError((e as Error).message);
      saveLock.current = false;
      return;
    }
    setBusy(true);
    setActiveSaveButton(button);
    setSavePhase("checking");
    setProgress(0);
    try {
      if (guest) {
        setSavePhase("saving");
        const draft: Item = {
          ...base,
          ...parsed,
          caption_source_cues: sourceCaptionTrack,
          id: persistedId.current || `preview-draft-${Date.now()}`,
          title: title.trim(),
          description,
          category,
          media_url: file?.uri || base.media_url,
          content_type: file?.mimeType || base.content_type,
          local_photo_uris: photos.flatMap((photo) => photo.localUri ? [photo.localUri] : []),
          tags: parsedTags,
          city: city.trim(),
          price_cents,
          remix_of: remix?.id || existing?.remix_of || null,
          overlays: canvas.overlays,
          timeline: canvas.timeline,
          visual_effect: visualEffect,
          soundtrack: soundtrackName.trim()
            ? {
                media_id: null,
                name: soundtrackName.trim(),
                volume: Number(soundtrackVolume) / 100,
                start: soundtrackStart,
                ...(soundtrackFile ? { local_uri: soundtrackFile.uri } : {}),
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
          label:
            file || base.label === "Local draft"
              ? "Local draft"
              : "Sample draft",
        };
        if (file) {
          retainedCaptureUris.current.add(file.uri);
          if (generatedSource.current?.uri === file.uri) {
            retainDraftMedia(
              `${draft.id}:source`,
              file.uri,
              generatedSource.current.release,
            );
            generatedSource.current = null;
          } else if (file.mimeType.startsWith("image/")) {
            retainDraftMedia(`${draft.id}:source`, file.uri);
          }
        }
        for (let index = 0; index < maxCreationPhotos - 1; index++) {
          const key = `${draft.id}:photo:${index}`;
          const uri = draft.local_photo_uris?.[index];
          if (uri) retainDraftMedia(key, uri);
          else releaseDraftMedia(key);
        }
        if (soundtrackFile) {
          retainDraftMedia(
            `${draft.id}:soundtrack`,
            soundtrackFile.uri,
            generatedRelease.current ||
              (() => disposePickedAudio(soundtrackFile.uri)),
          );
          generatedRelease.current = null;
        }
        persistedId.current = draft.id;
        savePreviewDraft(draft);
        if (!soundtrackFile) releaseDraftMedia(`${draft.id}:soundtrack`);
        navigation.replaceParams(savedComposerParams(draft));
        setSaved(draft);
        setCleanFingerprint(JSON.stringify({ ...formSnapshot, remixId: null }));
        setSaveNotice(
          "Draft saved for this preview session. Nothing was published.",
        );
      } else {
        let submitted: PendingSubmission | null = null;
        const controller = saveController.current;
        const outcome = await controller.run({
          action: visibility,
          phase: (phase) => {
            if (current()) {
              setSavePhase(phase);
              setProgress(0);
            }
          },
          isUnconfirmed: (error) =>
            (error instanceof ApiRequestError &&
              error.outcome === "unconfirmed") ||
            (error instanceof ApiError && error.status >= 500),
          prepare: async (phase) => {
            assertCurrent();
            // Older APIs ignore unknown overlay fields. Check before uploading
            // or writing so an unsupported edit is never silently discarded.
            if (hasAdvancedOverlays(overlays) || photos.length) {
              let config: unknown;
              try {
                config = await api("/api/creator/config");
              } catch (error) {
                if ((error as { status?: number }).status === 404)
                  throw new Error(photos.length ? "Photo series saves require the updated Ziipa server." : OVERLAY_API_REQUIRED);
                throw new Error(
                  "Could not verify save support. Your changes are still here. Try again shortly.",
                );
              }
              assertCurrent();
              setOverlayConfig(config);
              if (hasAdvancedOverlays(overlays) && !overlayLayoutSupported(config))
                throw new Error(OVERLAY_API_REQUIRED);
              if (photos.length && (config as { photo_series?: boolean } | null)?.photo_series !== true)
                throw new Error("Photo series saves require the updated Ziipa server.");
            }
            let selectedId = mediaId;
            const sourceCount = photos.length + 1;
            if (file && !selectedId) {
              phase("upload_source");
              const uploaded = await uploadMedia(
                file,
                session!.access_token,
                (value) => {
                  if (current()) setProgress(value / sourceCount);
                },
              );
              assertCurrent();
              selectedId = uploaded.id;
              setMediaId(selectedId);
            }
            const uploadedPhotos = [...photos];
            if (photos.some((photo) => !photo.id)) {
              phase("upload_source");
              for (const [index, photo] of photos.entries()) {
                if (photo.id) continue;
                if (!photo.file) throw new Error("Select the missing photo again.");
                const uploaded = await uploadMedia(photo.file, session!.access_token, (value) => {
                  if (current()) setProgress((100 * (index + 1) + value) / sourceCount);
                });
                assertCurrent();
                uploadedPhotos[index] = { ...photo, id: uploaded.id };
                setPhotos([...uploadedPhotos]);
              }
            }
            let selectedSoundtrackId = soundtrackId;
            if (soundtrackFile && !selectedSoundtrackId) {
              phase("upload_soundtrack");
              const uploaded = await uploadMedia(
                soundtrackFile,
                session!.access_token,
                (value) => {
                  if (current()) setProgress(value);
                },
              );
              assertCurrent();
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
              ...(uploadedPhotos.length || existing?.photo_ids?.length
                ? { photo_ids: uploadedPhotos.map((photo) => photo.id!) }
                : {}),
              visibility,
              ...parsed,
              caption_source_cues: sourceCaptionTrack,
              price_cents,
              remix_of: remix?.id || existing?.remix_of || null,
              overlays: canvas.overlays || [],
              timeline: canvas.timeline,
              visual_effect: visualEffect,
              soundtrack: soundtrackName.trim()
                ? {
                    media_id: selectedSoundtrackId,
                    name: soundtrackName.trim(),
                    volume: Number(soundtrackVolume) / 100,
                    start: soundtrackStart,
                  }
                : null,
              distribution_targets: saveTargets,
            };
            return {
              payload,
              cleanFingerprint: JSON.stringify({
                ...formSnapshot,
                mediaId: selectedId,
                photos: uploadedPhotos,
                soundtrackId: selectedSoundtrackId,
                remixId: null,
              }),
            };
          },
          write: async (prepared) => {
            assertCurrent();
            submitted = {
              ...prepared,
              id: persistedId.current || null,
              baselineIds: data.drafts.map((item) => item.id),
              ownerToken: session!.access_token,
            };
            return api<Item>(
              persistedId.current
                ? `/api/creator/items/${persistedId.current}`
                : "/api/creator/items",
              prepared.payload,
            );
          },
          confirmed: (result, prepared) => {
            assertCurrent();
            persistedId.current = result.id;
            // The canonical POST response is the receipt. Show it before a
            // separate library read, which can fail without undoing the save.
            setSaved(result);
            recordSavedItem(result, session!.access_token);
            setCleanFingerprint(prepared.cleanFingerprint);
            navigation.replaceParams(savedComposerParams(result));
          },
          ...(visibility === "published" && saveTargets.length
            ? {
                distribute: async (result: Item) => {
                  assertCurrent();
                  const distribution = await api<Distribution[]>(
                    `/api/creator/items/${result.id}/distribute`,
                      { providers: saveTargets },
                  );
                  assertCurrent();
                  const confirmed = { ...result, distribution };
                  setSaved(confirmed);
                  recordSavedItem(confirmed, session!.access_token);
                },
              }
            : {}),
          refresh: async () => {
            assertCurrent();
            await refresh({ throwOnError: true });
          },
        });
        if (!current()) return;
        if (outcome.kind === "failed") throw outcome.error;
        if (outcome.kind === "unconfirmed") {
          setPendingSubmission(submitted);
          setRecheckCandidates([]);
          setError(
            "Ziipa did not confirm the save response. It may already have saved or published this creation. Your edits are intact. Use Check saved status; do not publish again yet.",
          );
        } else if (outcome.kind === "confirmed") {
          setDeliveryNeedsReview(deliveryNeedsReview || outcome.distributionUnconfirmed);
          setSaveNotice(
            [
              ...outcome.warnings,
              ...(publishingToZiipaOnly
                ? ["Published to Ziipa only. Check the network outbox for the earlier delivery."]
                : []),
            ].join("\n") ||
              (visibility === "published"
                ? "Creation published to Ziipa."
                : "Private draft saved to your account."),
          );
        }
      }
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) {
        saveLock.current = false;
        setBusy(false);
        setActiveSaveButton(null);
      }
    }
  }
  function confirmRecheckedItem(item: Item, pending: PendingSubmission) {
    if (
      saveOwner.current !== pending.ownerToken ||
      !session ||
      item.creator_id !== session.user.id
    )
      return;
    saveController.current.confirmReadOnlyResult();
    persistedId.current = item.id;
    setSaved(item);
    recordSavedItem(item, pending.ownerToken);
    setCleanFingerprint(pending.cleanFingerprint);
    setPendingSubmission(null);
    setRecheckCandidates([]);
    setError("");
    setDeliveryNeedsReview(!!pending.payload.distribution_targets.length);
    setSaveNotice(
      "Saved creation confirmed from your account. Nothing was submitted again. Review the network outbox separately before requesting external delivery.",
    );
    navigation.replaceParams(savedComposerParams(item));
  }
  async function recheckSavedStatus() {
    const pending = pendingSubmission;
    if (
      !pending ||
      saveLock.current ||
      recheckLock.current ||
      pending.ownerToken !== saveOwner.current ||
      !session
    )
      return;
    recheckLock.current = true;
    const generation = saveGeneration.current;
    const current = () =>
      saveMounted.current &&
      generation === saveGeneration.current &&
      pending.ownerToken === saveOwner.current;
    setRechecking(true);
    setError("");
    try {
      // Owner-only canonical rows, not a title search or an optimistic replay.
      const bootstrap = await api<Bootstrap>("/api/creator/bootstrap");
      if (!current()) return;
      const matches = bootstrap.drafts.filter((item) =>
        matchesEditorSubmission(item, pending.payload, session.user.id),
      );
      const known = pending.id
        ? matches.find((item) => item.id === pending.id)
        : null;
      if (known) confirmRecheckedItem(known, pending);
      else {
        const candidates = pending.id
          ? []
          : matches.filter((item) => !pending.baselineIds.includes(item.id));
        setRecheckCandidates(candidates.slice(0, 3));
        setSaveNotice(
          candidates.length
            ? "Matching saved creations were found in your account. Review the creation, then explicitly choose Use this saved creation. No creation or external delivery was submitted again."
            : "No matching acknowledgement is visible yet. Your edits remain here. Checking status only reads your account; it does not submit again.",
        );
      }
    } catch (error) {
      if (current())
        setError(
          error instanceof Error
            ? error.message
            : "Could not check saved status. Your edits remain here.",
        );
    } finally {
      if (current()) {
        recheckLock.current = false;
        setRechecking(false);
      }
    }
  }
  const frameWidth = Math.min(
    canvasArea.width,
    canvasArea.height * sourceAspect,
  );
  const frameHeight = frameWidth / sourceAspect;
  const previewFrame = {
    x: (canvasArea.width - frameWidth) / 2,
    y: (canvasArea.height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
  };
  const previewCaptionTime = canvas.timeline
    ? currentTime
    : currentTime + (Number(start) || 0);
  const preview = (
    <View
      onLayout={(event) => {
        // Native layout events are pooled; retain values, not the event, for
        // the state updater that React may evaluate after dispatch returns.
        const { width, height } = event.nativeEvent.layout;
        setCanvasArea((previous) =>
          previous.width === width && previous.height === height
            ? previous
            : { width, height },
        );
      }}
      style={{
        height: desktop
          ? "100%"
          : Math.min(300, Math.max(96, mobileEditorHeight * 0.32)),
        width: desktop ? "100%" : undefined,
        alignSelf: desktop ? "center" : undefined,
        margin: desktop ? 0 : 14,
        marginBottom: 0,
        borderRadius: desktop ? 0 : 16,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: "#574366",
      }}
    >
      <EditorPreview
        item={photoPreview}
        paused={paused}
        muted={muted}
        localUri={photoPreviewUri}
        clips={clips}
        seek={seek}
        onTime={setCurrentTime}
        onDuration={receiveDuration}
        onFrames={setFrames}
        onDimensions={receiveDimensions}
      />
      <EditorSoundtrack
        mediaId={soundtrackId}
        uri={soundtrackFile?.uri}
        paused={paused || muted}
        time={currentTime}
        volume={Number(soundtrackVolume) / 100}
        start={soundtrackStart}
      />
      <EditorCanvasLayers
        frame={previewFrame}
        overlays={overlays}
        time={currentTime}
        caption={
          canvas.captions?.find(
            (cue) =>
              previewCaptionTime >= cue.start && previewCaptionTime < cue.end,
          )?.text
        }
        selectedId={tab === "Overlay" ? selectedOverlay : null}
        onSelect={(id) => {
          setSelectedOverlay(id);
          setTab("Overlay");
        }}
        onPositionChange={
          tab === "Overlay" && !busy && advancedOverlaysSupported
            ? (id, position) => {
                applyEdit({
                  overlays: overlays.map((layer) =>
                    layer.id === id ? { ...layer, ...position } : layer,
                  ),
                });
              }
            : undefined
        }
        onInteractionStart={() => setPaused(true)}
      />
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
        {photos.length ? (
          <PhotoSteps index={photoIndex} count={photos.length + 1} onChange={setPhotoIndex} />
        ) : (
          <Text style={eStyle.badge}>{guest ? "SAMPLE EDITOR" : "YOUR CREATION"}</Text>
        )}
        <FloatButton
          label={paused ? "Play editing preview" : "Pause editing preview"}
          icon={paused ? Play : Pause}
          size={37}
          onPress={() => setPaused(!paused)}
        />
      </View>
    </View>
  );
  const stepTabs = (
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
          onPress={() => {
            setPaused(true);
            if (name === "Audio") setMusicPurpose("soundtrack");
            setTab(name);
          }}
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
              fontSize: desktop ? 12 : 10,
              color: tab === name ? "white" : color.faint,
            }}
          >
            {desktop
              ? (
                  {
                    Media: "Upload",
                    Edit: "Edit",
                    Overlay: "Overlay",
                    Audio: "Audio",
                    Save: "Save",
                    Share: "Share",
                  } as const
                )[name]
              : name === "Media"
                ? "Upload"
                : name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
  const timeline = photos.length ? (
    <Text style={[styles.small, { padding: 16 }]}>
      Use the arrows on the preview to review all {photos.length + 1} photos.
    </Text>
  ) : canvas.content_type?.startsWith("image/") ? (
    <View style={{ padding: 16, gap: 5 }}>
      <Text style={styles.label}>Still canvas · 6 seconds</Text>
      <Text style={[styles.small, { fontSize: 11 }]}>
        Add text, effects and music. Export creates a six-second video; animated
        images use their first frame.
      </Text>
    </View>
  ) : (
    <EditorTimeline
      compact={desktop}
      duration={duration}
      currentTime={currentTime}
      sourceTime={sequenceToSource(clips, currentTime)?.sourceTime}
      clips={clips}
      selectedId={selectedClip}
      thumbnails={frames}
      captionLabel={
        sourceCaptionTrack?.length
          ? `${sourceCaptionTrack.length} timed caption${sourceCaptionTrack.length === 1 ? "" : "s"}`
          : caption
      }
      musicLabel={soundtrackName}
      onCaption={() => setTab("Overlay")}
      onMusic={() => {
        setPaused(true);
        setMusicPurpose("soundtrack");
        setTab("Audio");
      }}
      disabled={busy}
      onInteractionStart={() => setPaused(true)}
      onSeek={seekTo}
      onSelect={setSelectedClip}
      onTrim={(id, range) => {
        try {
          const next = trimClip(clips, id, range.start, range.end, duration);
          applyEdit({ clips: next, timelineEdited: true });
          seekTo(0);
        } catch (e) {
          setError((e as Error).message);
        }
      }}
      onSplit={() => {
        try {
          const next = splitClip(clips, currentTime, `clip-${Date.now()}`);
          applyEdit({ clips: next, timelineEdited: true });
          setSelectedClip(
            next[sequenceToSource(next, currentTime)?.index || 0]?.id || null,
          );
          seekTo(currentTime);
        } catch (e) {
          setError((e as Error).message);
        }
      }}
      onDelete={() => {
        if (clips.length <= 1 || !selectedClip) return;
        const next = deleteClip(clips, selectedClip);
        applyEdit({ clips: next, timelineEdited: true });
        setSelectedClip(next[0].id);
        seekTo(0);
      }}
      onUndo={() => undoEdit()}
      onRedo={() => undoEdit(true)}
      canSplit={canSplitAt(clips, currentTime)}
      canDelete={clips.length > 1 && !!selectedClip}
      canUndo={history.past.length > 0}
      canRedo={history.future.length > 0}
    />
  );
  const transport = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        padding: 10,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to start"
        onPress={() => seekTo(0)}
        style={{ padding: 9 }}
      >
        <SkipBack size={20} color="white" />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={paused ? "Play timeline" : "Pause timeline"}
        onPress={() => setPaused(!paused)}
        style={{ backgroundColor: color.purple, padding: 13, borderRadius: 24 }}
      >
        {paused ? (
          <Play size={22} color="white" />
        ) : (
          <Pause size={22} color="white" />
        )}
      </Pressable>
      <Text
        style={{
          color: "white",
          fontFamily: font.medium,
          fontSize: 12,
          minWidth: 95,
        }}
      >
        {formatTimelineTime(currentTime)} /{" "}
        {formatTimelineTime(totalDuration(clips))}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={muted ? "Unmute preview" : "Mute preview"}
        onPress={() => setMuted(!muted)}
        style={{ padding: 9 }}
      >
        {muted ? (
          <VolumeX size={19} color={color.muted} />
        ) : (
          <Volume2 size={19} color="white" />
        )}
      </Pressable>
    </View>
  );
  const inspector = (
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
          <Field
            label="Creation title"
            value={title}
            onChangeText={setTitle}
            maxLength={140}
            editable={!busy}
            placeholder="Give it a name"
          />
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
                      resetSource();
                      setFile(null);
                      setMediaId(null);
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
                  Up to 10 photos, or one video or audio file · 100 MB per file
                </Text>
              </View>
            </View>
            {!!photos.length ? (
              <Text style={styles.small}>{photos.length + 1} photos selected</Text>
            ) : !!file ? (
              <Text style={[styles.small, { color: color.text }]}>
                {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
              </Text>
            ) : !!mediaId && (
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
                  title="Camera"
                  icon={Camera}
                  secondary
                  disabled={busy || photos.length + 1 >= maxCreationPhotos}
                  onPress={() => {
                    setPaused(true);
                    setRecorderMode("photo");
                  }}
                />
              </View>
            </View>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Action
                  title="Record video"
                  icon={Film}
                  secondary
                  disabled={busy}
                  onPress={() => {
                    setPaused(true);
                    setRecorderMode("record");
                  }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Action
                  title="AI Creation"
                  icon={Sparkles}
                  secondary
                  disabled={busy}
                  onPress={() => {
                    setPaused(true);
                    setMusicPurpose("creation");
                    setTab("Audio");
                  }}
                />
              </View>
            </View>
            <Text style={styles.small}>
              Create instrumental music or voice narration, then preview and
              choose the audio before saving. Video generation and voice cloning
              are not connected.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Set up a live broadcast"
              disabled={busy}
              onPress={() => {
                setPaused(true);
                navigation.navigate("Live", { tab: "broadcast" });
              }}
              style={[styles.row, { justifyContent: "center", padding: 8 }]}
            >
              <Radio size={18} color="#FF707D" />
              <Text style={[styles.small, { color: color.text }]}>
                Create a live broadcast
              </Text>
            </Pressable>
          </View>
        </>
      )}
      {tab === "Edit" && (
        <View style={{ gap: 15 }}>
          <View style={styles.row}>
            <Scissors size={20} color={color.lime} />
            <Text style={[styles.heading, { fontSize: 20 }]}>
              Make your cut
            </Text>
          </View>
          <Text style={styles.small}>
            Drag the playhead, split at a moment, then select a clip to trim or
            remove it. Your original stays untouched.
          </Text>
          {!desktop && timeline}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add text and captions"
            onPress={() => setTab("Overlay")}
            style={{
              flexDirection: "row",
              alignItems: "center",
              padding: 14,
              gap: 12,
              backgroundColor: color.panel,
              borderRadius: 10,
            }}
          >
            <Captions size={21} color={color.lime} />
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Text, captions & effects</Text>
              <Text style={styles.small}>
                Titles, lower thirds and color looks
              </Text>
            </View>
            <ChevronRight color={color.muted} size={18} />
          </Pressable>
          {duration > 90 && (
            <Text style={[styles.small, { fontSize: 11 }]}>
              Your source is {formatTimelineTime(duration)}. Trim the edited
              sequence to 90 seconds or less for the current export worker.
            </Text>
          )}
        </View>
      )}
      <View style={tab === "Overlay" ? undefined : { display: "none" }}>
        <EditorOverlays
          overlays={overlays}
          selectedId={selectedOverlay}
          effect={visualEffect}
          sourceCover={frames[Math.min(2, frames.length - 1)]?.source}
          caption={caption}
          disabled={busy}
          time={currentTime}
          duration={totalDuration(clips)}
          selectedClipRange={overlayClipRange(clips, selectedClip)}
          onSeek={(time) => {
            setPaused(true);
            seekTo(time);
          }}
          advancedSupported={advancedOverlaysSupported}
          advancedStatus={overlayConfigStatus}
          onRefreshCapabilities={() => void reloadOverlayConfig()}
          onChange={(value) => applyEdit({ overlays: value })}
          onSelect={setSelectedOverlay}
          onEffect={(value) => applyEdit({ visualEffect: value })}
          onCaption={(value) =>
            applyEdit({ caption: value, sourceCaptionTrack: null })
          }
          captionTools={
            <EditorAutoCaptions
              itemId={
                mediaId
                  ? saved?.media_id === mediaId
                    ? saved.id
                    : existing?.media_id === mediaId
                      ? existing.id
                      : undefined
                  : undefined
              }
              mediaId={mediaId}
              key={`${session?.access_token || "guest"}:${file?.uri || mediaId || sample?.id || base.media_url || "no-source"}`}
              sourceKey={
                file?.uri ||
                mediaId ||
                sample?.id ||
                base.media_url ||
                "no-source"
              }
              accepted={sourceCaptionTrack}
              draftState={captionDraftState}
              onDraftStateChange={setCaptionDraftState}
              sourceDuration={duration}
              sourceTime={sequenceToSource(clips, currentTime)?.sourceTime || 0}
              onSeekSource={(time) => {
                const position =
                  sourceToSequence(clips, time, selectedClip || undefined) ??
                  sourceToSequence(clips, time);
                if (position === null) {
                  setError(
                    "That caption time is outside the clips in this edit. Include that source section to preview it.",
                  );
                  return false;
                }
                setError("");
                setPaused(true);
                seekTo(position);
                return true;
              }}
              disabled={busy}
              onApply={(cues) =>
                applyEdit({
                  sourceCaptionTrack: cues,
                  ...(cues !== null ? { caption: "" } : {}),
                })
              }
              onSaveSource={() => void save("draft", "caption-draft")}
              onRights={() =>
                navigation.navigate("MediaOS", { tab: "Library" })
              }
            />
          }
        />
      </View>
      {tab === "Audio" && (
        <MusicWorkspace
          purpose={musicPurpose}
          busy={busy}
          onAuditionStart={() => setPaused(true)}
          selectedName={musicPurpose === "creation" ? title : soundtrackName}
          selectedFile={
            musicPurpose === "creation"
              ? file?.mimeType.startsWith("audio/")
                ? file
                : null
              : soundtrackFile
          }
          selectedMediaId={
            musicPurpose === "creation"
              ? (file?.mimeType || canvas.content_type)?.startsWith("audio/")
                ? mediaId
                : null
              : soundtrackId
          }
          volume={musicPurpose === "creation" ? 100 : Number(soundtrackVolume)}
          onVolumeChange={(value) => {
            setSoundtrackVolume(String(value));
            setSaved(null);
          }}
          start={soundtrackStart}
          onStartChange={(value) => {
            setSoundtrackStart(value);
            setSaved(null);
          }}
          onDurationChange={setSoundtrackDuration}
          onRemove={() => {
            if (busy) return;
            releaseSoundtrack();
            setSoundtrackFile(null);
            setSoundtrackId(null);
            setSoundtrackName("");
            setSoundtrackStart(0);
            setSoundtrackDuration(null);
            setSaved(null);
          }}
          onUpload={() =>
            void pick(
              musicPurpose === "creation" ? "audioSource" : "soundtrack",
            )
          }
          onUseOwned={(audio) => {
            releaseSoundtrack();
            setSoundtrackFile(null);
            setSoundtrackId(audio.media_id);
            setSoundtrackName(audio.name);
            setSoundtrackStart(0);
            setSoundtrackDuration(null);
            setSaved(null);
          }}
          onUseGenerated={(generated, release, musicTitle) => {
            if (musicPurpose === "creation") {
              const source = audioCreationSource(generated, musicTitle);
              resetSource();
              generatedSource.current = { uri: source.file.uri, release };
              selectedUris.current.add(source.file.uri);
              setSample(undefined);
              setFile(source.file);
              setMediaId(null);
              setCategory("music");
              setTitle((current) => current || source.title);
              setSaved(null);
              setError("");
              setTab("Edit");
              return;
            }
            releaseSoundtrack();
            generatedRelease.current = release;
            setSoundtrackFile(generated);
            setSoundtrackId(null);
            setSoundtrackName(musicTitle);
            setSoundtrackStart(0);
            setSoundtrackDuration(null);
            setSaved(null);
          }}
        />
      )}
      {tab === "Save" && (
        <>
          <View style={styles.row}>
            <Save size={20} color={color.lime} />
            <Text style={[styles.heading, { fontSize: 19 }]}>
              Save your creation
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
            {worlds.filter((w) => isStudioMediaCategory(w.id)).map((w) => (
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
        </>
      )}
      {tab === "Share" && (
        <>
          <Text style={[styles.heading, { fontSize: 19 }]}>
            Share your creation
          </Text>
          <Text style={styles.body}>{title || "Untitled creation"}</Text>
          <Action
            title="Edit creation details"
            secondary
            icon={Pencil}
            onPress={() => setTab("Save")}
          />
          <View style={styles.separator} />
          <View style={styles.between}>
            <Text style={[styles.heading, { fontSize: 20 }]}>Publish to</Text>
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
                style={[eStyle.networkIcon, { backgroundColor: color.purple }]}
              >
                <Text style={eStyle.networkInitial}>Z</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Ziipa</Text>
                <Text style={styles.small}>
                  Creator profile · discovery
                </Text>
              </View>
              <Check size={20} color={color.lime} />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              targets.length ? `Social networks, ${targets.length} selected` : "Social networks"
            }
            accessibilityState={{ expanded: socialNetworksExpanded }}
            onPress={() => setSocialNetworksExpanded((expanded) => !expanded)}
            style={[eStyle.networkCard, styles.row, { minHeight: 44 }]}
          >
            <Text style={[styles.label, { flex: 1 }]}>Social networks</Text>
            {!!targets.length && (
              <Text style={styles.small}>{targets.length} selected</Text>
            )}
            {socialNetworksExpanded ? (
              <ChevronDown size={18} color={color.muted} />
            ) : (
              <ChevronRight size={18} color={color.muted} />
            )}
          </Pressable>
          {socialNetworksExpanded && socialProviders.map((provider) => {
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
                  disabled: !compatible || busy,
                }}
                disabled={!compatible || busy}
                accessibilityLabel={`Share to ${connection?.name || provider.id}`}
                onPress={() => {
                  if (!compatible || busy) return;
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
                    <Text style={eStyle.networkInitial}>{provider.short}</Text>
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
                          : connection?.status === "linked"
                            ? "Profile linked · posting not authorized"
                            : "Select destination · setup required"}
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
        </>
      )}
      {remix && (
        <Notice
          text={`Remix attribution: ${remix.title} by ${remix.creator}. ${guest ? "Sample media only." : "Bring your own licensed media; the source is not copied."}`}
        />
      )}
      {category === "live" && (
        <Text style={styles.small}>
          Save the broadcast setup as a draft, then connect a live provider in
          Connected networks.
        </Text>
      )}
      {!!error && <Notice text={error} error />}
      {!!saveNotice && <Notice text={saveNotice} />}
      {busy && (
        <Text accessibilityLiveRegion="polite" style={styles.small}>
          {editorSaveLabel(savePhase, progress)}
        </Text>
      )}
      {pendingSubmission ? (
        <View style={{ gap: 10 }}>
          <Action
            title="Check saved status (read only)"
            icon={RefreshCw}
            secondary
            busy={rechecking}
            disabled={busy}
            onPress={() => void recheckSavedStatus()}
          />
          <Notice text="A missing match does not prove the earlier request failed. Review your creations before intentionally starting a different draft. Opening your library keeps this editor and its changes in the navigation stack; this unconfirmed save will not be replayed." />
          <Action
            title="Review my creations"
            secondary
            disabled={busy || rechecking}
            onPress={() =>
              navigation.navigate("CreatorStudio", { tab: "library" })
            }
          />
          {recheckCandidates.map((item) => (
            <View key={item.id} style={[styles.panel, { gap: 10 }]}>
              <Text style={styles.label}>
                {item.title} ·{" "}
                {item.visibility === "published"
                  ? "Published"
                  : "Private draft"}
              </Text>
              <Text style={styles.small}>
                {item.created_at
                  ? new Date(item.created_at).toLocaleString()
                  : item.id}
              </Text>
              <Action
                title="Review matching creation"
                secondary
                disabled={rechecking || busy}
                onPress={() =>
                  navigation.navigate("Watch", {
                    itemId: item.id,
                    category: item.category,
                  })
                }
              />
              <Action
                title="Use this saved creation"
                icon={Check}
                disabled={rechecking || busy}
                onPress={() => confirmRecheckedItem(item, pendingSubmission)}
              />
            </View>
          ))}
        </View>
      ) : null}
      {saved && tab === "Share" && (
        <>
          <Notice
            text={
              guest
                ? `${saved.label === "Local draft" ? "Local" : "Sample"} draft saved for this session. Restarting clears it; nothing is uploaded or published.`
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
          <Action
            title="Share media & manage destinations"
            icon={Share2}
            secondary
            onPress={() =>
              navigation.navigate("Connections", { tab: "outbox" })
            }
          />
          {!guest && saved.media_id && !saved.photo_ids?.length && (
            <Action
              title="Render & export saved edit"
              icon={Share2}
              onPress={() =>
                navigation.navigate("Exports", { itemId: saved.id })
              }
            />
          )}
          {!guest &&
            saved.media_id &&
            saved.content_type?.startsWith("video/") && (
              <Action
                title="Prepare a reviewed release campaign"
                icon={Share2}
                secondary
                onPress={() =>
                  navigation.navigate("Campaigns", { itemId: saved.id })
                }
              />
            )}
          {!guest && saved.visibility === "published" && saved.media_id && !saved.photo_ids?.length && (
            <Action
              title="Publish directly to authorized networks"
              icon={Share2}
              onPress={() =>
                navigation.navigate("Publishing", { itemId: saved.id })
              }
            />
          )}
          {!!saved.distribution?.length &&
            saved.distribution.map((job) => (
              <Notice
                key={job.id}
                text={`${socialProvider(job.provider).short} · ${job.detail || job.status}`}
                error={job.status === "failed"}
              />
            ))}
        </>
      )}
      {tab === "Save" ? (
        <>
          <Action
            title={
              busy && activeSaveButton === "share-draft"
                ? editorSaveLabel(savePhase, progress)
                : draftActionTitle
            }
            icon={Save}
            onPress={() => void save("draft", "share-draft")}
            busy={busy && activeSaveButton === "share-draft"}
            disabled={busy || rechecking || !!pendingSubmission}
          />
          {saved?.visibility === "draft" && (
            <Notice
              text={
                guest
                  ? "Draft saved for this session."
                  : "Draft saved to your account."
              }
            />
          )}
          <Action
            title="Publish"
            icon={ChevronRight}
            secondary
            disabled={busy || rechecking || !!pendingSubmission}
            onPress={() => setTab("Share")}
          />
        </>
      ) : tab === "Share" ? (
        <>
          {!guest && publishRestriction === "category" && (
            <>
              <Notice text="This category is for broadcast or mint drafts. To publish the media as a Ziipa post, choose a different category in Save." />
              <Action
                title="Change category"
                icon={Pencil}
                secondary
                disabled={busy}
                onPress={() => setTab("Save")}
              />
            </>
          )}
          {!guest && publishRestriction === "removed" && (
            <Notice text="This post was removed by moderation. Contact support to appeal." />
          )}
          {!guest && !publishRestriction && deliveryNeedsReview && !!targets.length && (
            <Notice text="You can publish to Ziipa. This publish won’t retry external delivery. Review the earlier request in the network outbox." />
          )}
          {!guest ? (
            <Action
              title={
                busy && activeSaveButton === "share-publish"
                  ? editorSaveLabel(savePhase, progress)
                  : saved?.visibility === "published" && !unsaved
                    ? "Published to Ziipa"
                    : publishActionTitle
              }
              icon={Upload}
              onPress={() => void save("published", "share-publish")}
              busy={busy && activeSaveButton === "share-publish"}
              disabled={
                busy ||
                rechecking ||
                !!pendingSubmission ||
                (saved?.visibility === "published" && !unsaved) ||
                !!publishRestriction
              }
            />
          ) : (
            <Notice text="Sign in to publish your creation. Your session draft is available in Save." />
          )}
          {!guest && !iosLimitedTestflight && (file || mediaId) && (
            <>
              <Action
                title={mintSource ? "Review mint in Wallet" : "Save a draft before minting"}
                icon={Wallet}
                secondary
                disabled={busy || rechecking || !!pendingSubmission || existing?.visibility === "hidden"}
                onPress={() => {
                  if (mintSource)
                    navigation.navigate("Utility", { kind: "wallet", item: mintSource });
                  else setTab("Save");
                }}
              />
              <Text style={styles.small}>
                {photos.length
                  ? "Wallet reviews the cover photo from this series."
                  : "Wallet reviews the saved source file. Export first to mint an edited version."}
              </Text>
            </>
          )}
        </>
      ) : (
        <Action
          title={`Continue to ${steps[steps.findIndex((step) => step.name === tab) + 1]?.name}`}
          icon={ChevronRight}
          onPress={() => {
            const index = steps.findIndex((step) => step.name === tab);
            if (steps[index + 1]?.name === "Audio")
              setMusicPurpose("soundtrack");
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
  );
  const assistantBottom = desktop ? 18 : Math.max(10, insets.bottom);
  const assistantClearance = assistantBottom + 66;
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {desktop ? (
        <View style={{ flex: 1, minHeight: 0, padding: 18, paddingBottom: assistantClearance, gap: 12 }}>
          <View style={[styles.between, { gap: 12 }]}>
            <View>
              <Text style={[styles.heading, { fontSize: 22 }]}>
                {title || "Untitled creation"}
              </Text>
              <Text style={[styles.small, { fontSize: 11 }]}>
                {busy
                  ? editorSaveLabel(savePhase, progress)
                  : unsaved
                    ? "Unsaved changes"
                    : "All changes saved"}{" "}
                · Non-destructive editor
              </Text>
            </View>
            <Action
              title={
                busy && activeSaveButton === "desktop-draft"
                  ? editorSaveLabel(savePhase, progress)
                  : draftActionTitle
              }
              icon={Save}
              busy={busy && activeSaveButton === "desktop-draft"}
              disabled={busy || rechecking || !!pendingSubmission}
              onPress={() => void save("draft", "desktop-draft")}
            />
          </View>
          <View
            style={{ flex: 1, minHeight: 0, flexDirection: "row", gap: 16 }}
          >
            <View
              style={{
                flex: 1.6,
                minWidth: 0,
                minHeight: 0,
                borderWidth: 1,
                borderColor: color.border,
                borderRadius: 12,
                overflow: "hidden",
                backgroundColor: "#09060E",
              }}
            >
              <View
                style={{ flex: 1, minHeight: 150, justifyContent: "center" }}
              >
                {preview}
              </View>
              {transport}
              {timeline}
            </View>
            <View
              style={{
                flex: 1,
                minWidth: 300,
                maxWidth: 490,
                minHeight: 0,
                borderWidth: 1,
                borderColor: color.border,
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              {stepTabs}
              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 24 }}
              >
                {inspector}
              </ScrollView>
            </View>
          </View>
        </View>
      ) : (
        <View
          style={{ flex: 1, minHeight: 0 }}
          onLayout={(event) =>
            setMobileEditorHeight(event.nativeEvent.layout.height)
          }
        >
          {preview}
          {transport}
          {stepTabs}
          <ScrollView
            style={{ flex: 1, minHeight: 0 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: assistantClearance }}
          >
            {inspector}
          </ScrollView>
        </View>
      )}
      {focused && !recorderMode && (
        <AutomationAgentDock
          key={session?.access_token || "guest"}
          routeKey={route.key}
          bottom={assistantBottom}
          compact={!desktop}
          openWorkspace={() => navigation.navigate("MediaOS", { tab: "Assistant" })}
          openAudio={() => {
            setPaused(true);
            setMusicPurpose("creation");
            setTab("Audio");
          }}
        />
      )}
      {recorderMode && focused && (
        <Recorder
          mode={recorderMode}
          onClose={() => setRecorderMode(null)}
          onCapture={useRecording}
          onNetworks={() => {
            setRecorderMode(null);
            navigation.navigate("Connections");
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}
const eStyle = themedStyles(() => ({
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
    borderRadius: 12,
    padding: 10,
    backgroundColor: color.panel,
  },
  networkIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
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
}));

async function disposePickedAudio(uri: string) {
  forgetLocalMedia(uri);
  if (Platform.OS === "web") {
    if (uri.startsWith("blob:")) URL.revokeObjectURL(uri);
  } else
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}
