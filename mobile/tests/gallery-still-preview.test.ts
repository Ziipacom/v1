import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { profilePreviewRange } from "../src/lib/profile-preview.ts";
import * as galleryPreview from "../src/lib/gallery-preview.ts";
import * as stillCache from "../src/lib/gallery-still-cache.ts";
import type { Item } from "../src/lib/types.ts";

type Node = { type: any; props: Record<string, any> };
const item = (changes: Partial<Item> = {}): Item => ({
  id: "video",
  title: "Video",
  description: "",
  category: "games",
  creator: "Creator",
  tags: [],
  city: "",
  cover: "/brand/ziipa-background.png",
  media_url: "/api/creator/media/source",
  content_type: "video/mp4",
  demo: false,
  label: "Creation",
  visibility: "published",
  trim_start: 5,
  trim_end: 8,
  ...changes,
});

function stillUI(
  options: {
    platform?: string;
    portal?: boolean;
    status?: string;
    generate?: (times: number[], size: unknown) => Promise<any[]>;
    cacheLease?: stillCache.GalleryStillCacheLease;
    remoteSource?: string;
    prepareSource?: (source: unknown, signal: AbortSignal) => Promise<unknown>;
  } = {},
) {
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/components/gallery-still-preview.tsx", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exports: Record<string, any> = {};
  let hooks: any[] = [];
  const componentHooks = new Map<Function, any[]>();
  const effects: (() => void | (() => void))[] = [];
  const cleanups: (() => void)[] = [];
  const events = new Map<string, (event: any) => void>();
  let cursor = 0,
    instances = 0,
    plays = 0,
    pauses = 0,
    releases = 0;
  const samples: { times: number[]; size: unknown }[] = [];
  const playerSources: unknown[] = [];
  const bitmap = { width: 360, height: 203, release() {} };
  const player: Record<string, any> = {
    duration: 20,
    status: options.status || "readyToPlay",
    currentTime: 0,
    generateThumbnailsAsync(times: number[], size: unknown) {
      samples.push({ times, size });
      return options.generate
        ? options.generate(times, size)
        : Promise.resolve([bitmap]);
    },
    play() {
      plays++;
    },
    pause() {
      pauses++;
    },
    addListener(name: string, fn: (event: any) => void) {
      events.set(name, fn);
      return {
        remove() {
          events.delete(name);
        },
      };
    },
  };
  const jsx = (type: any, props: Node["props"]) => ({ type, props });
  new Function("exports", "require", code)(exports, (name: string) => {
    if (name === "react")
      return {
        useState(initial: unknown) {
          const slot = cursor++;
          const state = hooks;
          if (!(slot in hooks))
            hooks[slot] = typeof initial === "function" ? initial() : initial;
          return [
            hooks[slot],
            (next: any) =>
              (state[slot] =
                typeof next === "function" ? next(state[slot]) : next),
          ];
        },
        useRef(current: unknown) {
          const slot = cursor++;
          return (hooks[slot] ||= { current });
        },
        useMemo(fn: () => unknown, deps: unknown[]) {
          const slot = cursor++;
          if (
            !hooks[slot] ||
            deps.some((dep, n) => dep !== hooks[slot].deps[n])
          )
            hooks[slot] = { deps, value: fn() };
          return hooks[slot].value;
        },
        useEffect(effect: () => void | (() => void), deps: unknown[]) {
          const slot = cursor++;
          const previous = hooks[slot];
          if (!previous || deps.some((dep, n) => dep !== previous.deps[n])) {
            const next: { deps: unknown[]; cleanup?: () => void } = { deps };
            hooks[slot] = next;
            effects.push(() => {
              previous?.cleanup?.();
              if (previous) previous.cleanup = undefined;
              const cleanup = effect();
              if (cleanup) next.cleanup = cleanup;
            });
            cleanups.push(() => {
              next.cleanup?.();
              next.cleanup = undefined;
            });
          }
        },
      };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native")
      return {
        View: "View",
        Text: "Text",
        Platform: { OS: options.platform || "android" },
        StyleSheet: { absoluteFill: {} },
        Image: { resolveAssetSource: (source: any) => source },
      };
    if (name === "expo-image") return { Image: "Image" };
    if (name === "expo/fetch")
      return { fetch: () => assert.fail("Unexpected native fetch") };
    if (name === "../lib/native-thumbnail-source")
      return {
        prepareNativeThumbnailSource:
          options.prepareSource ||
          (() => assert.fail("Unexpected source resolution")),
      };
    if (name === "expo-asset")
      return { Asset: { fromModule: () => ({ uri: "/media/poster.jpg" }) } };
    if (name === "expo") return { useEvent: () => ({ status: player.status }) };
    if (name === "expo-video")
      return {
        VideoView: "VideoView",
        useVideoPlayer: (source: unknown, setup: (player: unknown) => void) => {
          const slot = cursor++;
          if (!hooks[slot]) {
            hooks[slot] = player;
            playerSources.push(source);
            instances++;
            setup(player);
            cleanups.push(() => {
              releases++;
            });
          }
          return player;
        },
      };
    if (name === "expo-linear-gradient")
      return { LinearGradient: "LinearGradient" };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "../lib/assets")
      return {
        background: 1,
        coverSource: (path: string) =>
          path === "/brand/ziipa-background.png" ? 1 : { uri: path },
        playbackSource: (path: string) =>
          path?.startsWith("/api/creator/media/")
            ? {
                uri: options.remoteSource || path,
                headers: { Authorization: "Bearer fixture" },
                useCaching: false,
              }
            : null,
      };
    if (name === "../lib/config")
      return {
        portalMode: options.portal ?? false,
        apiOrigin: "https://api.ziipa.com",
        canonicalApiOrigin: "https://api.ziipa.com",
      };
    if (name === "../lib/profile-preview") return { profilePreviewRange };
    if (name === "../lib/gallery-preview") return galleryPreview;
    if (name === "../lib/gallery-still-cache") return stillCache;
    if (name === "../provider")
      return {
        useZiipa: () => ({
          session: { access_token: "fixture" },
          stillCacheLease: options.cacheLease,
        }),
      };
    if (name === "../theme") return { font: {} };
    throw new Error(`Unexpected still dependency ${name}`);
  });
  function render(value: any): any {
    if (Array.isArray(value)) return value.map(render);
    if (!value || typeof value !== "object" || !("props" in value))
      return value;
    if (typeof value.type === "function") {
      const previousHooks = hooks,
        previousCursor = cursor;
      hooks = componentHooks.get(value.type) || [];
      componentHooks.set(value.type, hooks);
      cursor = 0;
      const child = value.type(value.props);
      hooks = previousHooks;
      cursor = previousCursor;
      return render(child);
    }
    return {
      ...value,
      props: { ...value.props, children: render(value.props.children) },
    };
  }
  function nodes(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    return [value, ...nodes(value.props.children)];
  }
  return {
    player,
    samples,
    playerSources,
    bitmap,
    events,
    render(props: Record<string, unknown> = {}) {
      cursor = 0;
      return nodes(
        render({
          type: exports.GalleryStillPreview,
          props: {
            item: item(),
            enabled: true,
            ...props,
          },
        }),
      );
    },
    flush() {
      while (effects.length) {
        const cleanup = effects.shift()!();
        if (cleanup) cleanups.push(cleanup);
      }
    },
    unmount() {
      cleanups.reverse().forEach((fn) => fn());
    },
    counts: () => ({ instances, plays, pauses, releases }),
  };
}

