import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { profilePreviewRange } from "../src/lib/profile-preview.ts";
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
  options: { platform?: string; portal?: boolean; status?: string } = {},
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
  const hooks: any[] = [];
  const effects: (() => void | (() => void))[] = [];
  const cleanups: (() => void)[] = [];
  const events = new Map<string, (event: any) => void>();
  let cursor = 0,
    instances = 0,
    plays = 0,
    pauses = 0,
    releases = 0;
  const player: Record<string, any> = {
    duration: 20,
    status: options.status || "readyToPlay",
    currentTime: 0,
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
          if (!(slot in hooks))
            hooks[slot] = typeof initial === "function" ? initial() : initial;
          return [
            hooks[slot],
            (next: any) =>
              (hooks[slot] =
                typeof next === "function" ? next(hooks[slot]) : next),
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
          if (!hooks[slot] || deps.some((dep, n) => dep !== hooks[slot][n])) {
            hooks[slot] = deps;
            effects.push(effect);
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
    if (name === "expo-asset")
      return { Asset: { fromModule: () => ({ uri: "/media/poster.jpg" }) } };
    if (name === "expo") return { useEvent: () => ({ status: player.status }) };
    if (name === "expo-video")
      return {
        VideoView: "VideoView",
        useVideoPlayer: (_: unknown, setup: (player: unknown) => void) => {
          instances++;
          setup(player);
          effects.push(() => () => {
            releases++;
          });
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
                uri: path,
                headers: { Authorization: "Bearer fixture" },
                useCaching: false,
              }
            : null,
      };
    if (name === "../lib/config")
      return { portalMode: options.portal ?? false };
    if (name === "../lib/profile-preview") return { profilePreviewRange };
    if (name === "../provider")
      return { useZiipa: () => ({ session: { access_token: "fixture" } }) };
    if (name === "../theme") return { font: {} };
    throw new Error(`Unexpected still dependency ${name}`);
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
    events,
    render(props: Record<string, unknown> = {}) {
      cursor = 0;
      return nodes(
        render(
          exports.GalleryStillPreview({
            item: item(),
            enabled: true,
            ...props,
          }),
        ),
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

test("Side video loads only a retained muted still, never plays, and releases its decoder", () => {
  const ui = stillUI();
  const nodes = ui.render();
  ui.flush();
  assert.equal(ui.counts().instances, 1);
  assert.equal(ui.counts().plays, 0);
  assert.equal(ui.player.currentTime, 5.05);
  assert.equal(ui.player.muted, true);
  assert.equal(ui.player.volume, 0);
  assert.equal(ui.player.staysActiveInBackground, false);
  assert.equal(ui.player.showNowPlayingNotification, false);
  assert.equal(ui.player.bufferOptions.maxBufferBytes, 1024 * 1024);
  assert.equal(ui.player.bufferOptions.preferredForwardBufferDuration, 0.5);
  const video = nodes.find((node) => node.type === "VideoView")!;
  assert.equal(video.props.nativeControls, false);
  assert.equal(video.props.allowsPictureInPicture, false);
  assert.equal(video.props.surfaceType, "textureView");
  const paused = ui.counts().pauses;
  ui.events.get("playingChange")!({ isPlaying: true });
  assert.equal(ui.counts().pauses, paused + 1);
  ui.unmount();
  assert.equal(ui.counts().releases, 1);
  assert.equal(ui.events.size, 0);
  assert.equal(ui.counts().plays, 0);
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
  const portal = stillUI({ platform: "web", portal: true });
  portal.render();
  portal.flush();
  assert.equal(portal.counts().instances, 1);
  assert.equal(portal.counts().plays, 0);
  portal.unmount();
});

test("Web side video uses explicit container dimensions while native inset sizing stays unchanged", () => {
  const web = stillUI({ platform: "web", portal: true });
  const webNodes = web.render();
  const webVideo = webNodes.find((node) => node.type === "VideoView")!;
  const webStyle = Object.assign({}, ...webVideo.props.style);
  assert.equal(webStyle.width, "100%");
  assert.equal(webStyle.height, "100%");
  assert.equal(webVideo.props.style[0], webNodes[0].props.style);
  web.flush();
  assert.equal(web.counts().plays, 0);
  web.unmount();

  const native = stillUI();
  const nativeNodes = native.render();
  const nativeVideo = nativeNodes.find((node) => node.type === "VideoView")!;
  assert.equal(nativeVideo.props.style, nativeNodes[0].props.style);
  assert.equal(Array.isArray(nativeVideo.props.style), false);
  assert.equal(nativeVideo.props.style.width, undefined);
  assert.equal(nativeVideo.props.style.height, undefined);
  native.flush();
  assert.equal(native.counts().plays, 0);
  native.unmount();
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

test("Invalid retained ranges and decoder errors stop at an honest still-unavailable state", () => {
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
    assert.ok(
      nodes.some((node) => node.props.children === "Still preview unavailable"),
    );
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
