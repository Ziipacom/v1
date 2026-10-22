import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as narration from "../src/lib/voice-narration.ts";
import * as music from "../src/lib/music-composer.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function native(
  permission: Promise<{ granted: boolean }> = Promise.resolve({
    granted: true,
  }),
) {
  let starts = 0,
    stops = 0,
    requests = 0,
    buffers: (buffer: any) => void = () => {};
  const cleanups: (() => void)[] = [],
    modes: unknown[] = [];
  const stream = {
    sampleRate: 22050,
    channels: 1,
    async start() {
      starts++;
    },
    stop() {
      stops++;
    },
  };
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/lib/voice-capture.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const exports: any = {};
  new Function("exports", "require", code)(exports, (name: string) => {
    if (name === "react")
      return {
        useRef: (current: unknown) => ({ current }),
        useCallback: (fn: unknown) => fn,
        useEffect: (fn: () => () => void) => cleanups.push(fn()),
      };
    if (name === "expo-audio")
      return {
        requestRecordingPermissionsAsync: () => {
          requests++;
          return permission;
        },
        setAudioModeAsync: async (value: unknown) => {
          modes.push(value);
        },
        useAudioStream: (options: any) => {
          buffers = options.onBuffer;
          return { stream };
        },
      };
    if (name === "./voice-narration") return narration;
    if (name === "./music-composer") return music;
    throw new Error(name);
  });
  return {
    capture: exports.useVoiceCapture(),
    stream,
    buffers: (buffer: any) => buffers(buffer),
    counts: () => ({ starts, stops, requests }),
    modes,
    unmount: () => cleanups.forEach((fn) => fn()),
  };
}
test("native microphone never starts on mount; permission needs explicit start and cancel defeats a late grant", async () => {
  const permission = deferred<{ granted: boolean }>(),
    h = native(permission.promise);
  assert.deepEqual(h.counts(), { starts: 0, stops: 0, requests: 0 });
  const pending = h.capture.start();
  h.capture.cancel();
  permission.resolve({ granted: true });
  await assert.rejects(pending, /cancelled/);
  assert.equal(h.counts().starts, 0);
  h.unmount();
});
test("native explicit start captures PCM and stop releases microphone with a usable WAV", async () => {
  const h = native();
  await h.capture.start();
  h.buffers({
    data: new Uint8Array(4410).buffer,
    sampleRate: 22050,
    channels: 1,
  });
  const wav = await h.capture.stop();
  music.validateMusicWave(wav);
  assert.equal(wav.length, 4454);
  assert.equal(h.counts().starts, 1);
  assert.ok(h.counts().stops >= 1);
  h.unmount();
});
test("native capture rejects hardware format mismatch, permission denial and empty/cancelled samples", async () => {
  const denied = native(Promise.resolve({ granted: false }));
  await assert.rejects(denied.capture.start(), /permission/);
  assert.equal(denied.counts().starts, 0);
  const h = native();
  await h.capture.start();
  h.buffers({ data: new ArrayBuffer(8), sampleRate: 48000, channels: 1 });
  await assert.rejects(h.capture.stop(), /format/);
  await h.capture.start();
  h.capture.cancel();
  h.buffers({ data: new ArrayBuffer(8), sampleRate: 22050, channels: 1 });
  await assert.rejects(h.capture.stop());
  denied.unmount();
  h.unmount();
});
test("native recording is bounded to 30 seconds and unmount stops/discards all un-attached samples", async () => {
  const h = native();
  await h.capture.start();
  h.buffers({ data: new ArrayBuffer(1400000), sampleRate: 22050, channels: 1 });
  assert.equal((await h.capture.stop()).length, music.musicMaxBytes);
  await h.capture.start();
  h.buffers({ data: new ArrayBuffer(20), sampleRate: 22050, channels: 1 });
  h.unmount();
  await assert.rejects(h.capture.stop());
});

