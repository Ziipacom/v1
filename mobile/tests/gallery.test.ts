import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  galleryIndex,
  galleryItems,
  galleryNeighbors,
  galleryRotationAllowed,
} from "../src/lib/gallery.ts";
import type { Item } from "../src/lib/types.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as gallery from "../src/lib/gallery.ts";
import * as domain from "../src/lib/domain.ts";
import { featuredGalleryPlayback } from "../src/lib/featured-gallery-playback.ts";
import { palettes } from "../src/lib/appearance.ts";

const creation = (
  id: string,
  category: Item["category"] = "video",
  changes: Partial<Item> = {},
): Item => ({
  id,
  title: id,
  category,
  description: "",
  creator: "Creator",
  tags: [],
  city: "",
  cover: "/brand/ziipa-background.png",
  media_url: null,
  visibility: "published",
  demo: false,
  label: "Creation",
  ...changes,
});

test("All Gallery creations spans every world while explicit icon filters keep Music and Film together", () => {
  const source = [
    creation("game", "games"),
    creation("film"),
    creation("song", "music"),
    creation("art", "nft"),
    creation("live", "live"),
    creation("store", "store"),
    creation("private", "games", { visibility: "draft" }),
    creation("removed", "video", { visibility: "hidden" }),
  ];
  const before = JSON.stringify(source);
  assert.deepEqual(
    galleryItems(source, "all", "").map(({ id }) => id),
    ["game", "film", "song", "art", "live", "store"],
  );
  assert.deepEqual(
    galleryItems(source, "music", "").map(({ id }) => id),
    ["film", "song"],
  );
  assert.deepEqual(
    galleryItems(source, "games", "").map(({ id }) => id),
    ["game"],
  );
  assert.deepEqual(
    galleryItems(source, "all", "ART").map(({ id }) => id),
    ["art"],
  );
  assert.equal(JSON.stringify(source), before);
});

