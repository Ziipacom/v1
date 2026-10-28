import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createProfileImageSync } from "../src/lib/profile-sync.ts";
import { createGalleryStillCache } from "../src/lib/gallery-still-cache.ts";
import type { ProfileImages } from "../src/lib/types.ts";

const images = (id: string): ProfileImages => ({
  avatar_media_id: id,
  avatar_url: `/api/creator/profile-images/${id}`,
  cover_media_id: null,
  cover_sample: "/media/ocean.jpg",
  cover_url: "/media/ocean.jpg",
});
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test("profile read failure retains confirmed images; late reads cannot replace a write receipt or a changed account", async () => {
  let token: string | null = "owner",
    latest = images("first");
  const pending: ((profile: ProfileImages) => void)[] = [];
  const sync = createProfileImageSync({
    currentToken: () => token,
    read: () => new Promise((resolve) => pending.push(resolve)),
    apply: (value) => {
      latest = value;
    },
  });
  const read = sync.refresh("owner");
  sync.record(images("written"), "owner");
  pending[0](images("old"));
  assert.equal(await read, false);
  assert.equal(latest.avatar_media_id, "written");
  const other = sync.refresh("owner");
  token = "another";
  pending[1](images("old-owner"));
  assert.equal(await other, false);
  assert.equal(sync.record(images("forbidden"), "owner"), false);
  assert.equal(latest.avatar_media_id, "written");
  sync.invalidate();
  token = "owner";
  assert.equal(latest.avatar_media_id, "written");
});

function syncReads() {
  let token = "owner";
  const applied: ProfileImages[] = [];
  const reads: {
    token: string;
    resolve: (profile: ProfileImages) => void;
    reject: (error: Error) => void;
  }[] = [];
  const sync = createProfileImageSync({
    currentToken: () => token,
    read: (owner) =>
      new Promise<ProfileImages>((resolve, reject) => {
        reads.push({ token: owner, resolve, reject });
      }),
    apply: (profile) => {
      applied.push(profile);
    },
  });
  return {
    sync,
    reads,
    applied,
    account(next: string) {
      token = next;
    },
  };
}

test("concurrent profile refreshes share only their pending read, not a successful cached result", async () => {
  const { sync, reads, applied } = syncReads();
  const first = sync.refresh("owner");
  assert.equal(sync.refresh("owner"), first);
  assert.equal(sync.refresh("owner"), first);
  assert.equal(reads.length, 1);
  reads[0].resolve(images("current"));
  assert.equal(await first, true);
  assert.equal(applied.length, 1);
  const next = sync.refresh("owner");
  assert.notEqual(next, first);
  assert.equal(reads.length, 2);
  reads[1].resolve(images("changed-on-other-device"));
  await next;
  assert.equal(applied.at(-1)?.avatar_media_id, "changed-on-other-device");
});

test("shared refresh failure keeps confirmed artwork and permits a new request", async () => {
  const { sync, reads, applied } = syncReads();
  sync.record(images("confirmed"), "owner");
  const first = sync.refresh("owner");
  const second = sync.refresh("owner");
  const failedFirst = assert.rejects(first, /offline/);
  const failedSecond = assert.rejects(second, /offline/);
  reads[0].reject(new Error("offline"));
  await Promise.all([failedFirst, failedSecond]);
  assert.equal(reads.length, 1);
  assert.deepEqual(
    applied.map((profile) => profile.avatar_media_id),
    ["confirmed"],
  );
  const retry = sync.refresh("owner");
  assert.equal(reads.length, 2);
  reads[1].resolve(images("restored"));
  await retry;
  assert.equal(applied.at(-1)?.avatar_media_id, "restored");
});

