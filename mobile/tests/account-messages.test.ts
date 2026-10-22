import assert from "node:assert/strict";
import test from "node:test";
import { NotificationMessagesSession, emptyMessagesSnapshot, isUnreadNotification, notificationReceipts, unreadNotificationCount, unreadNotificationsForSnapshot } from "../src/lib/account-messages.ts";
import type { PushDelivery } from "../src/lib/notification-types.ts";

const delivery = (patch: Partial<PushDelivery> = {}): PushDelivery => ({
  id: "7b107e2a-7e16-4dd1-9f5d-3127691f8fd2", category: "calendar", provider: "expo",
  status: "provider_accepted", detail: "The provider accepted this private reminder.",
  created_at: "2026-10-22T15:00:00Z", provider_accepted_at: "2026-10-22T15:01:00Z", opened_at: null,
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("new badges require provider acceptance, an actual timestamp and no opened receipt", () => {
  for (const status of ["provider_accepted", "accepted", "sent"]) assert.equal(isUnreadNotification(delivery({ status })), true);
  for (const status of ["queued", "pending", "sending", "awaiting_receipt", "failed", "uncertain", "revoked", "opened", "delivered"])
    assert.equal(isUnreadNotification(delivery({ status })), false, status);
  assert.equal(isUnreadNotification(delivery({ provider_accepted_at: null })), false);
  assert.equal(isUnreadNotification(delivery({ provider_accepted_at: "not-a-timestamp" })), false);
  assert.equal(isUnreadNotification(delivery({ opened_at: "2026-10-22T15:02:00Z" })), false);
  assert.equal(unreadNotificationCount([delivery(), delivery({ status: "queued" })]), 1);
  assert.equal(unreadNotificationsForSnapshot(emptyMessagesSnapshot), null);
  assert.equal(unreadNotificationsForSnapshot({ ...emptyMessagesSnapshot, deliveries: [] }), 0);
  assert.equal(unreadNotificationsForSnapshot({ ...emptyMessagesSnapshot, deliveries: [delivery()], loading: true }), null);
  assert.equal(unreadNotificationsForSnapshot({ ...emptyMessagesSnapshot, deliveries: [delivery()], error: "Offline" }), null);
});

test("receipt loading is GET-only, deduplicated and never marks messages read", async () => {
  const response = deferred<unknown>(), calls: unknown[][] = [];
  const state = new NotificationMessagesSession();
  state.select("account-one", async (...args) => { calls.push(args); return response.promise; });
  const first = state.refresh(), second = state.refresh();
  assert.equal(first, second);
  await Promise.resolve();
  assert.deepEqual(calls, [["/api/notifications/deliveries"]]);
  response.resolve([delivery()]); await first;
  assert.equal(unreadNotificationsForSnapshot(state.snapshot("account-one")), 1);
  assert.equal(state.snapshot("account-one").deliveries?.[0].opened_at, null);
  state.clear();
  assert.equal(state.snapshot("account-one"), emptyMessagesSnapshot);
});

test("switching accounts clears receipts immediately and discards late old results", async () => {
  const old = deferred<unknown>();
  const state = new NotificationMessagesSession();
  state.select("old-account", () => old.promise);
  const pending = state.refresh(); await Promise.resolve();
  // The render-time identity guard hides data even before the scope effect runs.
  assert.equal(state.snapshot("new-account"), emptyMessagesSnapshot);
  state.select("new-account", async () => []);
  await state.refresh();
  old.resolve([delivery()]); await pending;
  assert.deepEqual(state.snapshot("new-account").deliveries, []);
  assert.equal(state.snapshot("old-account"), emptyMessagesSnapshot);
});

test("sign-out before a deferred refresh starts performs no old-account request", async () => {
  let calls = 0;
  const state = new NotificationMessagesSession();
  state.select("mine", async () => { calls++; return [delivery()]; });
  const pending = state.refresh();
  state.clear();
  await pending;
  assert.equal(calls, 0);
  assert.equal(state.snapshot("mine"), emptyMessagesSnapshot);
});

test("only an explicit read posts its receipt and confirmed server state clears the badge", async () => {
  const calls: unknown[][] = [];
  let changed = 0;
  const state = new NotificationMessagesSession(() => { changed++; });
  state.select("mine", async (path, body) => {
    calls.push([path, body]);
    return body === undefined ? [delivery()] : delivery({ opened_at: "2026-10-22T15:05:00Z" });
  });
  await state.refresh();
  assert.equal(changed, 0);
  assert.equal(await state.markOpened(delivery().id), true);
  assert.deepEqual(calls, [["/api/notifications/deliveries", undefined], [`/api/notifications/deliveries/${delivery().id}/opened`, {}]]);
  assert.equal(unreadNotificationsForSnapshot(state.snapshot("mine")), 0);
  assert.equal(changed, 1);
  assert.equal(await state.markOpened(delivery().id), false);
  assert.equal(calls.length, 2);
});

test("queued, unknown and failed receipts cannot cause read writes", async () => {
  let requests = 0;
  const state = new NotificationMessagesSession();
  state.select("mine", async () => { requests++; return [delivery({ status: "queued" })]; });
  await state.refresh();
  assert.equal(await state.markOpened(delivery().id), false);
  assert.equal(await state.markOpened("../../another-account"), false);
  assert.equal(requests, 1);
});

test("a GET begun before marking read cannot resurrect the unread badge", async () => {
  const old = deferred<unknown>(); let reads = 0;
  const state = new NotificationMessagesSession();
  state.select("mine", async (_, body) => body === undefined
    ? (++reads === 1 ? [delivery()] : old.promise)
    : delivery({ opened_at: "2026-10-22T15:05:00Z" }));
  await state.refresh();
  const stale = state.refresh(); await Promise.resolve();
  assert.equal(await state.markOpened(delivery().id), true);
  old.resolve([delivery()]); await stale;
  assert.equal(unreadNotificationsForSnapshot(state.snapshot("mine")), 0);
});

test("failed reads are not optimistic, retry is explicit and stale read results stay scoped", async () => {
  const post = deferred<unknown>(); let writes = 0, changed = 0;
  const state = new NotificationMessagesSession(() => { changed++; });
  state.select("mine", async (_, body) => {
    if (body === undefined) return [delivery()];
    writes++; return post.promise;
  });
  await state.refresh();
  const read = state.markOpened(delivery().id);
  assert.equal(await state.markOpened(delivery().id), false);
  assert.equal(state.snapshot("mine").deliveries?.[0].opened_at, null);
  state.select("someone-else", async () => []);
  await state.refresh();
  post.resolve(delivery({ opened_at: "2026-10-22T15:05:00Z" }));
  assert.equal(await read, false);
  assert.equal(changed, 0); assert.equal(writes, 1);
  assert.deepEqual(state.snapshot("someone-else").deliveries, []);
});

test("transport errors never reject refresh or produce a false zero/new badge", async () => {
  const state = new NotificationMessagesSession();
  state.select("mine", () => { throw new Error("Connection unavailable"); });
  await assert.doesNotReject(state.refresh());
  assert.equal(state.snapshot("mine").error, "Connection unavailable");
  assert.equal(unreadNotificationsForSnapshot(state.snapshot("mine")), null);
  state.select("mine", async () => [delivery()]);
  await state.refresh();
  assert.equal(unreadNotificationsForSnapshot(state.snapshot("mine")), 1);
  state.select("mine", async () => { throw new Error("Read did not save"); });
  assert.equal(await state.markOpened(delivery().id), false);
  assert.equal(state.snapshot("mine").deliveries?.[0].opened_at, null);
});

test("bounded receipt parsing rejects path IDs, malformed times and duplicate rows", () => {
  assert.throws(() => notificationReceipts([delivery({ id: "../../private" })]));
  assert.throws(() => notificationReceipts([delivery({ created_at: "invalid" })]));
  assert.throws(() => notificationReceipts([delivery(), delivery()]));
  assert.throws(() => notificationReceipts(Array.from({ length: 101 }, () => delivery())));
  assert.deepEqual(notificationReceipts([{ ...delivery(), owner_token: "not-retained" }]), [delivery()]);
});
