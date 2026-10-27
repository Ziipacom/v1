import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as policy from "../src/lib/internal-beta-policy.ts";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const eas = JSON.parse(readFileSync(new URL("eas.json", root), "utf8"));
const scope = policy.internalBetaScope;
const baseline = {
  ...eas.build.production.env,
  ...eas.build[scope].env,
  EAS_BUILD_PLATFORM: "ios",
  EAS_BUILD_PROFILE: scope,
};
function environment(values: Record<string, string>) {
  return {
    SystemRoot: process.env.SystemRoot || "",
    PATH: process.env.PATH || "",
    EXPO_NO_DOTENV: "1",
    NODE_ENV: "test" as const,
    ...values,
  };
}
function gate(changes: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("scripts/check-build-scope.cjs", root))],
    {
      env: environment({ ...baseline, ...changes }),
      encoding: "utf8",
    },
  );
}

test("first internal iOS build has explicit pending acceptance, exact identity and no false production acknowledgments", () => {
  const result = gate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Device QA is pending/);
  assert.match(result.stdout, /no tester distribution until the owner/);
  assert.match(result.stdout, /External testing\/public release is forbidden/);
  assert.equal(
    Object.keys(baseline).some((key) => key.endsWith("_REVIEWED")),
    false,
  );
  for (const [key, value] of Object.entries({
    EAS_BUILD_PLATFORM: "android",
    EAS_BUILD_PROFILE: "production",
    ZIIPA_BUILD_SCOPE: "",
    EXPO_PUBLIC_BUILD_SCOPE: "typo",
    APP_VARIANT: "preview",
    ZIIPA_APP_ID: "com.ziipa.app.preview",
    ZIIPA_APPLE_TEAM_ID: "OTHERTEAM",
    ZIIPA_ASC_APP_ID: "1",
    EXPO_OWNER: "other",
    EXPO_EAS_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
    EXPO_PUBLIC_API_URL: "http://127.0.0.1:8018",
    EXPO_PUBLIC_PORTAL_MODE: "true",
    EXPO_PUBLIC_ENABLE_DEMO: "true",
    EXPO_PUBLIC_ENABLE_CONCEPTS: "true",
    ZIIPA_TESTFLIGHT_DEVICE_QA: "passed",
    ZIIPA_TESTFLIGHT_PUBLIC_RELEASE: "allowed",
    ZIIPA_TESTFLIGHT_DISTRIBUTION: "external",
    ZIIPA_TESTFLIGHT_EXPORT_COMPLIANCE: "exempt",
  }))
    assert.equal(gate({ [key]: value }).status, 1, key);
});

test("production checker is byte-identical and dispatcher retains production/preview failure behavior", () => {
  const original = readFileSync(new URL("scripts/check-release.cjs", root));
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "86f3055ff985b0da4deebd2f035e72cc4a1e43b9f57fbf9f7383f0534c40f622",
  );
  const env = environment({
    EAS_BUILD_PLATFORM: "ios",
    EAS_BUILD_PROFILE: "production",
    APP_VARIANT: "production",
  });
  const old = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("scripts/check-release.cjs", root))],
    { env, encoding: "utf8" },
  );
  const current = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("scripts/check-build-scope.cjs", root))],
    { env, encoding: "utf8" },
  );
  assert.equal(current.status, 1);
  assert.equal(current.stderr, old.stderr);
  assert.match(current.stderr, /WEB3.md/);
  const preview = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("scripts/check-build-scope.cjs", root))],
    { env: environment({ APP_VARIANT: "preview" }), encoding: "utf8" },
  );
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /Preview build/);
});

