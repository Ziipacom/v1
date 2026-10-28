import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Element = { type: unknown; props: Record<string, any> };

function categoryUI(limitedBeta: boolean, concepts = false) {
  const compiled = ts.transpileModule(
    readFileSync(new URL("../src/components/floating.tsx", import.meta.url), "utf8"),
    { compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    } },
  ).outputText;
  const jsx = (type: unknown, props: Element["props"]) => ({ type, props });
  const exported: Record<string, any> = {};
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native") return {
      Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView",
      Text: "Text", View: "View", StyleSheet: { absoluteFill: {} },
    };
    if (name === "react-native-safe-area-context") return {
      useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
    };
    if (name === "lucide-react-native") return new Proxy({}, { get: (_, key) => key });
    if (name === "../theme") return {
      color: { text: "white", onMedia: "white", onAccent: "white", bg: "black" },
      font: { regular: "Barlow", bold: "BarlowBold" }, styles: {},
      themedStyles: (fn: () => unknown) => fn(), useTheme() {},
    };
    if (name === "../lib/config") return {
      conceptsEnabled: concepts, iosLimitedTestflight: limitedBeta,
    };
    if (name === "./desktop-layout") return { useDesktopLayout: () => ({ desktop: false }) };
    throw new Error(`Unexpected category dependency: ${name}`);
  });
  return exported;
}

function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Element;
  return [node, ...nodes(node.props.children)];
}

test("limited iPhone beta keeps every category in the shared menu and bottom dock without enabling concepts", () => {
  const ui = categoryUI(true);
  assert.deepEqual(ui.worlds.map((world: any) => world.id), ["games", "live", "music", "nft", "store"]);
  assert.deepEqual(ui.worlds.filter((world: any) => world.concept).map((world: any) => world.id), ["live", "nft", "store"]);
  const selected: string[] = [];
  let inbox = 0;
  const rendered = ui.CategoryDock({ selected: "all", onSelect: (id: string) => selected.push(id), onInbox: () => inbox++ });
  const buttons = nodes(rendered).filter((node) => typeof node.props.label === "string");
  assert.deepEqual(buttons.map((node) => node.props.label), ["Games", "Live Feed", "Music & Film", "NFTs", "Store", "Inbox"]);
  for (const button of buttons) button.props.onPress();
  assert.deepEqual(selected, ["games", "live", "music", "nft", "store"]);
  assert.equal(inbox, 1);
  for (const id of ["games", "live", "music", "nft", "store", "inbox"]) {
    assert.ok(nodes(ui.WorldGlyph({ id })).every((node) => node.type !== undefined), `${id} has a real glyph`);
  }
});

test("ordinary release and concept-preview category policies remain unchanged", () => {
  assert.deepEqual(categoryUI(false).worlds.map((world: any) => world.id), ["games", "music"]);
  assert.deepEqual(categoryUI(false, true).worlds.map((world: any) => world.id), ["games", "live", "music", "nft", "store"]);
});
