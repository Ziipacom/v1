import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Node = { type: unknown; props: any };
function flatten(node: any): Node[] {
  return Array.isArray(node)
    ? node.flatMap(flatten)
    : node?.props
      ? [node, ...flatten(node.props.children)]
      : [];
}
function sheet(platform: string) {
  let state = 0,
    cursor = 0;
  const refs: any[] = [];
  const effects: (() => void | (() => void))[] = [];
  const events = new Map<string, () => void>();
  const frames = new Map<number, () => void>();
  let next = 0;
  let inside = true;
  let scrolled = 0;
  const focused = {
    matches: () => true,
    scrollIntoView: () => {
      scrolled++;
    },
  };
  const viewport = {
    height: 500,
    offsetTop: 0,
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    removeEventListener: (name: string) => events.delete(name),
  };
  const window = {
    innerHeight: 800,
    visualViewport: viewport,
    requestAnimationFrame: (fn: () => void) => {
      frames.set(++next, fn);
      return next;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  const document = {
    activeElement: focused,
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    removeEventListener: (name: string) => events.delete(name),
  };
  const jsx = (type: unknown, props: any) => ({ type, props });
  const out: any = {};
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/components/floating.tsx", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  new Function("exports", "require", "window", "document", code)(
    out,
    (name: string) => {
      if (name === "react")
        return {
          useState: () => [
            state,
            (value: number) => {
              state = value;
            },
          ],
          useRef: () => {
            const index = cursor++;
            return (refs[index] ||= { current: null });
          },
          useEffect: (fn: () => void) => effects.push(fn),
        };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react-native")
        return {
          Platform: { OS: platform },
          Modal: "Modal",
          KeyboardAvoidingView: "KeyboardAvoidingView",
          View: "View",
          ScrollView: "ScrollView",
          Text: "Text",
          Pressable: "Pressable",
          StyleSheet: { absoluteFill: {} },
        };
      if (name === "react-native-safe-area-context")
        return { useSafeAreaInsets: () => ({ bottom: 34 }) };
      if (name === "lucide-react-native") return {};
      if (name === "../theme")
        return {
          color: {},
          font: {},
          styles: {},
          useTheme() {},
          themedStyles: (fn: () => unknown) => fn(),
        };
      if (name === "../lib/config")
        return { conceptsEnabled: true, limitedStoreBeta: false };
      if (name === "./desktop-layout")
        return { useDesktopLayout: () => ({ desktop: false }) };
      throw new Error(name);
    },
    window,
    document,
  );
  function render(footer?: any) {
    cursor = 0;
    const tree = out.Sheet({
      title: "Storefront settings",
      children: "fields",
      onClose() {},
      footer,
    });
    return flatten(tree);
  }
  return {
    render,
    events,
    viewport,
    refs,
    frames,
    effects,
    scrolled: () => scrolled,
    setInside: (value: boolean) => {
      inside = value;
    },
    attach: () => {
      refs[0].current = { contains: () => inside };
    },
    flush: () => {
      for (const fn of frames.values()) fn();
      frames.clear();
    },
  };
}

test("all native sheets avoid the keyboard even without a footer and keep their body scrollable", () => {
  for (const platform of ["ios", "android"])
    for (const footer of [undefined, "Save"]) {
      const ui = sheet(platform);
      const nodes = ui.render(footer);
      const avoid = nodes.find((n) => n.type === "KeyboardAvoidingView")!;
      assert.equal(avoid.props.enabled, true);
      assert.equal(
        avoid.props.behavior,
        platform === "ios" ? "padding" : "height",
      );
      const scroll = nodes.find((n) => n.type === "ScrollView")!;
      assert.equal(scroll.props.style.flexShrink, 1);
      assert.equal(scroll.props.automaticallyAdjustKeyboardInsets, false); // One avoidance strategy, no duplicate inset.
      assert.equal(scroll.props.keyboardShouldPersistTaps, "handled");
    }
});

test("mobile web viewport changes reveal the focused sheet field, never a background field", () => {
  const ui = sheet("web");
  ui.render();
  ui.attach();
  const cleanup = ui.effects[0]() as () => void;
  ui.flush();
  assert.equal(ui.scrolled(), 1);
  const avoid = ui.render().find((n) => n.type === "KeyboardAvoidingView")!;
  assert.equal(avoid.props.style.paddingBottom, 300);
  ui.viewport.offsetTop = 50;
  ui.events.get("resize")!();
  ui.flush();
  assert.equal(
    ui.render().find((n) => n.type === "KeyboardAvoidingView")!.props.style
      .paddingBottom,
    250,
  );
  const previous = ui.scrolled();
  ui.setInside(false);
  ui.events.get("focusin")!();
  ui.flush();
  assert.equal(ui.scrolled(), previous);
  cleanup();
  assert.equal(ui.events.size, 0);
  assert.equal(ui.frames.size, 0);
});
