import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { audienceNumber } from "../src/lib/profile-collections.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function harness(desktop = false) {
  const states: unknown[] = [];
  let cursor = 0;
  const jsx = (type: string, props: Record<string, any>) => ({ type, props });
  const exported: Record<string, any> = {};
  const compiled = ts.transpileModule(
    readFileSync(
      new URL("../src/components/profile-audience.tsx", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react")
      return {
        useRef: () => ({
          current: { measureInWindow: (fn: Function) => fn(400, 100, 200, 30) },
        }),
        useState: (initial: unknown) => {
          const index = cursor++;
          if (!(index in states)) states[index] = initial;
          return [
            states[index],
            (value: unknown) => {
              states[index] = value;
            },
          ];
        },
      };
    if (name === "react-native")
      return {
        Modal: "Modal",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        useWindowDimensions: () => ({ width: 1280, height: 720 }),
      };
    if (name === "lucide-react-native")
      return { ChevronDown: "ChevronDown", Check: "Check" };
    if (name === "./floating") return { Sheet: "Sheet" };
    if (name === "./desktop-layout")
      return { useDesktopLayout: () => ({ desktop }) };
    if (name === "../lib/profile-collections") return { audienceNumber };
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    throw new Error(`Unexpected module: ${name}`);
  });
  return (profile?: unknown, onPeople = (..._args: unknown[]) => {}) => {
    cursor = 0;
    return exported.ProfileAudience({ profile, onPeople });
  };
}
function nodes(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const button = (tree: any, name: string) => {
  const found = nodes(tree).find(
    (node) => node.props?.accessibilityLabel === name,
  );
  assert.ok(found, `Missing button: ${name}`);
  return found;
};
const profile = {
  audience: { followers: 2, following: 0, updated_at: "2026-10-29T12:00:00Z" },
  network: {
    providers: [
      {
        provider: "bluesky",
        name: "Bluesky",
        status: "linked",
        audience: { followers: 1500, updated_at: "2026-10-28T09:00:00Z" },
      },
      {
        provider: "instagram",
        name: "Instagram",
        status: "connected",
        audience: null,
      },
      {
        provider: "youtube",
        name: "YouTube",
        status: "disconnected",
        audience: null,
      },
    ],
  },
};

test("audience defaults to real Ziipa counts, including zero, rather than a cross-network sum", () => {
  const render = harness();
  const tree = render(profile);
  button(tree, "Choose follower network · Ziipa");
  button(tree, "Ziipa followers: 2");
  button(tree, "Ziipa following: 0");
  assert.ok(
    nodes(tree).some((node) =>
      String(node.props?.children).startsWith("Updated "),
    ),
  );
  button(render(), "Ziipa followers: —");
});

for (const desktop of [false, true])
  test(`network selection uses ${desktop ? "a desktop dropdown" : "a mobile bottom sheet"} and preserves unavailable counts`, () => {
    const render = harness(desktop);
    button(render(profile), "Choose follower network · Ziipa").props.onPress();
    let tree = render(profile);
    assert.ok(
      nodes(tree).some((node) => node.type === (desktop ? "Modal" : "Sheet")),
    );
    assert.equal(
      nodes(tree).some(
        (node) =>
          node.props?.accessibilityLabel === "Show YouTube follower counts",
      ),
      false,
    );
    button(tree, "Show Bluesky follower counts").props.onPress();
    const visits: unknown[][] = [];
    tree = render(profile, (...args) => {
      visits.push(args);
    });
    button(tree, "Bluesky followers: 1.5K");
    button(tree, "Bluesky following: —").props.onPress();
    assert.deepEqual(visits, [["following", "bluesky"]]);
    button(tree, "Choose follower network · Bluesky").props.onPress();
    button(render(profile), "Show Instagram follower counts").props.onPress();
    tree = render(profile);
    button(tree, "Instagram followers: —");
    button(tree, "Instagram following: —");
  });
