import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as policy from "../src/lib/internal-beta-policy.ts";

const mobile = fileURLToPath(new URL("../", import.meta.url));
const eas = JSON.parse(readFileSync(path.join(mobile, "eas.json"), "utf8"));
const scope = policy.androidPlayInternalScope;
const baseline = {
  ...eas.build.production.env,
  ...eas.build[scope].env,
  EAS_BUILD_PROFILE: scope,
  EAS_BUILD_PLATFORM: "android",
};
type EnvOverrides = Record<string, string | undefined>;
function environment(changes: EnvOverrides = {}) {
  return { SystemRoot: process.env.SystemRoot || "", PATH: process.env.PATH || "", NODE_ENV: "test", ...baseline, ...changes };
}
function gate(changes: EnvOverrides = {}, directory = mobile) {
  return spawnSync(process.execPath, [path.join(directory, "scripts/check-build-scope.cjs")], {
    env: environment(changes), encoding: "utf8", timeout: 10000,
  });
}
function evaluateApp(changes: EnvOverrides = {}) {
  const source = ts.transpileModule(readFileSync(path.join(mobile, "app.config.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as any };
  new Function("module", "exports", "require", "process", source)(module, module.exports,
    createRequire(path.join(mobile, "app.config.ts")), { env: environment(changes) });
  return module.exports.default;
}
function runtime(platform: string, buildScope?: string) {
  const source = ts.transpileModule(readFileSync(path.join(mobile, "src/lib/config.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function("exports", "require", "process", "__DEV__", source)(exports, (name: string) => {
    if (name === "react-native") return { Platform: { OS: platform } };
    if (name === "./internal-beta-policy") return policy;
    if (name === "./preview-origin") return { browserPreviewApiOrigin: (origin: string) => origin };
    throw new Error("Unexpected config import");
  }, { env: { EXPO_PUBLIC_BUILD_SCOPE: buildScope, EXPO_PUBLIC_API_URL: "https://api.ziipa.com" } }, false);
  return exports;
}

test("internal Play gate requires the exact production identity, platform, dual scopes and live API", () => {
  assert.equal(gate().status, 0);
  for (const changes of [
    { EAS_BUILD_PLATFORM: "ios" }, { EAS_BUILD_PROFILE: "production" },
    { ZIIPA_BUILD_SCOPE: "" }, { EXPO_PUBLIC_BUILD_SCOPE: "" },
    { ZIIPA_BUILD_SCOPE: policy.internalBetaScope }, { ZIIPA_APP_ID: "com.ziipa.app.preview" },
    { APP_VARIANT: "preview" }, { EXPO_NO_DOTENV: "" },
    { EXPO_PUBLIC_API_URL: "http://localhost:8018" }, { EXPO_PUBLIC_PORTAL_MODE: "true" },
    { EXPO_PUBLIC_ENABLE_DEMO: "true" }, { EXPO_PUBLIC_ENABLE_CONCEPTS: "true" },
    { EXPO_PUBLIC_PRIVACY_URL: "https://other.invalid" }, { EXPO_OWNER: "other" },
  ]) assert.notEqual(gate(changes).status, 0, JSON.stringify(changes));
});

test("internal Play excludes ads and Firebase without reading or exposing provider configuration", () => {
  for (const changes of [
    { GOOGLE_SERVICES_JSON: "synthetic-private-client-file" },
    { ZIIPA_ADMOB_RELEASE_ADS: "true" }, { ZIIPA_ADMOB_TEST_ADS: "true" },
  ]) {
    const result = gate(changes);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /synthetic-private-client-file/);
  }
  const config = evaluateApp();
  assert.deepEqual(config.platforms, ["android"]);
  assert.equal(config.name, "Ziipa");
  assert.equal(config.android.package, "com.ziipa.app");
  assert.equal(config.android.googleServicesFile, undefined);
  assert.equal(config.extra.buildScope, scope);
  assert.equal(config.extra.publicReleaseAllowed, false);
  assert.equal(config.extra.deviceQA, "pending");
  assert.equal(config.extra.admobReleaseAds, undefined);
  assert.equal(config.plugins.some((item: any) => (Array.isArray(item) ? item[0] : item) === "react-native-google-mobile-ads"), false);
  assert.throws(() => evaluateApp({ EXPO_PUBLIC_BUILD_SCOPE: policy.externalBetaScope }));
});

test("internal Play rejects unsigned APK, automatic submission and profile redirection", () => {
  for (const change of [
    (value: any) => { value.build[scope].autoSubmit = true; },
    (value: any) => { value.build.production.autoSubmitWithProfile = "production"; },
    (value: any) => { value.build[scope].android = { buildType: "apk" }; },
    (value: any) => { value.build[scope].android = { withoutCredentials: true }; },
    (value: any) => { value.build[scope].android = { gradleCommand: ":app:assembleDebug" }; },
    (value: any) => { value.build.production.android.env = { EXPO_PUBLIC_BUILD_SCOPE: "" }; },
    (value: any) => { value.build[scope].android = { autoSubmit: true }; },
    (value: any) => { value.build[scope].extends = "preview"; },
    (value: any) => { value.build[scope].credentialsSource = "local"; },
    (value: any) => { value.build[scope].autoIncrement = true; },
  ]) {
    const base = realpathSync(tmpdir());
    const directory = mkdtempSync(path.join(base, "ziipa-play-scope-fixture-"));
    try {
      mkdirSync(path.join(directory, "scripts"));
      for (const name of ["check-build-scope.cjs", "check-android-play-internal.cjs"])
        copyFileSync(path.join(mobile, "scripts", name), path.join(directory, "scripts", name));
      const altered = structuredClone(eas); change(altered);
      writeFileSync(path.join(directory, "eas.json"), JSON.stringify(altered));
      assert.notEqual(gate({}, directory).status, 0);
    } finally {
      assert.equal(path.dirname(realpathSync(directory)), base);
      assert.equal(lstatSync(directory).isSymbolicLink(), false);
      assert.match(path.basename(directory), /^ziipa-play-scope-fixture-/);
      rmSync(directory, { recursive: true, force: false });
    }
  }
});

test("Android internal beta allows testnet wallet access and retains other guarded actions", () => {
  const config = runtime("android", scope);
  assert.equal(config.androidPlayInternal, true);
  assert.equal(config.limitedStoreBeta, true);
  assert.equal(config.iosLimitedTestflight, false);
  assert.equal(config.iosInternalTestflight, false);
  for (const action of ["registration", "network-import", "remote-push", "purchase"] as const)
    assert.throws(() => policy.assertInternalBetaAction(config.limitedStoreBeta, action));
  for (const route of ["/api/mobile/auth/register", "/api/social/youtube/sync", "/api/notifications/devices", "/api/services/purchase-context"])
    assert.throws(() => policy.assertInternalBetaRequest(config.limitedStoreBeta, route, "POST"));
  assert.doesNotThrow(() => policy.assertInternalBetaAction(config.limitedStoreBeta, "wallet"));
  for (const [route, method] of [
    ["/api/mobile/auth/login", "POST"], ["/api/creator/items", "GET"], ["/api/live/streams", "POST"],
    ["/api/social/facebook/disconnect", "POST"], ["/api/os/workflows/old/pause", "POST"],
    ["/api/web3/config", "GET"], ["/api/web3/challenge", "POST"],
    ["/api/web3/wallets/12345678-1234-4123-8123-123456789012/unlink", "POST"],
  ]) assert.doesNotThrow(() => policy.assertInternalBetaRequest(config.limitedStoreBeta, route, method));
  for (const selected of [policy.internalBetaScope, policy.externalBetaScope]) {
    const ios = runtime("ios", selected);
    assert.equal(ios.limitedStoreBeta, true);
    assert.equal(ios.iosInternalTestflight, true);
    assert.equal(ios.androidPlayInternal, false);
  }
  for (const platform of ["web", "ios"])
    assert.equal(runtime(platform, scope).limitedStoreBeta, false);
  assert.equal(runtime("android").limitedStoreBeta, false);
});