test("Native side video generates a bounded retained image, never paints or plays a video, and releases its decoder", async () => {
  const ui = stillUI();
  const nodes = ui.render();
  ui.flush();
  assert.equal(ui.counts().instances, 1);
  assert.equal(ui.counts().plays, 0);
  assert.deepEqual(ui.samples, [
    { times: [6], size: { maxWidth: 360, maxHeight: 360 } },
  ]);
  assert.equal(ui.player.muted, true);
  assert.equal(ui.player.volume, 0);
  assert.equal(ui.player.staysActiveInBackground, false);
  assert.equal(ui.player.showNowPlayingNotification, false);
  assert.equal(ui.player.bufferOptions.maxBufferBytes, 1024 * 1024);
  assert.equal(ui.player.bufferOptions.preferredForwardBufferDuration, 0.5);
  assert.equal(
    nodes.some((node) => node.type === "VideoView"),
    false,
  );
  const paused = ui.counts().pauses;
  ui.events.get("playingChange")!({ isPlaying: true });
  assert.equal(ui.counts().pauses, paused + 1);
  await Promise.resolve();
  const image = ui.render().find((node) => node.type === "Image")!;
  assert.equal(image.props.source, ui.bitmap);
  assert.equal(image.props.autoplay, false);
  assert.equal(image.props.cachePolicy, "none");
  ui.unmount();
  assert.equal(ui.counts().releases, 1);
  assert.equal(ui.events.size, 0);
  assert.equal(ui.counts().plays, 0);
});

