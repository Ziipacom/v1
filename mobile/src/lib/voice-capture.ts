import { useCallback, useEffect, useRef } from "react";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio";
import { narrationWave } from "./voice-narration";
import { musicMaxBytes, musicSampleRate } from "./music-composer";

/** No recording is started by mounting this hook. All samples stay in memory. */
export function useVoiceCapture() {
  const state = useRef({
    generation: 0,
    pending: false,
    recording: false,
    chunks: [] as Uint8Array[],
    size: 0,
    error: "",
  });
  const { stream } = useAudioStream({
    sampleRate: musicSampleRate,
    channels: 1,
    encoding: "int16",
    onBuffer(buffer) {
      const held = state.current;
      if (!held.recording) return;
      if (
        buffer.sampleRate !== musicSampleRate ||
        buffer.channels !== 1 ||
        buffer.data.byteLength % 2
      ) {
        held.error =
          "This phone cannot capture the required mono 22.05 kHz recording format.";
        held.recording = false;
        stream.stop();
        return;
      }
      const remaining = musicMaxBytes - 44 - held.size;
      const size = Math.min(remaining, buffer.data.byteLength);
      if (size > 0) {
        held.chunks.push(new Uint8Array(buffer.data.slice(0, size)));
        held.size += size;
      }
      if (held.size === musicMaxBytes - 44) {
        held.recording = false;
        stream.stop();
      }
    },
  });
  const cancel = useCallback(() => {
    const held = state.current;
    held.generation++;
    held.recording = false;
    held.chunks = [];
    held.size = 0;
    held.error = "";
    try {
      stream.stop();
    } catch {
      /* Already released on unmount. */
    }
    void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
  }, [stream]);
  useEffect(() => cancel, [cancel]);
  const start = useCallback(async () => {
    const held = state.current;
    if (held.pending || held.recording)
      throw new Error("A microphone request is already active.");
    held.pending = true;
    const generation = ++held.generation;
    const current = () => generation === held.generation;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!current()) throw new Error("Recording cancelled.");
      if (!permission.granted)
        throw new Error("Microphone permission was not granted.");
      await setAudioModeAsync({
        allowsRecording: true,
        allowsBackgroundRecording: false,
        shouldPlayInBackground: false,
        playsInSilentMode: true,
      });
      if (!current()) {
        await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
        throw new Error("Recording cancelled.");
      }
      held.chunks = [];
      held.size = 0;
      held.error = "";
      held.recording = true;
      await stream.start();
      if (!current()) {
        stream.stop();
        throw new Error("Recording cancelled.");
      }
      if (stream.sampleRate !== musicSampleRate || stream.channels !== 1)
        throw new Error(
          "This phone cannot capture mono 22.05 kHz audio. Upload your own audio instead.",
        );
    } catch (error) {
      if (current()) cancel();
      throw error;
    } finally {
      held.pending = false;
    }
  }, [stream, cancel]);
  const stop = useCallback(async () => {
    const held = state.current;
    held.recording = false;
    stream.stop();
    const error = held.error;
    const pcm = new Uint8Array(held.size);
    let offset = 0;
    for (const chunk of held.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    held.chunks = [];
    held.size = 0;
    held.error = "";
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    if (error) throw new Error(error);
    return narrationWave(pcm);
  }, [stream]);
  return { start, stop, cancel };
}