type Node = { type: unknown; key?: string; props: Record<string, any> };
/** Executes the real screen/component with inert native leaves; no network or player is created. */
function galleryUI(
  file: string,
  options: {
    desktop?: boolean;
    params?: Record<string, unknown>;
    items?: Item[];
    runEffects?: boolean;
    width?: number;
    appearance?: "dark" | "light";
  } = {},
) {
  const source = readFileSync(
    new URL(`../src/${file}.tsx`, import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const route = { params: options.params };
  const states: any[] = [];
  let cursor = 0;
  let refreshes = 0;
  let preferenceWrites = 0;
  const effects: (() => void)[] = [];
  const effectSlots: { cleanup?: () => void }[] = [];
  const preferences = { autoplay: true, startMuted: false };
  const navigations: unknown[] = [];
  const exports: Record<string, any> = {};
  const jsx = (type: unknown, props: Node["props"], key?: string) => ({
    type,
    props,
    key,
  });
  const navigation = {
    setParams: (params: Record<string, unknown>) => {
      route.params = { ...route.params, ...params };
    },
    navigate: (...args: unknown[]) => navigations.push(args),
  };
  class Value {
    constructor(_: unknown) {}
    stopAnimation() {}
    setValue(_: unknown) {}
  }
  const theme = {
    color: palettes[options.appearance || "dark"],
    font: {},
    styles: {},
    themeValue: (dark: unknown) => dark,
    themedStyles: (fn: () => unknown) => fn(),
    useTheme() {},
  };
  new Function("exports", "require", compiled)(exports, (name: string) => {
    if (name === "react")
      return {
        useState: (initial: unknown) => {
          const slot = cursor++;
          if (!(slot in states))
            states[slot] = typeof initial === "function" ? initial() : initial;
          return [
            states[slot],
            (value: any) => {
              states[slot] =
                typeof value === "function" ? value(states[slot]) : value;
            },
          ];
        },
        useEffect(effect: () => void | (() => void), deps: unknown[]) {
          if (!options.runEffects) return;
          const slot = cursor++;
          const previous = states[slot];
          if (
            !previous ||
            deps.some((value, n) => value !== previous.deps[n])
          ) {
            const next: { deps: unknown[]; cleanup?: () => void } = { deps };
            states[slot] = next;
            effectSlots.push(next);
            effects.push(() => {
              previous?.cleanup?.();
              const cleanup = effect();
              if (cleanup) next.cleanup = cleanup;
            });
          }
        },
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: unknown) => fn,
        useRef: (current: unknown) => {
          const slot = cursor++;
          return (states[slot] ||= { current });
        },
      };
    if (name === "react/jsx-runtime")
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "react-native")
      return {
        View: "View",
        Text: "Text",
        TextInput: "TextInput",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        ActivityIndicator: "ActivityIndicator",
        AccessibilityInfo: {
          isReduceMotionEnabled: () => Promise.resolve(false),
          addEventListener: () => ({ remove() {} }),
        },
        AppState: {
          currentState: "active",
          addEventListener: () => ({ remove() {} }),
        },
        Platform: { OS: "android" },
        useWindowDimensions: () => ({ width: options.width || 390 }),
        StyleSheet: { create: (value: unknown) => value },
        Animated: {
          Value,
          View: "AnimatedView",
          timing: () => ({ start() {}, stop() {} }),
        },
        PanResponder: { create: () => ({ panHandlers: {} }) },
      };
    if (name === "react-native-safe-area-context")
      return {
        SafeAreaView: "SafeAreaView",
        useSafeAreaInsets: () => ({ bottom: 0 }),
      };
    if (name === "@react-navigation/native")
      return { useIsFocused: () => true };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "expo-linear-gradient")
      return { LinearGradient: "LinearGradient" };
    if (name.endsWith("/desktop-layout"))
      return {
        useDesktopLayout: () => ({
          desktop: options.desktop ?? false,
          contentWidth: options.width || 1200,
        }),
      };
    if (name.endsWith("/device-preferences"))
      return {
        useDevicePreferences: () => ({
          ready: true,
          reducedMotion: false,
          preferences,
          update: () => preferenceWrites++,
        }),
      };
    if (name === "../provider")
      return {
        useZiipa: () => ({
          data: { items: options.items || [], preferences: { saved: [] } },
          guest: false,
          refresh: () => refreshes++,
          refreshing: false,
          loading: false,
          error: "",
        }),
      };
    if (name.endsWith("/floating"))
      return {
        CategoryDock: "CategoryDock",
        FloatButton: "FloatButton",
        floating: {},
        worlds: [
          { id: "games", title: "Games" },
          { id: "music", title: "Music & Film" },
        ],
      };
    if (name.endsWith("/ui"))
      return {
        Logo: "Logo",
        Cover: "Cover",
        Action: "Action",
        Notice: "Notice",
        categories: [
          { id: "video", title: "Videos" },
          { id: "games", title: "Games" },
          { id: "music", title: "Music & Film" },
          { id: "nft", title: "NFTs" },
        ],
      };
    if (name.endsWith("/gallery-slider"))
      return { GallerySlider: "GallerySlider" };
    if (name.endsWith("/desktop-featured-gallery"))
      return { DesktopFeaturedGallery: "DesktopFeaturedGallery" };
    if (name.endsWith("/account-menu")) return { AccountMenu: "AccountMenu" };
    if (name === "./desktop-explore")
      return { DesktopExplore: "DesktopExplore" };
    if (name === "./reel-media") return { ReelMedia: "ReelMedia" };
    if (name === "./profile-media-preview")
      return { ProfileMediaPreview: "ProfileMediaPreview" };
    if (name === "./gallery-still-preview")
      return { GalleryStillPreview: "GalleryStillPreview" };
    if (name === "../lib/gallery") return gallery;
    if (name === "../lib/domain") return domain;
    if (name === "../lib/featured-gallery-playback")
      return { featuredGalleryPlayback };
    if (name === "../theme") return theme;
    throw new Error(`Unexpected gallery dependency ${name}`);
  });
  function nodes(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    return [value, ...nodes(value.props.children)];
  }
  return {
    route,
    navigation,
    navigations,
    preferences,
    counts: () => ({ refreshes, preferenceWrites }),
    flushEffects() {
      while (effects.length) effects.shift()!();
    },
    unmount() {
      effectSlots.reverse().forEach((slot) => slot.cleanup?.());
    },
    render(name: string, props: Record<string, unknown> = {}) {
      cursor = 0;
      let tree = exports[name]({ route, navigation, ...props });
      // DiscoverScreen chooses its private MobileDiscoverScreen; leaves remain inert.
      if (typeof tree?.type === "function") tree = tree.type(tree.props);
      return nodes(tree);
    },
  };
}

