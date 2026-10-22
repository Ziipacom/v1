import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  profileCardVisible,
  profileCreations,
  profileMediaKind,
  profilePreviewPolicy,
  profilePreviewRange,
  profileVideoSelection,
} from "../src/lib/profile-preview.ts";
import * as helpers from "../src/lib/profile-preview.ts";
import type { Item } from "../src/lib/types.ts";

function item(id: string, changes: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    description: "",
    category: "video",
    creator: "Creator",
    tags: [],
    city: "",
    cover: "/brand/ziipa-background.png",
    media_url: "/api/creator/media/1b64411d-df3e-4b9a-9722-09eec2f94fd2",
    content_type: "video/mp4",
    demo: false,
    label: "Post",
    visibility: "published",
    ...changes,
  };
}

test("All creations includes every published world, while Music & Film and Games remain explicit local filters", () => {
  const originals = Object.freeze([
    item("game", { category: "games" }),
    item("film"),
    item("song", { category: "music" }),
    item("art", { category: "nft" }),
  ]);
  assert.deepEqual(
    profileCreations(originals, "all").map(({ id }) => id),
    ["game", "film", "song", "art"],
  );
  assert.deepEqual(
    profileCreations(originals, "music").map(({ id }) => id),
    ["film", "song"],
  );
  assert.deepEqual(
    profileCreations(originals, "games").map(({ id }) => id),
    ["game"],
  );
  assert.deepEqual(
    originals.map(({ id }) => id),
    ["game", "film", "song", "art"],
    "filtering must not reorder or write shared data/preferences",
  );
});

test("profile media classification follows actual content type instead of the creative world", () => {
  assert.equal(
    profileMediaKind(item("video-game", { category: "games" })),
    "video",
  );
  assert.equal(
    profileMediaKind(
      item("photo", { content_type: "image/jpeg", media_url: null }),
    ),
    "image",
  );
  assert.equal(
    profileMediaKind(item("music", { content_type: "audio/wav" })),
    "audio",
  );
  assert.equal(
    profileMediaKind(item("empty", { content_type: null, media_url: null })),
    "none",
  );
});

test("only one sufficiently visible video is selected without mutating the published list", () => {
  const videos = Object.freeze([item("first"), item("second"), item("third")]);
  const positions = {
    first: { top: 0, height: 180 },
    second: { top: 190, height: 180 },
    third: { top: 380, height: 180 },
  };
  assert.equal(
    profileVideoSelection(videos, positions, {
      top: 0,
      height: 400,
      gridTop: 100,
    }),
    "first",
  );
  assert.equal(
    profileVideoSelection(videos, positions, {
      top: 260,
      height: 300,
      gridTop: 100,
    }),
    "second",
  );
  assert.equal(
    profileVideoSelection(videos, positions, {
      top: 1000,
      height: 300,
      gridTop: 100,
    }),
    null,
  );
  assert.equal(
    profileCardVisible(
      { top: 0, height: 180 },
      { top: 190, height: 300, gridTop: 100 },
    ),
    true,
  );
  assert.equal(
    profileCardVisible(
      { top: 0, height: 180 },
      { top: 191, height: 300, gridTop: 100 },
    ),
    false,
  );
  assert.equal(
    profileCardVisible(undefined, { top: 0, height: 0, gridTop: 0 }),
    false,
  );
  assert.deepEqual(
    videos.map(({ id }) => id),
    ["first", "second", "third"],
  );
});

test("background, navigation, sheets, unresolved preferences and Save Data cannot mount a video", () => {
  const allowed = {
    focused: true,
    foreground: true,
    ready: true,
    autoplay: true,
    reducedMotion: false,
    saveData: false,
    blocked: false,
  };
  assert.deepEqual(profilePreviewPolicy(allowed), {
    mountVideo: true,
    autoplay: true,
  });
  for (const patch of [
    { focused: false },
    { foreground: false },
    { ready: false },
    { blocked: true },
    { saveData: true },
  ])
    assert.deepEqual(profilePreviewPolicy({ ...allowed, ...patch }), {
      mountVideo: false,
      autoplay: false,
    });
  for (const patch of [{ autoplay: false }, { reducedMotion: true }])
    assert.deepEqual(profilePreviewPolicy({ ...allowed, ...patch }), {
      mountVideo: true,
      autoplay: false,
    });
});