test("Android private stills resolve their source before creating a decoder and use only the resolved source", async () => {
  let finish!: (source: unknown) => void;
  let signal!: AbortSignal;
  const resolved = {
    uri: "https://fixture.r2.cloudflarestorage.com/still?capability=fixture",
    useCaching: false,
  };
  const ui = stillUI({
    remoteSource: "https://api.ziipa.com/api/creator/media/source",
    prepareSource(source, cancellation) {
      assert.deepEqual(source, {
        uri: "https://api.ziipa.com/api/creator/media/source",
        headers: { Authorization: "Bearer fixture" },
        useCaching: false,
      });
      signal = cancellation;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  ui.render();
  ui.flush();
  assert.equal(ui.counts().instances, 0);
  finish(resolved);
  await Promise.resolve();
  ui.render();
  ui.flush();
  assert.deepEqual(ui.playerSources, [resolved]);
  assert.equal(ui.counts().instances, 1);
  assert.equal(ui.counts().plays, 0);
  await Promise.resolve();
  assert.equal(
    ui.render().find((node) => node.type === "Image")!.props.source,
    ui.bitmap,
  );
  ui.unmount();
  assert.equal(signal.aborted, true);
});

test("Android source resolution cannot mount a decoder or report a stale result after disposal", async () => {
  let finish!: (source: unknown) => void;
  let signal!: AbortSignal;
  const ui = stillUI({
    remoteSource: "https://api.ziipa.com/api/creator/media/source",
    prepareSource(_source, cancellation) {
      signal = cancellation;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  ui.render();
  ui.flush();
  ui.unmount();
  assert.equal(signal.aborted, true);
  finish({ uri: "https://fixture.r2.cloudflarestorage.com/still" });
  await Promise.resolve();
  assert.equal(ui.counts().instances, 0);
  assert.deepEqual(ui.playerSources, []);
});

test("Android source resolution failures report a source failure without mounting a player", async () => {
  const ui = stillUI({
    remoteSource: "https://api.ziipa.com/api/creator/media/source",
    prepareSource: async () => {
      throw new Error("fixture failure");
    },
  });
  ui.render();
  ui.flush();
  await Promise.resolve();
  const nodes = ui.render();
  assert.equal(ui.counts().instances, 0);
  assert.ok(
    nodes.some(
      (node) =>
        node.props.testID === "gallery-still-failure-source-unavailable",
    ),
  );
  ui.unmount();
});

test("Disabled side previews and bearer-web transport do not mount private video decoders", () => {
  for (const [options, props] of [
    [{}, { enabled: false }],
    [{ platform: "web" }, {}],
  ] as const) {
    const ui = stillUI(options);
    const nodes = ui.render(props);
    ui.flush();
    assert.equal(ui.counts().instances, 0);
    assert.equal(
      nodes.some((node) => node.type === "VideoView"),
      false,
    );
  }
});

test("Native thumbnail candidates stay sequential and reject a returned frame outside the retained range", async () => {
  let discarded = 0;
  const invalid = {
    width: 360,
    height: 200,
    actualTime: 0,
    release() {
      discarded++;
    },
  };
  const valid = {
    width: 360,
    height: 200,
    actualTime: 7,
    release() {
      throw new Error("Displayed ref must not be manually released");
    },
  };
  const ui = stillUI({
    generate: async (_times) => [ui.samples.length === 1 ? invalid : valid],
  });
  ui.render();
  ui.flush();
  assert.equal(ui.samples.length, 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    ui.samples.map((sample) => sample.times),
    [[6], [6.95]],
  );
  assert.equal(discarded, 1);
  assert.equal(
    ui.render().find((node) => node.type === "Image")!.props.source,
    valid,
  );
  assert.equal(ui.counts().plays, 0);
  ui.unmount();
});

test("Unmounted native generation discards its late bitmap without starting another sample", async () => {
  let complete!: (frames: any[]) => void;
  let discarded = 0;
  const ui = stillUI({
    generate: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  ui.render();
  ui.flush();
  ui.unmount();
  complete([
    {
      width: 360,
      height: 203,
      release() {
        discarded++;
      },
    },
  ]);
  await Promise.resolve();
  assert.equal(discarded, 1);
  assert.equal(ui.samples.length, 1);
  assert.equal(ui.counts().plays, 0);
});

test("Accepted native images release exactly once after removal or unmount, never while displayed", async () => {
  for (const removeBeforeUnmount of [false, true]) {
    let released = 0;
    const bitmap = {
      width: 360,
      height: 200,
      release() {
        released++;
      },
    };
    const ui = stillUI({ generate: async () => [bitmap] });
    ui.render();
    ui.flush();
    await Promise.resolve();
    assert.equal(
      ui.render().find((node) => node.type === "Image")!.props.source,
      bitmap,
    );
    ui.flush();
    assert.equal(released, 0);
    if (removeBeforeUnmount) {
      assert.equal(
        ui.render({ enabled: false }).some((node) => node.type === "Image"),
        false,
      );
      assert.equal(
        released,
        0,
        "release belongs to passive cleanup after the old Image is removed",
      );
      ui.flush();
      ui.render({ enabled: false });
      ui.flush();
      assert.equal(released, 1);
    }
    ui.unmount();
    assert.equal(released, 1);
  }
});

test("A native result resolving between identity render and prior cleanup cannot stamp old pixels onto the new creation", async () => {
  let complete!: (frames: any[]) => void;
  let released = 0;
  const ui = stillUI({
    generate: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  try {
    ui.render();
    ui.flush();
    const replacement = item({
      id: "other-account-creation",
      media_url: "/api/creator/media/other-source",
    });
    ui.render({ item: replacement }); // New render has happened, old passive cleanup has not.
    complete([
      {
        width: 360,
        height: 200,
        release() {
          released++;
        },
      },
    ]);
    await Promise.resolve();
    assert.equal(released, 1);
    assert.equal(
      ui.render({ item: replacement }).some((node) => node.type === "Image"),
      false,
    );
    assert.equal(ui.samples.length, 1);
    assert.equal(ui.counts().plays, 0);
  } finally {
    ui.unmount();
  }
});

test("Each native attempt stops after three unusable candidates before its bounded retry", async () => {
  const ui = stillUI({ generate: async () => [] });
  try {
    ui.render();
    ui.flush();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    assert.deepEqual(
      ui.samples.map((sample) => sample.times),
      [[6], [6.95], [7.55]],
    );
    assert.ok(
      ui.render().some((node) => node.props.children === "Retrying still…"),
    );
    assert.equal(ui.counts().plays, 0);
  } finally {
    ui.unmount();
  }
});

test("Usable artwork is shown as a non-animated image rather than a video; audio never creates a player", () => {
  const photo = stillUI();
  const nodes = photo.render({
    item: item({
      content_type: "image/png",
      cover: "/api/creator/media/photo",
      media_url: null,
    }),
  });
  photo.flush();
  assert.equal(photo.counts().instances, 0);
  const image = nodes.find((node) => node.type === "Image")!;
  assert.equal(image.props.autoplay, false);
  assert.equal(image.props.cachePolicy, "none");
  assert.equal(image.props.source.uri, "/api/creator/media/photo");
  const poster = stillUI();
  poster.render({ item: item({ cover: "/api/creator/media/actual-poster" }) });
  poster.flush();
  assert.equal(poster.counts().instances, 0);
  const audio = stillUI();
  const rows = audio.render({ item: item({ content_type: "audio/wav" }) });
  audio.flush();
  assert.equal(audio.counts().instances, 0);
  assert.ok(rows.some((node) => node.props.children === "Audio creation"));
});

test("An unavailable explicit video poster falls back to a retained frame without playing the video", async () => {
  const ui = stillUI();
  const video = item({ cover: "/api/creator/media/missing-poster" });
  try {
    const poster = ui
      .render({ item: video })
      .find((node) => node.type === "Image")!;
    ui.flush();
    assert.equal(ui.counts().instances, 0);
    poster.props.onError();
    ui.render({ item: video });
    ui.flush();
    await Promise.resolve();
    const frame = ui
      .render({ item: video })
      .find((node) => node.type === "Image")!;
    assert.equal(frame.props.source, ui.bitmap);
    assert.equal(ui.counts().instances, 1);
    assert.equal(ui.counts().plays, 0);
  } finally {
    ui.unmount();
  }
});

test("Unavailable image-only artwork keeps an honest fallback and cannot start a video decoder", () => {
  const ui = stillUI();
  const photo = item({
    content_type: "image/png",
    media_url: null,
    cover: "/api/creator/media/missing-photo",
  });
  try {
    const poster = ui
      .render({ item: photo })
      .find((node) => node.type === "Image")!;
    ui.flush();
    poster.props.onError();
    assert.ok(
      ui
        .render({ item: photo })
        .some((node) => node.props.children === "Still preview unavailable"),
    );
    assert.equal(ui.counts().instances, 0);
  } finally {
    ui.unmount();
  }
});

test("A stale poster error cannot reject artwork from a replacement creation", () => {
  const ui = stillUI();
  const first = item({ cover: "/api/creator/media/first-poster" });
  const replacement = item({
    id: "replacement",
    cover: "/api/creator/media/second-poster",
  });
  try {
    const oldPoster = ui
      .render({ item: first })
      .find((node) => node.type === "Image")!;
    ui.flush();
    ui.render({ item: replacement });
    oldPoster.props.onError();
    const nodes = ui.render({ item: replacement });
    assert.equal(
      nodes.find((node) => node.type === "Image")!.props.source.uri,
      replacement.cover,
    );
    assert.equal(ui.counts().instances, 0);
    assert.ok(
      !nodes.some(
        (node) => node.props.children === "Still preview unavailable",
      ),
    );
  } finally {
    ui.unmount();
  }
});

test("Invalid retained ranges and decoder errors never paint or play a video while retrying", () => {
  for (const [options, props] of [
    [{}, { item: item({ trim_start: 10, trim_end: 4 }) }],
    [{ status: "error" }, {}],
  ] as const) {
    const ui = stillUI(options);
    ui.render(props);
    ui.flush();
    const nodes = ui.render(props);
    assert.equal(
      nodes.some((node) => node.type === "VideoView"),
      false,
    );
    assert.ok(nodes.some((node) => node.props.children === "Retrying still…"));
    assert.equal(ui.counts().plays, 0);
  }
});

test("Web side artwork captures one bounded still in memory and discards the decoder on cleanup", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  let removed = 0,
    drawn = 0;
  const requestOrder: string[] = [];
  let imageSource = "";
  const image: any = {
    naturalWidth: 1600,
    naturalHeight: 900,
    onload: null,
    onerror: null,
    set crossOrigin(value: string) {
      requestOrder.push(`cors:${value}`);
    },
    set src(value: string) {
      imageSource = value;
      requestOrder.push(`src:${value}`);
    },
    get src() {
      return imageSource;
    },
    removeAttribute() {
      removed++;
    },
  };
  const canvas: any = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage() {
          drawn++;
        },
      };
    },
    toDataURL() {
      return "data:image/png;base64,fixture-still";
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => (tag === "img" ? image : canvas) },
  });
  try {
    const ui = stillUI({ platform: "web", portal: true });
    const photo = item({
      content_type: "image/png",
      cover: "/api/creator/media/photo",
      media_url: null,
    });
    assert.equal(
      ui.render({ item: photo }).some((node) => node.type === "Image"),
      false,
    );
    ui.flush();
    assert.equal(image.src, "/api/creator/media/photo");
    assert.deepEqual(
      requestOrder,
      ["cors:anonymous", "src:/api/creator/media/photo"],
      "CORS must be configured before the API request redirects to private R2 storage",
    );
    image.onload();
    const nodes = ui.render({ item: photo });
    const still = nodes.find((node) => node.type === "Image")!;
    assert.equal(still.props.source.uri, "data:image/png;base64,fixture-still");
    assert.equal(still.props.autoplay, false);
    assert.equal(canvas.width, 360);
    assert.equal(canvas.height, 203);
    assert.equal(drawn, 1);
    ui.unmount();
    assert.ok(removed >= 2);
    assert.equal(image.onload, null);
    assert.equal(image.onerror, null);
    assert.equal(ui.counts().instances, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete (globalThis as any).document;
  }
});

test("Stalled web artwork has a bounded deadline and rejects a late load after fallback", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const timeout = globalThis.setTimeout,
    clear = globalThis.clearTimeout;
  let expire!: () => void,
    removed = 0;
  const image: any = {
    onload: null,
    onerror: null,
    removeAttribute() {
      removed++;
    },
  };
  globalThis.setTimeout = ((fn: () => void, duration: number) => {
    assert.equal(duration, 10000);
    expire = fn;
    return 1;
  }) as any;
  globalThis.clearTimeout = (() => {}) as any;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => image },
  });
  const ui = stillUI({ platform: "web", portal: true });
  const photo = item({
    content_type: "image/png",
    media_url: null,
    cover: "/api/creator/media/photo",
  });
  try {
    ui.render({ item: photo });
    ui.flush();
    const lateLoad = image.onload;
    expire();
    lateLoad();
    assert.equal(image.onload, null);
    assert.equal(image.onerror, null);
    assert.equal(removed, 1);
    assert.ok(
      ui
        .render({ item: photo })
        .some((node) => node.props.children === "Still preview unavailable"),
    );
    assert.equal(ui.counts().instances, 0);
  } finally {
    ui.unmount();
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete (globalThis as any).document;
    globalThis.setTimeout = timeout;
    globalThis.clearTimeout = clear;
  }
});

function webDecoder(pictures: boolean[], brokenCanvas = false) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const order: string[] = [],
    seeks: number[] = [];
  let stopped = 0,
    plays = 0,
    draws = 0,
    loads = 0,
    decoders = 0;
  const decoder: any = {
    duration: 20,
    videoWidth: 1920,
    videoHeight: 1080,
    readyState: 4,
    onloadedmetadata: null,
    onloadeddata: null,
    oncanplay: null,
    onseeked: null,
    onerror: null,
    set crossOrigin(value: string) {
      order.push(`cors:${value}`);
    },
    set src(value: string) {
      order.push(`src:${value}`);
    },
    set currentTime(value: number) {
      seeks.push(value);
    },
    pause() {
      stopped++;
    },
    play() {
      plays++;
    },
    load() {
      loads++;
    },
    removeAttribute(name: string) {
      assert.equal(name, "src");
    },
  };
  const canvas: any = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage() {
          draws++;
        },
        getImageData() {
          if (brokenCanvas)
            throw Object.assign(
              new Error("Never expose signed-source details"),
              {
                name: "SecurityError",
              },
            );
          const light = pictures[draws - 1] ? 80 : 0;
          return { data: new Uint8ClampedArray([light, light, light, 255]) };
        },
      };
    },
    toDataURL() {
      return "data:image/png;base64,representative-frame";
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tag: string) {
        assert.ok(tag === "video" || tag === "canvas");
        if (tag === "video") decoders++;
        return tag === "video" ? decoder : canvas;
      },
    },
  });
  return {
    decoder,
    canvas,
    order,
    seeks,
    counts: () => ({ stopped, plays, draws, loads, decoders }),
    restore() {
      if (original) Object.defineProperty(globalThis, "document", original);
      else delete (globalThis as any).document;
    },
  };
}

