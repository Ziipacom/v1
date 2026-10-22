import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Size = { width: number; height: number };
type Update = (previous: Size) => Size;
type LayoutEvent = { nativeEvent: { layout: Size } | null };

/** Run the real TSX callback without loading players, credentials or a device. */
function layoutHandler(relativePath: string, setter: string) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const text = readFileSync(sourcePath, "utf8");
  const source = ts.createSourceFile(
    sourcePath.pathname,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const handlers: ts.Expression[] = [];
  const callsSetter = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === setter) ||
    ts.forEachChild(node, callsSetter) === true;
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "onLayout" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      callsSetter(node.initializer.expression)
    )
      handlers.push(node.initializer.expression);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(handlers.length, 1, "identify the actual preview layout handler");
  const compiled = ts.transpileModule(
    `const handler = ${handlers[0].getText(source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const pending: Update[] = [];
  const handler = new Function(setter, `${compiled}\nreturn handler;`)(
    (update: Update) => pending.push(update),
  ) as (event: LayoutEvent) => void;
  return { handler, pending };
}

for (const [name, path, setter] of [
  ["creation editor", "../src/screens/editor.tsx", "setCanvasArea"],
  ["feed edit preview", "../src/components/reel-media.tsx", "setArea"],
  ["draggable text layer", "../src/components/editor-canvas-layers.tsx", "setMeasured"],
] as const) {
  test(`${name} keeps dimensions after a native layout event is released`, () => {
    const { handler, pending } = layoutHandler(path, setter);
    const event: LayoutEvent = {
      nativeEvent: { layout: { width: 390, height: 200 } },
    };
    handler(event);
    // React Native releases pooled SyntheticEvents after dispatch, before a
    // queued state updater is necessarily evaluated during the next render.
    event.nativeEvent = null;
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]({ width: 320, height: 280 }), {
      width: 390,
      height: 200,
    });
  });

  test(`${name} snapshots each layout before the event object is reused`, () => {
    const { handler, pending } = layoutHandler(path, setter);
    const event: LayoutEvent = {
      nativeEvent: { layout: { width: 390, height: 200 } },
    };
    handler(event);
    event.nativeEvent!.layout.width = 780;
    event.nativeEvent!.layout.height = 400;
    handler(event);
    event.nativeEvent = null;
    let size = pending[0]({ width: 320, height: 280 });
    assert.deepEqual(size, { width: 390, height: 200 });
    size = pending[1](size);
    assert.deepEqual(size, { width: 780, height: 400 });
  });

  test(`${name} preserves state identity for an unchanged measured size`, () => {
    const { handler, pending } = layoutHandler(path, setter);
    const previous = { width: 390, height: 200 };
    const event: LayoutEvent = { nativeEvent: { layout: { ...previous } } };
    handler(event);
    event.nativeEvent = null;
    assert.equal(pending[0](previous), previous);
  });
}