function browser(
  options: {
    permission?: Promise<any>;
    decode?: Promise<any>;
    stallStop?: boolean;
    fastDeadline?: boolean;
  } = {},
) {
  let requests = 0,
    trackStops = 0,
    recorderStarts = 0,
    recorderStops = 0,
    contextCloses = 0;
  const stream = {
    getTracks: () => [
      {
        stop() {
          trackStops++;
        },
      },
    ],
  };
  const instances: any[] = [],
    cleanups: (() => void)[] = [];
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable?: (event: any) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor() {
      instances.push(this);
    }
    start() {
      this.state = "recording";
      recorderStarts++;
    }
    stop() {
      this.state = "inactive";
      recorderStops++;
      if (options.stallStop) return;
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(80)]) });
        this.onstop?.();
      });
    }
  }
  class Context {
    decodeAudioData() {
      return (
        options.decode ||
        Promise.resolve({
          numberOfChannels: 1,
          sampleRate: 48000,
          getChannelData: () => new Float32Array(4800).fill(0.1),
        })
      );
    }
    async close() {
      contextCloses++;
    }
  }
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/lib/voice-capture.web.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const exports: any = {};
  new Function(
    "exports",
    "require",
    "navigator",
    "MediaRecorder",
    "AudioContext",
    "globalThis",
    "setTimeout",
    code,
  )(
    exports,
    (name: string) => {
      if (name === "react")
        return {
          useRef: (current: unknown) => ({ current }),
          useCallback: (fn: unknown) => fn,
          useEffect: (fn: () => () => void) => cleanups.push(fn()),
        };
      if (name === "./voice-narration") return narration;
      throw new Error(name);
    },
    {
      mediaDevices: {
        getUserMedia: () => {
          requests++;
          return options.permission || Promise.resolve(stream);
        },
      },
    },
    Recorder,
    Context,
    { isSecureContext: true },
    options.fastDeadline
      ? (callback: () => void) => setTimeout(callback, 15)
      : setTimeout,
  );
  return {
    capture: exports.useVoiceCapture(),
    stream,
    instances,
    counts: () => ({
      requests,
      trackStops,
      recorderStarts,
      recorderStops,
      contextCloses,
    }),
    unmount: () => cleanups.forEach((fn) => fn()),
  };
}
test("browser permission-cancel race stops the late microphone stream without recording", async () => {
  const permission = deferred<any>(),
    h = browser({ permission: permission.promise });
  assert.equal(h.counts().requests, 0);
  const pending = h.capture.start();
  h.capture.cancel();
  permission.resolve(h.stream);
  await assert.rejects(pending, /cancelled/);
  assert.equal(h.counts().recorderStarts, 0);
  assert.ok(h.counts().trackStops > 0);
  h.unmount();
});
test("browser explicit stop produces canonical real audio and releases tracks and decoder", async () => {
  const h = browser();
  await h.capture.start();
  const wav = await h.capture.stop();
  music.validateMusicWave(wav);
  assert.equal(wav.length, 4454);
  assert.ok(h.counts().trackStops > 0);
  assert.equal(h.counts().recorderStops, 1);
  assert.equal(h.counts().contextCloses, 1);
  h.unmount();
});
test("browser unmount cancels active capture and cannot return a discarded microphone take", async () => {
  const h = browser();
  await h.capture.start();
  h.unmount();
  await assert.rejects(h.capture.stop());
  assert.ok(h.counts().trackStops > 0);
  assert.equal(h.counts().recorderStops, 1);
});
test("browser cancellation during decoding discards the result and closes all local resources", async () => {
  const decode = deferred<any>(),
    h = browser({ decode: decode.promise });
  await h.capture.start();
  const pending = h.capture.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  h.capture.cancel();
  decode.resolve({
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => new Float32Array(4800),
  });
  await assert.rejects(pending, /cancelled/);
  assert.ok(h.counts().contextCloses >= 1);
  assert.ok(h.counts().trackStops > 0);
  h.unmount();
});
test("browser stalled stop has a bounded conversion deadline and cannot retain microphone tracks", async () => {
  const h = browser({ stallStop: true, fastDeadline: true });
  await h.capture.start();
  await assert.rejects(h.capture.stop(), /timed out/);
  assert.ok(h.counts().trackStops > 0);
  await assert.rejects(h.capture.stop(), /No voice recording/);
  h.unmount();
});
test("browser stalled decoder is bounded and closes the local audio context", async () => {
  const h = browser({ decode: new Promise(() => {}), fastDeadline: true });
  await h.capture.start();
  await assert.rejects(h.capture.stop(), /timed out/);
  assert.ok(h.counts().trackStops > 0);
  assert.ok(h.counts().contextCloses > 0);
  h.unmount();
});