test("Web video uses at most three paused interior samples and paints only a bounded nonblack static image", () => {
  const web = webDecoder([false, true]);
  const ui = stillUI({ platform: "web", portal: true });
  try {
    assert.equal(
      ui.render().some((node) => node.type === "VideoView"),
      false,
    );
    ui.flush();
    assert.deepEqual(web.order, [
      "cors:anonymous",
      "src:/api/creator/media/source",
    ]);
    assert.equal(web.decoder.muted, true);
    assert.equal(web.decoder.volume, 0);
    assert.equal(web.decoder.preload, "auto");
    assert.equal(
      web.counts().loads,
      1,
      "pixel loading begins explicitly without calling play",
    );
    web.decoder.onloadedmetadata();
    web.decoder.onseeked();
    assert.deepEqual(web.seeks, [6, 6.95]);
    web.decoder.onseeked();
    const image = ui.render().find((node) => node.type === "Image")!;
    assert.equal(
      image.props.source.uri,
      "data:image/png;base64,representative-frame",
    );
    assert.equal(image.props.autoplay, false);
    assert.equal(web.canvas.width, 360);
    assert.equal(web.canvas.height, 203);
    assert.equal(web.counts().plays, 0);
    assert.equal(web.counts().draws, 2);
    assert.equal(web.decoder.onseeked, null);
    assert.equal(web.decoder.preload, "none");
    assert.equal(
      web.counts().loads,
      2,
      "successful capture releases its media resource",
    );
    assert.equal(
      ui.counts().instances,
      0,
      "Web must not call native thumbnail API",
    );
  } finally {
    ui.unmount();
    web.restore();
  }
});