test("preview loops only retained trim or the first retained timeline clip, never discarded source regions", () => {
  assert.deepEqual(
    profilePreviewRange(item("trim", { trim_start: 8, trim_end: 12 }), 20),
    { start: 8, end: 12, speed: 1 },
  );
  assert.deepEqual(
    profilePreviewRange(
      item("edited", {
        timeline: {
          version: 1,
          clips: [
            { id: "first", start: 12, end: 16, speed: 2 },
            { id: "later", start: 1, end: 3 },
          ],
        },
      }),
      20,
    ),
    { start: 12, end: 16, speed: 2 },
  );
  assert.deepEqual(profilePreviewRange(item("bounded", { trim_end: 90 }), 4), {
    start: 0,
    end: 4,
    speed: 1,
  });
  assert.throws(
    () => profilePreviewRange(item("invalid", { trim_start: 5 }), 4),
    /invalid saved playback range/,
  );
});

type Node = { type: any; props: Record<string, any>; key?: string };
function previewHarness(
  options: {
    platform?: string;
    portal?: boolean;
    time?: number;
    status?: string;
    autoplay?: boolean;
    failed?: boolean;
    stillStatus?: "loading" | "error" | "dark";
  } = {},
) {
  const source = readFileSync(
    new URL("../src/components/profile-media-preview.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  const effects: (() => void | (() => void))[] = [];
  const cleanups: (() => void)[] = [];
  const updates: unknown[] = [];
  const events = new Map<string, () => void>();
  let plays = 0,
    pauses = 0,
    instances = 0,
    releases = 0;
  let firstMemo: unknown;
  let stateCalls = 0;
  const player: Record<string, any> = {
    status: options.status || "readyToPlay",
    duration: 20,
    currentTime: options.time ?? 0,
    play() {
      plays++;
    },
    pause() {
      pauses++;
    },
    addListener(name: string, listener: () => void) {
      events.set(name, listener);
      return {
        remove() {
          events.delete(name);
        },
      };
    },
  };
  const exported: Record<string, any> = {};
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react")
      return {
        useMemo: (fn: () => unknown) => {
          const value = fn();
          if (firstMemo === undefined) firstMemo = value;
          return value;
        },
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [
          options.failed && stateCalls++ === 0 ? firstMemo : initial,
          (value: unknown) => updates.push(value),
        ],
        useEffect: (effect: () => void | (() => void)) => effects.push(effect),
      };
    if (name === "react/jsx-runtime")
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "react-native")
      return {
        AppState: {
          currentState: "active",
          addEventListener: () => ({ remove() {} }),
        },
        Platform: { OS: options.platform || "android" },
        Pressable: "Pressable",
        Text: "Text",
        View: "View",
        StyleSheet: { absoluteFill: {} },
      };
    if (name === "expo-image") return { Image: "Image" };
    if (name === "expo")
      return {
        useEvent: (_: unknown, event: string) =>
          event === "statusChange"
            ? { status: player.status }
            : { currentTime: player.currentTime },
      };
    if (name === "expo-video")
      return {
        VideoView: "VideoView",
        useVideoPlayer: (_source: unknown, setup: (value: unknown) => void) => {
          instances++;
          setup(player);
          effects.push(() => () => {
            releases++;
          });
          return player;
        },
      };
    if (name === "@react-navigation/native")
      return { useIsFocused: () => true };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "./ui") return { Cover: "Cover" };
    if (name === "./gallery-still-preview")
      return {
        GalleryStillPreview: (props: Node["props"]) => ({
          type: "GalleryStillPreview",
          props: {
            ...props,
            children: options.stillStatus
              ? {
                  type: "Text",
                  props: {
                    children: {
                      loading: "Loading still…",
                      error: "Still preview unavailable",
                      dark: "Dark video · Open to watch",
                    }[options.stillStatus],
                  },
                }
              : null,
          },
        }),
      };
    if (name === "./device-preferences")
      return {
        useDevicePreferences: () => ({
          preferences: { autoplay: true },
          ready: true,
          reducedMotion: false,
        }),
      };
    if (name === "../provider")
      return {
        useZiipa: () => ({ session: { access_token: "fixture-token" } }),
      };
    if (name === "../lib/assets")
      return {
        localImages: { "/brand/ziipa-background.png": 1 },
        coverSource: (path: string) => ({ uri: path }),
        playbackSource: (path: string) => ({ uri: path, useCaching: false }),
      };
    if (name === "../lib/config")
      return { portalMode: options.portal ?? false };
    if (name === "../lib/profile-preview") return helpers;
    if (name === "../theme") return { font: {} };
    throw new Error(`Unexpected profile preview dependency ${name}`);
  });
  function render(value: any): any {
    if (Array.isArray(value)) return value.map(render);
    if (!value || typeof value !== "object" || !("props" in value))
      return value;
    if (typeof value.type === "function")
      return render(value.type(value.props));
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
    updates,
    events,
    render: (props: Record<string, unknown>) =>
      nodes(
        render(
          exported.ProfileMediaPreview({
            item: item("card"),
            visible: true,
            videoActive: true,
            autoplay: options.autoplay ?? true,
            allowVideoStill: true,
            ...props,
          }),
        ),
      ),
    flush() {
      while (effects.length) {
        const cleanup = effects.shift()!();
        if (cleanup) cleanups.push(cleanup);
      }
    },
    unmount() {
      cleanups.reverse().forEach((cleanup) => cleanup());
    },
    counts: () => ({ plays, pauses, instances, releases }),
  };
}

