import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, Platform, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { ImageUp, RefreshCw } from "lucide-react-native";
import { Action, Notice } from "./ui";
import { useZiipa } from "../provider";
import { uploadMedia } from "../lib/api";
import { coverSource } from "../lib/assets";
import {
  PROFILE_IMAGE_TYPES,
  PROFILE_SAMPLE_COVERS,
  profileImageConfig,
  uploadProfileImage,
  waitForProfilePickerResume,
  type ProfileImageAsset,
  type ProfileImageConfig,
} from "../lib/profile-images";
import type { ProfileImages } from "../lib/types";
import { color, font, styles } from "../theme";

/** Only user-chosen static images are uploaded; no photo-library permission is requested. */
export function ProfileImageControls({
  kind,
  profile,
  onSaved,
  onPreviewSample,
}: {
  kind: "avatar" | "cover";
  profile?: ProfileImages | null;
  onSaved: (profile: ProfileImages) => void;
  onPreviewSample?: (path: string) => void;
}) {
  const { session, guest, api } = useZiipa();
  const focused = useIsFocused();
  const [config, setConfig] = useState<ProfileImageConfig | null>(null);
  const [status, setStatus] = useState<
    "checking" | "ready" | "unavailable" | "unsupported"
  >("checking");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const phase = useRef<"idle" | "picking" | "uploading" | "saving">("idle");
  const operation = useRef(false);
  const loadEpoch = useRef(0);
  const state = useRef({
    token: session?.access_token,
    focused,
    mounted: true,
    version: 0,
  });
  if (
    state.current.token !== session?.access_token ||
    state.current.focused !== focused
  )
    state.current = {
      ...state.current,
      token: session?.access_token,
      focused,
      version: state.current.version + 1,
    };
  useEffect(() => {
    state.current.mounted = true;
    const listener = AppState.addEventListener("change", (next) => {
      // Android's system document picker is an expected external Activity.
      // Once a selection returns, upload/save require Ziipa in the foreground.
      if (next !== "active" && phase.current !== "picking")
        state.current.version++;
    });
    return () => {
      state.current.mounted = false;
      state.current.version++;
      loadEpoch.current++;
      listener.remove();
    };
  }, []);
  const capture = (requireForeground = true) => {
    const { token, version } = state.current;
    return () =>
      state.current.mounted &&
      state.current.focused &&
      state.current.token === token &&
      state.current.version === version &&
      (!requireForeground || AppState.currentState === "active");
  };
  const load = useCallback(async () => {
    if (!session || guest || operation.current) return;
    const currentEpoch = ++loadEpoch.current;
    const scopeValid = capture();
    const valid = () => scopeValid() && currentEpoch === loadEpoch.current;
    setStatus("checking");
    setConfig(null);
    try {
      const loaded = profileImageConfig(await api("/api/creator/config"));
      if (!valid()) return;
      setConfig(loaded);
      setStatus(loaded ? "ready" : "unsupported");
    } catch {
      if (valid()) setStatus("unavailable");
    } finally {
      // A canceled check never leaves an enabled upload button behind.
      if (
        !valid() &&
        state.current.mounted &&
        currentEpoch === loadEpoch.current &&
        state.current.token === session.access_token
      )
        setStatus("unavailable");
    }
  }, [api, guest, session?.access_token]);
  useEffect(() => {
    if (focused) void load();
  }, [focused, load]);

  async function cleanup(uri: string | null) {
    if (!uri) return;
    try {
      if (Platform.OS === "web") {
        if (uri.startsWith("blob:")) URL.revokeObjectURL(uri);
      } else if (
        FileSystem.cacheDirectory &&
        uri.startsWith(FileSystem.cacheDirectory)
      ) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      }
    } catch {
      /* The OS can reclaim a document-picker cache copy. */
    }
  }

  async function choose() {
    if (!session || guest || operation.current || status !== "ready" || !config)
      return;
    operation.current = true;
    const valid = capture();
    const sameScope = capture(false);
    let selectedUri: string | null = null;
    let canceled = false;
    setBusy(true);
    setProgress(0);
    setError("");
    setMessage("");
    try {
      const saved = await uploadProfileImage({
        kind,
        config,
        valid,
        pick: async () => {
          phase.current = "picking";
          // This is the first await after the user's press: web file pickers
          // require that activation. Capability was verified before enabling it.
          const result = await DocumentPicker.getDocumentAsync({
            type: [...PROFILE_IMAGE_TYPES],
            copyToCacheDirectory: true,
            multiple: false,
          });
          if (result.canceled) {
            phase.current = "idle";
            canceled = true;
            return null;
          }
          const asset = result.assets[0];
          selectedUri = asset.uri;
          const resumed = await waitForProfilePickerResume({
            sameScope,
            isForeground: () => AppState.currentState === "active",
            subscribe: (notify) => {
              const listener = AppState.addEventListener("change", notify);
              return () => listener.remove();
            },
          });
          phase.current = "idle";
          if (!resumed) return null;
          return asset;
        },
        measure: async (asset: ProfileImageAsset) => {
          if (Platform.OS === "web")
            return (await (await fetch(asset.uri)).blob()).size;
          const info = await FileSystem.getInfoAsync(asset.uri);
          return info.exists && !info.isDirectory ? info.size : 0;
        },
        refreshConfig: async () => {
          const value = await api("/api/creator/config");
          if (valid()) {
            const supported = profileImageConfig(value);
            setConfig(supported);
            setStatus(supported ? "ready" : "unsupported");
          }
          return value;
        },
        upload: async (file) => {
          phase.current = "uploading";
          return uploadMedia(file, session.access_token, (percent) => {
            if (valid()) setProgress(percent);
          });
        },
        save: async (patch) => {
          phase.current = "saving";
          return api<ProfileImages>("/api/creator/profile", patch);
        },
      });
      if (saved && valid()) {
        onSaved(saved);
        setMessage(
          `Your ${kind === "avatar" ? "profile photo" : "cover image"} is saved to your Ziipa account.`,
        );
      } else if (
        !canceled &&
        state.current.mounted &&
        state.current.token === session.access_token
      ) {
        setMessage(
          "The operation stopped when this screen left the foreground. Refresh your profile before trying again.",
        );
      }
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "Your image could not be saved. Refresh before trying again.",
        );
    } finally {
      phase.current = "idle";
      operation.current = false;
      if (state.current.mounted && state.current.token === session.access_token)
        setBusy(false);
      await cleanup(selectedUri);
    }
  }

  async function sample(path: string) {
    if (operation.current) return;
    if (!session || guest || !config || status !== "ready") {
      onPreviewSample?.(path);
      setMessage("Cover preview only. It is not saved to your account.");
      return;
    }
    operation.current = true;
    phase.current = "saving";
    const valid = capture();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const current = profileImageConfig(await api("/api/creator/config"));
      if (!valid()) return;
      if (!current || !current.cover_samples.includes(path))
        throw new Error(
          "Refresh profile image support before saving this gallery cover.",
        );
      const saved = await api<ProfileImages>("/api/creator/profile", {
        cover_sample: path,
      });
      if (valid()) {
        onSaved(saved);
        setMessage("Your gallery cover is saved to your Ziipa account.");
      }
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "The gallery cover could not be saved.",
        );
    } finally {
      phase.current = "idle";
      operation.current = false;
      if (state.current.mounted && state.current.token === session.access_token)
        setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      {!session || guest ? (
        <Notice text="Sign in to upload and save your own profile images. Gallery choices in sample mode are previews only." />
      ) : (
        <>
          {status !== "ready" && (
            <Notice
              text={
                status === "checking"
                  ? "Checking Ziipa’s profile image support…"
                  : status === "unsupported"
                    ? "This Ziipa server needs the profile image update before uploads can be saved. No image will be uploaded until support is confirmed."
                    : "Profile image support could not be checked. Check your connection and refresh the status before uploading."
              }
            />
          )}
          {status !== "ready" && (
            <Action
              title="Refresh image support"
              icon={RefreshCw}
              secondary
              busy={status === "checking"}
              disabled={busy}
              onPress={() => void load()}
            />
          )}
          <Action
            title={
              kind === "avatar"
                ? profile?.avatar_url
                  ? "Replace profile photo"
                  : "Upload profile photo"
                : profile?.cover_media_id
                  ? "Replace cover image"
                  : "Upload cover image"
            }
            icon={ImageUp}
            disabled={status !== "ready"}
            busy={busy}
            onPress={() => void choose()}
          />
          <Text style={styles.small}>
            Choose a static JPG, PNG or WebP image up to 10 MB. Your original
            file stays unchanged.
          </Text>
          {busy && (
            <Text accessibilityLiveRegion="polite" style={styles.small}>
              {phase.current === "uploading"
                ? `Uploading image · ${progress}%`
                : phase.current === "picking"
                  ? "Choose an image…"
                  : "Saving your image…"}
            </Text>
          )}
        </>
      )}
      {!!error && <Notice error text={error} />}
      {!!message && (
        <Text accessibilityLiveRegion="polite" style={styles.small}>
          {message}
        </Text>
      )}
      {kind === "cover" && (
        <>
          <Text
            style={{
              color: color.text,
              fontFamily: font.semibold,
              fontSize: 15,
            }}
          >
            Cover gallery
          </Text>
          <Text style={styles.small}>
            {session && !guest && status === "ready"
              ? "Choose a gallery cover to save it to your account."
              : "Choose a gallery cover to preview it on this device."}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {PROFILE_SAMPLE_COVERS.map((path) => (
              <Pressable
                key={path}
                accessibilityRole="button"
                accessibilityLabel={`Use ${path.split("/").pop()?.split(".")[0]} gallery cover`}
                accessibilityState={{
                  disabled: busy,
                  selected: profile?.cover_sample === path,
                }}
                disabled={busy}
                onPress={() => void sample(path)}
                style={{
                  borderRadius: 13,
                  overflow: "hidden",
                  borderWidth: 2,
                  borderColor:
                    profile?.cover_sample === path ? color.lime : color.border,
                }}
              >
                <Image
                  source={coverSource(path)}
                  resizeMode="cover"
                  style={{ width: 90, height: 84 }}
                />
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}