test("Metadata without decoded pixels still requests a retained frame before geometry arrives", () => {
  const web = webDecoder([true]);
  const ui = stillUI({ platform: "web", portal: true });
  try {
    ui.render();
    ui.flush();
    web.decoder.videoWidth = 0;
    web.decoder.videoHeight = 0;
    web.decoder.readyState = 1;
    web.decoder.onloadedmetadata();
    assert.equal(web.decoder.preload, "auto");
    assert.equal(web.counts().loads, 1);
    assert.deepEqual(
      web.seeks,
      [6],
      "metadata alone must initiate a retained seek, not wait for pixels it has not requested",
    );
    web.decoder.onseeked();
    assert.equal(web.counts().draws, 0);
    assert.equal(
      web.canvas.width,
      0,
      "the canvas waits for valid decoded geometry",
    );
    assert.ok(
      !ui
        .render()
        .some((node) => node.props.children === "Still preview unavailable"),
    );
    web.decoder.videoWidth = 1920;
    web.decoder.videoHeight = 1080;
    web.decoder.readyState = 4;
    web.decoder.onloadeddata();
    assert.deepEqual(web.seeks, [6]);
    assert.equal(web.counts().draws, 1);
    assert.ok(ui.render().some((node) => node.type === "Image"));
    assert.equal(web.counts().plays, 0);
  } finally {
    ui.unmount();
    web.restore();
  }
});