test("Gallery defaults to All; icons filter explicitly; reset clears route/search and permits the same category again", () => {
  const source = [
    creation("game", "games"),
    creation("film"),
    creation("private", "games", { visibility: "draft" }),
  ];
  const ui = galleryUI("screens/discovery", { items: source });
  const render = () => ui.render("DiscoverScreen");
  const slider = (nodes: Node[]) =>
    nodes.find((node) => node.type === "GallerySlider")!;
  let nodes = render();
  assert.deepEqual(
    slider(nodes).props.items.map((item: Item) => item.id),
    ["game", "film"],
  );
  assert.equal(
    nodes.find((node) => node.type === "CategoryDock")!.props.selected,
    "all",
  );
  nodes.find((node) => node.type === "CategoryDock")!.props.onSelect("games");
  nodes = render();
  assert.deepEqual(
    slider(nodes).props.items.map((item: Item) => item.id),
    ["game"],
  );
  slider(nodes).props.onOpen(source[0]);
  assert.deepEqual(ui.navigations, [
    ["Watch", { itemId: "game", category: "games" }],
  ]);
  nodes
    .find((node) => node.type === "TextInput")!
    .props.onChangeText("missing");
  nodes = render();
  assert.equal(
    nodes.some((node) => node.type === "GallerySlider"),
    false,
  );
  nodes
    .find(
      (node) =>
        node.props.accessibilityLabel ===
        "Reset gallery to all creations and clear search",
    )!
    .props.onPress();
  nodes = render();
  assert.equal(ui.route.params?.category, undefined);
  assert.equal(ui.route.params?.query, undefined);
  assert.equal(
    nodes.find((node) => node.type === "TextInput")!.props.value,
    "",
  );
  assert.equal(
    nodes.find((node) => node.type === "CategoryDock")!.props.selected,
    "all",
  );
  assert.equal(slider(nodes).props.startMuted, true);
  assert.deepEqual(
    slider(nodes).props.items.map((item: Item) => item.id),
    ["game", "film"],
  );
  const firstResetKey = slider(nodes).key;
  nodes
    .find(
      (node) =>
        node.props.accessibilityLabel ===
        "Reset gallery to all creations and clear search",
    )!
    .props.onPress();
  assert.notEqual(
    slider(render()).key,
    firstResetKey,
    "reset restarts the first slide even when already unfiltered",
  );
  ui.navigation.setParams({ category: "games" });
  assert.deepEqual(
    slider(render()).props.items.map((item: Item) => item.id),
    ["game"],
  );
  assert.deepEqual(ui.counts(), { refreshes: 0, preferenceWrites: 0 });
  assert.deepEqual(ui.preferences, { autoplay: true, startMuted: false });
});

