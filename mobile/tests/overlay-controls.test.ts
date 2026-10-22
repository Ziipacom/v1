import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Node = { type: unknown; props: Record<string, any> };

/** Run the actual shared slider with deterministic hooks; no native player or credentials. */
function slider(
  options: {
    disabled?: boolean;
    min?: number;
    max?: number;
    value?: number;
    lowerLimit?: number;
    upperLimit?: number;
  } = {},
) {
  const callbacks: Record<string, (...args: any[]) => any> = {};
  const updates: unknown[] = [];
  const changes: number[] = [];
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  const source = readFileSync(
    new URL("../src/components/editor-overlay-controls.tsx", import.meta.url),
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
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react")
      return {
        useMemo: (factory: () => unknown) => factory(),
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [
          initial,
          (value: unknown) => updates.push(value),
        ],
      };
    if (name === "react-native")
      return {
        PanResponder: {
          create: (handlers: typeof callbacks) => {
            Object.assign(callbacks, handlers);
            return { panHandlers: {} };
          },
        },
        Platform: { OS: "web" },
        View: "View",
        Text: "Text",
      };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "../theme") return { color: {}, font: {} };
    throw new Error(`Unexpected slider dependency ${name}`);
  });
  const tree = exported.OverlaySlider({
    label: "Overlay end",
    value: options.value ?? 20,
    min: options.min ?? 0,
    max: options.max ?? 240,
    step: 0.1,
    disabled: options.disabled ?? false,
    valueText: "00:20",
    lowerLimit: options.lowerLimit,
    upperLimit: options.upperLimit,
    onChange: (value: number) => changes.push(value),
  }) as Node;
  const control = (tree.props.children as Node[]).find(
    (node) => node.props.accessibilityRole === "adjustable",
  )!;
  assert.ok(control, "the actual component exposes an adjustable control");
  return { callbacks, control, changes, updates };
}

test("an overlay drag commits exactly once when released, keeping undo history useful", () => {
  const { callbacks, changes, updates } = slider();
  callbacks.onPanResponderGrant({ nativeEvent: { locationX: 22 } });
  callbacks.onPanResponderMove({}, { dx: 49 });
  callbacks.onPanResponderMove({}, { dx: 98 });
  callbacks.onPanResponderMove({}, { dx: 196 });
  assert.deepEqual(
    changes,
    [],
    "transient moves must not persist separate edits",
  );
  assert.ok(
    updates.includes(120),
    "the user sees local handle feedback during the drag",
  );
  callbacks.onPanResponderRelease();
  assert.deepEqual(changes, [240]);
  callbacks.onPanResponderRelease();
  assert.deepEqual(
    changes,
    [240],
    "a duplicate release must not persist a second edit",
  );
});

test("a canceled overlay gesture never persists a partial edit", () => {
  const { callbacks, changes } = slider();
  callbacks.onPanResponderGrant({ nativeEvent: { locationX: 22 } });
  callbacks.onPanResponderMove({}, { dx: 100 });
  callbacks.onPanResponderTerminate();
  callbacks.onPanResponderRelease();
  assert.deepEqual(changes, []);
});

test("overlay gestures snapshot a released native event and clamp to the edited duration", () => {
  const { callbacks, changes } = slider();
  const event: { nativeEvent: { locationX: number } | null } = {
    nativeEvent: { locationX: 22 },
  };
  callbacks.onPanResponderGrant(event);
  event.nativeEvent = null;
  callbacks.onPanResponderMove({}, { dx: 10000 });
  callbacks.onPanResponderRelease();
  assert.deepEqual(changes, [240]);
});

test("overlay layout snapshots width as a scalar instead of retaining a pooled event", () => {
  const { control, updates } = slider();
  const event: { nativeEvent: { layout: { width: number } } | null } = {
    nativeEvent: { layout: { width: 390 } },
  };
  control.props.onLayout(event);
  event.nativeEvent = null;
  assert.deepEqual(updates, [390]);
});

test("disabled or unmeasured overlay controls cannot mutate the draft", () => {
  for (const options of [{ disabled: true }, { min: 0, max: 0 }]) {
    const { callbacks, control, changes } = slider(options);
    assert.equal(callbacks.onStartShouldSetPanResponder(), false);
    callbacks.onPanResponderGrant({ nativeEvent: { locationX: 120 } });
    callbacks.onPanResponderMove({}, { dx: 80 });
    callbacks.onPanResponderRelease();
    control.props.onAccessibilityAction({
      nativeEvent: { actionName: "increment" },
    });
    control.props.onKeyDown({
      key: "End",
      preventDefault() {},
      stopPropagation() {},
    });
    assert.deepEqual(changes, []);
    assert.equal(control.props.tabIndex, -1);
  }
});

