import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as discovery from "../src/lib/discovery-feed.ts";
import * as domain from "../src/lib/domain.ts";
import {
  emptyNetworkHub,
  type NetworkHub,
  type NetworkMedia,
} from "../src/lib/network-hub.ts";
import { emptyPreferences, type Item } from "../src/lib/types.ts";

type Node = { type: unknown; props: Record<string, any> };
function hooks() {
  const slots: any[] = [];
  let cursor = 0,
    changed = false;
  let effects: (() => void)[] = [];
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
    useRef(initial: unknown) {
      const id = cursor++;
      return (slots[id] ||= { current: initial });
    },
    useMemo(fn: () => any, deps: unknown[]) {
      const id = cursor++,
        old = slots[id];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n])))
        slots[id] = { deps, value: fn() };
      return slots[id].value;
    },
    useCallback(fn: unknown, deps: unknown[]) {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn: () => any, deps: unknown[] = []) {
      const id = cursor++,
        old = slots[id];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n])))
        effects.push(() => {
          old?.cleanup?.();
          slots[id] = { deps, cleanup: fn() };
        });
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) {
      return getSnapshot();
    },
  };
  return {
    react,
    render<T>(fn: () => T, flush = true) {
      let result!: T;
      for (let n = 0; n < 10; n++) {
        cursor = 0;
        changed = false;
        effects = [];
        result = fn();
        if (!flush) return result;
        effects.forEach((effect) => effect());
        if (!changed) return result;
      }
      throw new Error("Discovery did not settle");
    },
    unmount: () => slots.forEach((slot) => slot?.cleanup?.()),
  };
}
function compile(path: string, require: (name: string) => unknown) {
  const code = ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exported: Record<string, any> = {};
  new Function("exports", "require", code)(exported, require);
  return exported;
}
const creation = (id: string): Item => ({
  id,
  title: id,
  description: "Public",
  creator: "Creator",
  creator_id: 1,
  category: "video",
  visibility: "published",
  demo: false,
  label: "Post",
  tags: [],
  city: "",
  cover: "",
  media_url: `/api/creator/media/${id}`,
  content_type: "video/mp4",
});
const media: NetworkMedia = {
  id: "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/one",
  provider: "bluesky",
  title: "Network post",
  text: "Public snapshot",
  kind: "image",
  author: "Network author",
  handle: "author.bsky.social",
  url: "https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/one",
};
function importedHub() {
  const result = emptyNetworkHub();
  Object.assign(result.providers[0], {
    status: "linked",
    auth_type: "public_profile",
    can_sync: true,
    revision: "link-a",
    handle: "author.bsky.social",
    profile_url: "https://bsky.app/profile/author.bsky.social",
  });
  result.media = [media];
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function feedHook() {
  const runtime = hooks();
  const requests: {
    owner: string;
    path: string;
    result: ReturnType<typeof deferred<NetworkHub>>;
  }[] = [];
  const opened: string[] = [];
  let refreshes = 0;
  const context = {
    guest: false,
    session: { access_token: "account-a", user: { id: 1 } },
    data: {
      items: [creation("public")],
      preferences: emptyPreferences,
      connections: importedHub().providers,
    },
    refreshing: false,
    refresh: async () => {
      refreshes++;
    },
    api: async (path: string) => {
      const result = deferred<NetworkHub>();
      requests.push({ owner: context.session.access_token, path, result });
      return result.promise;
    },
  };
  const exported = compile("../src/lib/use-discovery-feed.ts", (name) => {
    if (name === "react") return runtime.react;
    if (name === "@react-navigation/native")
      return {
        useFocusEffect: (fn: () => any) => runtime.react.useEffect(fn, [fn]),
      };
    if (name === "react-native")
      return {
        Linking: {
          openURL: async (url: string) => {
            opened.push(url);
          },
        },
      };
    if (name === "../provider") return { useZiipa: () => context };
    if (name === "./discovery-feed") return discovery;
    if (name === "./use-network-snapshot-expiry")
      return compile(
        "../src/lib/use-network-snapshot-expiry.ts",
        (dependency) => {
          if (dependency === "react") return runtime.react;
          if (dependency === "./discovery-feed") return discovery;
          throw new Error(dependency);
        },
      );
    throw new Error(name);
  });
  const render = (flush = true) =>
    runtime.render(() => exported.useDiscoveryFeed(), flush) as ReturnType<
      typeof import("../src/lib/use-discovery-feed").useDiscoveryFeed
    >;
  return {
    context,
    requests,
    opened,
    render,
    unmount: runtime.unmount,
    refreshes: () => refreshes,
  };
}

test("Discover reads only the current account's existing hub and masks prior snapshots before effects or late responses", async () => {
  const ui = feedHook();
  let model = ui.render();
  assert.deepEqual(
    ui.requests.map((request) => request.path),
    ["/api/social/hub"],
  );
  ui.requests[0].result.resolve(importedHub());
  await new Promise<void>((resolve) => setImmediate(resolve));
  model = ui.render();
  assert.equal(model.networkCount, 1);
  const oldOpen = model.openNetwork;
  ui.context.session = { access_token: "account-b", user: { id: 2 } };
  assert.equal(
    ui.render(false).networkCount,
    0,
    "a new account must never render the previous account's snapshot",
  );
  await oldOpen(media);
  assert.deepEqual(ui.opened, []);
  model = ui.render();
  assert.equal(model.networkCount, 0);
  assert.equal(ui.requests.at(-1)?.owner, "account-b");
  ui.requests.at(-1)!.result.resolve(emptyNetworkHub());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ui.render().networkCount, 0);
  ui.unmount();
});