test("beta app config pins iOS team, omits unreviewed encryption, and has a separate APNs-removal plugin", () => {
  const code =
    "const {default:c}=await import(process.argv[1]); console.log(JSON.stringify(c));";
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      code,
      new URL("app.config.ts", root).href,
    ],
    {
      env: environment({
        ...baseline,
        ZIIPA_ENCRYPTION_REVIEWED: "true",
        ZIIPA_USES_NON_EXEMPT_ENCRYPTION: "false",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(config.platforms, ["ios"]);
  assert.equal(config.ios.bundleIdentifier, "com.ziipa.app");
  assert.equal(config.ios.appleTeamId, "L6WH6BD2N5");
  assert.equal("ITSAppUsesNonExemptEncryption" in config.ios.infoPlist, false);
  assert.equal(config.extra.publicReleaseAllowed, false);
  assert.equal(config.extra.deviceQA, "pending");
  assert.equal(config.plugins[0], "./scripts/with-internal-testflight.cjs");
  for (const change of [
    { EXPO_OWNER: "other" },
    { EXPO_EAS_PROJECT_ID: "00000000-0000-4000-8000-000000000001" },
    { ZIIPA_APPLE_TEAM_ID: "OTHERTEAM" },
    { ZIIPA_ASC_APP_ID: "1" },
  ]) {
    const rejected = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        code,
        new URL("app.config.ts", root).href,
      ],
      {
        env: environment({ ...baseline, ...change }),
        encoding: "utf8",
      },
    );
    assert.equal(rejected.status, 1);
  }
  const pluginSource = readFileSync(
    new URL("scripts/with-internal-testflight.cjs", root),
    "utf8",
  );
  const module = { exports: null as any };
  new Function("module", "require", pluginSource)(module, (name: string) => {
    assert.equal(name, "expo/config-plugins");
    return {
      withEntitlementsPlist: (c: any, action: any) => {
        c.entitlements = action({ modResults: c.entitlements }).modResults;
        return c;
      },
      withInfoPlist: (c: any, action: any) => {
        c.info = action({ modResults: c.info }).modResults;
        return c;
      },
    };
  });
  const native = module.exports({
    extra: config.extra,
    entitlements: { "aps-environment": "development", keep: "untouched" },
    info: { UIBackgroundModes: ["remote-notification", "audio"] },
  });
  assert.deepEqual(native.entitlements, { keep: "untouched" });
  assert.deepEqual(native.info.UIBackgroundModes, ["audio"]);
  assert.throws(
    () => module.exports({ extra: {}, entitlements: {}, info: {} }),
    /explicit build scope/,
  );
});

test("runtime restriction applies only to the explicit iOS binary and blocks normalized direct bypasses", () => {
  assert.equal(policy.isIosInternalBeta("ios", scope), true);
  for (const platform of ["android", "web"])
    assert.equal(policy.isIosInternalBeta(platform, scope), false);
  assert.equal(policy.isIosInternalBeta("ios", undefined), false);
  const blocked = [
    "/api/mobile/auth/register",
    "/api/auth/register?x=1",
    "/api/web3/challenge",
    "/api/web3/intents",
    "/api/web3/metadata",
    "/api/social/facebook/connect",
    "/api/social/bluesky/link",
    "/api/social/youtube/sync",
    "/api/social/instagram/import-target",
    "/api/social/oauth/facebook/authorize",
    "/api/publishing/oauth/tiktok/start",
    "/api/publishing/connections/youtube/target",
    "/api/os/workflows",
    "/api/os/workflows/old/run",
    "/api/os/workflows/runs/old/retry",
    "/api/notifications/devices",
    "/api/social%2ffacebook/connect",
    "/api/social//facebook/sync",
    "/api/creator/%2e%2e/web3/intents",
  ];
  for (const path of blocked) {
    assert.throws(
      () => policy.assertInternalBetaRequest(true, path, "POST"),
      /private|beta/,
    );
    assert.doesNotThrow(() =>
      policy.assertInternalBetaRequest(false, path, "POST"),
    );
  }
  const allowed = [
    ["/api/mobile/auth/login", "POST"],
    ["/api/auth/forgot-password", "POST"],
    ["/api/me", "GET"],
    ["/api/creator/profile", "POST"],
    ["/api/creator/items", "POST"],
    ["/api/creator/media/presign", "POST"],
    ["/api/social/media/owned/export", "POST"],
    ["/api/social/facebook/disconnect", "POST"],
    ["/api/publishing/connections/tiktok/disconnect", "POST"],
    ["/api/social/hub", "GET"],
    ["/api/web3/wallets", "GET"],
    ["/api/web3/wallets/12345678-1234-4123-8123-123456789012/unlink", "POST"],
    ["/api/notifications/preferences", "POST"],
    ["/api/notifications/devices/existing/revoke", "POST"],
    ["/api/os/workflows", "GET"],
    ["/api/os/workflows/old/pause", "POST"],
    ["/api/os/workflows/runs/old/cancel", "POST"],
    ["/api/os/workflows/old", "DELETE"],
    ["/api/os/memories", "POST"],
    ["/api/os/agent/tasks", "POST"],
  ];
  for (const [path, method] of allowed)
    assert.doesNotThrow(
      () => policy.assertInternalBetaRequest(true, path, method),
      `${method} ${path}`,
    );
});

