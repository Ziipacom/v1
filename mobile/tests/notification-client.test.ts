import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as internalBetaPolicy from "../src/lib/internal-beta-policy.ts";
import {
  webPushKey,
  webPushKeyMatches,
  type PushConfig,
} from "../src/lib/notification-types.ts";

const config: PushConfig = {
  enabled: true,
  worker_ready: true,
  expo_ready: true,
  web_ready: true,
  vapid_public_key: Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(64, 42),
  ]).toString("base64url"),
  categories: ["calendar"],
  notice: "",
};
function client(
  platform: "ios" | "web",
  options: {
    granted?: boolean;
    deny?: boolean;
    afterPermission?: () => void;
    tokenError?: string;
    oldWebKey?: boolean;
    internalBeta?: boolean;
  } = {},
) {
  const calls = { permissions: 0, token: 0, subscribe: 0 };
  const permissions = () => ({
    granted: options.granted !== false,
    status: options.granted === false ? "undetermined" : "granted",
  });
  const notifications = {
    getPermissionsAsync: async () => permissions(),
    requestPermissionsAsync: async () => {
      calls.permissions++;
      options.afterPermission?.();
      return {
        granted: !options.deny,
        status: options.deny ? "denied" : "granted",
      };
    },
    getExpoPushTokenAsync: async () => {
      calls.token++;
      if (options.tokenError) throw new Error(options.tokenError);
      return { data: "ExpoPushToken[synthetic-test-token]" };
    },
  };
  const subscription = {
    options: {
      applicationServerKey: Buffer.concat([
        Buffer.from([4]),
        Buffer.alloc(64, options.oldWebKey ? 2 : 42),
      ]).buffer,
    },
    toJSON: () => ({
      endpoint: "https://fcm.googleapis.com/fcm/send/synthetic",
      keys: { p256dh: "public", auth: "synthetic" },
    }),
  };
  // Buffer pools expose unrelated bytes through .buffer; the browser returns an
  // exact key ArrayBuffer instead, so model that real API shape here.
  subscription.options.applicationServerKey = Uint8Array.from([
    4,
    ...Array(64).fill(options.oldWebKey ? 2 : 42),
  ]).buffer;
  const registration = {
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => {
        calls.subscribe++;
        return subscription;
      },
    },
  };
  const notification = {
    permission: "granted",
    requestPermission: async () => {
      calls.permissions++;
      return "granted";
    },
  };
  const exports: Record<string, any> = {};
  const source = readFileSync(
    new URL("../src/lib/notification-client.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    setTimeout,
    clearTimeout,
    Uint8Array,
    Notification: notification,
    window: {
      isSecureContext: true,
      Notification: notification,
      PushManager: class {},
    },
    navigator: {
      serviceWorker: {
        register: async () => registration,
        ready: Promise.resolve(registration),
      },
    },
    require: (name: string) => {
      if (name === "react-native") return { Platform: { OS: platform } };
      if (name === "expo-constants")
        return {
          __esModule: true,
          default: {
            executionEnvironment: "bare",
            expoConfig: {
              extra: {
                eas: { projectId: "fba49bfd-fd13-462e-93c4-835afc8c7d74" },
              },
            },
          },
        };
      if (name === "@react-native-async-storage/async-storage")
        return {
          __esModule: true,
          default: {
            getItem: async () => "5bca9ea2-5787-49b3-b01c-5067bc1d73b0",
            setItem: async () => {},
          },
        };
      if (name === "expo-crypto")
        return { randomUUID: () => "5bca9ea2-5787-49b3-b01c-5067bc1d73b0" };
      if (name === "./config") return { portalMode: platform === "web", iosInternalTestflight: platform === "ios" && !!options.internalBeta };
      if (name === "./internal-beta-policy") return internalBetaPolicy;
      if (name === "./notification-types")
        return { webPushKey, webPushKeyMatches };
      if (name === "expo-notifications") return notifications;
      throw new Error(`Unexpected notification dependency ${name}`);
    },
  });
  return { api: exports, calls };
}
test("capability checks never request permission; native provider errors cannot expose response bodies", async () => {
  const app = client("ios", {
    tokenError: "Provider echoed private synthetic credential: do-not-display",
  });
  assert.equal((await app.api.pushCapability()).supported, true);
  assert.equal(app.calls.permissions, 0);
  assert.equal(app.calls.token, 0);
  await assert.rejects(
    app.api.registerPushDevice(config, "Test iPhone", () => true),
    (error: Error) => {
      assert.match(
        error.message,
        /Native push registration could not complete/,
      );
      assert.doesNotMatch(error.message, /synthetic credential|do-not-display/);
      return true;
    },
  );
  assert.equal(app.calls.token, 1);
});

test("private iPhone beta never requests APNs permission or an Expo token and keeps native listener inert", async () => {
  const app = client("ios", { internalBeta: true, granted: false });
  const capability = await app.api.pushCapability();
  assert.equal(capability.supported, false);
  assert.match(capability.detail, /In-app notifications remain available/);
  await assert.rejects(app.api.registerPushDevice(config, "Private beta", () => true), /Remote push enrollment is unavailable/);
  assert.deepEqual(app.calls, { permissions: 0, token: 0, subscribe: 0 });
  const dispose = await app.api.nativeNotificationListener(() => assert.fail("No remote notification callback expected"));
  dispose();
  const web = client("web", { internalBeta: true });
  assert.equal((await web.api.pushCapability()).supported, true);
});
test("denied permission and account changes during the permission sheet cannot acquire a token", async () => {
  const denied = client("ios", { granted: false, deny: true });
  await assert.rejects(
    denied.api.registerPushDevice(config, "Test", () => true),
    /permission was not granted/,
  );
  assert.equal(denied.calls.permissions, 1);
  assert.equal(denied.calls.token, 0);
  let current = true;
  const changed = client("ios", {
    granted: false,
    afterPermission: () => {
      current = false;
    },
  });
  await assert.rejects(
    changed.api.registerPushDevice(config, "Test", () => current),
    /account changed/,
  );
  assert.equal(changed.calls.token, 0);
});
test("web registration rejects an existing subscription for a different VAPID key without replacing it", async () => {
  const app = client("web", { oldWebKey: true });
  await assert.rejects(
    app.api.registerPushDevice(config, "Browser", () => true),
    /different push key/,
  );
  assert.equal(app.calls.subscribe, 0);
  const matching = client("web");
  const registration = await matching.api.registerPushDevice(
    config,
    "Browser",
    () => true,
  );
  assert.equal(registration.provider, "web");
  assert.equal(registration.consent, true);
  assert.equal(matching.calls.subscribe, 0);
});