test("Desktop carousel includes every published creation including images beyond the eighth item; reset clears only local filters", () => {
  const source = Array.from({ length: 11 }, (_, n) =>
    creation(`creation-${n}`, n % 2 ? "games" : "video", {
      content_type: n === 10 ? "image/jpeg" : "video/mp4",
    }),
  );
  source.push(
    creation("private", "games", { visibility: "draft" }),
    creation("removed", "video", { visibility: "hidden" }),
  );
  const ui = galleryUI("screens/desktop-explore", {
    desktop: true,
    items: source,
  });
  let nodes = ui.render("DesktopExplore");
  assert.equal(
    nodes.find((node) => node.type === "DesktopFeaturedGallery")!.props.items
      .length,
    11,
  );
  ui.navigation.setParams({
    category: "games",
    collection: "saved",
    query: "missing",
  });
  nodes = ui.render("DesktopExplore");
  nodes
    .find(
      (node) =>
        node.props.accessibilityLabel ===
        "Reset gallery to all creations and clear search",
    )!
    .props.onPress();
  nodes = ui.render("DesktopExplore");
  assert.equal(
    nodes.find((node) => node.type === "DesktopFeaturedGallery")!.props.items
      .length,
    11,
  );
  assert.equal(
    nodes.find((node) => node.type === "DesktopFeaturedGallery")!.props
      .startMuted,
    true,
  );
  assert.deepEqual(ui.route.params, {
    category: undefined,
    collection: undefined,
    query: undefined,
  });
  assert.deepEqual(ui.counts(), { refreshes: 0, preferenceWrites: 0 });
});

test("Both Gallery layouts render image previews without creating video/audio players", () => {
  const photo = creation("photo", "nft", {
    content_type: "image/jpeg",
    cover: "/api/creator/media/photo",
  });
  for (const [file, name] of [
    ["components/gallery-slider", "GallerySlider"],
    ["components/desktop-featured-gallery", "DesktopFeaturedGallery"],
  ]) {
    const ui = galleryUI(file);
    const nodes = ui.render(name, {
      items: [photo],
      label: "All creations",
      onOpen() {},
      open() {},
    });
    assert.equal(
      nodes.filter((node) => node.type === "ProfileMediaPreview").length,
      1,
    );
    assert.equal(
      nodes.some((node) => node.type === "ReelMedia"),
      false,
    );
    assert.equal(
      nodes.find((node) => node.type === "ProfileMediaPreview")!.props
        .videoActive,
      false,
    );
    assert.equal(
      nodes.find((node) => node.type === "ProfileMediaPreview")!.props.autoplay,
      false,
      "motion remains paused until OS preferences resolve",
    );
  }
});

test("Reset's local mute override reaches the only active Gallery player and large desktop galleries retain navigation without unbounded dots", () => {
  const items = Array.from({ length: 11 }, (_, n) =>
    creation(`video-${n}`, "games", {
      media_url: "/media/sintel-trailer.mp4",
      content_type: "video/mp4",
    }),
  );
  for (const [file, name] of [
    ["components/gallery-slider", "GallerySlider"],
    ["components/desktop-featured-gallery", "DesktopFeaturedGallery"],
  ]) {
    const ui = galleryUI(file);
    const nodes = ui.render(name, {
      items,
      label: "All creations",
      startMuted: true,
      onOpen() {},
      open() {},
    });
    assert.equal(nodes.filter((node) => node.type === "ReelMedia").length, 1);
    assert.equal(
      nodes.find((node) => node.type === "ReelMedia")!.props.muted,
      true,
    );
    assert.equal(ui.preferences.startMuted, false);
    if (name === "DesktopFeaturedGallery") {
      assert.equal(
        nodes.some((node) =>
          node.props.accessibilityLabel?.startsWith("Show featured creation"),
        ),
        false,
      );
      assert.ok(
        nodes.some((node) => node.props.label === "Next featured creation"),
      );
    }
  }
});

test("Gallery excludes drafts and hidden entries without mutating the server selection", () => {
  const base = {
    title: "Film",
    description: "",
    creator: "Creator",
    tags: [],
    category: "video",
  } as unknown as Item;
  const source = [
    { ...base, id: "published", visibility: "published" },
    { ...base, id: "private", visibility: "draft" },
    { ...base, id: "removed", visibility: "hidden" },
    { ...base, id: "preview", demo: true },
  ] as Item[];
  assert.deepEqual(
    galleryItems(source, "music", "Film").map((item) => item.id),
    ["published", "preview"],
  );
  assert.deepEqual(
    source.map((item) => item.id),
    ["published", "private", "removed", "preview"],
  );
  assert.deepEqual(galleryItems(source, "games", ""), []);
});

