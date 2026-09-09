import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, StyleSheet } from "react-native";
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import { VideoView, useVideoPlayer } from "expo-video";
import type { UploadFile } from "../lib/api";
import { RecorderLayout, type RecorderProps } from "./recorder-ui";
import { Action } from "./ui";
import {
  cameraError,
  recordingBitrate,
  recordingBytes,
  recordingSeconds,
  validateRecordingSize,
} from "./recorder-utils";

function ClipReview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (value) => {
    value.loop = true;
  });
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") player.pause();
    });
    return () => sub.remove();
  }, [player]);
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      allowsPictureInPicture={false}
      style={StyleSheet.absoluteFill}
    />
  );
}

export function Recorder({
  mode,
  onClose,
  onCapture,
  onNetworks,
}: RecorderProps) {
  const camera = useRef<CameraView | null>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const clipUri = useRef("");
  const recordingRef = useRef(false);
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [microphonePermission, requestMicrophone] = useMicrophonePermissions();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [facing, setFacing] = useState<"front" | "back">("front");
  const [error, setError] = useState("");
  const [clip, setClip] = useState<UploadFile | null>(null);

  function stop() {
    if (!recordingRef.current) return;
    camera.current?.stopRecording();
    if (mounted.current) setBusy(true);
  }
  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        stop();
        setEnabled(false);
        setReady(false);
      }
    });
    return () => {
      mounted.current = false;
      sub.remove();
      camera.current?.stopRecording();
      if (clipUri.current)
        void FileSystem.deleteAsync(clipUri.current, {
          idempotent: true,
        }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(
      () =>
        setSeconds(
          Math.min(recordingSeconds, Math.floor((Date.now() - started) / 1000)),
        ),
      200,
    );
    const limit = setTimeout(stop, recordingSeconds * 1000);
    return () => {
      clearInterval(timer);
      clearTimeout(limit);
    };
  }, [recording]);

  async function enable() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const cam = cameraPermission?.granted
        ? cameraPermission
        : await requestCamera();
      if (!mounted.current) return;
      if (!cam.granted)
        throw new Error(
          "Allow camera access to show your live preview. You can update access in your device settings.",
        );
      const mic = microphonePermission?.granted
        ? microphonePermission
        : await requestMicrophone();
      if (!mounted.current) return;
      if (!mic.granted)
        throw new Error(
          "Allow microphone access to record video with sound. You can update access in your device settings.",
        );
      if (AppState.currentState !== "active")
        throw new Error("Return to Ziipa, then enable your camera again.");
      setReady(false);
      setEnabled(true);
    } catch (e) {
      if (mounted.current) setError(cameraError(e));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function start() {
    if (!camera.current || !ready || recordingRef.current || working.current)
      return;
    recordingRef.current = true;
    working.current = true;
    setRecording(true);
    setSeconds(0);
    setError("");
    let uri: string | undefined;
    try {
      const result = await camera.current.recordAsync({
        maxDuration: recordingSeconds,
        maxFileSize: recordingBytes,
        ...(Platform.OS === "ios" ? { codec: "avc1" as const } : {}),
      });
      uri = result?.uri;
      if (!uri) throw new Error("No clip was captured. Try recording again.");
      if (!mounted.current) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
        return;
      }
      const info = await FileSystem.getInfoAsync(uri);
      if (!mounted.current) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
        return;
      }
      const size = info.exists && !info.isDirectory ? info.size : 0;
      validateRecordingSize(size);
      const isMov = uri.toLowerCase().endsWith(".mov");
      clipUri.current = uri;
      setClip({
        uri,
        name: `ziipa-recording-${Date.now()}.${isMov ? "mov" : "mp4"}`,
        mimeType: isMov ? "video/quicktime" : "video/mp4",
        size,
      });
    } catch (e) {
      if (uri)
        void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      if (mounted.current) setError(cameraError(e));
    } finally {
      recordingRef.current = false;
      working.current = false;
      if (mounted.current) {
        setRecording(false);
        setBusy(false);
        setEnabled(false);
        setReady(false);
      }
    }
  }
  function retake() {
    if (clipUri.current)
      void FileSystem.deleteAsync(clipUri.current, { idempotent: true }).catch(
        () => {},
      );
    clipUri.current = "";
    setClip(null);
    setSeconds(0);
    void enable();
  }
  function useClip() {
    if (!clip) return;
    clipUri.current = ""; // Composer takes ownership of the capture's cache file.
    onCapture(clip);
  }

  return (
    <RecorderLayout
      mode={mode}
      enabled={enabled}
      ready={ready}
      busy={busy}
      recording={recording}
      seconds={seconds}
      clip={clip}
      error={error}
      recovery={
        cameraPermission?.canAskAgain === false ||
        microphonePermission?.canAskAgain === false ? (
          <Action
            title="Open device settings"
            secondary
            onPress={() => void Linking.openSettings()}
          />
        ) : undefined
      }
      onEnable={() => void enable()}
      onFlip={() => {
        setReady(false);
        setFacing((value) => (value === "front" ? "back" : "front"));
      }}
      onRecord={() => void start()}
      onStop={stop}
      onRetake={retake}
      onUse={useClip}
      onClose={onClose}
      onNetworks={onNetworks}
    >
      {clip ? (
        <ClipReview uri={clip.uri} />
      ) : enabled ? (
        <CameraView
          key={facing}
          ref={camera}
          style={StyleSheet.absoluteFill}
          facing={facing}
          mirror={facing === "front"}
          mode="video"
          mute={false}
          videoQuality="720p"
          videoBitrate={recordingBitrate}
          onCameraReady={() => setReady(true)}
          onMountError={(event) => {
            setError(event.message);
            setEnabled(false);
            setReady(false);
          }}
        />
      ) : null}
    </RecorderLayout>
  );
}
