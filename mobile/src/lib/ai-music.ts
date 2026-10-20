import {
  musicPlan,
  musicSampleRate,
  type MusicSettings,
} from "./music-composer.ts";

export const aiMusicInstruments = [
  "sine",
  "triangle",
  "pluck",
  "bass",
  "pad",
  "kick",
  "snare",
  "hat",
] as const;
export type AiMusicInstrument = (typeof aiMusicInstruments)[number];
export type AiMusicNote = {
  instrument: AiMusicInstrument;
  start: number;
  duration: number;
  midi: number;
  velocity: number;
};
export type AiMusicArrangement = {
  version: 1;
  title: string;
  bpm: number;
  duration: number;
  notes: AiMusicNote[];
};
export type AiMusicConfig = {
  provider: "private" | "cloudflare";
  available: boolean;
  engine: "ziipa-llm-composer-v1";
  model: string | null;
  max_duration: number;
  max_notes: number;
  instruments: string[];
  detail: string;
};
export type AiMusicResponse = {
  engine: "ziipa-llm-composer-v1";
  model: string;
  arrangement: AiMusicArrangement;
  fingerprint: string;
  detail: string;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The music model returned an invalid arrangement.");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("The music arrangement contains unsupported instructions.");
}
function finite(value: unknown, min: number, max: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

/** Treat a score as bounded data, never code, media URLs, tools or audio samples. */
export function validateAiMusicResponse(
  value: unknown,
  settings: MusicSettings,
): AiMusicResponse {
  musicPlan(settings);
  if (!settings.prompt.trim())
    throw new Error("Describe the music you want the model to compose.");
  const response = object(value);
  only(response, ["engine", "model", "arrangement", "fingerprint", "detail"]);
  if (
    response.engine !== "ziipa-llm-composer-v1" ||
    typeof response.model !== "string" ||
    !response.model.trim() ||
    response.model.length > 200 ||
    typeof response.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/i.test(response.fingerprint) ||
    typeof response.detail !== "string" ||
    response.detail.length > 1000
  )
    throw new Error("The music model response could not be verified.");
  const score = object(response.arrangement);
  only(score, ["version", "title", "bpm", "duration", "notes"]);
  if (
    score.version !== 1 ||
    typeof score.title !== "string" ||
    !score.title.trim() ||
    score.title.length > 60 ||
    score.bpm !== settings.bpm ||
    score.duration !== settings.duration ||
    !Array.isArray(score.notes) ||
    score.notes.length < 6 ||
    score.notes.length > 48
  )
    throw new Error(
      "The model score must match the requested tempo and bounded 5–30 second duration.",
    );
  const notes = score.notes.map((entry) => {
    const note = object(entry);
    only(note, ["instrument", "start", "duration", "midi", "velocity"]);
    if (
      !aiMusicInstruments.includes(note.instrument as AiMusicInstrument) ||
      !finite(note.start, 0, settings.duration) ||
      !finite(note.duration, 0.05, 30) ||
      (note.start as number) + (note.duration as number) >
        settings.duration + 0.000001 ||
      !finite(note.midi, 36, 96) ||
      !Number.isInteger(note.midi) ||
      !finite(note.velocity, 0.05, 0.85)
    )
      throw new Error(
        "The model score contains an unsupported instrument or note outside the safe audio bounds.",
      );
    return {
      instrument: note.instrument as AiMusicInstrument,
      start: note.start as number,
      duration: note.duration as number,
      midi: note.midi as number,
      velocity: note.velocity as number,
    };
  });
  if (new Set(notes.map((note) => note.instrument)).size < 2)
    throw new Error(
      "The model score must contain at least two instrument voices.",
    );
  const edges = notes
    .flatMap((note) => [
      { time: note.start, change: 1 },
      { time: note.start + note.duration, change: -1 },
    ])
    .sort((a, b) => a.time - b.time || a.change - b.change);
  let simultaneous = 0;
  for (const edge of edges) {
    simultaneous += edge.change;
    if (simultaneous > 12)
      throw new Error("The model score exceeds the 12-voice synthesis limit.");
  }
  return {
    engine: "ziipa-llm-composer-v1",
    model: response.model,
    arrangement: {
      version: 1,
      title: score.title.trim(),
      bpm: settings.bpm,
      duration: settings.duration,
      notes,
    },
    fingerprint: response.fingerprint,
    detail: response.detail,
  };
}

/** Real model-authored note timing/pitch/voicing rendered by a local PCM instrument. */
export function synthesizeAiMusic(value: unknown, settings: MusicSettings) {
  const result = validateAiMusicResponse(value, settings);
  const count = result.arrangement.duration * musicSampleRate;
  const mix = new Float32Array(count);
  for (let voice = 0; voice < result.arrangement.notes.length; voice++) {
    const note = result.arrangement.notes[voice];
    const start = Math.round(note.start * musicSampleRate);
    const end = Math.min(
      count,
      Math.round((note.start + note.duration) * musicSampleRate),
    );
    const frequency = 440 * 2 ** ((note.midi - 69) / 12);
    let noiseState =
      Math.imul(voice + 1, 2654435761) ^
      Math.round(note.start * 1000) ^
      note.midi;
    let previousNoise = 0;
    for (let sample = start; sample < end; sample++) {
      const time = (sample - start) / musicSampleRate;
      const remaining = (end - sample) / musicSampleRate;
      const phase = 2 * Math.PI * frequency * time;
      noiseState ^= noiseState << 13;
      noiseState ^= noiseState >>> 17;
      noiseState ^= noiseState << 5;
      const noise = (noiseState >>> 0) / 2147483648 - 1;
      let sound = 0;
      switch (note.instrument) {
        case "sine":
          sound = Math.sin(phase);
          break;
        case "triangle":
          sound = (2 / Math.PI) * Math.asin(Math.sin(phase));
          break;
        case "pluck":
          sound =
            ((Math.sin(phase) +
              0.22 * Math.sin(phase * 2) +
              0.1 * Math.sin(phase * 3)) /
              1.32) *
            Math.exp(-time * 5);
          break;
        case "bass":
          sound = (Math.sin(phase) + 0.2 * Math.sin(phase * 2)) / 1.2;
          break;
        case "pad":
          sound =
            (Math.sin(phase) +
              Math.sin(phase * 0.997) +
              Math.sin(phase * 1.003)) /
            3;
          break;
        case "kick":
          sound =
            Math.sin(
              2 *
                Math.PI *
                (45 * time + (130 / 30) * (1 - Math.exp(-30 * time))),
            ) * Math.exp(-time * 12);
          break;
        case "snare":
          sound =
            (noise * 0.8 + Math.sin(time * Math.PI * 360) * 0.2) *
            Math.exp(-time * 22);
          break;
        case "hat":
          sound = (noise - previousNoise) * 0.5 * Math.exp(-time * 55);
          break;
      }
      previousNoise = noise;
      const attack =
        note.instrument === "pad" ? Math.min(0.15, note.duration / 3) : 0.008;
      const release = Math.min(
        note.duration / 3,
        note.instrument === "pad" ? 0.3 : 0.05,
      );
      const envelope = Math.max(
        0,
        Math.min(1, time / attack, remaining / release),
      );
      mix[sample] += sound * envelope * note.velocity * 0.36;
    }
  }
  const bytes = new Uint8Array(44 + count * 2);
  const data = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++)
      data.setUint8(offset + i, text.charCodeAt(i));
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
  data.setUint32(40, count * 2, true);
  let peak = 0;
  for (let sample = 0; sample < count; sample++) {
    const edge = Math.max(
      0,
      Math.min(
        1,
        sample / (musicSampleRate * 0.02),
        (count - sample) / (musicSampleRate * 0.04),
      ),
    );
    const value = Math.tanh(mix[sample]) * 0.75 * edge;
    peak = Math.max(peak, Math.abs(value));
    data.setInt16(44 + sample * 2, Math.round(value * 32767), true);
  }
  if (peak < 0.0001)
    throw new Error(
      "The model score produced no audible notes. Try a different prompt.",
    );
  const voices = [
    ...new Set(result.arrangement.notes.map((note) => note.instrument)),
  ];
  return {
    ...result,
    bytes,
    peak,
    voices,
    summary: `${result.arrangement.duration}s · ${result.arrangement.bpm} BPM · ${result.arrangement.notes.length} model-planned notes · ${voices.join(", ")}`,
  };
}