test("late network reads after account change or unmount cannot restore old imports", async () => {
  const ui = feedHook();
  ui.render();
  ui.context.session = { access_token: "account-b", user: { id: 2 } };
  ui.render();
  ui.requests[0].result.resolve(importedHub());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ui.render().networkCount, 0);
  ui.unmount();
  ui.requests[1].result.resolve(importedHub());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ui.opened.length, 0);
});

test("disconnect or relink masks the old snapshot synchronously and a failed hub read cannot reinstate it", async () => {
  for (const relink of ["disconnect", "different-handle", "same-handle"]) {
    const ui = feedHook();
    ui.render();
    ui.requests[0].result.resolve(importedHub());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ui.render().networkCount, 1);
    const next = emptyNetworkHub();
    if (relink !== "disconnect")
      Object.assign(next.providers[0], {
        status: "linked",
        auth_type: "public_profile",
        revision: "link-b",
        handle:
          relink === "same-handle"
            ? "author.bsky.social"
            : "different.bsky.social",
        profile_url:
          relink === "same-handle"
            ? "https://bsky.app/profile/author.bsky.social"
            : "https://bsky.app/profile/different.bsky.social",
      });
    ui.context.data.connections = next.providers;
    assert.equal(ui.render(false).networkCount, 0);
    ui.render();
    ui.requests
      .at(-1)!
      .result.reject(new Error("offline after changing the connection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ui.render().networkCount, 0);
    ui.unmount();
  }
});

test("explicit refresh changes the mix but failed reads retain the same account's last public snapshot", async () => {
  const ui = feedHook();
  ui.render();
  ui.requests[0].result.resolve(importedHub());
  await new Promise<void>((resolve) => setImmediate(resolve));
  let model = ui.render();
  const seed = model.seed;
  const refresh = model.refreshFeed();
  ui.requests[1].result.reject(new Error("private transport diagnostic"));
  await refresh;
  model = ui.render();
  assert.notEqual(model.seed, seed);
  assert.equal(model.networkCount, 1);
  assert.match(model.networkError, /last imported snapshot/);
  assert.equal(model.networkError.includes("private transport"), false);
  assert.equal(ui.refreshes(), 1);
  await model.openNetwork(media);
  assert.deepEqual(ui.opened, [media.url]);
  ui.unmount();
});

test("all supported connection revisions and permission withdrawal invalidate former snapshots before failed reads", async () => {
  for (const provider of [
    "facebook",
    "instagram",
    "tiktok",
    "youtube",
  ] as const) {
    const ui = feedHook(),
      value = emptyNetworkHub();
    const account = value.providers.find((row) => row.provider === provider)!;
    const urls = {
      facebook: "https://www.facebook.com/123/posts/456",
      instagram: "https://www.instagram.com/p/ABC/",
      tiktok: "https://www.tiktok.com/@creator/video/123",
      youtube: "https://www.youtube.com/watch?v=aBcDeFg_-12",
    };
    Object.assign(account, {
      status: "connected",
      auth_type: "oauth",
      can_sync: true,
      revision: "grant-a",
      selected_import_target_id: "mine",
      import_targets: [
        { id: "mine", name: "My account", kind: "account", url: "" },
      ],
      snapshot_expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    account.capabilities.public_feed = true;
    value.media = [
      { ...media, provider, id: "same-id", kind: "video", url: urls[provider] },
    ];
    ui.context.data.connections = value.providers;
    ui.render();
    ui.requests[0].result.resolve(value);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ui.render().networkCount, 1, provider);
    const changed = { ...account, revision: "grant-b", can_sync: false };
    ui.context.data.connections = value.providers.map((row) =>
      row.provider === provider ? changed : row,
    );
    assert.equal(
      ui.render(false).networkCount,
      0,
      `${provider} invalidates before effects`,
    );
    ui.render();
    ui.requests
      .at(-1)!
      .result.reject(new Error("new permission state unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ui.render().networkCount, 0);
    ui.unmount();
  }
});

test("a focused public snapshot disappears at its local deadline without another API or provider request", async () => {
  const ui = feedHook(),
    value = emptyNetworkHub();
  const account = value.providers.find((row) => row.provider === "youtube")!;
  Object.assign(account, {
    status: "linked",
    auth_type: "public_profile",
    can_sync: true,
    snapshot_expires_at: new Date(Date.now() + 500).toISOString(),
    revision: "public-a",
  });
  account.capabilities.public_feed = true;
  value.media = [
    {
      ...media,
      provider: "youtube",
      id: "clip",
      kind: "video",
      url: "https://www.youtube.com/watch?v=aBcDeFg_-12",
    },
  ];
  ui.context.data.connections = value.providers;
  ui.render();
  ui.requests[0].result.resolve(value);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ui.render().networkCount, 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 550));
  assert.equal(ui.render().networkCount, 0);
  assert.equal(
    ui.requests.length,
    1,
    "expiry is a local mask, not a polling request",
  );
  assert.equal(ui.refreshes(), 0);
  ui.unmount();
});

function flatten(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  return !value || typeof value !== "object" || !value.props
    ? []
    : [value, ...flatten(value.props.children)];
}

test("Studio Discover's media surface opens Ziipa's existing feed and attributed network originals separately", () => {
  const runtime = hooks(),
    opened: string[] = [],
    network: string[] = [];
  const ziipa = creation("public");
  const entries: discovery.DiscoveryEntry[] = [
    { id: "ziipa:public", source: "ziipa", item: ziipa },
    { id: "network:one", source: "network", media },
  ];
  const props = {
    items: [ziipa],
    entries,
    editing: false,
    refreshKey: 1,
    onOpen: (item: Item) => opened.push(item.id),
    onOpenNetwork: (item: NetworkMedia) => network.push(item.url),
  };
  const jsx = (type: unknown, values: any) => ({ type, props: values });
  const exported = compile("../src/components/studio-feed.tsx", (name) => {
    if (name === "react") return runtime.react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native")
      return {
        FlatList: "FlatList",
        View: "View",
        Text: "Text",
        Pressable: "Pressable",
        StyleSheet: { absoluteFill: {} },
      };
    if (name === "expo-linear-gradient")
      return { LinearGradient: "LinearGradient" };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => String(key) });
    if (name === "./reel-media") return { ReelMedia: "ReelMedia" };
    if (name === "./discovery-network-card")
      return { DiscoveryNetworkPreview: "NetworkPreview" };
    if (name === "./device-preferences")
      return {
        useDevicePreferences: () => ({
          ready: true,
          reducedMotion: false,
          preferences: { autoplay: true, startMuted: true },
        }),
      };
    if (name === "../lib/domain") return domain;
    if (name === "../lib/discovery-feed") return discovery;
    if (name === "../theme")
      return {
        useTheme() {},
        color: {},
        font: {},
        themedStyles: (fn: () => any) => fn(),
      };
    throw new Error(name);
  });
  const render = () =>
    flatten(runtime.render(() => exported.StudioFeed(props)));
  let nodes = render();
  nodes[0].props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  nodes = render();
  const list = nodes.find((node) => node.type === "FlatList")!;
  const row = (index: number) =>
    flatten(list.props.renderItem({ item: entries[index], index }));
  row(0)
    .find(
      (node) => node.props.accessibilityLabel === "Open public in Gallery feed",
    )!
    .props.onPress();
  assert.deepEqual(opened, ["public"]);
  row(1)
    .find(
      (node) =>
        node.props.accessibilityLabel === "Open Network post on Bluesky",
    )!
    .props.onPress();
  assert.deepEqual(network, [media.url]);
  assert.equal(
    row(1).some((node) => node.type === "ReelMedia"),
    false,
    "an imported post is not an owned Ziipa player or social post",
  );
  props.editing = true;
  nodes = render();
  const pausedList = nodes.find((node) => node.type === "FlatList")!;
  assert.equal(pausedList.props.scrollEnabled, false);
  const pausedRow = flatten(
    pausedList.props.renderItem({ item: entries[0], index: 0 }),
  );
  assert.equal(
    pausedRow.find(
      (node) => node.props.accessibilityLabel === "Open public in Gallery feed",
    )!.props.disabled,
    true,
  );
  runtime.unmount();
});
