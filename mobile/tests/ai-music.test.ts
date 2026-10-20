import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  aiMusicInstruments,
  synthesizeAiMusic,
  validateAiMusicResponse,
  type AiMusicResponse,
} from "../src/lib/ai-music.ts";
import {
  validateMusicWave,
  type MusicSettings,
} from "../src/lib/music-composer.ts";

const settings: MusicSettings = {
  prompt: "A bright creator intro",
  style: "electronic",
  mood: "bright",
  bpm: 110,
  duration: 5,
  variation: 0,
};
const score = (): AiMusicResponse => ({
  engine: "ziipa-llm-composer-v1",
  model: "test-arranger",
  fingerprint: "a".repeat(64),
  detail: "A bounded model-authored score.",
  arrangement: {
    version: 1,
    title: "Bright intro",
    duration: 5,
    bpm: 110,
    notes: [
      {
        instrument: "pluck",
        start: 0.25,
        duration: 1,
        midi: 60,
        velocity: 0.5,
      },
      { instrument: "pad", start: 1.5, duration: 2, midi: 67, velocity: 0.3 },
      { instrument: "kick", start: 0, duration: 0.3, midi: 36, velocity: 0.6 },
      { instrument: "pluck", start: 2, duration: 0.5, midi: 64, velocity: 0.4 },
      { instrument: "pluck", start: 3, duration: 0.5, midi: 67, velocity: 0.4 },
      { instrument: "kick", start: 4, duration: 0.3, midi: 36, velocity: 0.6 },
    ],
  },
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("model-authored notes produce a bounded playable WAV, actual instruments and audible signal", () => {
  const result = synthesizeAiMusic(score(), settings);
  validateMusicWave(result.bytes);
  assert.equal(result.bytes.length, 44 + 5 * 22050 * 2);
  assert.equal(result.engine, "ziipa-llm-composer-v1");
  assert.deepEqual(result.voices, ["pluck", "pad", "kick"]);
  assert.ok(result.peak > 0.02 && result.peak < 0.75);
  const view = new DataView(result.bytes.buffer);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(result.bytes.length - 2, true), 0);
});

test("actual model pitches, event timing and instrument choices change rendered sound", () => {
  const baseline = digest(synthesizeAiMusic(score(), settings).bytes);
  for (const patch of [
    { midi: 72 },
    { start: 0.75 },
    { instrument: "triangle" as const },
    { velocity: 0.2 },
  ]) {
    const changed = score();
    changed.arrangement.notes[0] = {
      ...changed.arrangement.notes[0],
      ...patch,
    };
    assert.notEqual(
      digest(synthesizeAiMusic(changed, settings).bytes),
      baseline,
    );
  }
  assert.equal(digest(synthesizeAiMusic(score(), settings).bytes), baseline);
});

test("all whitelisted voices synthesize from the score without fetching media", () => {
  for (const instrument of aiMusicInstruments) {
    const result = score();
    result.arrangement.notes = Array.from({ length: 6 }, (_, index) => ({
      instrument:
        index < 3 ? instrument : instrument === "sine" ? "pad" : "sine",
      start: index * 0.6,
      duration: 0.5,
      midi: 60,
      velocity: 0.5,
    }));
    assert.ok(synthesizeAiMusic(result, settings).peak > 0.001, instrument);
  }
});

test("model data cannot exceed duration, polyphony, note limits or introduce media/tool instructions", () => {
  for (const patch of [
    { midi: 100 },
    { midi: 60.5 },
    { duration: 31 },
    { duration: NaN },
    { start: -1 },
    { start: 5 },
    { velocity: 1 },
    { instrument: "sample_url" },
  ]) {
    const bad = score();
    bad.arrangement.notes[0] = {
      ...bad.arrangement.notes[0],
      ...patch,
    } as AiMusicResponse["arrangement"]["notes"][number];
    assert.throws(() => validateAiMusicResponse(bad, settings));
  }
  const polyphony = score();
  polyphony.arrangement.notes = Array.from({ length: 13 }, (_, index) => ({
    ...polyphony.arrangement.notes[0],
    instrument: index % 2 ? "pad" : "pluck",
  }));
  assert.throws(() => validateAiMusicResponse(polyphony, settings), /12-voice/);
  const tooMany = score();
  tooMany.arrangement.notes = Array.from({ length: 49 }, () => ({
    ...tooMany.arrangement.notes[0],
  }));
  assert.throws(() => validateAiMusicResponse(tooMany, settings));
  assert.throws(() =>
    validateAiMusicResponse(
      { ...score(), url: "https://example.com/audio.wav" },
      settings,
    ),
  );
  assert.throws(() =>
    validateAiMusicResponse(
      { ...score(), engine: "ziipa-procedural-v1" },
      settings,
    ),
  );
  const wrong = score();
  wrong.arrangement.bpm = 120;
  assert.throws(() => validateAiMusicResponse(wrong, settings));
  const wrongDuration = score();
  wrongDuration.arrangement.duration = 30;
  assert.throws(() => validateAiMusicResponse(wrongDuration, settings));
  assert.throws(() =>
    validateAiMusicResponse(score(), { ...settings, prompt: "" }),
  );
});