test("Web seek completion before pixels are ready waits for loadeddata and never samples an in-flight seek", () => {
  const web = webDecoder([true]);
  const ui = stillUI({ platform: "web", portal: true });
  try {
    ui.render();
    ui.flush();
    web.decoder.onloadedmetadata();
    web.decoder.readyState = 1;
    web.decoder.onseeked();
    assert.equal(web.counts().draws, 0);
    assert.ok(
      !ui
        .render()
        .some((node) => node.props.children === "Still preview unavailable"),
    );
    web.decoder.readyState = 4;
    web.decoder.seeking = true;
    web.decoder.onloadeddata();
    assert.equal(web.counts().draws, 0);
    web.decoder.seeking = false;
    web.decoder.oncanplay();
    assert.equal(web.counts().draws, 1);
    assert.ok(ui.render().some((node) => node.type === "Image"));
    assert.equal(web.decoder.onloadeddata, null);
    assert.equal(web.decoder.oncanplay, null);
    assert.equal(web.counts().plays, 0);
  } finally {
    ui.unmount();
    web.restore();
  }
});

test("Three dark web samples and inaccessible canvas pixels produce honest nonvideo fallbacks", () => {
  for (const brokenCanvas of [false, true]) {
    const web = webDecoder([false, false, false], brokenCanvas);
    const ui = stillUI({ platform: "web", portal: true });
    try {
      ui.render();
      ui.flush();
      web.decoder.onloadedmetadata();
      while (web.decoder.onseeked) web.decoder.onseeked();
      const nodes = ui.render();
      assert.equal(
        nodes.some(
          (node) => node.type === "Image" || node.type === "VideoView",
        ),
        false,
      );
      assert.ok(
        nodes.some(
          (node) =>
            node.props.children ===
            (brokenCanvas ? "Retrying still…" : "Dark video · Open to watch"),
        ),
      );
      assert.equal(web.counts().plays, 0);
      assert.equal(web.seeks.length, brokenCanvas ? 1 : 3);
      assert.ok(web.seeks.every((time) => time > 5 && time < 8));
      if (brokenCanvas)
        assert.ok(
          nodes.some(
            (node) =>
              node.props.testID === "gallery-still-failure-canvas-security",
          ),
        );
    } finally {
      ui.unmount();
      web.restore();
    }
  }
});

test("Web deadline and unmount detach handlers without accepting late work or playing sound", () => {
  const timeout = globalThis.setTimeout,
    clear = globalThis.clearTimeout;
  let expire!: () => void;
  globalThis.setTimeout = ((fn: () => void, duration: number) => {
    assert.equal(duration, 10000);
    expire = fn;
    return 1;
  }) as any;
  globalThis.clearTimeout = (() => {}) as any;
  const web = webDecoder([true]);
  const ui = stillUI({ platform: "web", portal: true });
  try {
    ui.render();
    ui.flush();
    const lateMetadata = web.decoder.onloadedmetadata;
    expire();
    lateMetadata();
    assert.equal(web.seeks.length, 0);
    assert.equal(web.decoder.onseeked, null);
    assert.equal(web.decoder.onloadedmetadata, null);
    assert.equal(web.decoder.onloadeddata, null);
    assert.equal(web.decoder.oncanplay, null);
    assert.equal(web.decoder.onerror, null);
    assert.ok(
      ui.render().some((node) => node.props.children === "Retrying still…"),
    );
    assert.ok(
      ui
        .render()
        .some(
          (node) =>
            node.props.testID === "gallery-still-failure-metadata-timeout",
        ),
    );
    assert.equal(web.counts().plays, 0);
  } finally {
    ui.unmount();
    web.restore();
    globalThis.setTimeout = timeout;
    globalThis.clearTimeout = clear;
  }
});

