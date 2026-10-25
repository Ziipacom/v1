import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Node = { type: any; props: Record<string, any> };
const source = readFileSync(
  new URL("../src/screens/desktop-explore.tsx", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

function fixture(observerSupported = true) {
  const published = ["first", "second"].map((id) => ({
    id,
    title: id,
    creator: "Creator",
    category: "video",
    tags: [],
    demo: false,
    visibility: "published",
    cover: "/brand/ziipa-background.png",
    content_type: "video/mp4",
    media_url: `/api/creator/media/${id}`,
  }));
  const jsx = (type: any, props: Node["props"]) => ({ type, props });
  const states = new Map<any, any[]>();
  let values: any[] = [],
    cursor = 0;
  let activity = true;
  let effects: (() => any)[] = [];
  let intersection: (entries: any[]) => void = () => {};
  let disconnected = false;
  let bounds = {
    top: 1000,
    bottom: 1200,
    left: 0,
    right: 300,
    height: 200,
    width: 300,
  };
  const element = { getBoundingClientRect: () => bounds };
  const listeners = new Map<string, () => void>();
  const exported: Record<string, any> = {};
  const Observer = observerSupported
    ? class {
        constructor(callback: (entries: any[]) => void) {
          intersection = callback;
        }
        observe(node: unknown) {
          assert.equal(node, element);
        }
        disconnect() {
          disconnected = true;
        }
      }
    : undefined;
  const browser = {
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener(name: string, fn: () => void) {
      listeners.set(name, fn);
    },
    removeEventListener(name: string, fn: () => void) {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
  new Function(
    "exports",
    "require",
    "IntersectionObserver",
    "window",
    compiled,
  )(
    exported,
    (name: string) => {
      if (name === "react")
        return {
          useMemo: (fn: () => unknown) => fn(),
          useEffect: (fn: () => any) => effects.push(fn),
          useRef: () => {
            const slot = cursor++;
            return (values[slot] ||= { current: element });
          },
          useState: (initial: unknown) => {
            const slot = cursor++,
              stored = values;
            if (!(slot in stored)) stored[slot] = initial;
            return [
              stored[slot],
              (next: any) => {
                stored[slot] =
                  typeof next === "function" ? next(stored[slot]) : next;
              },
            ];
          },
        };
      if (name === "react/jsx-runtime")
        return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "react-native")
        return {
          ActivityIndicator: "ActivityIndicator",
          Pressable: "Pressable",
          ScrollView: "ScrollView",
          Text: "Text",
          TextInput: "TextInput",
          View: "View",
          StyleSheet: { create: (value: any) => value, absoluteFill: {} },
        };
      if (name === "expo-linear-gradient")
        return { LinearGradient: "LinearGradient" };
      if (name === "lucide-react-native")
        return new Proxy({}, { get: (_, key) => String(key) });
      if (name === "../components/desktop-layout")
        return { useDesktopLayout: () => ({ contentWidth: 1400 }) };
      if (name === "../components/desktop-featured-gallery")
        return { DesktopFeaturedGallery: "DesktopFeaturedGallery" };
      if (name === "../components/gallery-still-preview")
        return { GalleryStillPreview: "GalleryStillPreview" };
      if (name === "../components/profile-media-preview")
        return { useProfilePreviewActivity: () => ({ mountVideo: activity }) };
      if (name === "../components/ui")
        return { Action: "Action", Notice: "Notice", categories: [] };
      if (name === "../lib/domain")
        return {
          searchItems: (items: any[]) => items,
          inCreativeWorld: () => true,
        };
      if (name === "../provider")
        return {
          useZiipa: () => ({
            data: { items: published, preferences: { saved: [] } },
            loading: false,
            refreshing: false,
          }),
        };
      if (name === "../theme")
        return {
          themedStyles: (fn: () => unknown) => fn(),
          themeValue: (value: unknown) => value,
          color: {},
          font: {},
          styles: {},
        };
      throw new Error(`Unexpected import ${name}`);
    },
    Observer,
    browser,
  );
  function flatten(node: any): Node[] {
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (!node || typeof node !== "object" || !node.props) return [];
    return [node, ...flatten(node.props.children)];
  }
  function render(component: any, props: any) {
    values = states.get(component) || [];
    states.set(component, values);
    cursor = 0;
    effects = [];
    return flatten(component(props));
  }
  const root = () =>
    render(exported.DesktopExplore, { route: { params: {} }, navigation: {} });
  return {
    root,
    render,
    flush: () => effects.map((fn) => fn()).filter(Boolean),
    visible: (value: boolean) =>
      intersection([
        { isIntersecting: value, intersectionRatio: value ? 1 : 0 },
      ]),
    disable: () => {
      activity = false;
    },
    disconnected: () => disconnected,
    scrollIntoView: () => {
      bounds = { ...bounds, top: 20, bottom: 220 };
      listeners.get("scroll")?.();
    },
    listeners,
  };
}

test("desktop All creations cards use shared still previews, not another active player", () => {
  const ui = fixture();
  const nodes = ui.root();
  assert.equal(
    nodes.filter((node) => node.type === "DesktopFeaturedGallery").length,
    1,
  );
  const cards = nodes.filter(
    (node) => typeof node.type === "function" && node.props.item,
  );
  assert.deepEqual(
    cards.map((node) => node.props.item.id),
    ["first", "second"],
  );
  const card = cards[0];
  let preview = ui
    .render(card.type, card.props)
    .find((node) => node.type === "GalleryStillPreview")!;
  assert.equal(
    preview.props.enabled,
    false,
    "offscreen cards must not decode media",
  );
  const cleanup = ui.flush()[0];
  ui.visible(true);
  preview = ui
    .render(card.type, card.props)
    .find((node) => node.type === "GalleryStillPreview")!;
  assert.equal(preview.props.enabled, true);
  assert.equal(preview.props.item, card.props.item);
  ui.visible(false);
  assert.equal(
    ui
      .render(card.type, card.props)
      .find((node) => node.type === "GalleryStillPreview")!.props.enabled,
    false,
  );
  ui.visible(true);
  ui.disable();
  const inactive = ui.root().find((node) => node.type === card.type)!;
  preview = ui
    .render(inactive.type, inactive.props)
    .find((node) => node.type === "GalleryStillPreview")!;
  assert.equal(
    preview.props.enabled,
    false,
    "route/background/data-saving policy must still suspend decoding",
  );
  cleanup();
  assert.equal(ui.disconnected(), true);
});

test("desktop still visibility fallback follows ScrollView scrolling and cleans up", () => {
  const ui = fixture(false);
  const card = ui
    .root()
    .find((node) => typeof node.type === "function" && node.props.item)!;
  ui.render(card.type, card.props);
  const cleanup = ui.flush()[0];
  assert.equal(
    ui
      .render(card.type, card.props)
      .find((node) => node.type === "GalleryStillPreview")!.props.enabled,
    false,
  );
  ui.scrollIntoView();
  assert.equal(
    ui
      .render(card.type, card.props)
      .find((node) => node.type === "GalleryStillPreview")!.props.enabled,
    true,
  );
  cleanup();
  assert.equal(ui.listeners.size, 0);
});
