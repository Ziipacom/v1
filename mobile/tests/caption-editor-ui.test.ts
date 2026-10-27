import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as captionEditor from "../src/lib/caption-editor.ts";
import { validateCaptionCues } from "../src/lib/auto-captions.ts";
import type { Caption } from "../src/lib/types.ts";

type Node = { type: unknown; props: Record<string, any> };

/** Exercise the actual shared panel with deterministic hooks and no provider/player. */
function panel(
  initial: {
    accepted?: Caption[] | null;
    sourceTime?: number;
    draftState?: captionEditor.CaptionEditorDraftState | null;
    onDraftStateChange?: (
      draft: captionEditor.CaptionEditorDraftState | null,
    ) => void;
  } = {},
) {
  const slots: any[] = [];
  let index = 0;
  let changed = false;
  let effects: (() => void)[] = [];
  const applied: (Caption[] | null)[] = [];
  const pending: boolean[] = [];
  let props: Record<string, any> = {
    sourceKey: "original-a",
    sourceDuration: 12,
    sourceTime: initial.sourceTime ?? 1,
    accepted: initial.accepted ?? null,
    disabled: false,
    onApply: (cues: Caption[] | null) => applied.push(cues),
    onDraftChange: (value: boolean) => pending.push(value),
    onSaveSource() {},
    onRights() {},
    onSeekSource: () => true,
    ...(Object.hasOwn(initial, "draftState")
      ? { draftState: initial.draftState }
      : {}),
    onDraftStateChange: initial.onDraftStateChange,
  };
  const jsx = (type: unknown, values: Node["props"]) => ({
    type,
    props: values,
  });
  const source = readFileSync(
    new URL("../src/components/editor-auto-captions.tsx", import.meta.url),
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
        useState: (initialValue: any) => {
          const slot = index++;
          if (!slots[slot]) slots[slot] = { value: initialValue };
          return [
            slots[slot].value,
            (value: any) => {
              const next =
                typeof value === "function" ? value(slots[slot].value) : value;
              if (!Object.is(next, slots[slot].value)) changed = true;
              slots[slot].value = next;
            },
          ];
        },
        useRef: (value: any) => {
          const slot = index++;
          return (slots[slot] ||= { current: value });
        },
        useEffect: (callback: () => (() => void) | void, deps: unknown[]) => {
          const slot = index++;
          const before = slots[slot];
          if (
            !before ||
            deps.some((value, n) => !Object.is(value, before.deps[n]))
          ) {
            effects.push(() => {
              before?.cleanup?.();
              slots[slot] = { deps, cleanup: callback() };
            });
          }
        },
      };
    if (name === "react/jsx-runtime")
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "react-native")
      return {
        Pressable: "Pressable",
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      };
    if (name === "lucide-react-native") return {};
    if (name === "expo-crypto") return { randomUUID: () => "unused" };
    if (name === "../provider")
      return {
        useZiipa: () => ({
          api: () => {
            throw new Error("Manual captions must not call a provider.");
          },
          session: null,
          guest: true,
        }),
      };
    if (name === "./ui") return { Action: "Action", Notice: "Notice" };
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    if (name === "../lib/editor-timeline")
      return { formatTimelineTime: (time: number) => String(time) };
    if (name === "../lib/auto-captions") return { validateCaptionCues };
    if (name === "../lib/caption-editor") return captionEditor;
    throw new Error(`Unexpected caption dependency ${name}`);
  });
  let nodes: Node[] = [];
  const flatten = (node: unknown): Node[] => {
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const value = node as Node;
    return [value, ...flatten(value.props.children)];
  };
  function render(update: Record<string, any> = {}) {
    props = { ...props, ...update };
    for (let run = 0; run < 8; run += 1) {
      index = 0;
      changed = false;
      effects = [];
      nodes = flatten(exported.EditorAutoCaptions(props));
      effects.forEach((effect) => effect());
      if (!changed) return;
    }
    throw new Error("Caption panel did not settle.");
  }
  function renderBeforeEffects(update: Record<string, any>) {
    props = { ...props, ...update };
    index = 0;
    changed = false;
    effects = [];
    nodes = flatten(exported.EditorAutoCaptions(props));
  }
  function action(title: string) {
    const node = nodes.find((entry) => entry.props.title === title);
    assert.ok(node, `missing action ${title}`);
    return node.props;
  }
  function field(label: string) {
    const node = nodes.find(
      (entry) => entry.props.accessibilityLabel === label,
    );
    assert.ok(node, `missing field/control ${label}`);
    return node.props;
  }
  render();
  const unmount = () => slots.forEach((slot) => slot?.cleanup?.());
  return {
    render,
    renderBeforeEffects,
    action,
    field,
    applied,
    pending,
    unmount,
    nodes: () => nodes,
  };
}

test("manual cues work without Auto captions and cannot change the edit before Apply", () => {
  const ui = panel();
  assert.equal(ui.action("Auto captions").disabled, true);
  ui.action("Create a timed track").onPress();
  ui.render();
  ui.action("Add at 1 source seconds").onPress();
  ui.render();
  ui.field("Caption 1 start").onChangeText("0:01.250");
  ui.render();
  ui.field("Caption 1 end").onChangeText("3.5");
  ui.render();
  ui.field("Caption 1 words").onChangeText("My words");
  ui.render();
  assert.deepEqual(ui.applied, []);
  ui.action("Apply caption draft").onPress();
  ui.render();
  assert.deepEqual(ui.applied, [[{ start: 1.25, end: 3.5, text: "My words" }]]);
});

