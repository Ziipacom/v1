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
  const exported: Record<string, any> = {};
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react")
      return {
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [
          initial,
          (value: unknown) => updates.push(value),
        ],
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
                access_token: "fixture-token",
                user: { id: 1, name: "Alex Creator" },
              },
          guest: options.guest ?? false,
          data: {
            profile: options.avatar
              ? { avatar_url: options.avatar }
              : undefined,
          },
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
        ) =>
          path
            ? {
                uri: path,
                headers: { Authorization: `Bearer ${token}` },
              }
            : null,
      };
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    throw new Error(`Unexpected account dependency ${name}`);
  });
  function render(value: any): any {
    if (Array.isArray(value)) return value.map(render);
    if (!value || typeof value !== "object" || !("props" in value))
      return value;
    if (typeof value.type === "function")
      return render(value.type(value.props));
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
      render(
        exported[name]({ onNavigate: (name: string) => navigated.push(name) }),
      ),
    );
  }
  return {
    renderExport,
    updates,
    navigated,
    alerts,
    refreshes: () => refreshes,
    logouts: () => logouts,
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
  assert.ok(
    ui.updates.includes(path),
    "a failed image is marked for initial-avatar fallback",
  );
});