test("a confirmed artwork write prevents sharing or applying a read from before the mutation", async () => {
  const { sync, reads, applied } = syncReads();
  const before = sync.refresh("owner");
  sync.record(images("saved"), "owner");
  const after = sync.refresh("owner");
  assert.notEqual(after, before);
  assert.equal(reads.length, 2);
  reads[1].resolve(images("saved-current"));
  await after;
  reads[0].resolve(images("before-save"));
  assert.equal(await before, false);
  assert.deepEqual(
    applied.map((profile) => profile.avatar_media_id),
    ["saved", "saved-current"],
  );
});

test("forced refresh and bootstrap boundaries start fresh reads and retain request ordering", async () => {
  for (const boundary of ["force", "bootstrap"] as const) {
    const { sync, reads, applied } = syncReads();
    const before = sync.refresh("owner");
    const bootstrap = boundary === "bootstrap" ? sync.beginBootstrap() : null;
    const after = sync.refresh("owner", { force: boundary === "force" });
    assert.notEqual(after, before);
    assert.equal(sync.refresh("owner"), after);
    assert.equal(reads.length, 2);
    if (bootstrap !== null)
      assert.equal(sync.acceptBootstrap(bootstrap, "owner"), true);
    reads[1].resolve(images("newer-read"));
    await after;
    reads[0].resolve(images("older-read"));
    assert.equal(await before, false);
    assert.deepEqual(
      applied.map((profile) => profile.avatar_media_id),
      ["newer-read"],
    );
  }
});

test("an old account's completion cannot apply artwork or clear a new account's pending read", async () => {
  const { sync, reads, applied, account } = syncReads();
  const old = sync.refresh("owner");
  account("other");
  sync.invalidate();
  assert.equal(await sync.refresh("owner"), false);
  const current = sync.refresh("other");
  reads[0].resolve(images("old-owner"));
  assert.equal(await old, false);
  assert.equal(sync.refresh("other"), current);
  assert.equal(reads.length, 2);
  reads[1].resolve(images("other-owner"));
  await current;
  assert.deepEqual(
    applied.map((profile) => profile.avatar_media_id),
    ["other-owner"],
  );
});