test("discard keeps accepted captions and clearing requires an explicit empty Apply", () => {
  const accepted = [{ start: 1, end: 3, text: "Original" }];
  const ui = panel({ accepted });
  ui.action("Edit timed track").onPress();
  ui.render();
  ui.field("Caption 1 words").onChangeText("Changed");
  ui.render();
  ui.action("Discard caption draft").onPress();
  ui.render();
  assert.deepEqual(ui.applied, []);
  ui.action("Edit timed track").onPress();
  ui.render();
  assert.equal(ui.field("Caption 1 words").value, "Original");
  ui.field("Clear caption draft").onPress();
  ui.render();
  assert.deepEqual(ui.applied, []);
  ui.action("Apply empty track").onPress();
  ui.render({ accepted: [] });
  assert.deepEqual(
    ui.applied,
    [[]],
    "clearing must not use null and reactivate the legacy caption",
  );
});

test("invalid times cannot apply and a trimmed-out preview explains the source boundary", () => {
  const ui = panel({ accepted: [{ start: 1, end: 3, text: "Original" }] });
  ui.action("Edit timed track").onPress();
  ui.render();
  ui.field("Caption 1 end").onChangeText("99");
  ui.render();
  ui.action("Apply caption draft").onPress();
  ui.render();
  assert.deepEqual(ui.applied, []);
  assert.ok(
    ui
      .nodes()
      .some((node) =>
        String(node.props.text).includes("within the original media"),
      ),
  );
  ui.render({ onSeekSource: () => false });
  ui.field("Preview caption 1").onPress();
  ui.render();
  assert.ok(
    ui
      .nodes()
      .some((node) =>
        String(node.props.text).includes("outside your current clips"),
      ),
  );
});

test("stale Apply callbacks cannot overwrite a changed accepted track or another source", () => {
  const ui = panel({ accepted: [{ start: 1, end: 3, text: "Original" }] });
  ui.action("Edit timed track").onPress();
  ui.render();
  const oldApply = ui.action("Apply caption draft").onPress;
  ui.render({
    accepted: [{ start: 1, end: 3, text: "Restored through undo" }],
  });
  assert.equal(ui.action("Apply caption draft").disabled, true);
  oldApply();
  assert.deepEqual(ui.applied, []);
  ui.render({ sourceKey: "original-b", accepted: null });
  oldApply();
  assert.deepEqual(ui.applied, []);
  assert.ok(ui.action("Create a timed track"));
});

test("even an empty draft reports pending until Apply, Discard, source change or unmount", () => {
  const ui = panel();
  assert.equal(ui.pending.at(-1), false);
  ui.action("Create a timed track").onPress();
  ui.render();
  assert.equal(ui.pending.at(-1), true);
  ui.action("Apply empty track").onPress();
  ui.render({ accepted: [] });
  assert.equal(ui.pending.at(-1), false);
  ui.action("Edit timed track").onPress();
  ui.render();
  ui.action("Discard caption draft").onPress();
  ui.render();
  assert.equal(ui.pending.at(-1), false);
  ui.action("Edit timed track").onPress();
  ui.render();
  ui.render({ sourceKey: "different-original", accepted: null });
  assert.equal(ui.pending.at(-1), false);
  ui.action("Create a timed track").onPress();
  ui.render();
  ui.unmount();
  assert.equal(ui.pending.at(-1), false);
});

test("a new source render masks the prior draft before passive reset, even with identical null accepted tracks", () => {
  const ui = panel();
  ui.action("Create a timed track").onPress();
  ui.render();
  ui.action("Add at 1 source seconds").onPress();
  ui.render();
  ui.field("Caption 1 words").onChangeText("Only for the original source");
  ui.render();
  const priorApply = ui.action("Apply caption draft").onPress;
  ui.renderBeforeEffects({ sourceKey: "original-b", accepted: null });
  assert.equal(
    ui.nodes().some((node) => node.props.title === "Apply caption draft"),
    false,
  );
  assert.equal(
    ui
      .nodes()
      .some((node) => node.props.accessibilityLabel === "Caption 1 words"),
    false,
  );
  assert.ok(ui.action("Create a timed track"));
  priorApply();
  assert.deepEqual(ui.applied, []);
  ui.render();
  assert.ok(ui.action("Create a timed track"));
});

test("parent-owned draft survives a layout remount and remains pending until explicit Apply", () => {
  let held: captionEditor.CaptionEditorDraftState | null = null;
  const onDraftStateChange = (
    draft: captionEditor.CaptionEditorDraftState | null,
  ) => {
    held = draft;
  };
  const first = panel({ draftState: null, onDraftStateChange });
  first.action("Create a timed track").onPress();
  first.render({ draftState: held });
  first.action("Add at 1 source seconds").onPress();
  first.render({ draftState: held });
  first
    .field("Caption 1 words")
    .onChangeText("Keep this across the breakpoint");
  first.render({ draftState: held });
  first.field("Caption 1 end").onChangeText("4.25");
  first.render({ draftState: held });
  const savedDraft = JSON.stringify(held);
  first.unmount();
  assert.equal(
    JSON.stringify(held),
    savedDraft,
    "unmount must not clear parent-owned draft data",
  );
  const remounted = panel({ draftState: held, onDraftStateChange });
  assert.equal(remounted.pending.at(-1), true);
  assert.equal(
    remounted.field("Caption 1 words").value,
    "Keep this across the breakpoint",
  );
  assert.equal(remounted.field("Caption 1 end").value, "4.25");
  remounted.action("Apply caption draft").onPress();
  assert.deepEqual(remounted.applied, [
    [{ start: 1, end: 4.25, text: "Keep this across the breakpoint" }],
  ]);
  assert.equal(held, null);
});
