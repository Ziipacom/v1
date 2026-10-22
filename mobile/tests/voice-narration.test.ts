import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  decodeNarrationBase64,
  narrationRequest,
  narrationVoiceIds,
  narrationWave,
  normalizeRecordedVoice,
  validateNarrationAudio,
  validateNarrationConfig,
} from "../src/lib/voice-narration.ts";
import { validateMusicWave } from "../src/lib/music-composer.ts";

const config = () => ({
  version: 1,
  provider: "cloudflare",
  model: "@cf/deepgram/aura-1",
  available: true,
  detail: "Verified free provider",
  max_text_chars: 300,
  max_duration_seconds: 30,
  requires_consent: true,
  voices: narrationVoiceIds.map((id) => ({
    id,
    label: id,
    language: "en-GB",
    accent: "British",
    gender: "feminine",
    available: true,
  })),
  clone: {
    available: false,
    verified: false,
    max_reference_seconds: 20,
    max_reference_bytes: 2097152,
    detail: "Cloning unavailable",
  },
});
const digest = async (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const wav = () => narrationWave(new Uint8Array(4410).fill(12));
async function response() {
  const bytes = wav();
  return {
    version: 1,
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    voice_id: "athena",
    format: "wav",
    sample_rate: 22050,
    duration_seconds: 0.1,
    sha256: await digest(bytes),
    audio_base64: Buffer.from(bytes).toString("base64"),
    detail: "Generated audio",
  };
}

test("narration config requires fixed provider/model, four unique IDs and blocked cloning", () => {
  assert.equal(validateNarrationConfig(config()).voices.length, 4);
  for (const change of [
    { version: 2 },
    { provider: "private" },
    { model: "aura-2" },
    { max_text_chars: 301 },
    { requires_consent: false },
    { voices: config().voices.slice(1) },
    { voices: config().voices.map(() => config().voices[0]) },
    { clone: { ...config().clone, available: true } },
    { endpoint: "https://unexpected.test" },
  ])
    assert.throws(() => validateNarrationConfig({ ...config(), ...change }));
  assert.throws(() =>
    validateNarrationConfig({
      ...config(),
      voices: config().voices.map((voice) => ({
        ...voice,
        label: "x".repeat(101),
      })),
    }),
  );
});
test("narration request sends only explicit consented bounded script and the selected available voice", () => {
  const ready = validateNarrationConfig(config());
  assert.deepEqual(
    narrationRequest(ready, "  Hello world.  ", "athena", true),
    {
      version: 1,
      text: "Hello world.",
      voice_id: "athena",
      consent: true,
      expected_provider: "cloudflare",
    },
  );
  assert.throws(() => narrationRequest(ready, "Hello", "athena", false));
  assert.throws(() =>
    narrationRequest({ ...ready, available: false }, "Hello", "athena", true),
  );
  assert.throws(() =>
    narrationRequest(
      {
        ...ready,
        voices: ready.voices.map((voice) => ({ ...voice, available: false })),
      },
      "Hello",
      "athena",
      true,
    ),
  );
  for (const script of ["", " ", "x".repeat(301), "x\u0000y"])
    assert.throws(() => narrationRequest(ready, script, "athena", true));
});
test("narration response accepts actual canonical WAV only after binary SHA-256 verification", async () => {
  const value = await response();
  assert.deepEqual(
    await validateNarrationAudio(value, "athena", digest),
    wav(),
  );
  for (const change of [
    { provider: "other" },
    { model: "aura-2" },
    { voice_id: "helios" },
    { sample_rate: 24000 },
    { format: "mp3" },
    { duration_seconds: 31 },
    { duration_seconds: 0.2 },
    { duration_seconds: NaN },
    { sha256: "0".repeat(64) },
    { audio_url: "https://unexpected.test" },
  ])
    await assert.rejects(
      validateNarrationAudio({ ...value, ...change }, "athena", digest),
    );
  const malformed = wav();
  new DataView(malformed.buffer).setUint32(24, 24000, true);
  await assert.rejects(
    validateNarrationAudio(
      {
        ...value,
        audio_base64: Buffer.from(malformed).toString("base64"),
        sha256: await digest(malformed),
      },
      "athena",
      digest,
    ),
  );
});
test("bounded narration decoder rejects URLs, whitespace, oversized values and noncanonical padding", () => {
  assert.deepEqual(
    decodeNarrationBase64(Buffer.from(wav()).toString("base64")),
    wav(),
  );
  for (const input of [
    "https://media.test",
    "data:audio/wav;base64," + Buffer.from(wav()).toString("base64"),
    Buffer.from(wav()).toString("base64") + "\n",
    "A".repeat(1764064),
    "A".repeat(60) + "A===",
    "A".repeat(60) + "AB==",
  ])
    assert.throws(() => decodeNarrationBase64(input));
});
test("local microphone PCM is encoded as actual bounded WAV without uploading or an AI claim", () => {
  const bytes = wav();
  validateMusicWave(bytes);
  assert.equal(bytes.length, 4454);
  assert.equal(new DataView(bytes.buffer).getUint16(22, true), 1);
  for (const pcm of [
    new Uint8Array(),
    new Uint8Array(3),
    new Uint8Array(1323002),
  ])
    assert.throws(() => narrationWave(pcm));
});
test("local browser recording is downmixed/resampled to canonical bounded audio, not speech preview", () => {
  const left = new Float32Array(4800).fill(0.5),
    right = new Float32Array(4800).fill(-0.25);
  const bytes = normalizeRecordedVoice([left, right], 48000);
  validateMusicWave(bytes);
  assert.equal(bytes.length, 44 + 2205 * 2);
  assert.equal(new DataView(bytes.buffer).getInt16(44, true), 4096);
  for (const channels of [
    [],
    [new Float32Array()],
    [left, right, left],
    [left, new Float32Array(10)],
    [new Float32Array([NaN])],
  ])
    assert.throws(() => normalizeRecordedVoice(channels, 48000));
  assert.throws(() =>
    normalizeRecordedVoice([new Float32Array(48000 * 31)], 48000),
  );
  assert.throws(() => normalizeRecordedVoice([left], 1000000));
});
