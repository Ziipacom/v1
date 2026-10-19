import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  notificationOpened,
  notificationPreferenceInput,
  notificationStatus,
  webPushKey,
} from "../src/lib/notification-types.ts";

const deliveryId = "a2f9fbb5-d803-4ebd-a795-f98cc025d2e4";
test("notification opt-in binds selected supported categories and a current preference revision", () => {
  assert.throws(() =>
    notificationPreferenceInput(true, ["calendar"], 1, false),
  );
  assert.throws(() => notificationPreferenceInput(true, [], 1, true));
  assert.throws(() => notificationPreferenceInput(true, ["calendar"], 0, true));
  assert.deepEqual(
    notificationPreferenceInput(
      true,
      ["campaigns", "calendar", "calendar"],
      3,
      true,
    ),
    {
      enabled: true,
      categories: ["calendar", "campaigns"],
      revision: 3,
      consent: true,
    },
  );
  assert.deepEqual(notificationPreferenceInput(false, [], 4, false), {
    enabled: false,
    categories: [],
    revision: 4,
    consent: false,
  });
  assert.match(notificationStatus("accepted"), /Accepted by push provider/);
  assert.doesNotMatch(notificationStatus("active"), /delivered|displayed/i);
});
test("notification taps only identify private-center receipts and never navigate payload URLs", () => {
  const value = {
    kind: "ziipa_notification",
    category: "recordings",
    route: "Notifications",
    delivery_id: deliveryId,
  };
  assert.equal(notificationOpened(value), deliveryId);
  for (const invalid of [
    null,
    {},
    { ...value, route: "Live" },
    { ...value, route: "https://evil.example" },
    { ...value, category: "billing" },
    { ...value, delivery_id: "../../asset" },
  ])
    assert.equal(notificationOpened(invalid), null);
});
test("browser VAPID input must be an uncompressed P-256 public key", () => {
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 42)]).toString(
    "base64url",
  );
  assert.equal(webPushKey(key).length, 65);
  for (const invalid of [
    null,
    "https://evil.example/key",
    key.slice(1),
    Buffer.alloc(65, 1).toString("base64url"),
  ])
    assert.throws(() => webPushKey(invalid));
});
function worker(scope: string) {
  const events: Record<string, (event: any) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  vm.runInNewContext(
    readFileSync(
      new URL("../public/ziipa-push-sw.js", import.meta.url),
      "utf8",
    ),
    {
      URL,
      self: {
        location: { origin: "https://ziipa.com" },
        registration: {
          scope,
          showNotification: async (
            title: string,
            options: Record<string, unknown>,
          ) => {
            shown.push({ title, options });
          },
        },
        addEventListener: (name: string, callback: (event: any) => void) => {
          events[name] = callback;
        },
        clients: {
          matchAll: async () => [],
          openWindow: async (url: string) => {
            opened.push(url);
          },
        },
      },
    },
  );
  return { events, shown, opened };
}
test("actual push worker strips private payload text and opens only a fixed origin route", async () => {
  const app = worker("https://ziipa.com/studio/");
  const pending: Promise<unknown>[] = [];
  const payload = {
    kind: "ziipa_notification",
    category: "calendar",
    route: "Notifications",
    delivery_id: deliveryId,
    url: "https://evil.example",
    title: "Private appointment",
    body: "Secret calendar notes",
  };
  app.events.push({
    data: {
      json: () => ({
        title: "Private appointment",
        body: "Secret calendar notes",
        data: payload,
      }),
    },
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
  assert.equal(app.shown.length, 1);
  assert.equal(app.shown[0].title, "Ziipa");
  assert.doesNotMatch(JSON.stringify(app.shown), /Secret|appointment|evil/);
  app.events.notificationclick({
    notification: { data: { url: payload.url }, close: () => {} },
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
  assert.deepEqual(app.opened, ["https://ziipa.com/portal"]);
  app.events.push({
    data: {
      json: () => ({
        title: "Ziipa",
        body: "Generic",
        data: { ...payload, route: "Live" },
      }),
    },
    waitUntil: () => assert.fail("Invalid payload must not display"),
  });
});
