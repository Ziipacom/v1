import { useCallback, useEffect, useRef } from "react";
import { normalizeRecordedVoice } from "./voice-narration";

type Capture = {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  bytes: number;
  failed: string;
  done: Promise<void>;
  context?: AudioContext;
};
/** Explicit browser microphone ownership, including permission/cancellation races. */
export function useVoiceCapture() {
  const state = useRef<{
    generation: number;
    pending: boolean;
    capture: Capture | null;
  }>({ generation: 0, pending: false, capture: null });
  const cancel = useCallback(() => {
    state.current.generation++;
    const held = state.current.capture;
    state.current.capture = null;
    if (!held) return;
    held.chunks = [];
    held.stream.getTracks().forEach((track) => track.stop());
    if (held.recorder.state !== "inactive") held.recorder.stop();
    void held.context?.close().catch(() => {});
  }, []);
  useEffect(() => cancel, [cancel]);
  const start = useCallback(async () => {
    if (state.current.pending || state.current.capture)
      throw new Error("A microphone request is already active.");
    if (
      !globalThis.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined" ||
      typeof AudioContext === "undefined"
    )
      throw new Error(
        "Voice recording requires a supported browser on HTTPS. You can upload your own audio instead.",
      );
    state.current.pending = true;
    const generation = ++state.current.generation;
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
        video: false,
      });
      if (generation !== state.current.generation)
        throw new Error("Recording cancelled.");
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/webm",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType)
        throw new Error("This browser cannot record supported audio.");
      const recorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 64000,
      });
      let resolve!: () => void;
      const done = new Promise<void>((finish) => {
        resolve = finish;
      });
      const held: Capture = {
        stream,
        recorder,
        chunks: [],
        bytes: 0,
        failed: "",
        done,
      };
      recorder.ondataavailable = (event) => {
        if (
          state.current.capture !== held ||
          generation !== state.current.generation ||
          !event.data.size
        )
          return;
        held.bytes += event.data.size;
        if (held.bytes > 2097152) {
          held.failed = "The recording exceeded the local size limit.";
          held.chunks = [];
          held.stream.getTracks().forEach((track) => track.stop());
          if (recorder.state !== "inactive") recorder.stop();
        } else held.chunks.push(event.data);
      };
      recorder.onerror = () => {
        held.failed = "The browser microphone recording failed.";
        held.stream.getTracks().forEach((track) => track.stop());
        resolve();
      };
      recorder.onstop = () => {
        held.stream.getTracks().forEach((track) => track.stop());
        resolve();
      };
      state.current.capture = held;
      recorder.start(250);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === state.current.generation) cancel();
      throw error;
    } finally {
      state.current.pending = false;
    }
  }, [cancel]);
  const stop = useCallback(async () => {
    const held = state.current.capture;
    if (!held) throw new Error("No voice recording is available.");
    const generation = state.current.generation;
    const deadline = Date.now() + 10000;
    async function bounded<T>(promise: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Local voice conversion timed out. The microphone is stopped; discard this take and try a supported browser.",
                  ),
                ),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      if (held.recorder.state !== "inactive") held.recorder.stop();
      // Release microphone tracks immediately, not after decode or navigation.
      held.stream.getTracks().forEach((track) => track.stop());
      await bounded(held.done);
      if (
        generation !== state.current.generation ||
        state.current.capture !== held
      )
        throw new Error("Recording cancelled.");
      if (held.failed || !held.chunks.length)
        throw new Error(held.failed || "No microphone audio was captured.");
      const blob = new Blob(held.chunks, { type: held.recorder.mimeType });
      held.chunks = [];
      const bytes = await bounded(blob.arrayBuffer());
      if (generation !== state.current.generation)
        throw new Error("Recording cancelled.");
      held.context = new AudioContext();
      const decoded = await bounded(held.context.decodeAudioData(bytes));
      if (generation !== state.current.generation)
        throw new Error("Recording cancelled.");
      return normalizeRecordedVoice(
        Array.from({ length: decoded.numberOfChannels }, (_, index) =>
          decoded.getChannelData(index),
        ),
        decoded.sampleRate,
      );
    } finally {
      held.stream.getTracks().forEach((track) => track.stop());
      held.chunks = [];
      void held.context?.close().catch(() => {});
      if (state.current.capture === held) state.current.capture = null;
    }
  }, []);
  return { start, stop, cancel };
}