test("only an active card mounts a muted bounded player and unmount pauses/releases it", () => {
  const hidden = previewHarness();
  assert.equal(
    hidden
      .render({ videoActive: false })
      .some((node) => node.type === "VideoView"),
    false,
  );
  assert.equal(hidden.counts().instances, 0);
  const active = previewHarness();
  const nodes = active.render({
    item: item("trim", { trim_start: 8, trim_end: 12 }),
  });
  active.flush();
  assert.equal(active.player.muted, true);
  assert.equal(active.player.volume, 0);
  assert.equal(active.player.staysActiveInBackground, false);
  assert.equal(active.player.showNowPlayingNotification, false);
  assert.equal(active.player.bufferOptions.maxBufferBytes, 4 * 1024 * 1024);
  assert.equal(active.player.currentTime, 8);
  assert.equal(active.counts().plays, 1);
  const view = nodes.find((node) => node.type === "VideoView")!;
  assert.equal(view.props.nativeControls, false);
  assert.equal(view.props.allowsPictureInPicture, false);
  assert.equal(view.props.surfaceType, "textureView");
  active.events.get("playToEnd")!();
  assert.equal(
    active.player.currentTime,
    8,
    "manual looping retains the start instead of discarded time zero",
  );
  active.unmount();
  assert.ok(active.counts().pauses >= 1);
  assert.equal(active.counts().releases, 1);
  assert.equal(active.events.size, 0);
});

test("visible inactive Profile videos use their own still and play affordance without mounting a playback view", () => {
  for (const options of [
    { platform: "android" },
    { platform: "web", portal: true },
  ]) {
    const ui = previewHarness(options);
    const creation = item("inactive", {
      trim_start: 6,
      trim_end: 12,
      timeline: { version: 1, clips: [{ id: "retained", start: 8, end: 10 }] },
    });
    const nodes = ui.render({ item: creation, videoActive: false });
    const still = nodes.find((node) => node.type === "GalleryStillPreview")!;
    assert.ok(still);
    assert.equal(still.props.item, creation);
    assert.equal(still.props.enabled, true);
    assert.ok(nodes.some((node) => node.type === "Play"));
    assert.ok(nodes.some((node) => node.props.children === "Open to play"));
    assert.equal(nodes.some((node) => node.type === "VideoView"), false);
    ui.flush();
    assert.equal(ui.counts().plays, 0);
    assert.equal(ui.counts().instances, 0);
    ui.unmount();
  }
});

test("Profile still loading, failure and dark feedback stays separate from the corner play affordance", () => {
  for (const [stillStatus, expected] of [
    ["loading", "Loading still…"],
    ["error", "Still preview unavailable"],
    ["dark", "Dark video · Open to watch"],
  ] as const) {
    const ui = previewHarness({ stillStatus });
    const nodes = ui.render({ videoActive: false });
    const badge = nodes.find((node) => node.props.testID === "profile-video-still-play")!;
    assert.ok(badge);
    assert.equal(badge.props.style.top, 8);
    assert.equal(badge.props.style.right, 8);
    assert.ok(nodes.some((node) => node.props.children === expected));
    assert.equal(nodes.filter((node) => node.props.children === "Open to play").length, 1);
    assert.equal(nodes.some((node) => node.props.children === "Video · Open to play"), false);
    assert.equal(nodes.some((node) => node.type === "VideoView"), false);
    ui.flush();
    assert.equal(ui.counts().plays, 0);
    ui.unmount();
  }
});

test("Profile still jobs and playback views are absent offscreen or when the shared activity marks a card hidden", () => {
  for (const videoActive of [true, false]) {
    const ui = previewHarness();
    const nodes = ui.render({ videoActive, visible: false });
    assert.equal(nodes.some((node) => node.type === "GalleryStillPreview"), false);
    assert.equal(nodes.some((node) => node.type === "VideoView"), false);
    ui.flush();
    assert.equal(ui.counts().instances, 0);
    assert.equal(ui.counts().plays, 0);
    ui.unmount();
  }
});

test("Profile inactive video stills require the shared readiness and Save Data permission independently of static image visibility", () => {
  const ui = previewHarness();
  const nodes = ui.render({ videoActive: false, allowVideoStill: false });
  assert.equal(nodes.some((node) => node.type === "GalleryStillPreview"), false);
  assert.equal(ui.counts().instances, 0);
  const photo = ui.render({
    item: item("photo", {
      content_type: "image/jpeg",
      media_url: null,
      cover: "/api/creator/media/photo",
    }),
    videoActive: false,
    allowVideoStill: false,
  });
  assert.ok(photo.some((node) => node.type === "Image"));
});

