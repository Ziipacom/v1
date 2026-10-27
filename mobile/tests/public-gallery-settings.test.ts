import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as gallery from "../src/lib/public-gallery.ts";

type Node = { type: any; props: Record<string, any>; key?: string };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const state = (changes: Record<string, unknown> = {}) => ({
  slug: null,
  enabled: false,
  revision: 0,
  public_url: null,
  profile_public: true,
  pending_render_count: 0,
  ...changes,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function panel(
  options: { saved?: ReturnType<typeof state>; get?: Promise<unknown> } = {},
) {
  const hooks: any[] = [];
  let cursor = 0,
    changed = false,
    mountedKey: string | undefined,
    tree: Node;
  let effects: (() => void)[] = [];
  const context = { token: "owner-a", focused: true, platform: "android" };
  const server = {
    saved: options.saved || state(),
    get: options.get,
    post: undefined as Promise<unknown> | undefined,
  };
  const calls: { owner: string; path: string; data?: any }[] = [];
  const copied: string[] = [],
    opened: string[] = [],
    shared: string[] = [];
  const api = async (path: string, data?: any) => {
    calls.push({ owner: context.token, path, data });
    if (data !== undefined) {
      if (server.post) return server.post;
      const next = path.endsWith("/disable")
        ? { slug: server.saved.slug, enabled: false }
        : data;
      server.saved = state({
        ...server.saved,
        ...next,
        revision: data.revision + 1,
        public_url: next.enabled ? `https://ziipa.com/g/${next.slug}` : null,
      });
      return server.saved;
    }
    return server.get || server.saved;
  };
  const react = {
    useState(initial: any) {
      const index = cursor++;
      hooks[index] ??= {
        value: typeof initial === "function" ? initial() : initial,
      };
      return [
        hooks[index].value,
        (next: any) => {
          const value =
            typeof next === "function" ? next(hooks[index].value) : next;
          if (!Object.is(value, hooks[index].value)) changed = true;
          hooks[index].value = value;
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      return (hooks[index] ??= { current: initial });
    },
    useCallback(fn: any, deps: any[]) {
      const index = cursor++,
        previous = hooks[index];
      if (
        !previous ||
        deps.some((value, n) => !Object.is(value, previous.deps[n]))
      )
        hooks[index] = { fn, deps };
      return hooks[index].fn;
    },
    useEffect(fn: () => void | (() => void), deps: any[]) {
      const index = cursor++,
        previous = hooks[index];
      if (
        !previous ||
        deps.some((value, n) => !Object.is(value, previous.deps[n]))
      ) {
        effects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: fn() };
        });
      }
    },
  };
  const hookExports: any = {};
  const compile = (relative: string) =>
    ts.transpileModule(
      readFileSync(new URL(relative, import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText;
  new Function(
    "exports",
    "require",
    compile("../src/lib/use-operation-scope.ts"),
  )(hookExports, () => react);
  const jsx = (type: any, props: any, key?: string) => ({ type, props, key });
  const exports: any = {};
  const platform = {
    get OS() {
      return context.platform;
    },
  };
  new Function(
    "exports",
    "require",
    compile("../src/components/public-gallery-settings.tsx"),
  )(exports, (name: string) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime")
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "@react-navigation/native")
      return {
        useIsFocused: () => context.focused,
        useFocusEffect: (fn: () => void | (() => void)) =>
          react.useEffect(
            () => (context.focused ? fn() : undefined),
            [fn, context.focused],
          ),
      };
    if (name === "react-native")
      return {
        Platform: platform,
        Pressable: "Pressable",
        Switch: "Switch",
        Text: "Text",
        View: "View",
        Linking: {
          async openURL(url: string) {
            opened.push(url);
          },
        },
        Share: {
          dismissedAction: "dismissedAction",
          async share(value: { message: string }) {
            shared.push(value.message);
            return { action: "sharedAction" };
          },
        },
      };
    if (name === "expo-clipboard")
      return {
        async setStringAsync(value: string) {
          copied.push(value);
          return true;
        },
      };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => String(key) });
    if (name === "./ui")
      return {
        Action: "Action",
        Field: "Field",
        IconButton: "IconButton",
        Notice: "Notice",
      };
    if (name === "./desktop-layout")
      return { useDesktopLayout: () => ({ desktop: false }) };
    if (name === "./desktop-workspace") return { workspace: {} };
    if (name === "../provider")
      return {
        useZiipa: () => ({
          api,
          session: context.token
            ? { access_token: context.token, user: { id: 1 } }
            : null,
        }),
      };
    if (name === "../lib/use-operation-scope") return hookExports;
    if (name === "../lib/public-gallery") return gallery;
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    throw new Error(name);
  });
  const props = { disabled: false, refreshKey: 0 };
  const nodes = (value: any): Node[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object") return [];
    return [value, ...nodes(value.props?.children)];
  };
  function render() {
    const outer = exports.PublicGallerySettingsPanel(props);
    if (mountedKey !== undefined && mountedKey !== outer.key) {
      for (const hook of hooks) hook?.cleanup?.();
      hooks.length = 0;
    }
    mountedKey = outer.key;
    for (let pass = 0; pass < 10; pass++) {
      cursor = 0;
      changed = false;
      effects = [];
      tree = outer.type(outer.props);
      for (const effect of effects) effect();
      if (!changed) return nodes(tree);
    }
    throw new Error("Gallery panel did not settle.");
  }
  function find(type: string, key: string, name: string) {
    const node = render().find(
      (node) => node.type === type && node.props[key] === name,
    );
    assert.ok(node, `Missing ${type}: ${name}`);
    return node.props;
  }
  const flush = async () => {
    await settle();
    return render();
  };
  render();
  await flush();
  return {
    context,
    server,
    calls,
    props,
    copied,
    opened,
    shared,
    render,
    flush,
    field: () => find("Field", "label", "Custom gallery address"),
    toggle: () => find("Switch", "accessibilityLabel", "Enable public gallery"),
    save: () => find("Action", "title", "Save gallery settings"),
    refresh: () => find("IconButton", "label", "Refresh gallery status"),
    link: (label: string) =>
      find("Pressable", "accessibilityLabel", `${label} public gallery link`),
    notices: () =>
      render()
        .filter((node) => node.type === "Notice")
        .map((node) => node.props.text as string),
    unmount: () => hooks.forEach((hook) => hook?.cleanup?.()),
  };
}