test("overlay sliders support precise keyboard and screen reader adjustment", () => {
  const { control, changes } = slider();
  let intercepted = 0;
  const key = (key: string, shiftKey = false) =>
    control.props.onKeyDown({
      key,
      shiftKey,
      preventDefault() {
        intercepted += 1;
      },
      stopPropagation() {},
    });
  key("ArrowRight");
  key("ArrowLeft", true);
  key("Home");
  key("End");
  control.props.onAccessibilityAction({
    nativeEvent: { actionName: "increment" },
  });
  control.props.onAccessibilityAction({
    nativeEvent: { actionName: "decrement" },
  });
  assert.deepEqual(changes, [20.1, 19, 0, 240, 20.1, 19.9]);
  assert.equal(intercepted, 4);
  assert.equal(control.props.style.height, 44);
  assert.equal(control.props["aria-valuemax"], 240);
});

test("timing handles cannot cross and expose their real available range to assistive technology", () => {
  const { callbacks, control, changes, updates } = slider({
    lowerLimit: 12.1,
    upperLimit: 79.9,
  });
  callbacks.onPanResponderGrant({ nativeEvent: { locationX: 22 } });
  assert.ok(updates.includes(12.1));
  callbacks.onPanResponderMove({}, { dx: 10000 });
  callbacks.onPanResponderRelease();
  assert.deepEqual(changes, [79.9]);
  assert.equal(control.props["aria-valuemin"], 12.1);
  assert.equal(control.props["aria-valuemax"], 79.9);
  control.props.onKeyDown({
    key: "Home",
    preventDefault() {},
    stopPropagation() {},
  });
  control.props.onKeyDown({
    key: "End",
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(changes, [79.9, 12.1, 79.9]);
});

function capabilityPanel(status: string, supported = false) {
  const source = readFileSync(
    new URL("../src/components/editor-overlays.tsx", import.meta.url),
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
  const exported: Record<string, any> = {};
  let retries = 0;
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react-native")
      return {
        Pressable: "Pressable",
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "expo-image") return { Image: "Image" };
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    if (name === "../lib/editor-timeline")
      return { formatTimelineTime: String };
    if (name === "../lib/editor-overlays")
      return {
        overlayCoordinates: () => ({ x: 0.5, y: 0.5 }),
        overlayTimeRange: (_: unknown, duration: number) => ({
          start: 0,
          end: duration,
        }),
      };
    if (name === "./editor-preview") return { effectFilter: () => "none" };
    if (name === "./editor-overlay-controls")
      return { OverlaySlider: "OverlaySlider" };
    throw new Error(`Unexpected panel dependency ${name}`);
  });
  const tree = exported.EditorOverlays({
    overlays: [
      { id: "layer", text: "Title", position: "center", theme: "light" },
    ],
    selectedId: "layer",
    effect: "none",
    caption: "",
    disabled: true,
    onChange() {},
    onSelect() {},
    onEffect() {},
    onCaption() {},
    advancedStatus: status,
    advancedSupported: supported,
    onRefreshCapabilities: () => {
      retries += 1;
    },
  });
  const nodes: Node[] = [];
  const text: string[] = [];
  function walk(value: unknown) {
    if (typeof value === "string") text.push(value);
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object" && "props" in value) {
      nodes.push(value as Node);
      walk((value as Node).props.children);
    }
  }
  walk(tree);
  return {
    text: text.join(" "),
    refresh: nodes.find(
      (node) =>
        node.props.accessibilityLabel === "Refresh overlay support status",
    ),
    retries: () => retries,
  };
}

test("overlay support distinguishes checking, connection failure and a server that needs updating", () => {
  const checking = capabilityPanel("checking");
  assert.match(checking.text, /Checking Ziipa’s support/);
  assert.equal(checking.refresh!.props.disabled, true);
  checking.refresh!.props.onPress();
  assert.equal(checking.retries(), 0);
  const unavailable = capabilityPanel("unavailable");
  assert.match(unavailable.text, /Couldn’t check Ziipa’s overlay support/);
  assert.doesNotMatch(unavailable.text, /server needs an update/);
  assert.equal(unavailable.refresh!.props.disabled, false);
  unavailable.refresh!.props.onPress();
  assert.equal(unavailable.retries(), 1);
  const unsupported = capabilityPanel("unsupported");
  assert.match(unsupported.text, /server needs an update/);
  assert.equal(unsupported.refresh!.props.disabled, false);
  unsupported.refresh!.props.onPress();
  assert.equal(unsupported.retries(), 1);
  const ready = capabilityPanel("ready", true);
  assert.equal(ready.refresh, undefined);
  assert.doesNotMatch(
    ready.text,
    /Couldn’t check|Checking Ziipa|server needs an update/,
  );
});
