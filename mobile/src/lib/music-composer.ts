import type { Library } from "./media-os-types";

export const musicStyles = [
  "ambient",
  "lofi",
  "electronic",
  "cinematic",
] as const;
export const musicMoods = ["calm", "bright", "moody"] as const;
export type MusicStyle = (typeof musicStyles)[number];
export type MusicMood = (typeof musicMoods)[number];
export type MusicSettings = {
  prompt: string;
  style: MusicStyle;
  mood: MusicMood;
  bpm: number;
  duration: number;
  variation: number;
};
export type MusicPlan = MusicSettings & {
  engine: "ziipa-procedural-v1";
  voices: string[];
  summary: string;
};
export const musicSampleRate = 22050;
export const musicMaxBytes = 44 + 30 * musicSampleRate * 2;

/** Explicit keyword planning, not inference, artist imitation or sampled audio. */
export function planMusicPrompt(
  prompt: string,
  current: MusicSettings,
): MusicSettings {
  const text = prompt.trim().slice(0, 500);
  const lower = text.toLowerCase();
  const tempo = lower.match(/\b(\d{2,3})\s*bpm\b/);
  const style: MusicStyle = /ambient|meditat|spacious|drone/.test(lower)
    ? "ambient"
    : /cinematic|orchestr|film|epic/.test(lower)
      ? "cinematic"
      : /electro|dance|synth|techno/.test(lower)
        ? "electronic"
        : /lo[ -]?fi|chill|study|jazz/.test(lower)
          ? "lofi"
          : current.style;
  const mood: MusicMood = /dark|moody|sad|minor|tense/.test(lower)
    ? "moody"
    : /bright|happy|uplift|joy|major/.test(lower)
      ? "bright"
      : /calm|soft|relax|peace|gentle/.test(lower)
        ? "calm"
        : current.mood;
  return {
    ...current,
    prompt: text,
    style,
    mood,
    bpm: tempo ? Math.max(60, Math.min(160, Number(tempo[1]))) : current.bpm,
  };
}

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++)
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}
function random(seed: number) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
function validate(settings: MusicSettings) {
  if (
    typeof settings.prompt !== "string" ||
    settings.prompt.length > 500 ||
    !musicStyles.includes(settings.style) ||
    !musicMoods.includes(settings.mood) ||
    !Number.isInteger(settings.bpm) ||
    settings.bpm < 60 ||
    settings.bpm > 160 ||
    !Number.isInteger(settings.duration) ||
    settings.duration < 5 ||
    settings.duration > 30 ||
    !Number.isInteger(settings.variation) ||
    settings.variation < 0 ||
    settings.variation > 9999
  )
    throw new Error(
      "Choose a style, mood, 60–160 BPM and a 5–30 second duration.",
    );
}

export function musicPlan(settings: MusicSettings): MusicPlan {
  validate(settings);
  return {
    ...settings,
    engine: "ziipa-procedural-v1",
    voices:
      settings.style === "ambient"
        ? ["Synth pad", "Bass", "Melody"]
        : ["Synth pad", "Bass", "Melody", "Synth drums"],
    summary: `${settings.duration}s · ${settings.bpm} BPM · ${settings.mood === "bright" ? "major" : "minor"} key · ${settings.style === "ambient" ? "slow chord bed and sparse melody" : "four-chord progression, bass, melody and synthesized rhythm"}`,
  };
}