test("public gallery remains opt-in and saves only on an explicit gesture; link actions use the acknowledged canonical URL", async () => {
  const h = await panel();
  try {
    assert.equal(h.toggle().value, false);
    assert.equal(h.calls.filter((call) => call.data).length, 0);
    h.field().onChangeText("MY-CREATOR");
    h.toggle().onValueChange(true);
    h.render();
    assert.equal(h.calls.filter((call) => call.data).length, 0);
    const save = h.save().onPress;
    save();
    save();
    await h.flush();
    assert.deepEqual(
      h.calls.filter((call) => call.data).map((call) => call.data),
      [{ slug: "my-creator", enabled: true, revision: 0 }],
    );
    h.field().onChangeText("unsaved-name");
    h.render();
    h.link("Copy").onPress();
    await h.flush();
    h.link("Open gallery").onPress();
    await h.flush();
    h.link("Share").onPress();
    await h.flush();
    assert.deepEqual(h.copied, ["https://ziipa.com/g/my-creator"]);
    assert.deepEqual(h.opened, h.copied);
    assert.deepEqual(h.shared, h.copied);
  } finally {
    h.unmount();
  }
});

test("private profiles can save a reserved address but cannot enable a public gallery", async () => {
  const h = await panel({ saved: state({ profile_public: false }) });
  try {
    h.field().onChangeText("private-owner");
    h.render();
    assert.equal(h.toggle().disabled, true);
    h.toggle().onValueChange(true);
    h.render();
    assert.equal(h.toggle().value, false);
    h.save().onPress();
    await h.flush();
    assert.deepEqual(
      h.calls.filter((call) => call.data).map((call) => call.data),
      [{ slug: "private-owner", enabled: false, revision: 0 }],
    );
  } finally {
    h.unmount();
  }
});