/** Execute the actual provider with an in-memory account server and Activity events. */
function providerUI() {
  const code = ts.transpileModule(
    readFileSync(new URL("../src/provider.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exported: Record<string, any> = {},
    hooks: any[] = [],
    effects: (() => void)[] = [];
  const cleanups = new Set<{ cleanup?: () => void }>();
  const listeners = new Set<(state: string) => void>();
  let cursor = 0;
  let serverProfile = images("initial"),
    background = "active";
  const session = {
    access_token: "owner",
    expires_at: "2030-01-01T00:00:00Z",
    user: { id: 1, name: "Owner" },
  };
  const calls: { path: string; body?: unknown }[] = [];
  let bootstrapRead: (() => Promise<any>) | null = null;
  let profileRead: (() => Promise<ProfileImages>) | null = null;
  let clearSessionWrite: (() => Promise<void>) | null = null;
  const stillCache = createGalleryStillCache();
  const bootstrap = () => ({
    items: [],
    drafts: [],
    preferences: { saved: [] },
    feeds: [],
    community_feeds: [],
    connections: [],
    distributions: [],
    profile: serverProfile,
  });
  class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super("API error");
      this.status = status;
    }
  }
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useContext() {},
    useState(initial: any) {
      const slot = cursor++;
      if (!(slot in hooks))
        hooks[slot] = typeof initial === "function" ? initial() : initial;
      return [
        hooks[slot],
        (value: any) => {
          hooks[slot] =
            typeof value === "function" ? value(hooks[slot]) : value;
        },
      ];
    },
    useRef(current: any) {
      const slot = cursor++;
      return (hooks[slot] ||= { current });
    },
    useCallback(fn: any, deps: any[]) {
      const slot = cursor++;
      if (
        !hooks[slot] ||
        deps.some((value, n) => value !== hooks[slot].deps[n])
      )
        hooks[slot] = { deps, fn };
      return hooks[slot].fn;
    },
    useEffect(fn: any, deps: any[]) {
      const slot = cursor++,
        previous = hooks[slot];
      if (!previous || deps.some((value, n) => value !== previous.deps[n])) {
        const next = { deps, cleanup: undefined as any };
        hooks[slot] = next;
        cleanups.add(next);
        effects.push(() => {
          previous?.cleanup?.();
          if (previous) previous.cleanup = undefined;
          next.cleanup = fn();
        });
      }
    },
  };
  new Function("exports", "require", code)(exported, (name: string) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime")
      return { jsx: (type: any, props: any) => ({ type, props }) };
    if (name === "react-native")
      return {
        Platform: { OS: "android" },
        AppState: {
          get currentState() {
            return background;
          },
          addEventListener(_name: string, fn: (state: string) => void) {
            listeners.add(fn);
            return {
              remove() {
                listeners.delete(fn);
              },
            };
          },
        },
      };
    if (name === "./lib/api")
      return {
        ApiError,
        readSession: async () => session,
        clearSession: async () => {
          if (clearSessionWrite) await clearSessionWrite();
        },
        writeSession: async () => {},
        request: async (path: string, _token: string, body?: unknown) => {
          calls.push({ path, body });
          if (path === "/api/me") return session.user;
          if (path === "/api/creator/bootstrap")
            return bootstrapRead ? bootstrapRead() : bootstrap();
          if (path === "/api/creator/profile")
            return profileRead ? profileRead() : serverProfile;
          if (path === "/api/mobile/auth/login") return session;
          throw new Error(`Unexpected account request ${path}`);
        },
      };
    if (name === "./lib/config")
      return {
        demoEnabled: false,
        portalMode: false,
        policyVersion: "fixture",
      };
    if (name === "./lib/local-media") return { clearDraftMedia() {} };
    if (name === "./lib/types") return { emptyPreferences: { saved: [] } };
    if (name === "./lib/demo.json") return { default: { items: [] } };
    if (name === "./lib/wallet-connector")
      return { disconnectWallet: async () => {} };
    if (name === "./lib/network-hub")
      return { emptyNetworkHub: () => ({ providers: [] }) };
    if (name === "./lib/editor-save")
      return { applyConfirmedEditorItem: (state: any) => state };
    if (name === "./lib/profile-sync") return { createProfileImageSync };
    if (name === "./lib/gallery-still-cache")
      return { webGalleryStillCache: stillCache };
    if (name === "./theme") return { useTheme() {} };
    throw new Error(`Unexpected provider dependency ${name}`);
  });
  return {
    calls,
    bootstrap,
    session,
    stillCache,
    render() {
      cursor = 0;
      return exported.ZiipaProvider({ children: null }).props.value;
    },
    flush() {
      while (effects.length) effects.shift()!();
    },
    unmount() {
      cleanups.forEach((value) => {
        value.cleanup?.();
        value.cleanup = undefined;
      });
    },
    server(profile: ProfileImages) {
      serverProfile = profile;
    },
    deferBootstrap(read: (() => Promise<any>) | null) {
      bootstrapRead = read;
    },
    deferProfile(read: (() => Promise<ProfileImages>) | null) {
      profileRead = read;
    },
    deferClearSession(write: (() => Promise<void>) | null) {
      clearSessionWrite = write;
    },
    activity(state: string) {
      background = state;
      listeners.forEach((fn) => fn(state));
    },
  };
}

async function restored(ui: ReturnType<typeof providerUI>) {
  ui.render();
  ui.flush();
  await tick();
  const value = ui.render();
  ui.flush();
  return value;
}

