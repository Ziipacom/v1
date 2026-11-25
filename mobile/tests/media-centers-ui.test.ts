import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as recordingTypes from "../src/lib/recording-types.ts";
import * as notificationTypes from "../src/lib/notification-types.ts";
import { campaignFormats } from "../src/lib/campaign-types.ts";

type Node = { type: any; props: Record<string, any> };
const walk = (value: any): Node[] =>
  Array.isArray(value)
    ? value.flatMap(walk)
    : value && typeof value === "object" && "props" in value
      ? [value, ...walk(value.props.children)]
      : [];
const diagnostic =
  "postgres://private-token@internal.invalid synthetic Traceback line 123";
function center(
  screen: "notifications" | "recordings",
  options: {
    error?: unknown;
    enabled?: boolean;
    deviceReady?: boolean;
    tab?: string;
  } = {},
) {
  const hooks: any[] = [],
    effects: (() => any)[] = [];
  const calls: { path: string; body?: any; method?: string }[] = [],
    navigations: any[] = [];
  let cursor = 0,
    registrations = 0;
  const session = { access_token: "synthetic-owner-token", user: { id: 7 } };
  const preferences = {
    enabled: !!options.enabled,
    categories: ["calendar"],
    revision: 3,
  };
  const recording = {
    id: "receipt",
    stream_id: "stream",
    status: "ready",
    revision: 4,
    title: "My recording",
    detail: diagnostic,
    media_id: "media",
    item_id: "item",
    duration: 60,
    size: 1000,
    clips: [
      {
        item_id: "clip",
        render_id: null,
        status: "unexpected " + diagnostic,
        detail: diagnostic,
        start: 0,
        end: 30,
        rendition: "portrait",
      },
    ],
    created_at: "2026-11-25T12:00:00Z",
    updated_at: "2026-11-25T12:00:00Z",
  };
  const owned = {
    id: "item",
    creator_id: 7,
    visibility: "draft",
    demo: false,
    title: "My recording",
    category: "video",
    tags: [],
  };
  const config = {
    enabled: true,
    worker_ready: options.deviceReady !== false,
    expo_ready: true,
    web_ready: true,
    readiness_protocol: 2,
    categories: [],
    vapid_public_key: null,
    notice: diagnostic,
  };
  const api = async (path: string, body?: any) => {
    calls.push({ path, body });
    if (options.error) throw options.error;
    if (path === "/api/notifications/config") return config;
    if (path.endsWith("/preferences")) return preferences;
    if (path.endsWith("/devices"))
      return body
        ? {
            id: "new-device",
            provider: "web",
            label: "My browser",
            status: "active",
            revision: 1,
            created_at: "2026-11-25T12:00:00Z",
            last_registered_at: "2026-11-25T12:00:00Z",
          }
        : [
            {
              id: "device",
              provider: "web",
              label: "My browser",
              status: "active",
              revision: 2,
              last_registered_at: "2026-11-25T12:00:00Z",
            },
          ];
    if (path.endsWith("/deliveries"))
      return [
        {
          id: "delivery",
          category: "calendar",
          provider: "web",
          status: "unexpected " + diagnostic,
          detail: diagnostic,
          created_at: "2026-11-25T12:00:00Z",
          opened_at: null,
          provider_accepted_at: null,
        },
      ];
    if (path === "/api/live/recordings/config")
      return {
        enabled: true,
        webhook_configured: true,
        worker_ready: true,
        max_bytes: 1000000,
        max_duration_seconds: 90,
        max_clips: 3,
        automatic_publication: false,
        detail: diagnostic,
      };
    if (path === "/api/live/streams")
      return [{ id: "stream", title: "My broadcast", record: true }];
    if (path.startsWith("/api/live/recordings")) return [recording];
    if (path === "/api/creator/bootstrap")
      return { items: [], drafts: [owned] };
    return {};
  };
  const memo = (value: any, deps: any[]) => {
    const slot = cursor++;
    if (
      !hooks[slot] ||
      deps.some((item, i) => !Object.is(item, hooks[slot].deps[i]))
    )
      hooks[slot] = { value, deps };
    return hooks[slot].value;
  };
  const capture = () => () => true;
  const react = {
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
    useRef(initial: any) {
      const slot = cursor++;
      return (hooks[slot] ||= { current: initial });
    },
    useCallback: memo,
    useEffect(fn: () => any, deps: any[]) {
      const slot = cursor++,
        previous = hooks[slot];
      if (
        !previous ||
        deps.some((item, i) => !Object.is(item, previous.deps[i]))
      ) {
        previous?.cleanup?.();
        hooks[slot] = { deps };
        effects.push(() => {
          hooks[slot].cleanup = fn();
        });
      }
    },
  };
  const jsx = (type: any, props: any) =>
    typeof type === "function" ? type(props) : { type, props };
  const exports: Record<string, any> = {};
  new Function(
    "exports",
    "require",
    "setTimeout",
    "clearTimeout",
    ts.transpileModule(
      readFileSync(
        new URL(`../src/screens/${screen}.tsx`, import.meta.url),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
  )(
    exports,
    (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react-native")
        return new Proxy(
          {
            AppState: {
              currentState: "active",
              addEventListener: () => ({ remove() {} }),
            },
            Platform: { OS: "web", Version: "test" },
          },
          { get: (target: any, key) => (key in target ? target[key] : key) },
        );
      if (name === "lucide-react-native")
        return new Proxy({}, { get: (_, key) => key });
      if (name === "@react-navigation/native")
        return { useIsFocused: () => true };
      if (name === "../provider")
        return { useZiipa: () => ({ session, guest: false, api }) };
      if (name === "../components/desktop-layout")
        return { useDesktopLayout: () => ({ desktop: false }) };
      if (name === "../lib/use-operation-scope")
        return { useOperationScope: () => capture };
      if (name === "../lib/horizontal-mouse-drag")
        return { horizontalMouseDrag: () => undefined };
      if (name === "../lib/recording-types") return recordingTypes;
      if (name === "../lib/notification-types") return notificationTypes;
      if (name === "../lib/campaign-types") return { campaignFormats };
      if (name === "../lib/release-notes")
        return {
          releaseNotes: [{ version: "test", changes: ["A version note"] }],
        };
      if (name === "expo-application")
        return { nativeApplicationVersion: null, nativeBuildVersion: null };
      if (name === "expo-constants")
        return { default: { expoConfig: { version: "test" } } };
      if (name === "../lib/notification-client")
        return {
          pushCapability: async () => ({
            supported: true,
            permission: "default",
            detail: diagnostic,
          }),
          registerPushDevice: async () => {
            registrations++;
            return {
              installation_id: "new-device",
              provider: "web",
              label: "My browser",
              consent: true,
            };
          },
        };
      if (name === "../lib/creator-request")
        return {
          creatorRequest: async (
            path: string,
            _token: string,
            method: string,
            body: any,
          ) => {
            calls.push({ path, body, method });
            return { ...body, revision: 4 };
          },
        };
      if (name === "../theme")
        return {
          color: new Proxy({}, { get: () => "#333" }),
          styles: new Proxy({}, { get: () => ({}) }),
        };
      if (name.startsWith("../components/"))
        return new Proxy({}, { get: (_, key) => key });
      throw new Error(`Unexpected screen import: ${name}`);
    },
    () => 0,
    () => {},
  );
  const props = {
    route: { params: { tab: options.tab } },
    navigation: { navigate: (...args: any[]) => navigations.push(args) },
  };
  let tree: any;
  const render = () => {
    cursor = 0;
    tree =
      exports[
        screen === "notifications" ? "NotificationsScreen" : "RecordingsScreen"
      ](props);
    for (const effect of effects.splice(0)) effect();
    return tree;
  };
  const nodes = () => walk(tree);
  const find = (label: string) =>
    nodes().find(
      (node) =>
        node.props.title === label ||
        node.props.label === label ||
        node.props.accessibilityLabel === label,
    );
  const press = (label: string) => {
    const node = find(label);
    assert.ok(node, `Missing control: ${label}`);
    assert.ok(
      !node.props.disabled && !node.props.accessibilityState?.disabled,
      `Disabled control: ${label}`,
    );
    node.props.onPress();
    render();
  };
  const flush = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    render();
  };
  render();
  return {
    render,
    flush,
    press,
    find,
    nodes,
    calls,
    navigations,
    exports,
    registrations: () => registrations,
    text: () => JSON.stringify(tree),
  };
}

test("notification preferences and device permission remain separate explicit actions", async () => {
  const app = center("notifications", { tab: "Preferences" });
  await app.flush();
  app.press("Account notifications");
  assert.equal(app.find("Save preferences")?.props.disabled, true);
  app.press("I agree to receive these selected updates.");
  app.press("Save preferences");
  await app.flush();
  const write = app.calls.find((call) => call.method === "PUT");
  assert.deepEqual(write?.body, {
    enabled: true,
    categories: ["calendar"],
    revision: 3,
    consent: true,
  });
  assert.equal(app.registrations(), 0);
});

test("device setup does not request permission before the final explicit opt-in", async () => {
  const app = center("notifications", { tab: "Devices", enabled: true });
  await app.flush();
  assert.equal(app.find("Enable on this device"), undefined);
  app.press("Set up this device");
  assert.equal(app.find("Enable on this device")?.props.disabled, true);
  assert.equal(app.registrations(), 0);
  app.press(
    "Enable notifications and register this device with my Ziipa account.",
  );
  app.press("Enable on this device");
  await app.flush();
  assert.equal(app.registrations(), 1);
  assert.equal(
    app.calls.filter(
      (call) => call.path === "/api/notifications/devices" && call.body,
    ).length,
    1,
  );
});

test("unavailable delivery retains consent gating and registered-device revision removal", async () => {
  const app = center("notifications", {
    tab: "Devices",
    enabled: true,
    deviceReady: false,
  });
  await app.flush();
  app.press("Set up this device");
  app.press(
    "Enable notifications and register this device with my Ziipa account.",
  );
  assert.equal(app.find("Enable on this device")?.props.disabled, true);
  assert.equal(app.registrations(), 0);
  app.find("Enable this device")?.props.onClose();
  app.render();
  app.press("Remove My browser");
  await app.flush();
  assert.ok(
    app.calls.some(
      (call) =>
        call.path === "/api/notifications/devices/device?revision=2" &&
        call.method === "DELETE",
    ),
  );
});

test("notification receipts and failed requests never expose arbitrary diagnostic details", async () => {
  const app = center("notifications");
  await app.flush();
  assert.ok(app.text().includes("Status unavailable"));
  assert.ok(!app.text().includes(diagnostic));
  const failed = center("notifications", { error: new Error(diagnostic) });
  await failed.flush();
  assert.ok(failed.text().includes("Updates could not be loaded"));
  assert.ok(!failed.text().includes(diagnostic));
  assert.match(
    failed.exports.notificationScreenError({ outcome: "unconfirmed" }),
    /Refresh.*before trying again/,
  );
});

test("recording details keep owned-source edit available without raw receipt/clip diagnostics", async () => {
  const app = center("recordings");
  await app.flush();
  app.press("Open recording My recording");
  assert.ok(!app.text().includes(diagnostic));
  assert.ok(app.text().includes("Saved privately in your library"));
  app.press("Edit recording");
  await app.flush();
  assert.equal(app.navigations[0]?.[0], "Composer");
  assert.equal(app.navigations[0]?.[1]?.item.id, "item");
  assert.ok(
    !app.calls.some(
      (call) => call.body && /publish|distribute/.test(call.path),
    ),
  );
});

test("recording errors and unknown clip states stay short and do not claim success", async () => {
  const app = center("recordings", { error: new Error(diagnostic) });
  await app.flush();
  assert.ok(app.text().includes("Recordings could not be loaded"));
  assert.ok(!app.text().includes(diagnostic));
  assert.ok(!app.text().includes("No recordings yet"));
  assert.equal(
    app.exports.recordingClipState(diagnostic),
    "Status unavailable",
  );
  assert.match(
    app.exports.recordingScreenError({ status: 409 }),
    /changed.*Refresh/,
  );
  assert.match(
    app.exports.recordingScreenError({ outcome: "unconfirmed" }),
    /not confirmed.*Refresh/,
  );
});
