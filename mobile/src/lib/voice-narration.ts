import {
  musicMaxBytes,
  musicSampleRate,
  validateMusicWave,
} from "./music-composer.ts";

export const narrationVoiceIds = [
  "athena",
  "helios",
  "asteria",
  "orion",
] as const;
export type NarrationVoiceId = (typeof narrationVoiceIds)[number];
export type NarrationConfig = {
  version: 1;
  provider: "cloudflare";
  model: "@cf/deepgram/aura-1";
  available: boolean;
  detail: string;
  max_text_chars: 300;
  max_duration_seconds: 30;
  voices: {
    id: NarrationVoiceId;
    label: string;
    language: string;
    accent: string;
    gender: string;
    available: boolean;
  }[];
  clone: {
    available: false;
    verified: false;
    max_reference_seconds: 20;
    max_reference_bytes: 2097152;
    detail: string;
  };
};
const model = "@cf/deepgram/aura-1";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid narration response.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported narration response fields.");
}
function text(value: unknown, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error("Invalid narration text metadata.");
  return value;
}
export function validateNarrationConfig(input: unknown): NarrationConfig {
  const value = object(input);
  keys(value, [
    "version",
    "provider",
    "model",
    "available",
    "detail",
    "max_text_chars",
    "max_duration_seconds",
    "voices",
    "clone",
    "requires_consent",
  ]);
  if (
    value.version !== 1 ||
    value.provider !== "cloudflare" ||
    value.model !== model ||
    typeof value.available !== "boolean" ||
    value.max_text_chars !== 300 ||
    value.max_duration_seconds !== 30 ||
    (value.requires_consent !== undefined && value.requires_consent !== true)
  )
    throw new Error("Unsupported narration configuration.");
  text(value.detail, 1500);
  if (!Array.isArray(value.voices) || value.voices.length !== 4)
    throw new Error("Invalid narration voice list.");
  const seen = new Set<string>();
  for (const raw of value.voices) {
    const voice = object(raw);
    keys(voice, ["id", "label", "language", "accent", "gender", "available"]);
    if (
      !narrationVoiceIds.includes(voice.id as NarrationVoiceId) ||
      seen.has(String(voice.id)) ||
      typeof voice.available !== "boolean"
    )
      throw new Error("Unsupported narration voice.");
    seen.add(String(voice.id));
    for (const key of ["label", "language", "accent", "gender"])
      text(voice[key], 100);
  }
  const clone = object(value.clone);
  keys(clone, [
    "available",
    "verified",
    "max_reference_seconds",
    "max_reference_bytes",
    "detail",
  ]);
  if (
    clone.available !== false ||
    clone.verified !== false ||
    clone.max_reference_seconds !== 20 ||
    clone.max_reference_bytes !== 2097152
  )
    throw new Error("Voice cloning is not enabled in this release.");
  text(clone.detail, 1500);
  return value as unknown as NarrationConfig;
}
export function narrationRequest(
  config: NarrationConfig,
  script: string,
  voiceId: NarrationVoiceId,
  consent: boolean,
) {
  validateNarrationConfig(config);
  const clean = script.trim();
  if (
    !consent ||
    !config.available ||
    !config.voices.some((voice) => voice.id === voiceId && voice.available)
  )
    throw new Error(
      "Choose an available voice and consent before generating narration.",
    );
  if (
    !clean ||
    clean.length > 300 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)
  )
    throw new Error("Enter a script of 1–300 characters.");
  return {
    version: 1,
    text: clean,
    voice_id: voiceId,
    consent: true,
    expected_provider: "cloudflare",
  } as const;
}
/** Strict bounded decoder, with canonical padding bits; no URLs or external fetch. */
export function decodeNarrationBase64(input: unknown): Uint8Array {
  if (
    typeof input !== "string" ||
    input.length < 60 ||
    input.length > Math.ceil(musicMaxBytes / 3) * 4 ||
    input.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input)
  )
    throw new Error("Invalid narration audio encoding.");
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
  const size = (input.length / 4) * 3 - padding;
  if (size > musicMaxBytes || size < 46)
    throw new Error("Narration audio exceeds the 30-second limit.");
  const bytes = new Uint8Array(size);
  let cursor = 0;
  for (let index = 0; index < input.length; index += 4) {
    const a = alphabet.indexOf(input[index]),
      b = alphabet.indexOf(input[index + 1]);
    const c = input[index + 2] === "=" ? 0 : alphabet.indexOf(input[index + 2]);
    const d = input[index + 3] === "=" ? 0 : alphabet.indexOf(input[index + 3]);
    if (
      index === input.length - 4 &&
      ((padding === 2 && b & 15) || (padding === 1 && c & 3))
    )
      throw new Error("Invalid narration padding.");
    const group = a * 262144 + b * 4096 + c * 64 + d;
    if (cursor < size) bytes[cursor++] = group >>> 16;
    if (cursor < size) bytes[cursor++] = group >>> 8;
    if (cursor < size) bytes[cursor++] = group;
  }
  return bytes;
}
export async function validateNarrationAudio(
  input: unknown,
  voiceId: NarrationVoiceId,
  sha256: (bytes: Uint8Array) => Promise<string>,
) {
  const value = object(input);
  keys(value, [
    "version",
    "provider",
    "model",
    "voice_id",
    "format",
    "sample_rate",
    "duration_seconds",
    "sha256",
    "audio_base64",
    "detail",
  ]);
  if (
    value.version !== 1 ||
    value.provider !== "cloudflare" ||
    value.model !== model ||
    value.voice_id !== voiceId ||
    value.format !== "wav" ||
    value.sample_rate !== musicSampleRate ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.duration_seconds !== "number" ||
    !Number.isFinite(value.duration_seconds) ||
    value.duration_seconds <= 0 ||
    value.duration_seconds > 30
  )
    throw new Error("Unsupported narration audio response.");
  text(value.detail, 1500);
  const bytes = decodeNarrationBase64(value.audio_base64);
  validateMusicWave(bytes);
  const duration = (bytes.length - 44) / (musicSampleRate * 2);
  if (
    Math.abs(duration - value.duration_seconds) > 1 / musicSampleRate ||
    (await sha256(bytes)) !== value.sha256
  )
    throw new Error("Narration audio integrity check failed.");
  return bytes;
}

