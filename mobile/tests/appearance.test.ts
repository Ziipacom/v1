import test from "node:test";
import assert from "node:assert/strict";
import { createAppearanceStore, palettes, resolveAppearance, themeRecord } from "../src/lib/appearance.ts";

test("default stays Ziipa dark until the user explicitly chooses system or light", () => {
  const store = createAppearanceStore();
  assert.deepEqual(store.getSnapshot(), { mode: "dark", resolvedMode: "dark" });
  store.set("dark", "light");
  assert.equal(store.getSnapshot().resolvedMode, "dark");
  assert.equal(palettes.dark.bg, "#120D1F");
  assert.equal(palettes.dark.panel, "#211C2C");
  assert.equal(palettes.dark.purple, palettes.light.purple);
  assert.equal(resolveAppearance("system", null), "dark");
});

test("system changes update subscribers without resetting stores or emitting duplicate changes", () => {
  const store = createAppearanceStore();
  const snapshots: unknown[] = [];
  const stop = store.subscribe(() => snapshots.push(store.getSnapshot()));
  store.set("system", "light");
  const first = store.getSnapshot();
  store.set("system", "light");
  assert.equal(store.getSnapshot(), first);
  store.set("system", "dark");
  store.set("light", "dark");
  store.set("light", "light");
  assert.deepEqual(snapshots, [
    { mode: "system", resolvedMode: "light" }, { mode: "system", resolvedMode: "dark" },
    { mode: "light", resolvedMode: "light" },
  ]);
  stop(); store.set("dark");
  assert.equal(snapshots.length, 3);
  assert.throws(() => store.set("unknown" as never));
});

test("existing module style references resolve the current palette and preserve cached geometry", () => {
  const store = createAppearanceStore();
  let calls = 0;
  const styles = themeRecord(() => {
    calls++;
    return { panel: { backgroundColor: palettes[store.getSnapshot().resolvedMode].panel, padding: 20 },
      text: { color: palettes[store.getSnapshot().resolvedMode].text } };
  }, () => store.getSnapshot().resolvedMode);
  const held = styles;
  const darkPanel = held.panel;
  assert.equal(calls, 1);
  store.set("light");
  assert.equal(held, styles);
  assert.equal(held.panel.backgroundColor, "#FFFFFF");
  assert.equal(held.panel.padding, darkPanel.padding);
  assert.deepEqual(Object.keys(held), ["panel", "text"]);
  assert.deepEqual({ ...held }.text, { color: palettes.light.text });
  assert.equal(calls, 2);
  store.set("dark");
  assert.equal(held.panel, darkPanel);
  assert.equal(calls, 2);
});

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + 0.05) / (values[0] + 0.05);
}
test("both palettes keep body, muted, accent-button and error text readable", () => {
  for (const palette of Object.values(palettes)) {
    for (const surface of [palette.bg, palette.panel]) {
      assert.ok(contrast(palette.text, surface) >= 4.5);
      assert.ok(contrast(palette.muted, surface) >= 4.5);
      assert.ok(contrast(palette.lime, surface) >= 4.5);
    }
    assert.ok(contrast(palette.onAccent, palette.purple) >= 4.5);
    assert.ok(contrast(palette.danger, palette.errorPanel) >= 4.5);
    assert.ok(contrast(palette.onLime, palette.lime) >= 4.5);
    assert.equal(palette.onMedia, "#FFFFFF");
  }
});