test("a legacy 404 deployment never fabricates or offers a public URL", async () => {
  const pending = deferred<unknown>(),
    h = await panel({ get: pending.promise });
  try {
    pending.reject({ status: 404 });
    await h.flush();
    assert.ok(h.notices().some((text) => /deployment is not ready/.test(text)));
    assert.equal(h.field().editable, false);
    assert.equal(h.save().disabled, true);
    assert.equal(
      h
        .render()
        .some(
          (node) =>
            node.props.accessibilityLabel === "Copy public gallery link",
        ),
      false,
    );
    assert.deepEqual(h.copied, []);
  } finally {
    h.unmount();
  }
});

test("network refresh failures preserve the unsaved slug and never trigger a write", async () => {
  const h = await panel();
  try {
    h.field().onChangeText("draft-name");
    h.render();
    const pending = deferred<unknown>();
    h.server.get = pending.promise;
    h.refresh().onPress();
    pending.reject(new Error("private network detail"));
    await h.flush();
    assert.equal(h.field().value, "draft-name");
    assert.ok(h.notices().some((text) => /unsaved address is kept/.test(text)));
    assert.equal(h.calls.filter((call) => call.data).length, 0);
  } finally {
    h.unmount();
  }
});

test("revision conflicts preserve changes and require an explicit refreshed review before another save", async () => {
  const h = await panel();
  try {
    h.field().onChangeText("my-draft");
    h.render();
    const pending = deferred<unknown>();
    h.server.post = pending.promise;
    h.save().onPress();
    pending.reject({
      status: 409,
      message: "Gallery settings changed. Refresh before saving.",
    });
    await h.flush();
    assert.equal(h.field().value, "my-draft");
    assert.equal(h.save().disabled, true);
    assert.equal(h.calls.filter((call) => call.data).length, 1);
    h.server.saved = state({ slug: "other-client", revision: 7 });
    h.server.post = undefined;
    h.refresh().onPress();
    await h.flush();
    assert.equal(h.field().value, "my-draft");
    assert.equal(h.save().disabled, false);
    h.save().onPress();
    await h.flush();
    assert.equal(h.calls.filter((call) => call.data).at(-1)?.data.revision, 7);
  } finally {
    h.unmount();
  }
});

test("an unconfirmed save is reconciled with a read, never automatically replayed", async () => {
  const h = await panel();
  try {
    h.field().onChangeText("my-gallery");
    h.toggle().onValueChange(true);
    h.render();
    const pending = deferred<unknown>();
    h.server.post = pending.promise;
    h.save().onPress();
    pending.reject({ outcome: "unconfirmed" });
    await h.flush();
    assert.equal(h.save().disabled, true);
    assert.equal(h.calls.filter((call) => call.data).length, 1);
    h.server.saved = state({
      slug: "my-gallery",
      enabled: true,
      revision: 1,
      public_url: "https://ziipa.com/g/my-gallery",
    });
    h.refresh().onPress();
    await h.flush();
    assert.equal(
      h.save().disabled,
      true,
      "the read confirmed this exact desired state, so there is no new change to save",
    );
    assert.equal(h.calls.filter((call) => call.data).length, 1);
    assert.ok(
      h
        .render()
        .some(
          (node) => node.props.children === "https://ziipa.com/g/my-gallery",
        ),
    );
  } finally {
    h.unmount();
  }
});

