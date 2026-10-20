import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  composeMusic,
  musicPlan,
  musicSampleRate,
  musicMaxBytes,
  ownedAudioTracks,
  planMusicPrompt,
  validateMusicWave,
  type MusicSettings,
} from "../src/lib/music-composer.ts";
import type { Library, LibraryItem } from "../src/lib/media-os-types.ts";

const base: MusicSettings = {
  prompt: "A calm study instrumental",
  style: "lofi",
  mood: "calm",
  bpm: 90,
  duration: 5,
  variation: 0,
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("procedural composition is a bounded playable mono PCM WAV with real signal and faded edges", () => {
  const result = composeMusic(base);
  const view = new DataView(result.bytes.buffer);
  assert.equal(result.bytes.length, 44 + 5 * musicSampleRate * 2);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 22050);
  assert.equal(view.getUint16(34, true), 16);
  validateMusicWave(result.bytes);
  assert.ok(result.peak > 0.05 && result.peak < 0.8);
  assert.equal(view.getInt16(44, true), 0);
  assert.ok(Math.abs(view.getInt16(result.bytes.length - 2, true)) < 5);
  let energy = 0;
  for (let offset = 44; offset < result.bytes.length; offset += 2)
    energy += view.getInt16(offset, true) ** 2;
  assert.ok(
    energy / (5 * musicSampleRate) > 10000,
    "output must contain audible music rather than a success-only empty fixture",
  );
  assert.equal(result.plan.engine, "ziipa-procedural-v1");
});

test("composition is reproducible but a new variation changes the actual audio bytes", () => {
  const first = composeMusic(base);
  assert.equal(digest(first.bytes), digest(composeMusic({ ...base }).bytes));
  assert.notEqual(
    digest(first.bytes),
    digest(composeMusic({ ...base, variation: 1 }).bytes),
  );
  assert.notEqual(
    digest(first.bytes),
    digest(composeMusic({ ...base, style: "ambient" }).bytes),
  );
  assert.deepEqual(musicPlan({ ...base, style: "ambient" }).voices, [
    "Synth pad",
    "Bass",
    "Melody",
  ]);
});

test("invalid or unbounded composition requests fail before synthesis", () => {
  for (const patch of [
    { duration: 31 },
    { duration: Infinity },
    { duration: 1e9 },
    { duration: 4 },
    { bpm: 59 },
    { bpm: NaN },
    { bpm: 161 },
    { variation: -1 },
    { prompt: "x".repeat(501) },
    { style: "remote-model" },
  ])
    assert.throws(() => composeMusic({ ...base, ...patch } as MusicSettings));
  assert.equal(musicMaxBytes, 1323044);
});

test("prompt planner interprets explicit keywords, bounds BPM and leaves source settings untouched", () => {
  const copy = { ...base };
  const plan = planMusicPrompt("Bright electronic synth, 128 BPM", base);
  assert.equal(plan.style, "electronic");
  assert.equal(plan.mood, "bright");
  assert.equal(plan.bpm, 128);
  assert.equal(planMusicPrompt("ambient 999 BPM", base).bpm, 160);
  assert.equal(planMusicPrompt("cinematic 20 BPM", base).bpm, 60);
  assert.equal(
    planMusicPrompt("sing like a famous artist", base).style,
    base.style,
  );
  assert.deepEqual(base, copy);
});

test("materialization rejects forged, oversized or truncated WAV payloads", () => {
  const valid = composeMusic(base).bytes;
  validateMusicWave(valid);
  const forged = valid.slice();
  forged[20] = 3;
  assert.throws(() => validateMusicWave(forged));
  assert.throws(() => validateMusicWave(valid.subarray(0, valid.length - 1)));
  assert.throws(() => validateMusicWave(new Uint8Array(musicMaxBytes + 1)));
  assert.throws(() => validateMusicWave(new Uint8Array(44)));
});

test("owned audio picker excludes hidden sources, demos, remote identifiers and nonaudio while keeping rights expiry", () => {
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const library: Library = {
    media: [
      ...ids.map((id) => ({ id, content_type: "audio/wav", size: 1200 })),
      {
        id: "https://example.com/track",
        content_type: "audio/wav",
        size: 1200,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        content_type: "video/mp4",
        size: 1200,
      },
    ],
    items: [
      {
        media_id: ids[0],
        title: "My authorized instrumental",
        creator_id: 7,
        demo: false,
        visibility: "draft",
        metadata: { rights: { expired: true } },
      },
      {
        media_id: ids[1],
        title: "Moderated source",
        creator_id: 7,
        demo: false,
        visibility: "hidden",
      },
      {
        media_id: ids[2],
        title: "Another owner's private title",
        creator_id: 9,
        demo: false,
        visibility: "draft",
      },
    ] as LibraryItem[],
  };
  const tracks = ownedAudioTracks(library, 7);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].name, "My authorized instrumental");
  assert.equal(tracks[0].rightsExpired, true);
  assert.equal(tracks[1].name, `Audio ${ids[2].slice(0, 8)}`);
  assert.ok(!JSON.stringify(tracks).includes("Another owner's"));
  assert.ok(!tracks.some((entry) => entry.media_id === ids[1]));
});
