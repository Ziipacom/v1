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

type Node = { type: any; props: Record<string, any> };
function previewHarness(
  options: {
    platform?: string;
    portal?: boolean;
    time?: number;
    status?: string;
    autoplay?: boolean;
    failed?: boolean;
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
  const handler = new Function(
    "setCardLayouts",
    "layoutIdentity",
    "layoutKey",
    "item",
    `${compiled};return handler;`,
  )(
    (callback: (state: unknown) => unknown) => pending.push(callback),
    { current: "all" },
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
});