/** Bounded mono PCM synthesis. All sound is mathematical; no catalog/model call. */
export function composeMusic(settings: MusicSettings) {
  const plan = musicPlan(settings);
  const seed = hash(JSON.stringify(settings));
  const rand = random(seed);
  const notes = Array.from({ length: 32 }, () => Math.floor(rand() * 7));
  const rests = Array.from(
    { length: 32 },
    () => rand() < (settings.style === "ambient" ? 0.5 : 0.2),
  );
  const scale =
    settings.mood === "bright"
      ? [0, 2, 4, 5, 7, 9, 11]
      : [0, 2, 3, 5, 7, 8, 10];
  const progression = settings.mood === "bright" ? [0, 4, 5, 3] : [0, 5, 2, 6];
  const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
  const degree = (value: number) =>
    scale[value % 7] + 12 * Math.floor(value / 7);
  const chords = progression.map((root) =>
    [0, 2, 4].map((offset) => frequency(48 + degree(root + offset))),
  );
  const bass = progression.map((root) => frequency(36 + degree(root)));
  const melody = progression.map((root) =>
    notes.map((note) => frequency(60 + degree(root + note))),
  );
  const samples = settings.duration * musicSampleRate;
  const bytes = new Uint8Array(44 + samples * 2);
  const data = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      data.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, "RIFF");
  data.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, musicSampleRate, true);
  data.setUint32(28, musicSampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  ascii(36, "data");
  data.setUint32(40, samples * 2, true);
  const beatSeconds = 60 / settings.bpm;
  const speed = settings.style === "ambient" ? 0.5 : 2;
  let previousNoise = 0;
  let peak = 0;
  for (let index = 0; index < samples; index++) {
    const time = index / musicSampleRate;
    const beat = time / beatSeconds;
    const chord = Math.floor(beat / (settings.style === "ambient" ? 8 : 4)) % 4;
    const localBeat = (beat % 1) * beatSeconds;
    const step = Math.floor(beat * speed) % notes.length;
    const localNote = (((beat * speed) % 1) * beatSeconds) / speed;
    const angle = 2 * Math.PI * time;
    const pad =
      chords[chord].reduce((sum, f) => sum + Math.sin(angle * f), 0) *
      0.045 *
      (0.8 + 0.2 * Math.sin(time * 0.7));
    const bassNote =
      Math.sin(angle * bass[chord]) *
      0.13 *
      Math.exp(-localBeat * (settings.style === "ambient" ? 1.6 : 4));
    const lead = rests[step]
      ? 0
      : (Math.sin(angle * melody[chord][step]) +
          0.12 * Math.sin(angle * melody[chord][step] * 3)) *
        0.085 *
        Math.min(1, localNote / 0.015) *
        Math.exp(-localNote * 6);
    let drums = 0;
    const noise = rand() * 2 - 1;
    if (settings.style !== "ambient") {
      const kick =
        Math.sin(
          2 *
            Math.PI *
            (45 * localBeat + (100 / 35) * (1 - Math.exp(-35 * localBeat))),
        ) *
        Math.exp(-localBeat * 14) *
        (Math.floor(beat) % 2 === 0 ? 0.27 : 0.12);
      const snare =
        Math.floor(beat) % 2 === 1
          ? noise * Math.exp(-localBeat * 24) * 0.12
          : 0;
      const hatTime = (((beat * 2) % 1) * beatSeconds) / 2;
      drums =
        kick +
        snare +
        (noise - previousNoise) * Math.exp(-hatTime * 65) * 0.025;
    }
    previousNoise = noise;
    const fade = Math.min(1, time / 0.06, (settings.duration - time) / 0.65);
    const value =
      Math.tanh((pad + bassNote + lead + drums) * 0.9) *
      0.8 *
      Math.max(0, fade);
    peak = Math.max(peak, Math.abs(value));
    data.setInt16(44 + index * 2, Math.round(value * 32767), true);
  }
  return { bytes, plan, peak, seed: seed.toString(16).padStart(8, "0") };
}

export function validateMusicWave(bytes: Uint8Array) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 44 ||
    bytes.length > musicMaxBytes
  )
    throw new Error("Generated audio is outside the bounded WAV size.");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  if (
    text(0, 4) !== "RIFF" ||
    text(8, 4) !== "WAVE" ||
    text(12, 4) !== "fmt " ||
    text(36, 4) !== "data" ||
    data.getUint32(4, true) !== bytes.length - 8 ||
    data.getUint32(16, true) !== 16 ||
    data.getUint16(20, true) !== 1 ||
    data.getUint16(22, true) !== 1 ||
    data.getUint32(24, true) !== musicSampleRate ||
    data.getUint32(28, true) !== musicSampleRate * 2 ||
    data.getUint16(32, true) !== 2 ||
    data.getUint16(34, true) !== 16 ||
    data.getUint32(40, true) !== bytes.length - 44 ||
    (bytes.length - 44) % 2
  )
    throw new Error("Generated WAV format is invalid.");
}

export type OwnedAudio = {
  media_id: string;
  name: string;
  size: number;
  rightsExpired: boolean;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function ownedAudioTracks(
  library: Library,
  ownerId: number,
): OwnedAudio[] {
  const hidden = new Set(
    library.items
      .filter((item) => item.visibility === "hidden")
      .map((item) => item.media_id),
  );
  const names = new Map(
    library.items
      .filter(
        (item) =>
          !item.demo &&
          item.creator_id === ownerId &&
          item.visibility !== "hidden" &&
          !!item.media_id,
      )
      .map((item) => [item.media_id!, item]),
  );
  return (library.media || [])
    .filter(
      (media) =>
        uuid.test(media.id) &&
        media.content_type.startsWith("audio/") &&
        !hidden.has(media.id),
    )
    .map((media) => {
      const item = names.get(media.id);
      return {
        media_id: media.id,
        name:
          item?.title ||
          media.name ||
          media.filename ||
          `Audio ${media.id.slice(0, 8)}`,
        size: media.size,
        rightsExpired: !!(
          item?.metadata?.rights.expired || item?.asset_metadata?.rights.expired
        ),
      };
    });
}