test("late GET and POST responses cannot become another account's gallery", async () => {
  const pendingGet = deferred<unknown>(),
    h = await panel({ get: pendingGet.promise });
  try {
    h.context.token = "owner-b";
    h.server.get = undefined;
    h.server.saved = state({ slug: "owner-b" });
    h.render();
    await h.flush();
    pendingGet.resolve(state({ slug: "owner-a" }));
    await h.flush();
    assert.equal(h.field().value, "owner-b");
    h.field().onChangeText("new-owner-b");
    h.render();
    const pendingPost = deferred<unknown>();
    h.server.post = pendingPost.promise;
    h.save().onPress();
    h.context.token = "owner-c";
    h.server.post = undefined;
    h.server.saved = state({ slug: "owner-c" });
    h.render();
    await h.flush();
    pendingPost.resolve(state({ slug: "new-owner-b", revision: 1 }));
    await h.flush();
    assert.equal(h.field().value, "owner-c");
    assert.equal(h.calls.filter((call) => call.data).length, 1);
  } finally {
    h.unmount();
  }
});

test("focus refresh and saved privacy refresh preserve unsaved choices while rechecking revision and visibility", async () => {
  const h = await panel();
  try {
    h.field().onChangeText("draft-name");
    h.render();
    h.context.focused = false;
    h.render();
    h.server.saved = state({
      slug: "other-client",
      revision: 2,
      profile_public: false,
    });
    h.context.focused = true;
    h.render();
    await h.flush();
    assert.equal(h.field().value, "draft-name");
    assert.equal(h.save().disabled, true);
    assert.equal(h.toggle().disabled, true);
    h.server.saved = state({
      slug: "other-client",
      revision: 2,
      profile_public: true,
    });
    h.props.refreshKey++;
    h.render();
    await h.flush();
    assert.equal(h.field().value, "draft-name");
    assert.equal(h.toggle().disabled, false);
    assert.equal(
      h.save().disabled,
      true,
      "automatic refresh must not silently accept a conflicting revision",
    );
    h.refresh().onPress();
    await h.flush();
    assert.equal(h.save().disabled, false);
  } finally {
    h.unmount();
  }
});

test("untrusted returned links cannot reach clipboard, browser or share sheet", async () => {
  const h = await panel({
    saved: state({
      slug: "my-creator",
      enabled: true,
      public_url: "https://evil.test/g/my-creator",
    }),
  });
  try {
    assert.equal(
      h
        .render()
        .some(
          (node) =>
            node.props.accessibilityLabel === "Copy public gallery link",
        ),
      false,
    );
    assert.deepEqual(h.copied, []);
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.shared, []);
    assert.equal(h.save().disabled, true);
  } finally {
    h.unmount();
  }
});

test("revocation uses the maintenance-safe route and keeps an unfinished address change for a separate save", async () => {
  const h = await panel({
    saved: state({
      slug: "my-creator",
      enabled: true,
      revision: 3,
      public_url: "https://ziipa.com/g/my-creator",
    }),
  });
  try {
    h.field().onChangeText("unfinished__rename");
    h.toggle().onValueChange(false);
    h.render();
    h.save().onPress();
    await h.flush();
    assert.deepEqual(
      h.calls
        .filter((call) => call.data)
        .map((call) => ({ path: call.path, body: call.data })),
      [{ path: "/api/creator/gallery/disable", body: { revision: 3 } }],
    );
    assert.equal(h.field().value, "unfinished__rename");
    assert.equal(h.toggle().value, false);
    assert.ok(h.notices().some((text) => /off.*separate save/.test(text)));
    assert.equal(
      h
        .render()
        .some(
          (node) =>
            node.props.accessibilityLabel === "Copy public gallery link",
        ),
      false,
    );
  } finally {
    h.unmount();
  }
});

