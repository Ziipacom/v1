import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Node = { type: unknown; props: Record<string, any> };

function accountUI(
  options: {
    guest?: boolean;
    unread?: number | null;
    logout?: () => Promise<void>;
    avatar?: string;
  } = {},
) {
  const source = readFileSync(
    new URL("../src/components/account-menu.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  const updates: unknown[] = [];
  const navigated: string[] = [];
  const alerts: string[] = [];
  let refreshes = 0;
  let logouts = 0;
  let token = "fixture-token";
  let profile = options.avatar ? { avatar_url: options.avatar } : undefined;
  const imageSources = new Map<string, unknown>();
  let hooks: any[] = [];
  let cursor = 0;
  const componentHooks = new Map<Function, any[]>();
  const exported: Record<string, any> = {};
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react")
      return {
        useRef(current: unknown) {
          return (hooks[cursor++] ||= { current });
        },
        useState(initial: unknown) {
          const slot = cursor++,
            state = hooks;
          if (!(slot in state)) state[slot] = initial;
          return [
            state[slot],
            (value: unknown) => {
              updates.push(value);
              state[slot] = value;
            },
          ];
        },
        useMemo(fn: () => unknown, deps: unknown[]) {
          const slot = cursor++;
          if (
            !hooks[slot] ||
            deps.some((value, i) => value !== hooks[slot].deps[i])
          )
            hooks[slot] = { deps, value: fn() };
          return hooks[slot].value;
        },
      };
    if (name === "react/jsx-runtime")
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "react-native")
      return {
        Alert: {
          alert: (title: string, message: string) =>
            alerts.push(`${title}: ${message}`),
        },
        Modal: "Modal",
        Image: "Image",
        Pressable: "Pressable",
        Text: "Text",
        View: "View",
      };
    if (name === "react-native-safe-area-context")
      return { useSafeAreaInsets: () => ({ top: 20 }) };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "../provider")
      return {
        useZiipa: () => ({
          session: options.guest
            ? null
            : {
                access_token: token,
                user: { id: 1, name: "Alex Creator" },
              },
          guest: options.guest ?? false,
          data: { profile },
          logout: async () => {
            logouts += 1;
            await options.logout?.();
          },
        }),
      };
    if (name === "../lib/use-account-messages")
      return {
        useAccountMessages: () => ({
          unreadNotifications: options.unread ?? null,
          refresh: async () => {
            refreshes += 1;
          },
        }),
      };
    if (name === "../lib/use-operation-scope")
      return { useOperationScope: () => () => () => true };
    if (name === "../lib/profile-image-source")
      return {
        useProfileImageSource: (
          path: string | null | undefined,
          token: string,
        ) => {
          if (!path) return null;
          const key = `${path}:${token}`;
          if (!imageSources.has(key))
            imageSources.set(key, {
              uri: path,
              headers: { Authorization: `Bearer ${token}` },
            });
          return imageSources.get(key);
        },
      };
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    throw new Error(`Unexpected account dependency ${name}`);
  });
  function render(value: any): any {
    if (Array.isArray(value)) return value.map(render);
    if (!value || typeof value !== "object" || !("props" in value))
      return value;
    if (typeof value.type === "function") {
      const previousHooks = hooks,
        previousCursor = cursor;
      hooks = componentHooks.get(value.type) || [];
      componentHooks.set(value.type, hooks);
      cursor = 0;
      const child = value.type(value.props);
      hooks = previousHooks;
      cursor = previousCursor;
      return render(child);
    }
    return {
      ...value,
      props: { ...value.props, children: render(value.props.children) },
    };
  }
  function nodes(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    return [value, ...nodes(value.props.children)];
  }
  function renderExport(name: string) {
    return nodes(
      render({
        type: exported[name],
        props: { onNavigate: (name: string) => navigated.push(name) },
      }),
    );
  }
  return {
    renderExport,
    updates,
    navigated,
    alerts,
    refreshes: () => refreshes,
    logouts: () => logouts,
    confirmProfile() {
      if (profile) profile = { ...profile };
    },
    changeSession() {
      token = "renewed-fixture-token";
    },
  };
}

test("account avatar opens its menu and refreshes only account notification status", () => {
  const ui = accountUI();
  const nodes = ui.renderExport("AccountMenu");
  const avatar = nodes.find(
    (node) =>
      node.props.accessibilityLabel === "Open account menu for Alex Creator",
  )!;
  assert.equal(avatar.props.style({ pressed: false }).width, 44);
  avatar.props.onPress();
  assert.deepEqual(ui.updates, [true]);
  assert.equal(ui.refreshes(), 1);
  assert.deepEqual(ui.navigated, []);
});