test("a visible active Profile video never also starts a still job; untrusted bearer-web and audio do not create video stills", () => {
  const active = previewHarness();
  const activeNodes = active.render({});
  assert.ok(activeNodes.some((node) => node.type === "VideoView"));
  assert.equal(activeNodes.some((node) => node.type === "GalleryStillPreview"), false);
  active.unmount();
  const bearer = previewHarness({ platform: "web", portal: false });
  const bearerNodes = bearer.render({ videoActive: false });
  assert.equal(bearerNodes.some((node) => node.type === "GalleryStillPreview"), false);
  assert.equal(bearer.counts().instances, 0);
  const audio = previewHarness();
  const audioNodes = audio.render({
    item: item("song", { content_type: "audio/wav" }),
    videoActive: false,
  });
  assert.equal(audioNodes.some((node) => node.type === "GalleryStillPreview"), false);
  assert.equal(audio.counts().instances, 0);
});

test("reduced-motion/autoplay-off previews load a retained still frame without starting playback", () => {
  const ui = previewHarness({ autoplay: false });
  ui.render({ item: item("trim", { trim_start: 8, trim_end: 12 }) });
  ui.flush();
  assert.equal(ui.player.currentTime, 8);
  assert.equal(ui.counts().plays, 0);
  assert.ok(ui.counts().pauses > 0);
  ui.events.get("playToEnd")!();
  assert.equal(ui.counts().plays, 0);
  ui.unmount();
});

test("bearer-web cards never mount a full-file private blob player, while cookie portal streaming works", () => {
  const bearer = previewHarness({ platform: "web", portal: false });
  const nodes = bearer.render({});
  assert.equal(
    nodes.some((node) => node.type === "VideoView"),
    false,
  );
  assert.equal(bearer.counts().instances, 0);
  assert.ok(
    nodes.some((node) => node.props.children === "Open creation to view media"),
  );
  const portal = previewHarness({ platform: "web", portal: true });
  assert.ok(portal.render({}).some((node) => node.type === "VideoView"));
  portal.flush();
  portal.unmount();
});

test("visible images use real media, while audio cards never mount an audio or video player", () => {
  const photo = previewHarness();
  assert.ok(
    photo
      .render({
        item: item("photo", {
          content_type: "image/jpeg",
          media_url: null,
          cover: "/api/creator/media/photo",
        }),
      })
      .some((node) => node.type === "Image"),
  );
  const audio = previewHarness();
  const nodes = audio.render({
    item: item("song", { content_type: "audio/wav" }),
  });
  assert.equal(audio.counts().instances, 0);
  assert.ok(
    nodes.some((node) => node.props.children === "Audio · Open to listen"),
  );
});

test("animated image previews honor playback preferences natively and never animate through the web fallback", () => {
  for (const content_type of ["image/gif", "image/webp", "image/png"]) {
    const media = item("animation", {
      content_type,
      media_url: null,
      cover: "/api/creator/media/animation",
    });
    for (const autoplay of [true, false]) {
      const native = previewHarness({ autoplay });
      const image = native
        .render({ item: media })
        .find((node) => node.type === "Image")!;
      assert.ok(image);
      assert.equal(image.props.autoplay, autoplay);
      assert.equal(native.counts().instances, 0);
      assert.equal(
        native
          .render({ item: media, visible: false })
          .some((node) => node.type === "Image"),
        false,
        "offscreen images unmount instead of continuing to animate",
      );
      const web = previewHarness({ platform: "web", portal: true, autoplay });
      const nodes = web.render({ item: media });
      assert.equal(
        nodes.some((node) => node.type === "Image"),
        autoplay,
      );
      if (!autoplay)
        assert.ok(
          nodes.some(
            (node) =>
              node.props.children === "Image preview paused · Open to view",
          ),
          "HTML images cannot be paused, so disabled playback must not mount them",
        );
    }
  }
  const jpeg = previewHarness({
    platform: "web",
    portal: true,
    autoplay: false,
  });
  assert.ok(
    jpeg
      .render({ item: item("photo", { content_type: "image/jpeg" }) })
      .some((node) => node.type === "Image"),
    "known static JPEGs still preview when autoplay is disabled",
  );
});

