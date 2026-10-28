import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Insets = { top: number; bottom: number; left: number; right: number };
type Node = { type: unknown; props: Record<string, any> };

function frameUI(beta: boolean, initialInsets: Insets) {
  const compiled = ts.transpileModule(
    readFileSync(
      new URL("../src/components/app-frame.tsx", import.meta.url),
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
  let insets = initialInsets;
  const viewport = { x: 0, y: 0, width: 393, height: 852 };
  const memo: any[] = [];
  let cursor = 0;
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  new Function("exports", "require", compiled)(exports, (name: string) => {
    if (name === "react")
      return {
        useMemo(fn: () => unknown, deps: unknown[]) {
          const slot = cursor++;
          if (!memo[slot] || deps.some((dep, i) => dep !== memo[slot].deps[i]))
            memo[slot] = { deps, value: fn() };
          return memo[slot].value;
        },
      };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native") return { View: "View" };
    if (name === "react-native-safe-area-context")
      return {
        SafeAreaProvider: "NativeSafeAreaProvider",
        useSafeAreaInsets: () => insets,
        useSafeAreaFrame: () => viewport,
      };
    if (name === "../lib/config") return { iosLimitedTestflight: beta };
    if (name === "../theme")
      return {
        color: { panel: "#211C2C" },
        useTheme() {},
      };
    throw new Error(`Unexpected AppFrame dependency ${name}`);
  });
  return {
    render(notice: unknown, navigation: unknown): Node {
      cursor = 0;
      return exports.AppFrame({ notice, children: navigation });
    },
    updateInsets(next: Insets) {
      insets = next;
    },
  };
}

test("iPhone notice consumes the notch once while native navigation retains bottom and side protection", () => {
  const insets = { top: 59, bottom: 34, left: 7, right: 11 };
  const ui = frameUI(true, insets);
  const navigation = { type: "Navigation", props: {} };
  const frame = ui.render("Beta notice", navigation);
  const [notice, content] = frame.props.children as Node[];
  assert.equal(notice.props.children, "Beta notice");
  assert.equal(notice.props.style.paddingTop, 59);
  assert.equal(notice.props.style.paddingLeft, 7);
  assert.equal(notice.props.style.paddingRight, 11);
  assert.equal(content.type, "NativeSafeAreaProvider");
  assert.deepEqual(content.props.initialMetrics.insets, {
    top: 0,
    bottom: 34,
    left: 7,
    right: 11,
  });
  assert.equal(
    notice.props.style.paddingTop + content.props.initialMetrics.insets.top,
    59,
  );
  assert.equal(content.props.children, navigation);
  assert.deepEqual(insets, { top: 59, bottom: 34, left: 7, right: 11 });
});

test("a banner refresh preserves the native provider and navigation instead of resetting a private draft", () => {
  const ui = frameUI(true, { top: 59, bottom: 34, left: 0, right: 0 });
  const navigation = { type: "Navigation", props: { draft: "unsaved-edit" } };
  const first = ui.render("Beta notice", navigation).props.children[1] as Node;
  const next = ui.render("Beta notice\nOperator update", navigation).props
    .children[1] as Node;
  assert.equal(next.type, first.type);
  assert.equal(next.props.children, first.props.children);
  assert.equal(next.props.initialMetrics, first.props.initialMetrics);
  assert.equal(next.props.key, first.props.key);
});

test("rotation recomputes the notice padding and leaves native measurements to the stable content provider", () => {
  const ui = frameUI(true, { top: 59, bottom: 34, left: 0, right: 0 });
  const navigation = { type: "Navigation", props: {} };
  const first = ui.render("Beta notice", navigation).props.children[1] as Node;
  ui.updateInsets({ top: 0, bottom: 21, left: 59, right: 59 });
  const [notice, content] = ui.render("Beta notice", navigation).props
    .children as Node[];
  assert.equal(notice.props.style.paddingTop, 0);
  assert.equal(notice.props.style.paddingLeft, 59);
  assert.equal(notice.props.style.paddingRight, 59);
  assert.equal(content.type, first.type);
  assert.equal(content.props.children, navigation);
  assert.deepEqual(content.props.initialMetrics.insets, {
    top: 0,
    bottom: 21,
    left: 59,
    right: 59,
  });
});

test("ordinary Android and web layouts keep their original screen safe-area ownership", () => {
  const ui = frameUI(false, { top: 24, bottom: 16, left: 0, right: 0 });
  const navigation = { type: "Navigation", props: {} };
  for (const message of [null, "Operator notice"]) {
    const [notice, content] = ui.render(message, navigation).props.children;
    assert.equal(notice.props.style, undefined);
    assert.equal(notice.props.children, message);
    assert.equal(content, navigation);
  }
});