test("a cold long source returns nearby retained pixels before a distant seek would exhaust the deadline", () => {
  const timers = thumbnailTimers();
  const web = webDecoder([true]);
  const ui = stillUI({ platform: "web", portal: true });
  const clip = item({ trim_start: 0, trim_end: null });
  const seek = Object.getOwnPropertyDescriptor(
    web.decoder,
    "currentTime",
  )!.set!;
  Object.defineProperty(web.decoder, "currentTime", {
    set(time: number) {
      seek.call(web.decoder, time);
      // The cold source has its short prefix available; a distant range takes
      // longer than the unchanged whole-job budget. This is a transport model,
      // not a claim that an actual production R2 request has this latency.
      setTimeout(
        () => {
          web.decoder.readyState = 4;
          web.decoder.onseeked?.();
        },
        time <= 3 ? 100 : galleryPreview.galleryStillTimeoutMs + 1,
      );
    },
  });
  try {
    web.decoder.duration = 240;
    web.decoder.readyState = 1;
    ui.render({ item: clip });
    ui.flush();
    web.decoder.onloadedmetadata();
    assert.deepEqual(web.seeks, [1]);
    assert.equal(web.counts().draws, 0);
    timers.run(100);
    assert.ok(ui.render({ item: clip }).some((node) => node.type === "Image"));
    assert.equal(web.seeks.length, 1);
    assert.equal(timers.count(), 0, "capture clears the original10s deadline");
    assert.equal(web.counts().plays, 0);
  } finally {
    ui.unmount();
    web.restore();
    timers.restore();
  }
});

test("web media failure diagnostics contain only the enumerated phase and media code", () => {
  for (const [code, label] of [
    [1, "aborted"],
    [2, "network"],
    [3, "decode"],
    [4, "unsupported"],
    [99, "unavailable"],
  ] as const) {
    const web = webDecoder([true]);
    const ui = stillUI({ platform: "web", portal: true });
    try {
      ui.render();
      ui.flush();
      web.decoder.onloadedmetadata();
      web.decoder.error = {
        code,
        message: "secret-source?signature=never-copy",
      };
      web.decoder.onerror();
      const nodes = ui.render();
      assert.ok(
        nodes.some(
          (node) => node.props.testID === `gallery-still-failure-seek-${label}`,
        ),
      );
      assert.ok(!JSON.stringify(nodes).includes("secret-source"));
      assert.equal(web.counts().plays, 0);
    } finally {
      ui.unmount();
      web.restore();
    }
  }
});

test("A stale web seek or error before passive cleanup cannot affect the replacement creation", () => {
  const web = webDecoder([true]);
  const ui = stillUI({ platform: "web", portal: true });
  try {
    ui.render();
    ui.flush();
    web.decoder.onloadedmetadata();
    const oldSeek = web.decoder.onseeked,
      oldError = web.decoder.onerror;
    const replacement = item({
      id: "replacement",
      media_url: "/api/creator/media/replacement",
    });
    ui.render({ item: replacement }); // Do not flush the old effect cleanup yet.
    oldSeek();
    oldError();
    const nodes = ui.render({ item: replacement });
    assert.equal(web.counts().draws, 0);
    assert.equal(
      nodes.some((node) => node.type === "Image"),
      false,
    );
    assert.equal(
      nodes.some((node) => node.props.children === "Still preview unavailable"),
      false,
    );
  } finally {
    ui.unmount();
    web.restore();
  }
});

const capturedPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV6sAAAAASUVORK5CYII=";

function thumbnailTimers() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let next = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = ++next;
    pending.set(id, { fn, ms });
    return id;
  }) as any;
  globalThis.clearTimeout = ((id: number) => pending.delete(id)) as any;
  return {
    run(ms: number) {
      const entry = Array.from(pending).find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `Expected a ${ms}ms thumbnail timer`);
      pending.delete(entry[0]);
      entry[1].fn();
    },
    count: () => pending.size,
    restore() {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    },
  };
}

test("deadline diagnostics distinguish a pending seek from pixels that never become ready", () => {
  for (const waitForPixels of [false, true]) {
    const timers = thumbnailTimers();
    const web = webDecoder([true]);
    const ui = stillUI({ platform: "web", portal: true });
    try {
      ui.render();
      ui.flush();
      web.decoder.onloadedmetadata();
      if (waitForPixels) {
        web.decoder.readyState = 1;
        web.decoder.onseeked();
      }
      timers.run(10000);
      assert.ok(
        ui
          .render()
          .some(
            (node) =>
              node.props.testID ===
              `gallery-still-failure-${waitForPixels ? "frame" : "seek"}-timeout`,
          ),
      );
      assert.equal(web.counts().draws, 0);
      assert.equal(web.counts().plays, 0);
      assert.equal(web.decoder.onseeked, null);
    } finally {
      ui.unmount();
      web.restore();
      timers.restore();
    }
  }
});

test("A transient web decoder error retries once with a fresh job and rejects callbacks from its first attempt", () => {
  const timers = thumbnailTimers();
  const web = webDecoder([true]);
  const ui = stillUI({ platform: "web", portal: true });
  try {
    ui.render();
    ui.flush();
    const oldMetadata = web.decoder.onloadedmetadata;
    const oldError = web.decoder.onerror;
    oldError();
    assert.ok(ui.render().some((n) => n.props.children === "Retrying still…"));
    ui.flush();
    timers.run(750);
    ui.render(); // Render the replacement before cleaning up the old job.
    oldMetadata();
    oldError();
    assert.equal(web.counts().draws, 0);
    assert.ok(
      !ui
        .render()
        .some((n) => n.props.children === "Still preview unavailable"),
    );
    ui.flush();
    assert.equal(web.counts().decoders, 2);
    web.decoder.onloadedmetadata();
    web.decoder.onseeked();
    assert.ok(ui.render().some((n) => n.type === "Image"));
    assert.equal(web.counts().plays, 0);
    ui.flush();
    assert.equal(timers.count(), 0);
  } finally {
    ui.unmount();
    web.restore();
    timers.restore();
  }
});