test("Gallery wraps manual and timed navigation safely", () => {
  assert.equal(galleryIndex(-1, 3), 2);
  assert.equal(galleryIndex(3, 3), 0);
  assert.equal(galleryIndex(8, 1), 0);
  assert.equal(galleryIndex(4, 0), 0);
});

test("Three Gallery slots never repeat a creation just to fill empty space", () => {
  const a = creation("a"),
    b = creation("b"),
    c = creation("c"),
    d = creation("d");
  assert.deepEqual(galleryNeighbors([], 0), { left: null, right: null });
  assert.deepEqual(galleryNeighbors([a], 0), { left: null, right: null });
  assert.deepEqual(galleryNeighbors([a, b], 0), { left: null, right: b });
  assert.deepEqual(galleryNeighbors([a, b], 1), { left: null, right: a });
  assert.deepEqual(galleryNeighbors([a, b, c, d], 0), { left: d, right: b });
  assert.deepEqual(galleryNeighbors([a, b, c, d], 3), { left: c, right: a });
  assert.deepEqual(galleryNeighbors([a, b, c, d], -1), { left: c, right: a });
});

test("Gallery keeps three stacked slots while selecting a side card promotes that real asset to the only playing front", () => {
  const source = [
    creation("first", "games", {
      media_url: "/media/sintel-trailer.mp4",
      content_type: "video/mp4",
    }),
    creation("second", "video", {
      media_url: "/media/sintel-trailer.mp4",
      content_type: "video/mp4",
    }),
    creation("third", "nft", { content_type: "image/jpeg" }),
  ];
  for (const count of [1, 2, 3]) {
    const ui = galleryUI("components/gallery-slider");
    const props = {
      items: source.slice(0, count),
      label: "All creations",
      onOpen() {},
    };
    let nodes = ui.render("GallerySlider", props);
    assert.equal(
      nodes.filter((node) => node.props.testID?.startsWith("gallery-neighbor-"))
        .length,
      2,
    );
    assert.equal(nodes.filter((node) => node.type === "ReelMedia").length, 1);
    assert.equal(
      nodes.filter((node) => node.type === "GalleryStillPreview").length,
      count === 1 ? 0 : count === 2 ? 1 : 2,
    );
    if (count < 3)
      assert.ok(
        nodes.some(
          (node) => node.props.testID === "gallery-neighbor-left-empty",
        ),
      );
    if (count === 1)
      assert.ok(
        nodes.some(
          (node) => node.props.testID === "gallery-neighbor-right-empty",
        ),
      );
    if (count > 1) {
      const next = nodes.find(
        (node) => node.props.testID === "gallery-neighbor-right",
      )!;
      assert.equal(next.props.accessibilityRole, "button");
      next.props.onPress();
      nodes = ui.render("GallerySlider", props);
      assert.equal(
        nodes.find((node) => node.type === "ReelMedia")!.props.item.id,
        "second",
      );
      assert.equal(nodes.filter((node) => node.type === "ReelMedia").length, 1);
      assert.ok(
        nodes
          .filter((node) => node.type === "GalleryStillPreview")
          .every((node) => node.props.item.id !== "second"),
      );
    }
  }
});