test("restored and authenticated provider leases forget cached stills before session storage finishes and never revive after relogin", async () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV6sAAAAASUVORK5CYII=";
  for (const mode of ["restore", "authenticate"]) {
    const ui = providerUI();
    try {
      let value = await restored(ui);
      if (mode === "authenticate") {
        await value.forgetSession();
        await ui
          .render()
          .authenticate("owner@example.test", "fixture-not-a-password");
        value = ui.render();
      }
      const beforeLogout = value.stillCacheLease;
      assert.ok(beforeLogout, `${mode} exposes its provider-issued lease`);
      assert.equal(ui.stillCache.isActive(beforeLogout), true);
      assert.equal(ui.stillCache.put(beforeLogout, "private-clip", png), true);
      assert.equal(ui.stillCache.get(beforeLogout, "private-clip"), png);

      let finishStorage!: () => void;
      let storagePending = true;
      ui.deferClearSession(
        () =>
          new Promise<void>((resolve) => {
            finishStorage = () => {
              storagePending = false;
              resolve();
            };
          }),
      );
      const forgetting = value.forgetSession();
      assert.equal(storagePending, true);
      assert.equal(ui.stillCache.isActive(beforeLogout), false);
      assert.equal(ui.stillCache.get(beforeLogout, "private-clip"), null);
      assert.equal(ui.stillCache.put(beforeLogout, "late-capture", png), false);
      assert.equal(ui.render().stillCacheLease, null);
      assert.notEqual(
        ui.render().session,
        null,
        "storage completion is still pending; invalidation did not wait for session state cleanup",
      );

      finishStorage();
      await forgetting;
      ui.deferClearSession(null);
      assert.equal(ui.render().session, null);
      await ui
        .render()
        .authenticate("owner@example.test", "fixture-not-a-password");
      const afterLogin = ui.render().stillCacheLease;
      assert.ok(afterLogin);
      assert.notEqual(afterLogin, beforeLogout);
      assert.equal(ui.stillCache.isActive(afterLogin), true);
      assert.equal(ui.stillCache.get(afterLogin, "private-clip"), null);
      assert.equal(ui.stillCache.get(afterLogin, "late-capture"), null);
      assert.equal(
        ui.stillCache.put(beforeLogout, "late-after-relogin", png),
        false,
      );
      assert.equal(ui.stillCache.put(afterLogin, "current-clip", png), true);
      assert.equal(ui.stillCache.get(afterLogin, "current-clip"), png);
    } finally {
      ui.unmount();
    }
  }
});

test("cold app/update hydration and background resume use saved server artwork from another device", async () => {
  const ui = providerUI();
  try {
    ui.server(images("changed-on-web"));
    assert.equal(
      (await restored(ui)).data.profile.avatar_media_id,
      "changed-on-web",
    );
    ui.server(images("later-web-change"));
    ui.activity("background");
    ui.activity("active");
    await tick();
    assert.equal(ui.render().data.profile.avatar_media_id, "later-web-change");
    assert.equal(
      ui.calls.filter((call) => call.path === "/api/creator/profile").length,
      1,
    );
    assert.ok(ui.calls.every((call) => call.body === undefined));
  } finally {
    ui.unmount();
  }
});