test("a blank address cannot be saved as null or remove a reserved name", async () => {
  const h = await panel({
    saved: state({ slug: "reserved-owner", revision: 2 }),
  });
  try {
    h.field().onChangeText("   ");
    h.render();
    assert.equal(h.save().disabled, true);
    h.save().onPress();
    await h.flush();
    assert.equal(h.calls.filter((call) => call.data).length, 0);
    assert.ok(
      h
        .notices()
        .some((text) =>
          /Enter a gallery address.*reserved names stay/.test(text),
        ),
    );
    assert.equal(
      h
        .render()
        .some(
          (node) =>
            node.props.accessibilityLabel === "Copy public gallery link",
        ),
      false,
    );
  } finally {
    h.unmount();
  }
});

test("a blank rename still permits explicit revocation and restores the retained reserved address", async () => {
  const h = await panel({
    saved: state({
      slug: "reserved-owner",
      enabled: true,
      revision: 2,
      public_url: "https://ziipa.com/g/reserved-owner",
    }),
  });
  try {
    h.field().onChangeText("");
    h.toggle().onValueChange(false);
    h.render();
    assert.equal(h.save().disabled, false);
    h.save().onPress();
    await h.flush();
    assert.deepEqual(
      h.calls
        .filter((call) => call.data)
        .map((call) => ({ path: call.path, body: call.data })),
      [{ path: "/api/creator/gallery/disable", body: { revision: 2 } }],
    );
    assert.equal(h.field().value, "reserved-owner");
    assert.equal(h.toggle().value, false);
    assert.equal(h.save().disabled, true);
    assert.ok(
      h
        .notices()
        .some((text) =>
          /previous addresses stay reserved.*account deletion/.test(text),
        ),
    );
    assert.equal(
      h
        .render()
        .some(
          (node) =>
            node.props.accessibilityLabel === "Copy public gallery link",
        ),
      false,
    );
  } finally {
    h.unmount();
  }
});

test("retired save callbacks cannot write after account replacement", async () => {
  const h = await panel();
  try {
    h.field().onChangeText("owner-a-gallery");
    h.render();
    const retiredSave = h.save().onPress;
    h.context.token = "owner-b";
    h.server.saved = state({ slug: "owner-b" });
    h.render();
    await h.flush();
    retiredSave();
    await h.flush();
    assert.equal(h.calls.filter((call) => call.data).length, 0);
    assert.equal(h.field().value, "owner-b");
  } finally {
    h.unmount();
  }
});

test("a save response must confirm the requested setting rather than displaying success for ignored input", async () => {
  const h = await panel();
  try {
    h.field().onChangeText("wanted-gallery");
    h.toggle().onValueChange(true);
    h.render();
    h.server.post = Promise.resolve(state());
    h.save().onPress();
    await h.flush();
    assert.equal(h.field().value, "wanted-gallery");
    assert.equal(h.save().disabled, true);
    assert.ok(h.notices().some((text) => /did not confirm/.test(text)));
    assert.equal(
      h
        .render()
        .some(
          (node) =>
            node.props.accessibilityLabel === "Copy public gallery link",
        ),
      false,
    );
  } finally {
    h.unmount();
  }
});

test("a confirmed legacy deployment remains unavailable until a successful new read, even if a later refresh has a network error", async () => {
  const h = await panel({
    saved: state({
      slug: "my-gallery",
      enabled: true,
      public_url: "https://ziipa.com/g/my-gallery",
    }),
  });
  try {
    const missing = deferred<unknown>();
    h.server.get = missing.promise;
    h.refresh().onPress();
    missing.reject({ status: 404 });
    await h.flush();
    const network = deferred<unknown>();
    h.server.get = network.promise;
    h.refresh().onPress();
    network.reject(new Error("offline"));
    await h.flush();
    assert.equal(h.save().disabled, true);
    assert.equal(
      h
        .render()
        .some(
          (node) =>
            node.props.accessibilityLabel === "Copy public gallery link",
        ),
      false,
    );
  } finally {
    h.unmount();
  }
});