test("Wide desktop Gallery keeps the three-slot stack without replacing its hero copy or mounting side playback", () => {
  const source = [
    creation("first", "games", {
      media_url: "/media/sintel-trailer.mp4",
      content_type: "video/mp4",
    }),
    creation("second", "video", {
      media_url: "/media/sintel-trailer.mp4",
      content_type: "video/mp4",
    }),
    creation("third", "music"),
  ];
  for (const count of [1, 2, 3]) {
    const ui = galleryUI("components/desktop-featured-gallery", {
      desktop: true,
    });
    const props = { items: source.slice(0, count), open() {} };
    let nodes = ui.render("DesktopFeaturedGallery", props);
    assert.equal(
      nodes.filter((node) =>
        node.props.testID?.startsWith("desktop-gallery-neighbor-"),
      ).length,
      2,
    );
    assert.equal(
      nodes.filter((node) => node.type === "GalleryStillPreview").length,
      count === 1 ? 0 : count === 2 ? 1 : 2,
    );
    assert.equal(nodes.filter((node) => node.type === "ReelMedia").length, 1);
    assert.ok(
      nodes.some(
        (node) => node.props.testID === "desktop-gallery-front-creation",
      ),
    );
    assert.ok(
      nodes.some(
        (node) =>
          node.type === "Action" && node.props.title === "Watch creation",
      ),
    );
    if (count < 3)
      assert.ok(
        nodes.some(
          (node) => node.props.testID === "desktop-gallery-neighbor-left-empty",
        ),
      );
    if (count > 1) {
      nodes
        .find((node) => node.props.testID === "desktop-gallery-neighbor-right")!
        .props.onPress();
      nodes = ui.render("DesktopFeaturedGallery", props);
      assert.equal(
        nodes.find((node) => node.type === "ReelMedia")!.props.item.id,
        "second",
      );
      assert.ok(
        nodes
          .filter((node) => node.type === "GalleryStillPreview")
          .every((node) => node.props.item.id !== "second"),
      );
    }
  }
});

test("Front Gallery silhouettes stay opaque above neighboring images in narrow/wide layouts and both themes", () => {
  const source = [
    creation("transparent-front", "nft", { content_type: "image/png" }),
    creation("real-neighbor", "nft", {
      content_type: "image/jpeg",
      cover: "/api/creator/media/photo",
    }),
  ];
  for (const width of [377, 1280])
    for (const appearance of ["dark", "light"] as const) {
      for (const [file, name, prefix] of [
        ["components/gallery-slider", "GallerySlider", "gallery"],
        [
          "components/desktop-featured-gallery",
          "DesktopFeaturedGallery",
          "desktop-gallery",
        ],
      ]) {
        const ui = galleryUI(file, { width, appearance });
        const nodes = ui.render(name, {
          items: source,
          label: "All creations",
          onOpen() {},
          open() {},
        });
        const front = nodes.find(
          (node) => node.props.testID === `${prefix}-front-creation`,
        )!;
        const side = nodes.find(
          (node) => node.props.testID === `${prefix}-neighbor-right`,
        )!;
        const surface = Array.isArray(front.props.style)
          ? Object.assign({}, ...front.props.style)
          : front.props.style;
        assert.match(
          surface.backgroundColor,
          /^#[\da-f]{6}$/i,
          "front has an opaque own surface even before its image loads or where image pixels are transparent",
        );
        assert.equal(surface.overflow, "hidden");
        assert.ok(surface.zIndex > side.props.style.zIndex);
        assert.equal(
          nodes.filter((node) => node.type === "GalleryStillPreview").length,
          1,
        );
      }
    }
});