function evaluate(
  relative: string,
  imports: (name: string) => any,
  values: Record<string, unknown> = {},
) {
  const exports: any = {};
  const source = ts.transpileModule(
    readFileSync(new URL(relative, root), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("exports", "require", ...Object.keys(values), source)(
    exports,
    imports,
    ...Object.values(values),
  );
  return exports;
}

test("real native request and direct creator transport reject writes before any fetch, while normal sign-in and drafts continue", async () => {
  for (const locked of [true, false]) {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const config = {
      iosInternalTestflight: locked,
      validateOrigin: () => "https://api.ziipa.test",
      authorizationHeaders: () => ({}),
      portalMode: false,
    };
    const imports = (name: string): any => {
      if (name === "./config") return config;
      if (name === "./internal-beta-policy") return policy;
      if (name === "./api") return { ApiError: class extends Error {} };
      if (name === "./request-deadline")
        return {
          ApiRequestError: class extends Error {},
          OperationTimeoutError: class extends Error {},
          withDeadline: async (job: any) => job(() => true),
        };
      if (name === "expo-secure-store" || name === "expo-file-system/legacy")
        return {};
      throw new Error(name);
    };
    const native = evaluate("src/lib/api.ts", imports, { fetch });
    const direct = evaluate("src/lib/creator-request.ts", imports, { fetch });
    if (locked) {
      await assert.rejects(
        native.request("/api/mobile/auth/register", undefined, {}),
        /existing Ziipa accounts/,
      );
      await assert.rejects(
        direct.creatorRequest(
          "/api/social/facebook/import-target",
          "owner",
          "PUT",
          {},
        ),
        /imports are unavailable/,
      );
      assert.deepEqual(calls, []);
    } else await native.request("/api/mobile/auth/register", undefined, {});
    await native.request("/api/mobile/auth/login", undefined, {});
    await native.request("/api/creator/items", "owner", {
      visibility: "draft",
    });
    await direct.creatorRequest("/api/creator/items/owned", "owner", "PUT", {
      title: "Draft",
    });
    assert.equal(calls.length, locked ? 3 : 4);
  }
});

test("wallet exported actions block provider pairing/signing/transactions before external calls; normal connector still works", async () => {
  for (const locked of [true, false]) {
    const calls: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts")
          return ["0x" + "1".repeat(40)];
        if (method === "eth_chainId") return "0x14a34";
        if (method === "personal_sign") return "synthetic-signature";
        if (method === "eth_sendTransaction") return "0x" + "2".repeat(64);
      },
      on() {},
      removeListener() {},
    };
    const wallet = evaluate(
      "src/lib/wallet-connector.ts",
      (name) => {
        if (name === "buffer") return require("node:buffer");
        if (name === "react-native") return { Platform: { OS: "ios" } };
        if (name === "./config") return { iosInternalTestflight: locked };
        if (name === "./internal-beta-policy") return policy;
        if (name === "./wallet-injected")
          return { injectedWallet: () => provider };
        throw new Error(`Unexpected external wallet import ${name}`);
      },
      {
        process: { env: { EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID: "synthetic" } },
        __DEV__: false,
      },
    );
    const intent = {
      status: "prepared",
      chain_id: 84532,
      transaction: { from: "0x" + "1".repeat(40) },
    };
    if (locked) {
      assert.equal(wallet.walletConnectConfigured, false);
      assert.equal(wallet.browserWalletAvailable(), false);
      await assert.rejects(
        wallet.connectWallet(84532, "injected", () => {}),
        /Wallet pairing/,
      );
      await assert.rejects(
        wallet.connectWallet(84532, "walletconnect", () => {}),
        /Wallet pairing/,
      );
      await assert.rejects(
        wallet.signWalletProof("fixture", intent.transaction.from, 84532),
        /Wallet pairing/,
      );
      await assert.rejects(
        wallet.sendWalletTransaction(intent),
        /Wallet pairing/,
      );
      assert.equal(wallet.currentWallet(), null);
      assert.deepEqual(calls, []);
    } else {
      await wallet.connectWallet(84532, "injected", () => {});
      assert.equal(
        await wallet.signWalletProof("fixture", intent.transaction.from, 84532),
        "synthetic-signature",
      );
      assert.equal(
        await wallet.sendWalletTransaction(intent),
        "0x" + "2".repeat(64),
      );
      assert.ok(calls.includes("eth_sendTransaction"));
    }
    await wallet.disconnectWallet();
    await wallet.cancelPairing();
  }
});

