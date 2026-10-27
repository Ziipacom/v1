import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as hubLib from "../src/lib/network-hub.ts";
import * as imports from "../src/lib/network-imports.ts";
import * as discovery from "../src/lib/discovery-feed.ts";
import * as social from "../src/lib/social.ts";

type Node = { type: any; props: Record<string, any> };
function flat(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(flat);
  return value?.props ? [value, ...flat(value.props.children)] : [];
}
function runtime() {
  const slots: any[] = [];
  let cursor = 0,
    changed = false,
    effects: (() => void)[] = [];
  const react: any = {
    useState(initial: any) {
      const id = cursor++;
      slots[id] ||= {
        value: typeof initial === "function" ? initial() : initial,
      };
      return [
        slots[id].value,
        (next: any) => {
          const value =
            typeof next === "function" ? next(slots[id].value) : next;
          changed ||= !Object.is(value, slots[id].value);
          slots[id].value = value;
        },
      ];
    },
    useRef(initial: any) {
      return (slots[cursor++] ||= { current: initial });
    },
    useMemo(fn: () => any, deps: any[]) {
      const id = cursor++,
        old = slots[id];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n])))
        slots[id] = { deps, value: fn() };
      return slots[id].value;
    },
    useCallback(fn: any, deps: any[]) {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn: () => any, deps: any[] = []) {
      const id = cursor++,
        old = slots[id];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n])))
        effects.push(() => {
          old?.cleanup?.();
          slots[id] = { deps, cleanup: fn() };
        });
    },
  };
  return {
    react,
    render(fn: () => any) {
      for (let n = 0; n < 12; n++) {
        cursor = 0;
        changed = false;
        effects = [];
        const result = fn();
        effects.forEach((fn) => fn());
        if (!changed) return result;
      }
      throw new Error("UI did not settle");
    },
    unmount() {
      slots.forEach((value) => value?.cleanup?.());
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(native = false, initialTab = "accounts") {
  const hooks = runtime(),
    requests: { path: string; body: any }[] = [],
    opened: string[] = [];
  let hub = hubLib.emptyNetworkHub(),
    refreshes = 0;
  let connect: any = {
    status: "authorization_required",
    auth_url: `https://ziipa.com/api/social/oauth/facebook/authorize?ticket=${"A".repeat(54)}`,
    detail: "Read Page posts only.",
    requirements: [],
  };
  const context = {
    guest: false,
    session: { access_token: "owner-a" },
    data: { drafts: [], distributions: [] },
    previewNetworks: hub,
    savePreviewNetworks() {},
    refresh: async () => {
      refreshes++;
    },
    api: async (path: string, body?: any) => {
      requests.push({ path, body });
      if (path === "/api/social/hub") return hub;
      if (path.endsWith("/connect")) {
        if (connect instanceof Error) throw connect;
        return connect;
      }
      if (path.endsWith("/import-target")) {
        hub = {
          ...hub,
          providers: hub.providers.map((row) =>
            row.provider === "facebook"
              ? {
                  ...row,
                  selected_import_target_id: body.target_id,
                  revision: "14be4a4a-2083-479c-881d-297a0cc1f430",
                }
              : row,
          ),
        };
        return hub.providers[3];
      }
      throw new Error(path);
    },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  function compile(path: string) {
    const output = ts.transpileModule(
      readFileSync(new URL(path, import.meta.url), "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText;
    const exports: any = {};
    new Function("exports", "require", "__DEV__", output)(
      exports,
      (name: string) => {
        if (name === "react") return hooks.react;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "react-native")
          return {
            Platform: { OS: native ? "android" : "web" },
            Linking: {
              openURL: async (url: string) => {
                opened.push(url);
              },
            },
            StyleSheet: { absoluteFill: {}, create: (value: unknown) => value },
          };
        if (name === "@react-navigation/native")
          return {
            useIsFocused: () => true,
            useFocusEffect: (fn: any) => hooks.react.useEffect(fn, [fn]),
          };
        if (name === "../provider") return { useZiipa: () => context };
        if (name === "../lib/network-hub") return hubLib;
        if (name === "../lib/network-imports") return imports;
        if (name === "../lib/discovery-feed" || name === "./discovery-feed")
          return discovery;
        if (name === "../lib/social") return social;
        if (name === "../lib/config")
          return { canonicalApiOrigin: "https://api.ziipa.com" };
        if (name === "../lib/use-operation-scope")
          return { useOperationScope: () => () => () => true };
        if (name === "../lib/use-network-snapshot-expiry")
          return compile("../src/lib/use-network-snapshot-expiry.ts");
        if (name === "../components/desktop-layout")
          return {
            useDesktopLayout: () => ({ desktop: false, contentWidth: 400 }),
          };
        if (name === "../theme")
          return {
            color: {},
            font: {},
            styles: {},
            themeValue: (value: any) => value,
            themedStyles: (fn: any) => fn(),
          };
        return new Proxy({}, { get: (_, key) => String(key) });
      },
      false,
    );
    return exports;
  }
  const screen = compile("../src/screens/connections.tsx");
  const props = {
    route: { params: { tab: initialTab } },
    navigation: { navigate() {}, setParams() {} },
  };
  const render = () =>
    flat(
      hooks.render(() => {
        const wrapper = screen.ConnectionsScreen(props);
        return wrapper.type(wrapper.props);
      }),
    );
  const press = (title: string) => {
    const node = render().find(
      (row) =>
        row.props.title === title || row.props.accessibilityLabel === title,
    );
    assert.ok(node, `Missing ${title}`);
    assert.equal(!!node.props.disabled, false);
    node.props.onPress();
  };
  return {
    render,
    press,
    requests,
    opened,
    refreshes: () => refreshes,
    unmount: hooks.unmount,
    setHub(value: hubLib.NetworkHub) {
      hub = value;
    },
    setConnect(value: any) {
      connect = value;
    },
  };
}

test("Connections separates readiness from explicit read-only authorization and never auto-syncs or claims connection", async () => {
  const ui = harness();
  ui.render();
  await tick();
  ui.press("Manage Facebook account");
  ui.press("Set up read-only public imports");
  await tick();
  assert.deepEqual(ui.opened, []);
  assert.equal(
    ui
      .render()
      .some((row) => row.props.title === "Continue read-only authorization"),
    true,
  );
  ui.press("Continue read-only authorization");
  await tick();
  assert.equal(ui.opened.length, 1);
  assert.equal(new URL(ui.opened[0]).origin, "https://ziipa.com");
  assert.equal(
    ui.requests.some((row) => row.path.endsWith("/sync")),
    false,
  );
  assert.equal(ui.requests.filter((row) => row.body !== undefined).length, 1);
  ui.unmount();
});

test("the public import data notice opens only on an explicit gesture and uses its fixed public URL", async () => {
  const ui = harness();
  ui.render();
  await tick();
  assert.deepEqual(ui.opened, []);
  ui.press("How public imports use data");
  await tick();
  assert.deepEqual(ui.opened, ["https://ziipa.com/network-imports"]);
  assert.equal(
    ui.requests.some((row) => row.body !== undefined),
    false,
  );
  ui.unmount();
});

test("native setup offers only explicit Ziipa portal handoff and an old deployment cannot fabricate consent", async () => {
  const ui = harness(true);
  ui.setConnect({
    status: "browser_sign_in_required",
    auth_url: null,
    connect_via_portal: "https://ziipa.com/portal",
    detail: "Sign in to the same Ziipa account.",
    requirements: [],
  });
  ui.render();
  await tick();
  ui.press("Manage Facebook account");
  ui.press("Set up read-only public imports");
  await tick();
  assert.deepEqual(ui.opened, []);
  ui.press("Continue in Ziipa portal");
  await tick();
  assert.deepEqual(ui.opened, ["https://ziipa.com/portal"]);
  ui.setConnect(Object.assign(new Error("not found"), { status: 404 }));
  ui.press("Set up read-only public imports");
  await tick();
  assert.equal(
    ui
      .render()
      .some((row) => /updated Ziipa server/.test(row.props.text || "")),
    true,
  );
  assert.equal(
    ui
      .render()
      .some((row) => row.props.title === "Continue read-only authorization"),
    false,
  );
  ui.unmount();
});

test("target choice submits its acknowledged revision, refreshes owner status and leaves sync explicit", async () => {
  const ui = harness(),
    value = hubLib.emptyNetworkHub();
  Object.assign(
    value.providers.find((row) => row.provider === "facebook")!,
    {
      status: "connected",
      auth_type: "oauth",
      revision: "a39a0bde-a91e-4e5b-a58d-8348460db961",
      import_targets: [{ id: "123", name: "My Page", kind: "page", url: "" }],
    },
  );
  ui.setHub(value);
  ui.render();
  await tick();
  ui.press("Manage Facebook account");
  ui.press("Select · My Page");
  await tick();
  const write = ui.requests.find((row) => row.path.endsWith("/import-target"));
  assert.deepEqual(write, {
    path: "/api/social/facebook/import-target",
    body: {
      target_id: "123",
      revision: "a39a0bde-a91e-4e5b-a58d-8348460db961",
    },
  });
  assert.equal(
    ui.requests.some((row) => row.path.endsWith("/sync")),
    false,
  );
  assert.equal(ui.refreshes(), 1);
  assert.equal(
    ui.render().find((row) => row.props.title === "Selected · My Page")?.props
      .disabled,
    true,
  );
  ui.unmount();
});

test("Networks removes expired public snapshots from its visible feed and count without auto-refresh or sync", async () => {
  const ui = harness(false, "feed"),
    value = hubLib.emptyNetworkHub();
  const account = value.providers.find((row) => row.provider === "youtube")!;
  Object.assign(account, {
    status: "linked",
    auth_type: "public_profile",
    can_sync: true,
    snapshot_expires_at: new Date(Date.now() + 600).toISOString(),
  });
  account.capabilities.public_feed = true;
  value.media = [
    {
      id: "clip",
      provider: "youtube",
      title: "My public video",
      text: "Public",
      author: "Creator",
      handle: "channel",
      kind: "video",
      url: "https://www.youtube.com/watch?v=aBcDeFg_-12",
    },
  ];
  ui.setHub(value);
  ui.render();
  await tick();
  assert.equal(
    ui
      .render()
      .some(
        (row) =>
          row.props.accessibilityLabel === "Open My public video on YouTube",
      ),
    true,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 650));
  assert.equal(
    ui
      .render()
      .some(
        (row) =>
          row.props.accessibilityLabel === "Open My public video on YouTube",
      ),
    false,
  );
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.refreshes(), 0);
  ui.unmount();
});