test("Desktop viewport observer suspends all media and rotation offscreen and cleans up on unmount", async () => {
  const names = [
    "window",
    "document",
    "navigator",
    "IntersectionObserver",
    "setTimeout",
    "clearTimeout",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  let intersect:
    | ((
        entries: { isIntersecting: boolean; intersectionRatio: number }[],
      ) => void)
    | undefined;
  let observed: unknown,
    disconnected = 0,
    timerId = 0;
  const pending = new Set<number>();
  const element = {
    getBoundingClientRect: () => ({
      top: 0,
      bottom: 400,
      left: 0,
      right: 1000,
      width: 1000,
      height: 400,
    }),
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false;
    },
  };
  const replace = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  replace("window", {
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
  });
  replace("document", {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  });
  replace("navigator", {});
  replace(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe(node: unknown) {
        observed = node;
      }
      disconnect() {
        disconnected++;
      }
    },
  );
  replace("setTimeout", () => {
    const id = ++timerId;
    pending.add(id);
    return id;
  });
  replace("clearTimeout", (id: number) => pending.delete(id));
  try {
    const ui = galleryUI("components/desktop-featured-gallery", {
      desktop: true,
      runEffects: true,
    });
    const props = {
      items: [
        creation("first", "video", {
          media_url: "/media/sintel-trailer.mp4",
          content_type: "video/mp4",
        }),
        creation("next", "video", {
          media_url: "/media/sintel-trailer.mp4",
          content_type: "video/mp4",
        }),
      ],
      open() {},
    };
    let nodes = ui.render("DesktopFeaturedGallery", props);
    nodes.find(
      (node) =>
        node.props.accessibilityLabel === "Featured published media gallery",
    )!.props.ref.current = element;
    ui.flushEffects();
    await Promise.resolve();
    assert.equal(observed, element);
    assert.equal(
      nodes.find((node) => node.type === "ReelMedia")!.props.active,
      false,
      "no player is active before viewport measurement",
    );
    intersect!([{ isIntersecting: true, intersectionRatio: 0.49 }]);
    nodes = ui.render("DesktopFeaturedGallery", props);
    ui.flushEffects();
    assert.equal(
      nodes.find((node) => node.type === "GalleryStillPreview")!.props.enabled,
      false,
    );
    assert.equal(pending.size, 0);
    intersect!([{ isIntersecting: true, intersectionRatio: 0.5 }]);
    nodes = ui.render("DesktopFeaturedGallery", props);
    ui.flushEffects();
    assert.equal(
      nodes.find((node) => node.type === "GalleryStillPreview")!.props.enabled,
      true,
    );
    assert.equal(
      nodes.find((node) => node.type === "ReelMedia")!.props.active,
      true,
    );
    assert.equal(
      nodes.find((node) => node.type === "ReelMedia")!.props.paused,
      false,
    );
    assert.equal(pending.size, 1);
    intersect!([{ isIntersecting: false, intersectionRatio: 0 }]);
    nodes = ui.render("DesktopFeaturedGallery", props);
    ui.flushEffects();
    assert.equal(
      nodes.find((node) => node.type === "GalleryStillPreview")!.props.enabled,
      false,
    );
    assert.equal(
      nodes.find((node) => node.type === "ReelMedia")!.props.active,
      false,
    );
    assert.equal(
      nodes.find((node) => node.type === "ReelMedia")!.props.paused,
      true,
    );
    assert.equal(pending.size, 0, "the previous rotation timer is cancelled");
    ui.unmount();
    assert.equal(disconnected, 1);
    assert.equal(pending.size, 0);
  } finally {
    for (const name of names) {
      if (previous[name])
        Object.defineProperty(globalThis, name, previous[name]!);
      else delete (globalThis as any)[name];
    }
  }
});

test("Gallery rotation pauses for focus, visibility, user interaction and reduced motion", () => {
  const ready = {
    count: 3,
    enabled: true,
    focused: true,
    foreground: true,
    visible: true,
    hovering: false,
    controlFocused: false,
    reducedMotion: false,
  };
  assert.equal(galleryRotationAllowed(ready), true);
  for (const key of ["enabled", "focused", "foreground", "visible"] as const)
    assert.equal(
      galleryRotationAllowed({ ...ready, [key]: false }),
      false,
      key,
    );
  for (const key of ["hovering", "controlFocused", "reducedMotion"] as const)
    assert.equal(galleryRotationAllowed({ ...ready, [key]: true }), false, key);
  assert.equal(galleryRotationAllowed({ ...ready, count: 1 }), false);
  assert.equal(galleryRotationAllowed({ ...ready, count: 0 }), false);
});