test("internal auth routes stale registration links to existing-account sign-in; normal adult registration contract is unchanged", async () => {
  for (const internal of [true, false]) {
    const slots: any[] = [];
    let cursor = 0;
    const signedIn: any[] = [],
      navigated: any[] = [];
    const jsx = (type: any, props: any) => ({ type, props });
    const flat = (value: any): any[] =>
      Array.isArray(value)
        ? value.flatMap(flat)
        : value?.props
          ? [value, ...flat(value.props.children)]
          : [];
    const exports: any = {};
    const compiled = ts.transpileModule(
      readFileSync(new URL("src/screens/auth.tsx", root), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText;
    new Function("exports", "require", "__DEV__", compiled)(
      exports,
      (name: string) => {
        if (name === "react")
          return {
            useState(initial: any) {
              const index = cursor++;
              if (!(index in slots)) slots[index] = initial;
              return [
                slots[index],
                (value: any) => {
                  slots[index] = value;
                },
              ];
            },
          };
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "react-native")
          return new Proxy(
            { Platform: { OS: internal ? "ios" : "android" } },
            {
              get: (target, key) =>
                key in target
                  ? target[key as keyof typeof target]
                  : String(key),
            },
          );
        if (name === "../lib/config")
          return { demoEnabled: false, iosInternalTestflight: internal };
        if (name === "../provider")
          return {
            useZiipa: () => ({
              enterGuest() {},
              authenticate: async (...args: any[]) => {
                signedIn.push(args);
              },
            }),
          };
        if (name === "../theme") return { color: {}, font: {}, styles: {} };
        return new Proxy({}, { get: (_, key) => String(key) });
      },
      false,
    );
    const navigation = { navigate: (...args: any[]) => navigated.push(args) };
    const welcome = flat(exports.WelcomeScreen({ navigation }));
    welcome
      .find(
        (node) =>
          node.props.title ===
          (internal ? "Sign in to the private beta" : "Get started"),
      )!
      .props.onPress();
    assert.equal(navigated[0][1].register, !internal);
    const render = () => {
      cursor = 0;
      return flat(
        exports.LoginScreen({
          navigation,
          route: { params: { register: true } },
        }),
      );
    };
    let nodes = render();
    assert.equal(
      nodes.some(
        (node) => node.props.accessibilityLabel === "I am 18 or older",
      ),
      !internal,
    );
    if (internal) {
      assert.equal(
        nodes.some(
          (node) => node.props.title === "New to Ziipa? Create an account",
        ),
        false,
      );
      nodes
        .find((node) => node.props.label === "Email address")!
        .props.onChangeText("owner@example.test");
      nodes
        .find((node) => node.props.label === "Password")!
        .props.onChangeText("synthetic-signin");
      nodes = render();
      nodes
        .find((node) => node.props.testID === "auth-submit")!
        .props.onPress();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(signedIn, [
        ["owner@example.test", "synthetic-signin", undefined],
      ]);
    } else
      assert.ok(nodes.some((node) => node.props.title === "Create my account"));
  }
});