test("account menu destinations open the real profile, inbox and notification list routes", () => {
  const ui = accountUI();
  const nodes = ui.renderExport("AccountMenu");
  for (const label of ["Profile page", "Inbox", "Notifications"]) {
    const button = nodes.find(
      (node) => node.props.accessibilityLabel === label,
    )!;
    assert.ok(button);
    button.props.onPress();
    assert.ok(button.props.style({ pressed: false }).minHeight >= 44);
  }
  assert.deepEqual(ui.navigated, ["Profile", "Inbox", "NotificationMessages"]);
});

test("a green new-notification indicator appears only for confirmed unread records", () => {
  for (const unread of [null, 0]) {
    const nodes = accountUI({ unread }).renderExport("AccountMenu");
    assert.ok(
      nodes.find((node) => node.props.accessibilityLabel === "Notifications"),
    );
    assert.equal(
      nodes.some((node) => node.props.children === "New"),
      false,
    );
  }
  const nodes = accountUI({ unread: 2 }).renderExport("AccountMenu");
  assert.ok(
    nodes.find(
      (node) =>
        node.props.accessibilityLabel === "Notifications, new notifications",
    ),
  );
  assert.ok(nodes.find((node) => node.props.children === "New"));
});

test("guest avatar asks for sign-in and exposes no sign-out shortcut", () => {
  const ui = accountUI({ guest: true });
  const nodes = ui.renderExport("AccountMenu");
  nodes
    .find((node) => node.props.accessibilityLabel === "Sign in to Ziipa")!
    .props.onPress();
  assert.deepEqual(ui.navigated, ["Login"]);
  assert.equal(ui.refreshes(), 0);
  assert.deepEqual(ui.renderExport("SignOutButton"), []);
});

test("profile sign-out calls the provider once even if tapped twice", async () => {
  let finish!: () => void;
  const ui = accountUI({
    logout: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  const nodes = ui.renderExport("SignOutButton");
  const button = nodes.find(
    (node) => node.props.accessibilityLabel === "Sign out",
  )!;
  button.props.onPress();
  button.props.onPress();
  assert.equal(ui.logouts(), 1);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ui.alerts, []);
});

test("failed profile sign-out reports the error without deleting data or pretending success", async () => {
  const ui = accountUI({
    logout: async () => {
      throw new Error("Network unavailable");
    },
  });
  const nodes = ui.renderExport("SignOutButton");
  nodes
    .find((node) => node.props.accessibilityLabel === "Sign out")!
    .props.onPress();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.logouts(), 1);
  assert.deepEqual(ui.alerts, ["Couldn’t sign out: Network unavailable"]);
  assert.deepEqual(ui.navigated, []);
  assert.ok(ui.updates.includes("Network unavailable"));
});

test("the saved account avatar uses the authenticated image source instead of a public remote URL", () => {
  const path =
    "/api/creator/profile-images/3f27d47b-0c2a-49ac-bffa-1f9ee335c03d";
  const ui = accountUI({ avatar: path });
  const image = ui
    .renderExport("AccountMenu")
    .find((node) => node.type === "Image")!;
  assert.deepEqual(image.props.source, {
    uri: path,
    headers: { Authorization: "Bearer fixture-token" },
  });
  image.props.onError();
  assert.equal(
    ui.renderExport("AccountMenu").some((node) => node.type === "Image"),
    false,
  );
});

test("an account avatar retries the same URL only after a confirmed profile or session change", () => {
  const ui = accountUI({
    avatar: "/api/creator/profile-images/3f27d47b-0c2a-49ac-bffa-1f9ee335c03d",
  });
  const avatar = () =>
    ui.renderExport("AccountMenu").find((node) => node.type === "Image");
  const first = avatar()!;
  first.props.onError();
  assert.equal(avatar(), undefined);
  assert.equal(
    avatar(),
    undefined,
    "ordinary renders cannot loop a failed image",
  );
  ui.confirmProfile();
  const retried = avatar()!;
  assert.equal(retried.props.source.uri, first.props.source.uri);
  first.props.onError();
  assert.ok(
    avatar(),
    "a stale error cannot reject the newer confirmed receipt",
  );
  retried.props.onError();
  assert.equal(avatar(), undefined);
  first.props.onError();
  assert.equal(
    avatar(),
    undefined,
    "a stale error cannot clear a newer failure",
  );
  ui.changeSession();
  assert.equal(
    avatar()!.props.source.headers.Authorization,
    "Bearer renewed-fixture-token",
  );
});
