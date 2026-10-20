import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultDevicePreferences,
  parseDevicePreferences,
  serializeDevicePreferences,
  updateDevicePreferences,
} from "../src/lib/device-preferences.ts";
test("device preferences round-trip appearance and real playback choices without account data", () => {
  const value = updateDevicePreferences(defaultDevicePreferences, {
    appearance: "light",
    autoplay: false,
    startMuted: false,
    reduceMotion: true,
  });
  assert.deepEqual(
    parseDevicePreferences(serializeDevicePreferences(value)),
    value,
  );
  assert.equal(serializeDevicePreferences(value).includes("token"), false);
  assert.equal(defaultDevicePreferences.appearance, "dark");
});
test("invalid or old preference storage falls back to bounded safe defaults", () => {
  for (const raw of [
    null,
    "not json",
    "[]",
    '{"version":2,"appearance":"light"}',
  ])
    assert.deepEqual(parseDevicePreferences(raw), defaultDevicePreferences);
  assert.deepEqual(
    parseDevicePreferences(
      '{"version":1,"appearance":"light","autoplay":"yes","startMuted":null,"reduceMotion":true,"token":"ignored"}',
    ),
    { ...defaultDevicePreferences, appearance: "light", reduceMotion: true },
  );
});
test("preference updates reject unknown settings and non-boolean switch values", () => {
  assert.deepEqual(
    updateDevicePreferences(defaultDevicePreferences, { autoplay: undefined }),
    defaultDevicePreferences,
  );
  assert.throws(() =>
    updateDevicePreferences(defaultDevicePreferences, {
      cameraPermission: true,
    } as never),
  );
  assert.throws(() =>
    updateDevicePreferences(defaultDevicePreferences, {
      appearance: "bright",
    } as never),
  );
  assert.throws(() =>
    updateDevicePreferences(defaultDevicePreferences, {
      autoplay: "on",
    } as never),
  );
});
