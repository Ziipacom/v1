import { createElement, useEffect, useRef, useState } from "react";
import type { UploadFile } from "../lib/api";
import { RecorderLayout, type RecorderProps } from "./recorder-ui";
import {
  cameraError,
  recordingBitrate,
  recordingBytes,
  recordingFormat,
  recordingSeconds,
  validateRecordingSize,
} from "./recorder-utils";

export function Recorder({
  mode,
  onClose,
  onCapture,
  onNetworks,
}: RecorderProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const operation = useRef(0);
  const mounted = useRef(true);
  const clipUrl = useRef("");
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [error, setError] = useState("");
  const [clip, setClip] = useState<UploadFile | null>(null);
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";
  const unavailable = !secure
    ? "Browsers block camera and microphone access on this HTTP Wi-Fi address. On the computer running Ziipa, open the localhost preview below. Other devices need a trusted HTTPS preview or the native Ziipa app. Do not disable browser security."
    : !supported
      ? "This browser does not support in-app video recording. Use a current Chrome or Safari browser, or the native Ziipa app."
      : undefined;

  function stopStream() {
    stream.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }
  function stop() {
    if (recorder.current && recorder.current.state !== "inactive") {
      setBusy(true);
      recorder.current.stop();
    }
  }
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.visibilityState !== "hidden") return;
      if (recorder.current && recorder.current.state !== "inactive") stop();
      else {
        operation.current++;
        setBusy(false);
      }
      stopStream();
      setEnabled(false);
      setReady(false);
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      operation.current++;
      document.removeEventListener("visibilitychange", hide);
      if (recorder.current && recorder.current.state !== "inactive")
        recorder.current.stop();
      stopStream();
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
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

  async function enable(nextFacing = facing) {
    if (busy || recorder.current?.state === "recording" || unavailable) return;
    const current = ++operation.current;
    setBusy(true);
    setError("");
    setReady(false);
    stopStream();
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: nextFacing },
          width: { ideal: 720 },
          height: { ideal: 1280 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (
        !mounted.current ||
        current !== operation.current ||
        document.visibilityState === "hidden"
      ) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = next;
      next.getTracks().forEach((track) => {
        track.onended = () => {
          stop();
          stopStream();
          setEnabled(false);
          setReady(false);
          setError(
            "Camera or microphone access ended. Your stopped clip can be reviewed, or enable the camera again.",
          );
        };
      });
      setFacing(nextFacing);
      setEnabled(true);
    } catch (e) {
      if (mounted.current && current === operation.current) {
        setError(cameraError(e));
        setEnabled(false);
      }
    } finally {
      if (mounted.current && current === operation.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!enabled || !video.current || !stream.current) return;
    video.current.srcObject = stream.current;
    void video.current.play().catch(() => {
      if (mounted.current)
        setError(
          "The camera preview could not play. Close the camera and try again.",
        );
    });
  }, [enabled, facing]);

  function start() {
    if (
      !ready ||
      busy ||
      !stream.current ||
      recorder.current?.state === "recording"
    )
      return;
    const current = operation.current;
    setError("");
    setSeconds(0);
    try {
      const preferred = [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      if (!preferred)
        throw new Error(
          "This browser has no compatible video recording codec. Try a current Chrome or Safari browser.",
        );
      const active = new MediaRecorder(stream.current, {
        mimeType: preferred,
        videoBitsPerSecond: recordingBitrate,
        audioBitsPerSecond: 128_000,
      });
      const chunks: Blob[] = [];
      let size = 0;
      let failed = false;
      active.ondataavailable = (event) => {
        if (!event.data.size || failed || current !== operation.current) return;
        size += event.data.size;
        if (size > recordingBytes) {
          failed = true;
          chunks.length = 0;
          if (mounted.current)
            setError("This recording reached 100 MB. Retake a shorter clip.");
          if (active.state !== "inactive") active.stop();
        } else chunks.push(event.data);
      };
      active.onerror = () => {
        failed = true;
        chunks.length = 0;
        if (mounted.current)
          setError(
            "Recording was interrupted by the browser. Retake your clip.",
          );
        if (active.state !== "inactive") active.stop();
      };
      active.onstop = () => {
        if (recorder.current === active) recorder.current = null;
        if (!mounted.current || current !== operation.current) {
          chunks.length = 0;
          return;
        }
        stopStream();
        setRecording(false);
        setBusy(false);
        setEnabled(false);
        setReady(false);
        if (failed) return;
        try {
          validateRecordingSize(size);
          const format = recordingFormat(active.mimeType || preferred);
          const blob = new Blob(chunks, { type: format.mimeType });
          clipUrl.current = URL.createObjectURL(blob);
          setClip({
            uri: clipUrl.current,
            name: `ziipa-recording-${Date.now()}.${format.extension}`,
            mimeType: format.mimeType,
            size: blob.size,
          });
        } catch (e) {
          setError(cameraError(e));
        } finally {
          chunks.length = 0;
        }
      };
      recorder.current = active;
      active.start(500);
      setRecording(true);
    } catch (e) {
      recorder.current = null;
      setError(cameraError(e));
    }
  }
  function retake() {
    if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
    clipUrl.current = "";
    setClip(null);
    setSeconds(0);
    void enable();
  }
  function useClip() {
    if (!clip) return;
    clipUrl.current = ""; // Ownership passes to the composer, which releases the URL.
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
      unavailable={unavailable}
      recovery={
        !secure
          ? createElement(
              "a",
              {
                href: `http://localhost:${typeof window !== "undefined" ? window.location.port || "8082" : "8082"}/preview.html`,
                target: "_blank",
                rel: "noopener noreferrer",
                style: {
                  color: "#C59CFF",
                  textAlign: "center",
                  fontSize: 13,
                  lineHeight: "20px",
                },
              },
              "Open localhost on the Ziipa host computer ↗",
            )
          : undefined
      }
      onEnable={() => void enable()}
      onFlip={() => void enable(facing === "user" ? "environment" : "user")}
      onRecord={start}
      onStop={stop}
      onRetake={retake}
      onUse={useClip}
      onClose={onClose}
      onNetworks={onNetworks}
    >
      {clip
        ? createElement("video", {
            key: clip.uri,
            src: clip.uri,
            controls: true,
            playsInline: true,
            preload: "metadata",
            style: {
              width: "100%",
              height: "100%",
              objectFit: "contain",
              position: "absolute",
              inset: 0,
            },
          })
        : enabled
          ? createElement("video", {
              ref: video,
              autoPlay: true,
              muted: true,
              playsInline: true,
              onLoadedMetadata: () => setReady(true),
              style: {
                width: "100%",
                height: "100%",
                objectFit: "cover",
                position: "absolute",
                inset: 0,
                transform: facing === "user" ? "scaleX(-1)" : undefined,
              },
              "aria-label": "Live camera preview",
            })
          : null}
    </RecorderLayout>
  );
}