/** Local recording only: encode bounded mono PCM, never send microphone data. */
export function narrationWave(pcm: Uint8Array) {
  if (!pcm.length || pcm.length % 2 || pcm.length > musicMaxBytes - 44)
    throw new Error("Record between a moment and 30 seconds of audio.");
  const bytes = new Uint8Array(44 + pcm.length);
  const data = new DataView(bytes.buffer);
  for (const [offset, label] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const)
    for (let index = 0; index < 4; index++)
      bytes[offset + index] = label.charCodeAt(index);
  data.setUint32(4, bytes.length - 8, true);
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, musicSampleRate, true);
  data.setUint32(28, musicSampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  data.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44);
  validateMusicWave(bytes);
  return bytes;
}
/** Bounded linear resampling for browser-decoded local microphone audio. */
export function normalizeRecordedVoice(
  channels: readonly Float32Array[],
  sampleRate: number,
) {
  if (
    !channels.length ||
    channels.length > 2 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    !channels[0].length ||
    channels.some((channel) => channel.length !== channels[0].length) ||
    channels[0].length > sampleRate * 30.5
  )
    throw new Error("This recording format or duration is unsupported.");
  const count = Math.min(
    musicSampleRate * 30,
    Math.floor((channels[0].length * musicSampleRate) / sampleRate),
  );
  const pcm = new Uint8Array(count * 2),
    view = new DataView(pcm.buffer);
  for (let index = 0; index < count; index++) {
    const position = (index * sampleRate) / musicSampleRate,
      left = Math.floor(position),
      right = Math.min(left + 1, channels[0].length - 1);
    let sample = 0;
    for (const channel of channels) {
      const value =
        channel[left] + (channel[right] - channel[left]) * (position - left);
      if (!Number.isFinite(value))
        throw new Error("Invalid microphone samples.");
      sample += value / channels.length;
    }
    view.setInt16(
      index * 2,
      Math.round(
        Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
      ),
      true,
    );
  }
  return narrationWave(pcm);
}