test("Two failed attempts stop at an honest fallback without scheduling a third decoder", () => {
  const timers = thumbnailTimers();
  const web = webDecoder([true]);
  const ui = stillUI({ platform: "web", portal: true });
  try {
    ui.render();
    ui.flush();
    timers.run(10000);
    ui.render();
    ui.flush();
    timers.run(750);
    ui.render();
    ui.flush();
    timers.run(10000);
    assert.ok(
      ui.render().some((n) => n.props.children === "Still preview unavailable"),
    );
    ui.flush();
    assert.equal(timers.count(), 0);
    assert.equal(web.counts().decoders, 2);
    assert.equal(web.counts().plays, 0);
  } finally {
    ui.unmount();
    web.restore();
    timers.restore();
  }
});

test("Hiding or unmounting a failed card cancels its pending retry", () => {
  for (const hide of [true, false]) {
    const timers = thumbnailTimers();
    const web = webDecoder([true]);
    const ui = stillUI({ platform: "web", portal: true });
    try {
      ui.render();
      ui.flush();
      web.decoder.onerror();
      ui.render();
      ui.flush();
      if (hide) {
        ui.render({ enabled: false });
        ui.flush();
      } else ui.unmount();
      assert.equal(timers.count(), 0);
      assert.equal(web.counts().decoders, 1);
      assert.equal(web.counts().plays, 0);
    } finally {
      ui.unmount();
      web.restore();
      timers.restore();
    }
  }
});

test("A successful web still survives visibility changes and remounts without another decoder", () => {
  const web = webDecoder([true]);
  web.canvas.toDataURL = () => capturedPng;
  const lease = stillCache.webGalleryStillCache.activate("current-account");
  const ui = stillUI({ platform: "web", portal: true, cacheLease: lease });
  const next = stillUI({ platform: "web", portal: true, cacheLease: lease });
  try {
    ui.render();
    ui.flush();
    web.decoder.onloadedmetadata();
    web.decoder.onseeked();
    assert.equal(
      ui.render().find((n) => n.type === "Image")?.props.source.uri,
      capturedPng,
    );
    ui.flush();
    assert.equal(
      ui.render({ enabled: false }).some((n) => n.type === "Image"),
      false,
    );
    ui.flush();
    assert.equal(
      ui.render().find((n) => n.type === "Image")?.props.source.uri,
      capturedPng,
    );
    ui.flush();
    ui.unmount();
    assert.equal(
      next.render().find((n) => n.type === "Image")?.props.source.uri,
      capturedPng,
    );
    next.flush();
    assert.equal(web.counts().decoders, 1);
    assert.equal(web.counts().plays, 0);
    const changed = item({ trim_start: 6 });
    assert.equal(
      next.render({ item: changed }).some((n) => n.type === "Image"),
      false,
    );
  } finally {
    ui.unmount();
    next.unmount();
    web.restore();
    stillCache.webGalleryStillCache.clear();
  }
});

test("Logout invalidates a web capture even before the old component receives its new context", () => {
  const web = webDecoder([true]);
  web.canvas.toDataURL = () => capturedPng;
  const lease = stillCache.webGalleryStillCache.activate("old-account");
  const ui = stillUI({ platform: "web", portal: true, cacheLease: lease });
  try {
    ui.render();
    ui.flush();
    web.decoder.onloadedmetadata();
    stillCache.webGalleryStillCache.clear();
    web.decoder.onseeked();
    assert.equal(
      ui.render().some((n) => n.type === "Image"),
      false,
    );
    assert.equal(
      stillCache.webGalleryStillCache.get(
        lease,
        stillCache.galleryStillCacheKey(item()),
      ),
      null,
    );
    assert.equal(web.counts().plays, 0);
  } finally {
    ui.unmount();
    web.restore();
    stillCache.webGalleryStillCache.clear();
  }
});

test("A still poster holds rotation until the actual image has loaded", () => {
  const ui = stillUI();
  const statuses: string[] = [];
  const props = {
    item: item({ cover: "/api/creator/media/actual-poster" }),
    onStatus: (status: string) => statuses.push(status),
  };
  try {
    const image = ui.render(props).find((n) => n.type === "Image")!;
    ui.flush();
    assert.deepEqual(statuses, ["loading"]);
    image.props.onLoad();
    ui.render(props);
    ui.flush();
    assert.deepEqual(statuses, ["loading", "ready"]);
    const nextScene: string[] = [];
    ui.render({
      ...props,
      statusOwner: {},
      onStatus: (s: string) => nextScene.push(s),
    });
    ui.flush();
    assert.deepEqual(
      nextScene,
      ["ready"],
      "an unchanged still replays readiness to a new gallery scene",
    );
    assert.equal(ui.counts().instances, 0);
  } finally {
    ui.unmount();
  }
});

test("A superseded passive status cannot report loading into a replacement creation", () => {
  const ui = stillUI();
  const statuses: string[] = [];
  try {
    ui.render({ onStatus: (s: string) => statuses.push(s) });
    ui.render({
      item: item({ id: "replacement-audio", content_type: "audio/wav" }),
      onStatus: (s: string) => statuses.push(s),
    });
    ui.flush();
    assert.deepEqual(statuses, ["unavailable"]);
  } finally {
    ui.unmount();
  }
});
