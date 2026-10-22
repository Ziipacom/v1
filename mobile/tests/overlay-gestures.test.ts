import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { overlayDragHandlers } from "../src/lib/overlay-gestures.ts";
import { overlayBox } from "../src/lib/editor-overlays.ts";
import type { Overlay } from "../src/lib/types.ts";

function setup() {
  const layer: Overlay = {
    id: "title",
    text: "Hello",
    position: "center",
    theme: "dark",
  };
  const frame = { width: 400, height: 200 };
  const measured = { width: 100, height: 40 };
  const commits: unknown[] = [],
    previews: unknown[] = [],
    selections: string[] = [];
  const current = {
    layer,
    ...frame,
    measured,
    box: overlayBox(layer, frame, measured),
    onSelect: (id: string) => selections.push(id),
    onPositionChange: (id: string, value: unknown) => {
      commits.push({ id, value });
    },
  };
  return {
    current,
    commits,
    previews,
    selections,
    handlers: overlayDragHandlers(
      () => current,
      (value) => previews.push(value),
    ),
  };
}

test("tap is left to Pressable while a View captures actual drags", () => {
  const { handlers } = setup();
  assert.equal(handlers.onStartShouldSetPanResponder(), false);
  assert.equal(
    handlers.onMoveShouldSetPanResponderCapture(null, { dx: 2, dy: 0 }),
    false,
  );
  assert.equal(
    handlers.onMoveShouldSetPanResponderCapture(null, { dx: 5, dy: 0 }),
    true,
  );
});

test("native responder is attached to View so Pressability cannot replace it", () => {
  const text = readFileSync(new URL("../src/components/editor-canvas-layers.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("canvas.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hosts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      for (const property of node.attributes.properties)
        if (ts.isJsxSpreadAttribute(property) && property.expression.getText(source) === "responder.panHandlers")
          hosts.push(node.tagName.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(hosts, ["View"]);
});

test("drag previews continuously and commits exactly one undoable edit on release", () => {
  const { handlers, previews, commits, selections } = setup();
  handlers.onPanResponderGrant();
  handlers.onPanResponderMove(null, { dx: 40, dy: 20 });
  handlers.onPanResponderMove(null, { dx: 80, dy: 40 });
  assert.equal(commits.length, 0);
  assert.deepEqual(previews.at(-1), { x: 0.7, y: 0.7 });
  handlers.onPanResponderRelease(null, { dx: 80, dy: 40 });
  assert.deepEqual(commits, [{ id: "title", value: { x: 0.7, y: 0.7 } }]);
  assert.deepEqual(selections, ["title"]);
  assert.equal(previews.at(-1), null);
});

test("drag cannot move the box outside media bounds", () => {
  const { handlers, commits } = setup();
  handlers.onPanResponderGrant();
  handlers.onPanResponderRelease(null, { dx: 1000, dy: -1000 });
  assert.deepEqual(commits, [{ id: "title", value: { x: 0.875, y: 0.1 } }]);
});

test("cancellation, orientation changes and permission loss do not commit", () => {
  for (const mode of ["cancel", "resize", "disabled"]) {
    const { handlers, current, commits } = setup();
    handlers.onPanResponderGrant();
    handlers.onPanResponderMove(null, { dx: 30, dy: 20 });
    if (mode === "cancel") handlers.onPanResponderTerminate();
    if (mode === "resize") current.width = 800;
    if (mode === "disabled") current.onPositionChange = undefined as never;
    handlers.onPanResponderRelease(null, { dx: 50, dy: 40 });
    assert.equal(commits.length, 0, mode);
  }
});

test("oversized text cannot be dragged into an invalid normalized position", () => {
  const { handlers, current, commits } = setup();
  current.measured.height = 500;
  assert.equal(handlers.onMoveShouldSetPanResponderCapture(null, { dx: 50, dy: 40 }), false);
  handlers.onPanResponderGrant();
  handlers.onPanResponderRelease(null, { dx: 50, dy: 40 });
  assert.equal(commits.length, 0);
});