test("screen-focus and foreground profile requests share one real provider API read", async () => {
  const ui = providerUI();
  try {
    const value = await restored(ui);
    let finish!: (profile: ProfileImages) => void;
    ui.deferProfile(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const focusRead = value.refreshProfileImages();
    ui.activity("background");
    ui.activity("active");
    const repeatedFocus = value.refreshProfileImages();
    assert.equal(
      ui.calls.filter((call) => call.path === "/api/creator/profile").length,
      1,
    );
    finish(images("shared-current"));
    await Promise.all([focusRead, repeatedFocus]);
    await tick();
    assert.equal(ui.render().data.profile.avatar_media_id, "shared-current");
    assert.ok(ui.calls.every((call) => call.body === undefined));
  } finally {
    ui.unmount();
  }
});

test("profile receipts update shared headers immediately while stale bootstrap still refreshes other fields", async () => {
  const ui = providerUI();
  try {
    const value = await restored(ui);
    let finish!: (value: any) => void;
    ui.deferBootstrap(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = value.refresh();
    value.recordProfileImages(images("confirmed-save"), "owner");
    assert.equal(ui.render().data.profile.avatar_media_id, "confirmed-save");
    assert.equal(
      ui.render().refreshing,
      true,
      "lightweight image updates must not end unrelated refresh UI",
    );
    finish({
      ...ui.bootstrap(),
      profile: images("old-snapshot"),
      items: [{ id: "new-creation" }],
      preferences: { saved: ["new-creation"] },
    });
    await refresh;
    const next = ui.render();
    assert.equal(next.data.profile.avatar_media_id, "confirmed-save");
    assert.equal(next.data.items[0].id, "new-creation");
    assert.deepEqual(next.data.preferences.saved, ["new-creation"]);
    assert.equal(next.refreshing, false);
  } finally {
    ui.unmount();
  }
});

test("late login bootstrap success or failure cannot erase a newer same-account profile receipt", async () => {
  for (const fails of [false, true]) {
    const ui = providerUI();
    try {
      const value = await restored(ui);
      let finish!: (value: any) => void, reject!: (cause: Error) => void;
      ui.deferBootstrap(
        () =>
          new Promise((resolve, fail) => {
            finish = resolve;
            reject = fail;
          }),
      );
      const login = value.authenticate(
        "owner@example.test",
        "fixture-not-a-password",
      );
      await tick();
      ui.render().recordProfileImages(images("new-during-login"), "owner");
      if (fails) reject(new Error("bootstrap unavailable"));
      else
        finish({
          ...ui.bootstrap(),
          items: [{ id: "fresh" }],
          profile: images("stale-login-snapshot"),
        });
      await login;
      assert.equal(
        ui.render().data.profile.avatar_media_id,
        "new-during-login",
      );
      if (!fails) assert.equal(ui.render().data.items[0].id, "fresh");
    } finally {
      ui.unmount();
    }
  }
});

test("both read start orders and both completion orders retain the latest requested profile while refreshing other data", async () => {
  for (const profileStartsLater of [false, true])
    for (const profileFinishesFirst of [false, true]) {
      const ui = providerUI();
      try {
        const value = await restored(ui);
        let finishBootstrap!: (value: any) => void,
          finishProfile!: (value: ProfileImages) => void;
        ui.deferBootstrap(
          () =>
            new Promise((resolve) => {
              finishBootstrap = resolve;
            }),
        );
        ui.deferProfile(
          () =>
            new Promise((resolve) => {
              finishProfile = resolve;
            }),
        );
        let bootstrap: Promise<void>, profile: Promise<void>;
        if (profileStartsLater) {
          bootstrap = value.refresh();
          profile = value.refreshProfileImages();
        } else {
          profile = value.refreshProfileImages();
          bootstrap = value.refresh();
        }
        if (profileFinishesFirst) {
          finishProfile(images("other-device"));
          await profile;
        }
        finishBootstrap({
          ...ui.bootstrap(),
          profile: images("bootstrap"),
          items: [{ id: "fresh-content" }],
        });
        await bootstrap;
        if (!profileFinishesFirst) {
          finishProfile(images("other-device"));
          await profile;
        }
        const current = ui.render().data;
        assert.equal(
          current.profile.avatar_media_id,
          profileStartsLater ? "other-device" : "bootstrap",
        );
        assert.equal(current.items[0].id, "fresh-content");
      } finally {
        ui.unmount();
      }
    }
});

test("logout blocks late reads and receipts and a transient refresh error retains confirmed artwork", async () => {
  const ui = providerUI();
  try {
    const value = await restored(ui);
    ui.deferProfile(async () => {
      throw new Error("offline");
    });
    await assert.rejects(value.refreshProfileImages());
    assert.equal(ui.render().data.profile.avatar_media_id, "initial");
    let complete!: (profile: ProfileImages) => void;
    ui.deferProfile(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = value.refreshProfileImages();
    await value.forgetSession();
    complete(images("late-owner"));
    await pending;
    value.recordProfileImages(images("late-receipt"), "owner");
    assert.equal(ui.render().data.profile, undefined);
    assert.equal(ui.render().session, null);
  } finally {
    ui.unmount();
  }
});
