import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as policy from "../src/lib/internal-beta-policy.ts";

const root = new URL("../", import.meta.url);
const mobile = fileURLToPath(root);
const source = JSON.parse(readFileSync(new URL("eas.json", root), "utf8"));
const scope = policy.externalBetaScope;
const baseline = { ...source.build.production.env, ...source.build[scope].env, EAS_BUILD_PLATFORM: "ios", EAS_BUILD_PROFILE: scope };
const productionHash = "86f3055ff985b0da4deebd2f035e72cc4a1e43b9f57fbf9f7383f0534c40f622";

function environment(values: Record<string, string> = baseline) {
  return { SystemRoot: process.env.SystemRoot || "", WINDIR: process.env.WINDIR || "", EXPO_NO_DOTENV: "1", NODE_ENV: "test" as const, ...values };
}
function gate(changes: Record<string, string> = {}, directory = mobile) {
  return spawnSync(process.execPath, [path.join(directory, "scripts/check-build-scope.cjs")], {
    cwd: directory, env: environment({ ...baseline, ...changes }), encoding: "utf8", timeout: 10000, windowsHide: true,
  });
}
function evaluateConfig(platform: string, selectedScope?: string) {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL("src/lib/config.ts", root), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "exports", "process", "__DEV__", code)((name: string) => {
    if (name === "react-native") return { Platform: { OS: platform } };
    if (name === "./internal-beta-policy") return policy;
    if (name === "./preview-origin") return { browserPreviewApiOrigin: (value: string) => value };
    throw new Error(name);
  }, exports, { env: { EXPO_PUBLIC_BUILD_SCOPE: selectedScope, EXPO_PUBLIC_API_URL: "https://api.ziipa.com" } }, false);
  return exports;
}

test("external profile passes only preparation checks with every approval still pending", () => {
  const result = gate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PREPARATION only/);
  assert.match(result.stdout, /no external distribution/);
  assert.match(result.stdout, /Privacy publication, reviewer setup, device QA and Apple beta review are pending/);
  assert.equal(Object.keys(baseline).some(name => name.endsWith("_REVIEWED")), false);
  assert.equal(source.build[scope].env.EXPO_PUBLIC_PRIVACY_URL, "https://ziipa.com/privacy-beta");
  assert.equal(createHash("sha256").update(readFileSync(new URL("scripts/check-release.cjs", root))).digest("hex"), productionHash);
  const rejectedChanges: Record<string, string>[] = [
    { EAS_BUILD_PLATFORM: "android" }, { EAS_BUILD_PROFILE: "production" },
    { ZIIPA_BUILD_SCOPE: policy.internalBetaScope }, { EXPO_PUBLIC_BUILD_SCOPE: "" },
    { ZIIPA_APPLE_TEAM_ID: "OTHERTEAM" }, { EXPO_PUBLIC_API_URL: "https://other.invalid" },
    { EXPO_PUBLIC_PRIVACY_URL: "" }, { EXPO_PUBLIC_PRIVACY_URL: "https://example.com/privacy" },
    { ZIIPA_TESTFLIGHT_POLICY_STATUS: "published" }, { ZIIPA_TESTFLIGHT_REVIEWER_STATUS: "ready" },
    { ZIIPA_TESTFLIGHT_APPLE_BETA_REVIEW: "approved" }, { ZIIPA_TESTFLIGHT_DEVICE_QA: "passed" },
    { ZIIPA_TESTFLIGHT_EXTERNAL_DISTRIBUTION: "allowed" }, { ZIIPA_TESTFLIGHT_PUBLIC_RELEASE: "allowed" },
  ];
  for (const changes of rejectedChanges) assert.equal(gate(changes).status, 1, JSON.stringify(changes));
});

test("external profile rejects inherited automatic submission, iOS overrides and different signing identity", () => {
  for (const change of [
    (eas: any) => { eas.build.production.autoSubmit = true; },
    (eas: any) => { eas.build[scope].autoSubmitWithProfile = "production"; },
    (eas: any) => { eas.build[scope].ios = { simulator: true }; },
    (eas: any) => { eas.build[scope].extends = "preview"; },
    (eas: any) => { eas.submit[scope].ios.ascAppId = "other"; },
    (eas: any) => { eas.build[scope].env.ZIIPA_TESTFLIGHT_APPLE_BETA_REVIEW = "approved"; },
  ]) {
    const base = realpathSync(tmpdir());
    const directory = mkdtempSync(path.join(base, "ziipa-external-preparation-fixture-"));
    try {
      mkdirSync(path.join(directory, "scripts"));
      for (const file of ["check-build-scope.cjs", "check-ios-external-testflight.cjs", "check-ios-internal-testflight.cjs", "check-release.cjs"])
        copyFileSync(path.join(mobile, "scripts", file), path.join(directory, "scripts", file));
      const eas = structuredClone(source); change(eas);
      writeFileSync(path.join(directory, "eas.json"), JSON.stringify(eas));
      assert.equal(gate({}, directory).status, 1);
    } finally {
      const actual = realpathSync(directory);
      assert.equal(actual, directory);
      assert.equal(path.dirname(actual), base);
      assert.equal(lstatSync(actual).isSymbolicLink(), false);
      assert.match(path.basename(actual), /^ziipa-external-preparation-fixture-/);
      rmSync(actual, { recursive: true, force: false });
      assert.equal(existsSync(actual), false);
    }
  }
});

