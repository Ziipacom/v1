import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  galleryIndex,
  galleryItems,
  galleryRotationAllowed,
} from "../src/lib/gallery.ts";
import type { Item } from "../src/lib/types.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as gallery from "../src/lib/gallery.ts";
import * as domain from "../src/lib/domain.ts";
import { featuredGalleryPlayback } from "../src/lib/featured-gallery-playback.ts";

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
    color: {},
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
        useEffect() {},
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: unknown) => fn,
        useRef: (current: unknown) => ({ current }),
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
        AccessibilityInfo: {},
        AppState: { currentState: "active" },
        Platform: { OS: "android" },
        useWindowDimensions: () => ({ width: 390 }),
        StyleSheet: { create: (value: unknown) => value },
        Animated: { Value, View: "AnimatedView" },
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
          contentWidth: 1200,
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