test("preview failures stop playback and retry only through an explicit local button", () => {
  const broken = previewHarness({ status: "error" });
  broken.render({});
  broken.flush();
  assert.equal(broken.counts().plays, 0);
  assert.ok(broken.counts().pauses >= 1);
  assert.equal(broken.counts().instances, 1);
  assert.equal(
    broken.updates.filter((value) => value && typeof value === "object").length,
    1,
  );
  broken.unmount();
  const failed = previewHarness({ failed: true });
  const nodes = failed.render({});
  assert.equal(
    failed.counts().instances,
    0,
    "an errored preview cannot remount automatically",
  );
  const retry = nodes.find(
    (node) => node.props.accessibilityLabel === "Retry preview for card",
  )!;
  let stopped = false;
  retry.props.onPress({
    stopPropagation() {
      stopped = true;
    },
  });
  assert.equal(
    stopped,
    true,
    "retry does not trigger the surrounding card navigation",
  );
  assert.equal(retry.props.style.width, 44);
  assert.ok(failed.updates.includes(null));
});

test("profile card layout snapshots native event dimensions before a deferred state update", () => {
  const sourceText = readFileSync(
    new URL("../src/screens/profile.tsx", import.meta.url),
    "utf8",
  );
  const source = ts.createSourceFile(
    "profile.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const handlers: ts.Expression[] = [];
  const hasSetter = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "setCardLayouts") ||
    ts.forEachChild(node, hasSetter) === true;
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "onLayout" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      hasSetter(node.initializer.expression)
    )
      handlers.push(node.initializer.expression);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(handlers.length, 1);
  const compiled = ts.transpileModule(
    `const handler=${handlers[0].getText(source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const pending: ((state: unknown) => unknown)[] = [];
  const layoutIdentity = { current: "all" };
  const handler = new Function(
    "setCardLayouts",
    "layoutIdentity",
    "layoutKey",
    "item",
    `${compiled};return handler;`,
  )(
    (callback: (state: unknown) => unknown) => pending.push(callback),
    layoutIdentity,
    "all",
    { id: "clip" },
  );
  const event: {
    nativeEvent: { layout: { y: number; height: number } } | null;
  } = { nativeEvent: { layout: { y: 190, height: 179 } } };
  handler(event);
  event.nativeEvent = null;
  assert.deepEqual(pending[0]({ key: "all", values: {} }), {
    key: "all",
    values: { clip: { top: 190, height: 179 } },
  });
  const current = { key: "games", values: { game: { top: 0, height: 179 } } };
  layoutIdentity.current = "games";
  assert.equal(
    pending[0](current),
    current,
    "an already queued old-filter event cannot replace fresh bounds",
  );
  handler({ nativeEvent: { layout: { y: 9000, height: 179 } } });
  assert.equal(
    pending.length,
    1,
    "a late old-filter event is ignored before queuing",
  );
});

/** Render the real Profile screen with inert native leaves and persistent hook
 * slots, so local filters, native layout events and scroll position interact. */
function profileScreenHarness(desktop = false) {
  const source = readFileSync(
    new URL("../src/screens/profile.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exported: Record<string, any> = {};
  const hooks: any[] = [];
  let cursor = 0;
  let requests = 0;
  let refreshes = 0;
  let preferenceWrites = 0;
  const navigations: unknown[] = [];
  const creations = [
    item("game", { category: "games" }),
    item("film"),
    item("song", { category: "music" }),
    item("art", { category: "nft" }),
    item("broadcast", { category: "live" }),
    item("product", { category: "store" }),
    item("private", { visibility: "draft" }),
  ];
  const preferences = { saved: ["game"], autoplay: true, startMuted: false };
  const activity = { mountVideo: true, visible: true, autoplay: true };
  const jsx = (
    type: unknown,
    props: Record<string, unknown>,
    key?: string,
  ) => ({ type, props, key });
  const categories = [
    { id: "video", title: "Videos", icon: "FilmIcon" },
    { id: "music", title: "Music & Film", icon: "MusicIcon" },
    { id: "games", title: "Games", icon: "GamesIcon" },
    { id: "nft", title: "NFTs", icon: "ArtIcon" },
    { id: "live", title: "Live feeds", icon: "LiveIcon" },
    { id: "store", title: "Store", icon: "StoreIcon" },
  ];
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react")
      return {
        useState(initial: unknown) {
          const slot = cursor++;
          if (!(slot in hooks))
            hooks[slot] = typeof initial === "function" ? initial() : initial;
          return [
            hooks[slot],
            (value: any) => {
              hooks[slot] =
                typeof value === "function" ? value(hooks[slot]) : value;
            },
          ];
        },
        useRef(current: unknown) {
          const slot = cursor++;
          return (hooks[slot] ||= { current });
        },
        useEffect() {},
        useCallback: (fn: unknown) => fn,
      };
    if (name === "react/jsx-runtime")
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "react-native")
      return Object.fromEntries(
        [
          "Image",
          "ImageBackground",
          "Pressable",
          "ScrollView",
          "Text",
          "View",
        ].map((name) => [name, name]),
      );
    if (name === "react-native-safe-area-context")
      return {
        SafeAreaView: "SafeAreaView",
        useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
      };
    if (name === "@react-navigation/native") return { useFocusEffect() {} };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name.endsWith("/desktop-layout"))
      return { useDesktopLayout: () => ({ desktop, contentWidth: 1200 }) };
    if (name.endsWith("/desktop-workspace"))
      return { workspace: { page: {} }, WorkspaceHeading: "WorkspaceHeading" };
    if (name.endsWith("/floating"))
      return {
        CategoryDock: "CategoryDock",
        FloatButton: "FloatButton",
        Sheet: "Sheet",
        WorldGlyph: "WorldGlyph",
        worlds: categories,
      };
    if (name.endsWith("/ui"))
      return {
        Action: "Action",
        Notice: "Notice",
        Pill: "Pill",
        allCategories: categories,
      };
    if (name.endsWith("/account-menu"))
      return { SignOutButton: "SignOutButton" };
    if (name.endsWith("/profile-image-controls"))
      return { ProfileImageControls: "ProfileImageControls" };
    if (name.endsWith("/profile-media-preview"))
      return {
        ProfileMediaPreview: "ProfileMediaPreview",
        useProfilePreviewActivity: () => activity,
      };
    if (name.endsWith("/assets"))
      return { coverSource: (uri: string) => ({ uri }) };
    if (name.endsWith("/profile-image-source"))
      return { useProfileImageSource: () => null };
    if (name.endsWith("/profile-preview")) return helpers;
    if (name === "../provider")
      return {
        useZiipa: () => ({
          session: {
            access_token: "fixture-token",
            user: { id: 1, name: "Creator" },
          },
          guest: false,
          data: {
            items: creations.filter((row) => row.visibility === "published"),
            drafts: creations,
            preferences,
          },
          api: () => {
            requests++;
            throw new Error("Local filters must not request account changes");
          },
          refresh: () => {
            refreshes++;
          },
          preferences: () => {
            preferenceWrites++;
          },
        }),
      };
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    throw new Error(`Unexpected Profile screen dependency ${name}`);
  });
  function nodes(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    return [value, ...nodes(value.props.children)];
  }
  function render() {
    cursor = 0;
    return nodes(
      exported.ProfileScreen({
        navigation: {
          navigate: (...args: unknown[]) => navigations.push(args),
        },
      }),
    );
  }
  let mountedCards = new Map<string, { top: number; height: number }>();
  const layoutEvents: { key: string; top: number; height: number }[] = [];
  return {
    preferences,
    activity,
    creations,
    navigations,
    layoutEvents,
    counts: () => ({ requests, refreshes, preferenceWrites }),
    render,
    /** Native layout events are required for mounts or changed geometry only.
     * A retained key at unchanged y/height intentionally emits no new event. */
    renderWithLayout() {
      const tree = render();
      const scroll = tree.find((node) => node.type === "ScrollView")!;
      const feed = tree.find(
        (node) => node.props.testID === "profile-creations-feed",
      )!;
      scroll.props.onLayout({
        nativeEvent: { layout: { height: desktop ? 500 : 300 } },
      });
      feed.props.onLayout({ nativeEvent: { layout: { y: 0 } } });
      const next = new Map<string, { top: number; height: number }>();
      let top = 0;
      for (const card of feed.props.children[0]) {
        const key = card.key as string;
        const height = card.props.style.height;
        const previous = mountedCards.get(key);
        if (!previous || previous.top !== top || previous.height !== height) {
          card.props.onLayout({ nativeEvent: { layout: { y: top, height } } });
          layoutEvents.push({ key, top, height });
        }
        next.set(key, { top, height });
        top += height + feed.props.style.gap;
      }
      mountedCards = next;
      return render();
    },
  };
}

test("Profile forwards the shared video-loading gate to stills while keeping ordinary card visibility separate", () => {
  const ui = profileScreenHarness();
  let nodes = ui.renderWithLayout();
  const previews = () => nodes.filter((node) => node.type === "ProfileMediaPreview");
  assert.ok(previews().every((node) => node.props.allowVideoStill === true));
  assert.equal(previews().filter((node) => node.props.videoActive).length, 1);
  ui.activity.mountVideo = false;
  nodes = ui.renderWithLayout();
  assert.ok(previews().every((node) => node.props.allowVideoStill === false));
  assert.ok(previews().some((node) => node.props.visible));
  assert.equal(previews().filter((node) => node.props.videoActive).length, 0);
  assert.deepEqual(ui.counts(), { requests: 0, refreshes: 0, preferenceWrites: 0 });
});

test("unchanged leading Profile cards remeasure across category and Saved filters without replacing the ScrollView", () => {
  for (const desktop of [false, true]) {
    const ui = profileScreenHarness(desktop);
    let tree = ui.renderWithLayout();
    const preview = () =>
      tree.find(
        (node) =>
          node.type === "ProfileMediaPreview" && node.props.item.id === "game",
      )!;
    const feed = () =>
      tree.find((node) => node.props.testID === "profile-creations-feed")!;
    const originalCard = feed().props.children[0][0];
    const originalBounds = ui.layoutEvents[0];
    assert.equal(preview().props.visible, true);
    assert.equal(preview().props.videoActive, true);
    tree.find((node) => node.type === "CategoryDock")!.props.onSelect("games");
    tree = ui.renderWithLayout();
    assert.notEqual(
      feed().props.children[0][0].key,
      originalCard.key,
      "unchanged geometry must not retain an unmeasured card",
    );
    assert.ok(
      ui.layoutEvents.some(
        (event) =>
          event.key === feed().props.children[0][0].key &&
          event.top === originalBounds.top &&
          event.height === originalBounds.height,
      ),
    );
    assert.equal(preview().props.visible, true);
    assert.equal(preview().props.videoActive, true);
    originalCard.props.onLayout({
      nativeEvent: { layout: { y: 9999, height: originalBounds.height } },
    });
    tree = ui.render();
    assert.equal(
      preview().props.videoActive,
      true,
      "a stale All-view event cannot replace filtered measurements",
    );
    tree
      .find((node) => node.props.accessibilityLabel === "Show saved creations")!
      .props.onPress();
    tree = ui.renderWithLayout();
    assert.equal(preview().props.visible, true);
    assert.equal(preview().props.videoActive, true);
    tree
      .find((node) => node.props.accessibilityLabel === "Show creations")!
      .props.onPress();
    tree = ui.renderWithLayout();
    assert.equal(preview().props.videoActive, true);
    assert.equal(
      tree.find((node) => node.type === "ScrollView")!.key,
      undefined,
    );
    assert.equal(
      tree.filter(
        (node) => node.type === "ProfileMediaPreview" && node.props.videoActive,
      ).length,
      1,
    );
    assert.deepEqual(ui.counts(), {
      requests: 0,
      refreshes: 0,
      preferenceWrites: 0,
    });
  }
});

test("Music & Film filters and list changes remeasure an unchanged first video instead of relying on geometry-change events", () => {
  for (const desktop of [false, true]) {
    const ui = profileScreenHarness(desktop);
    ui.creations.splice(0, 1);
    let tree = ui.renderWithLayout();
    const active = () =>
      tree
        .filter(
          (node) =>
            node.type === "ProfileMediaPreview" && node.props.videoActive,
        )
        .map((node) => node.props.item.id);
    assert.deepEqual(active(), ["film"]);
    tree.find((node) => node.type === "CategoryDock")!.props.onSelect("music");
    tree = ui.renderWithLayout();
    assert.deepEqual(active(), ["film"]);
    tree
      .find(
        (node) =>
          node.props.accessibilityLabel === "Reset Profile to all creations",
      )!
      .props.onPress();
    tree = ui.renderWithLayout();
    assert.deepEqual(active(), ["film"]);
    ui.creations.push(item("new-creation", { category: "store" }));
    tree = ui.renderWithLayout();
    assert.deepEqual(
      active(),
      ["film"],
      "appending a trailing item cannot disable the retained first video",
    );
    ui.creations.pop();
    tree = ui.renderWithLayout();
    assert.deepEqual(
      active(),
      ["film"],
      "removing a trailing item also requests fresh measurements",
    );
    assert.deepEqual(ui.counts(), {
      requests: 0,
      refreshes: 0,
      preferenceWrites: 0,
    });
  }
});

test("an unchanged first image remains visible after filtering and Saved view changes", () => {
  const ui = profileScreenHarness();
  ui.creations[0] = item("game", {
    category: "games",
    content_type: "image/jpeg",
    media_url: null,
    cover: "/api/creator/media/photo",
  });
  let tree = ui.renderWithLayout();
  const image = () =>
    tree.find(
      (node) =>
        node.type === "ProfileMediaPreview" && node.props.item.id === "game",
    )!;
  assert.equal(image().props.visible, true);
  tree.find((node) => node.type === "CategoryDock")!.props.onSelect("games");
  tree = ui.renderWithLayout();
  assert.equal(image().props.visible, true);
  assert.equal(image().props.videoActive, false);
  tree
    .find((node) => node.props.accessibilityLabel === "Show saved creations")!
    .props.onPress();
  tree = ui.renderWithLayout();
  assert.equal(image().props.visible, true);
  assert.equal(image().props.videoActive, false);
  assert.deepEqual(ui.counts(), {
    requests: 0,
    refreshes: 0,
    preferenceWrites: 0,
  });
});

test("Profile stacks every published creation in one scrollable column and badges use each creation's own world", () => {
  for (const desktop of [false, true]) {
    const ui = profileScreenHarness(desktop);
    const nodes = ui.render();
    const feed = nodes.find(
      (node) => node.props.testID === "profile-creations-feed",
    )!;
    assert.equal(feed.props.style.flexDirection, undefined);
    assert.equal(feed.props.style.flexWrap, undefined);
    const cards = feed.props.children[0];
    assert.deepEqual(
      cards.map((card: any) => card.props.accessibilityLabel),
      [
        "Watch game · Games",
        "Watch film · Music & Film",
        "Watch song · Music & Film",
        "Watch art · NFTs",
        "Watch broadcast · Live feeds",
        "Watch product · Store",
      ],
    );
    assert.ok(cards.every((card: any) => card.props.style.width === "100%"));
    assert.deepEqual(
      nodes
        .filter((node) =>
          [
            "GamesIcon",
            "FilmIcon",
            "MusicIcon",
            "ArtIcon",
            "LiveIcon",
            "StoreIcon",
          ].includes(String(node.type)),
        )
        .map((node) => node.type),
      [
        "GamesIcon",
        "FilmIcon",
        "MusicIcon",
        "ArtIcon",
        "LiveIcon",
        "StoreIcon",
      ],
    );
    assert.equal(
      nodes.some((node) => node.props.accessibilityLabel?.includes("private")),
      false,
    );
    cards[0].props.onPress();
    assert.deepEqual(ui.navigations, [
      ["Watch", { itemId: "game", category: "games" }],
    ]);
    assert.deepEqual(ui.counts(), {
      requests: 0,
      refreshes: 0,
      preferenceWrites: 0,
    });
  }
});

test("Profile reset clears only category and Saved view, preserving scroll and stacked-card visibility", () => {
  const ui = profileScreenHarness();
  let nodes = ui.render();
  const scroll = () => nodes.find((node) => node.type === "ScrollView")!;
  const feed = () =>
    nodes.find((node) => node.props.testID === "profile-creations-feed")!;
  const reset = () =>
    nodes.find(
      (node) =>
        node.props.accessibilityLabel === "Reset Profile to all creations",
    )!;
  scroll().props.onLayout({ nativeEvent: { layout: { height: 300 } } });
  scroll().props.onScroll({ nativeEvent: { contentOffset: { y: 420 } } });
  feed().props.onLayout({ nativeEvent: { layout: { y: 0 } } });
  feed().props.children[0].forEach((card: any, n: number) =>
    card.props.onLayout({
      nativeEvent: { layout: { y: n * 200, height: 179 } },
    }),
  );
  nodes = ui.render();
  assert.deepEqual(
    nodes
      .filter(
        (node) => node.type === "ProfileMediaPreview" && node.props.videoActive,
      )
      .map((node) => node.props.item.id),
    ["song"],
  );
  nodes.find((node) => node.type === "CategoryDock")!.props.onSelect("games");
  nodes = ui.render();
  assert.deepEqual(
    nodes
      .filter((node) => node.type === "ProfileMediaPreview")
      .map((node) => node.props.item.id),
    ["game"],
  );
  nodes
    .find((node) => node.props.accessibilityLabel === "Show saved creations")!
    .props.onPress();
  nodes = ui.render();
  assert.ok(
    nodes.some((node) => node.props.accessibilityLabel === "Show creations"),
  );
  assert.equal(reset().props.style.minWidth, 44);
  assert.equal(reset().props.style.minHeight, 44);
  reset().props.onPress();
  nodes = ui.render();
  assert.equal(
    nodes.find((node) => node.type === "CategoryDock")!.props.selected,
    "all",
  );
  assert.ok(
    nodes.some(
      (node) => node.props.accessibilityLabel === "Show saved creations",
    ),
  );
  assert.deepEqual(
    nodes
      .filter((node) => node.type === "ProfileMediaPreview")
      .map((node) => node.props.item.id),
    ["game", "film", "song", "art", "broadcast", "product"],
  );
  assert.deepEqual(
    nodes
      .filter(
        (node) => node.type === "ProfileMediaPreview" && node.props.videoActive,
      )
      .map((node) => node.props.item.id),
    ["song"],
    "reset retains scroll offset rather than remounting or snapping the feed",
  );
  assert.equal(scroll().key, undefined);
  assert.deepEqual(ui.preferences, {
    saved: ["game"],
    autoplay: true,
    startMuted: false,
  });
  assert.deepEqual(ui.counts(), {
    requests: 0,
    refreshes: 0,
    preferenceWrites: 0,
  });
});
