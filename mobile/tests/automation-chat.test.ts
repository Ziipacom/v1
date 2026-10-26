import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutomationChatController,
  type AutomationChatSendOptions,
} from "../src/lib/automation-chat.ts";

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(changes: Partial<AutomationChatSendOptions> = {}) {
  const events: unknown[] = [];
  let draft = "  Plan my release  ";
  const options: AutomationChatSendOptions = {
    draft,
    owner: "owner-a",
    projectId: null,
    isCurrent: () => true,
    post: async (body) => {
      events.push(["post", body]);
      return {};
    },
    open: () => events.push("open"),
    busy: (sending) => events.push(["busy", sending]),
    error: (message) => events.push(["error", message]),
    accepted: () => {
      events.push("accepted");
      draft = "";
    },
    refresh: async () => {
      events.push("refresh");
    },
    ...changes,
  };
  return { options, events, draft: () => draft };
}

test("automation chat opens the conversation and sends one trimmed request with explicit project context", async () => {
  const controller = createAutomationChatController();
  const ui = fixture({ projectId: "project-a" });
  assert.equal(await controller.send(ui.options), true);
  assert.deepEqual(ui.events, [
    ["busy", true],
    ["error", ""],
    "open",
    ["post", { message: "Plan my release", project_id: "project-a" }],
    "accepted",
    "refresh",
    ["busy", false],
  ]);
  assert.equal(ui.draft(), "");
});

test("blank, oversized and signed-out requests show validation without opening or posting", async () => {
  for (const changes of [
    { draft: " \n\t " },
    { draft: "x".repeat(3001) },
    { owner: undefined },
    { owner: " " },
  ]) {
    const controller = createAutomationChatController();
    const ui = fixture(changes);
    assert.equal(await controller.send(ui.options), false);
    assert.equal(ui.events.length, 1);
    const error = ui.events[0] as [string, string];
    assert.equal(error[0], "error");
    assert.ok(error[1].length > 0);
    assert.equal(ui.draft(), "  Plan my release  ");
  }
  const controller = createAutomationChatController();
  const ui = fixture({ draft: ` ${"x".repeat(3000)} ` });
  assert.equal(await controller.send(ui.options), true);
});

test("keyboard submission and send-icon submission cannot duplicate a pending message", async () => {
  const controller = createAutomationChatController();
  const reply = deferred();
  let posts = 0;
  const ui = fixture({
    post: () => {
      posts++;
      return reply.promise;
    },
  });
  const keyboard = controller.send(ui.options);
  const icon = controller.send(ui.options);
  assert.equal(posts, 1);
  assert.equal(await icon, false);
  assert.equal(ui.draft(), "  Plan my release  ");
  assert.equal(ui.events.includes("accepted"), false);
  reply.resolve({});
  assert.equal(await keyboard, true);
  assert.equal(ui.draft(), "");
  assert.deepEqual(
    ui.events.filter((entry) => Array.isArray(entry) && entry[0] === "busy"),
    [
      ["busy", true],
      ["busy", false],
    ],
  );
});

test("post failure preserves the draft, releases the send lock and permits an explicit retry", async () => {
  const controller = createAutomationChatController();
  let posts = 0;
  const ui = fixture({
    post: async () => {
      if (++posts === 1)
        throw new Error("The workspace is temporarily unavailable.");
      return {};
    },
  });
  assert.equal(await controller.send(ui.options), false);
  assert.equal(ui.draft(), "  Plan my release  ");
  assert.equal(ui.events.includes("refresh"), false);
  assert.ok(
    ui.events.some(
      (entry) =>
        Array.isArray(entry) &&
        entry[0] === "error" &&
        entry[1] === "The workspace is temporarily unavailable.",
    ),
  );
  assert.deepEqual(ui.events.at(-1), ["busy", false]);
  assert.equal(await controller.send(ui.options), true);
  assert.equal(posts, 2);
  assert.equal(ui.draft(), "");
});

test("refresh failure reports an already-sent message without preserving a resendable draft", async () => {
  const controller = createAutomationChatController();
  const ui = fixture({
    refresh: async () => {
      throw new Error("refresh failed");
    },
  });
  assert.equal(await controller.send(ui.options), true);
  assert.equal(ui.draft(), "");
  assert.ok(
    ui.events.some(
      (entry) =>
        Array.isArray(entry) &&
        entry[0] === "error" &&
        String(entry[1]).startsWith("Your message was sent"),
    ),
  );
  assert.deepEqual(ui.events.at(-1), ["busy", false]);
});