test("both iOS beta scopes share all existing request/action guards and preserve cleanup", () => {
  for (const selectedScope of [policy.internalBetaScope, scope]) {
    const config = evaluateConfig("ios", selectedScope);
    assert.equal(config.iosLimitedTestflight, true);
    assert.equal(config.iosInternalTestflight, true); // Existing guarded callers use this compatibility export.
    assert.equal(config.iosExternalTestflight, selectedScope === scope);
    for (const route of ["/api/mobile/auth/register", "/api/web3/challenge", "/api/social/youtube/sync", "/api/social/facebook/connect", "/api/notifications/devices", "/api/os/workflows/new/run"])
      assert.throws(() => policy.assertInternalBetaRequest(config.iosInternalTestflight, route, "POST"));
    for (const action of ["registration", "wallet", "network-import", "remote-push"] as const)
      assert.throws(() => policy.assertInternalBetaAction(config.iosInternalTestflight, action));
    assert.doesNotThrow(() => policy.assertInternalBetaRequest(config.iosInternalTestflight, "/api/social/facebook/disconnect", "POST"));
    assert.doesNotThrow(() => policy.assertInternalBetaRequest(config.iosInternalTestflight, "/api/web3/wallets/12345678-1234-4123-8123-123456789012/unlink", "POST"));
    assert.doesNotThrow(() => policy.assertInternalBetaRequest(config.iosInternalTestflight, "/api/os/workflows/old/pause", "POST"));
  }
  const external = evaluateConfig("ios", scope);
  assert.equal(external.legalUrls.privacy, policy.externalBetaPrivacyUrl);
  assert.equal(external.legalOperatorName, "Niche Labs LLC");
  for (const platform of ["web", "android"])
    assert.equal(evaluateConfig(platform, scope).iosInternalTestflight, false);
  assert.equal(evaluateConfig("ios").iosInternalTestflight, false);
  assert.equal(evaluateConfig("ios").legalUrls.privacy, "");
  assert.equal(policy.isIosInternalBeta("ios", scope), false);
});

test("external config retains exact Z, permission purposes and APNs removal without declaring an exemption", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", "const {default:c}=await import(process.argv[1]); console.log(JSON.stringify(c));", new URL("app.config.ts", root).href], {
    cwd: mobile, env: environment({ ...baseline, ZIIPA_ENCRYPTION_REVIEWED: "true", ZIIPA_USES_NON_EXEMPT_ENCRYPTION: "false" }), encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(config.platforms, ["ios"]);
  assert.equal(config.version, "1.0.15");
  assert.equal(config.ios.bundleIdentifier, "com.ziipa.app");
  assert.equal(config.ios.appleTeamId, "L6WH6BD2N5");
  assert.equal(config.icon, "./assets/brand/ziipa-favicon.png");
  assert.equal(config.extra.buildScope, scope);
  assert.equal(config.extra.externalDistributionAllowed, false);
  assert.equal(config.extra.publicReleaseAllowed, false);
  assert.equal(config.extra.appleBetaReview, "pending");
  assert.equal(config.extra.policyPublication, "pending-owner-review-and-publication");
  assert.equal("ITSAppUsesNonExemptEncryption" in config.ios.infoPlist, false);
  assert.ok(config.ios.infoPlist.NSPhotoLibraryUsageDescription.includes("profile avatar and cover artwork"));
  const module = { exports: null as any };
  new Function("module", "require", readFileSync(new URL("scripts/with-internal-testflight.cjs", root), "utf8"))(module, () => ({
    withEntitlementsPlist: (c: any, action: any) => { c.entitlements = action({ modResults: c.entitlements }).modResults; return c; },
    withInfoPlist: (c: any, action: any) => { c.info = action({ modResults: c.info }).modResults; return c; },
  }));
  const native = module.exports({ extra: config.extra, entitlements: { "aps-environment": "production", keep: "safe" }, info: { UIBackgroundModes: ["remote-notification", "audio"] } });
  assert.deepEqual(native.entitlements, { keep: "safe" });
  assert.deepEqual(native.info.UIBackgroundModes, ["audio"]);
  assert.throws(() => module.exports({ extra: { buildScope: "production" }, entitlements: {}, info: {} }));
});