test("a stale account before submission or after opening cannot create a request", async () => {
  const controller = createAutomationChatController();
  const stale = fixture({ isCurrent: () => false });
  assert.equal(await controller.send(stale.options), false);
  assert.deepEqual(stale.events, []);
  let current = true;
  const ui = fixture({
    isCurrent: () => current,
    open: () => {
      current = false;
    },
  });
  assert.equal(await controller.send(ui.options), false);
  assert.equal(ui.draft(), "  Plan my release  ");
  assert.equal(
    ui.events.some((entry) => Array.isArray(entry) && entry[0] === "post"),
    false,
  );
  assert.equal(ui.events.includes("accepted"), false);
  assert.equal(
    ui.events.some(
      (entry) =>
        Array.isArray(entry) && entry[0] === "busy" && entry[1] === false,
    ),
    false,
  );
});

test("a response for a changed account cannot clear a draft, refresh or reset its busy state", async () => {
  const controller = createAutomationChatController();
  const reply = deferred();
  let current = true;
  const ui = fixture({ isCurrent: () => current, post: () => reply.promise });
  const sent = controller.send(ui.options);
  const before = [...ui.events];
  current = false;
  reply.resolve({});
  assert.equal(await sent, false);
  assert.deepEqual(ui.events, before);
  assert.equal(ui.draft(), "  Plan my release  ");
});

test("a failed response for a changed account cannot report an error to the new account", async () => {
  const controller = createAutomationChatController();
  const reply = deferred();
  let current = true;
  const ui = fixture({ isCurrent: () => current, post: () => reply.promise });
  const sent = controller.send(ui.options);
  const before = [...ui.events];
  current = false;
  reply.reject(new Error("old account failure"));
  assert.equal(await sent, false);
  assert.deepEqual(ui.events, before);
});

test("account invalidation during acceptance does not launch a stale conversation refresh", async () => {
  const controller = createAutomationChatController();
  let current = true;
  const ui = fixture({
    isCurrent: () => current,
    accepted: () => {
      current = false;
    },
  });
  assert.equal(await controller.send(ui.options), false);
  assert.equal(ui.events.includes("refresh"), false);
  assert.equal(
    ui.events.some(
      (entry) =>
        Array.isArray(entry) && entry[0] === "busy" && entry[1] === false,
    ),
    false,
  );
});

test("a changed account during refresh receives no later success, error or busy callbacks", async () => {
  for (const reject of [false, true]) {
    const controller = createAutomationChatController();
    const refresh = deferred<void>();
    let current = true;
    const ui = fixture({
      isCurrent: () => current,
      refresh: () => refresh.promise,
    });
    const sent = controller.send(ui.options);
    await Promise.resolve();
    const before = [...ui.events];
    assert.ok(before.includes("accepted"));
    current = false;
    if (reject) refresh.reject(new Error("old refresh failure"));
    else refresh.resolve();
    assert.equal(await sent, false);
    assert.deepEqual(ui.events, before);
  }
});

test("cancel permits a new send while a late old result cannot release its lock or update its UI", async () => {
  for (const rejectOld of [false, true]) {
    const controller = createAutomationChatController();
    const oldReply = deferred();
    const old = fixture({ post: () => oldReply.promise });
    const oldSent = controller.send(old.options);
    const oldBefore = [...old.events];
    controller.cancel();
    const newReply = deferred();
    let newPosts = 0;
    const next = fixture({
      owner: "owner-b",
      post: () => {
        newPosts++;
        return newReply.promise;
      },
    });
    const newSent = controller.send(next.options);
    const newBefore = [...next.events];
    if (rejectOld) oldReply.reject(new Error("retired request"));
    else oldReply.resolve({});
    assert.equal(await oldSent, false);
    assert.deepEqual(old.events, oldBefore);
    assert.deepEqual(next.events, newBefore);
    assert.equal(await controller.send(next.options), false);
    assert.equal(newPosts, 1);
    newReply.resolve({});
    assert.equal(await newSent, true);
    assert.deepEqual(next.events.at(-1), ["busy", false]);
  }
});

test("cancel during a refresh cannot let its completion clear a newer pending request", async () => {
  const controller = createAutomationChatController();
  const oldRefresh = deferred<void>();
  const old = fixture({ refresh: () => oldRefresh.promise });
  const oldSent = controller.send(old.options);
  await Promise.resolve();
  assert.ok(old.events.includes("accepted"));
  controller.cancel();
  const newReply = deferred();
  const next = fixture({ owner: "owner-b", post: () => newReply.promise });
  const newSent = controller.send(next.options);
  oldRefresh.resolve();
  assert.equal(await oldSent, false);
  assert.equal(await controller.send(next.options), false);
  newReply.resolve({});
  assert.equal(await newSent, true);
});
