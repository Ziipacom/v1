import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(
  new URL("../scripts/check-release.cjs", import.meta.url),
);
const configPath = new URL("../app.config.ts", import.meta.url).href;
const fixtureDirectory = mkdtempSync(join(tmpdir(), "ziipa-release-firebase-"));
after(() => {
  // Only delete this test's freshly created, bounded temporary directory.
  assert.equal(dirname(resolve(fixtureDirectory)), resolve(tmpdir()));
  assert.match(fixtureDirectory, /ziipa-release-firebase-[^/\\]+$/);
  rmSync(fixtureDirectory, { recursive: true, force: true });
});
function firebaseFile(name: string, value: unknown) {
  const path = join(fixtureDirectory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
const clientConfiguration = {
  project_info: { project_number: "123456789", project_id: "synthetic-ziipa" },
  client: [
    {
      client_info: {
        mobilesdk_app_id: "1:123456789:android:synthetic",
        android_client_info: { package_name: "com.ziipa.app" },
      },
    },
  ],
};
const firebasePath = firebaseFile("android-client.json", clientConfiguration);
const baseline: Record<string, string> = {
  APP_VARIANT: "production",
  EXPO_PUBLIC_API_URL: "https://api.ziipa.com",
  EXPO_PUBLIC_PRIVACY_URL: "https://ziipa.com/privacy",
  EXPO_PUBLIC_TERMS_URL: "https://ziipa.com/terms",
  EXPO_PUBLIC_COMMUNITY_URL: "https://ziipa.com/community",
  EXPO_PUBLIC_DELETE_ACCOUNT_URL: "https://ziipa.com/account-deletion",
  EXPO_PUBLIC_WALLET_ORIGIN: "https://ziipa.com",
  EXPO_PUBLIC_SUPPORT_EMAIL: "release-test@ziipa.com",
  EXPO_OWNER: "test-owner",
  EXPO_EAS_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
  ZIIPA_APP_ID: "com.ziipa.app",
  EXPO_PUBLIC_ENABLE_DEMO: "false",
  EXPO_PUBLIC_ENABLE_CONCEPTS: "false",
  EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID: "0".repeat(32),
  ZIIPA_RELEASE_REVIEWED: "true",
  ZIIPA_WEB3_REVIEWED: "true",
  ZIIPA_APP_ID_CONFIRMED: "true",
  ZIIPA_SIGNING_REVIEWED: "true",
  ZIIPA_ENCRYPTION_REVIEWED: "true",
  ZIIPA_USES_NON_EXEMPT_ENCRYPTION: "false",
  GOOGLE_SERVICES_JSON: firebasePath,
};
function environment(changes: Record<string, string>) {
  // No tokens, signing passwords, or unrelated developer identity are inherited.
  return {
    SystemRoot: process.env.SystemRoot || "",
    PATH: process.env.PATH || "",
    ...changes,
    NODE_ENV: "test" as const,
  };
}
function check(changes: Record<string, string> = {}, strict = true) {
  return spawnSync(
    process.execPath,
    [checker, ...(strict ? ["--strict"] : [])],
    {
      env: environment({ ...baseline, ...changes }),
      encoding: "utf8",
    },
  );
}
test("production fails closed for owner, signer, export review, preview identity and portal mode", () => {
  const blocked: Record<string, string>[] = [
    { ZIIPA_APP_ID_CONFIRMED: "false" },
    { ZIIPA_SIGNING_REVIEWED: "" },
    { ZIIPA_ENCRYPTION_REVIEWED: "" },
    { ZIIPA_USES_NON_EXEMPT_ENCRYPTION: "yes" },
    { ZIIPA_APP_ID: "com.ziipa.app.preview" },
    { EXPO_PUBLIC_PORTAL_MODE: "true" },
    { EXPO_PUBLIC_API_URL: "https://api.invalid" },
  ];
  for (const changes of blocked) {
    assert.equal(check(changes).status, 1);
  }
  assert.equal(check().status, 0); // Syntax/acknowledgments only; no remote request or credential creation.
});

test("Android release preflight rejects missing, mismatched and private-key Firebase files without echoing them", () => {
  const wrongPackage = firebaseFile("wrong-package.json", {
    ...clientConfiguration,
    client: [
      {
        client_info: {
          mobilesdk_app_id: "1:123456789:android:synthetic",
          android_client_info: { package_name: "com.other.app" },
        },
      },
    ],
  });
  const serviceAccount = firebaseFile("private-key.json", {
    ...clientConfiguration,
    type: "service_account",
    private_key: "synthetic-do-not-display",
  });
  for (const file of [
    "",
    join(fixtureDirectory, "missing.json"),
    wrongPackage,
    serviceAccount,
  ]) {
    const result = check({
      EAS_BUILD_PLATFORM: "android",
      GOOGLE_SERVICES_JSON: file,
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Firebase Android client file matching ZIIPA_APP_ID/,
    );
    assert.doesNotMatch(
      result.stderr,
      /synthetic-do-not-display|wrong-package\.json|private-key\.json|missing\.json/,
    );
  }
  assert.equal(check({ EAS_BUILD_PLATFORM: "android" }).status, 0);
  assert.equal(
    check({ EAS_BUILD_PLATFORM: "ios", GOOGLE_SERVICES_JSON: "" }).status,
    0,
  );
});

test("Firebase file wiring is native-only, optional for preview and never embeds file contents", () => {
  function evaluate(changes: Record<string, string>) {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        "const {default:c}=await import(process.argv[1]); console.log(JSON.stringify({file:c.android.googleServicesFile,package:c.android.package}));",
        configPath,
      ],
      { env: environment(changes), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stdout,
      /project_number|mobilesdk_app_id|private_key/,
    );
    return JSON.parse(result.stdout);
  }
  assert.equal(evaluate({}).file, undefined);
  assert.deepEqual(
    evaluate({ APP_VARIANT: "production", GOOGLE_SERVICES_JSON: firebasePath }),
    {
      file: firebasePath,
      package: "com.ziipa.app",
    },
  );
  assert.equal(
    evaluate({ GOOGLE_SERVICES_JSON: firebasePath }).package,
    "com.ziipa.app.preview",
  );
  assert.equal(
    evaluate({
      EXPO_PUBLIC_PORTAL_MODE: "true",
      GOOGLE_SERVICES_JSON: firebasePath,
    }).file,
    undefined,
  );
});
test("production variant cannot bypass the check with another EAS profile", () => {
  assert.equal(
    check({ EAS_BUILD_PROFILE: "custom", ZIIPA_SIGNING_REVIEWED: "" }, false)
      .status,
    1,
  );
  const preview = spawnSync(process.execPath, [checker], {
    env: environment({ APP_VARIANT: "preview" }),
    encoding: "utf8",
  });
  assert.equal(preview.status, 0);
});
test("iOS configuration omits unreviewed export declarations and preserves explicit answers", () => {
  const evaluate = (env: Record<string, string>) => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        "const {default:c}=await import(process.argv[1]); console.log(JSON.stringify(c.ios.infoPlist));",
        configPath,
      ],
      { env: environment(env), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal("ITSAppUsesNonExemptEncryption" in evaluate({}), false);
  assert.equal(
    "ITSAppUsesNonExemptEncryption" in
      evaluate({ ZIIPA_USES_NON_EXEMPT_ENCRYPTION: "false" }),
    false,
  );
  for (const value of ["false", "true"]) {
    const plist = evaluate({
      ZIIPA_ENCRYPTION_REVIEWED: "true",
      ZIIPA_USES_NON_EXEMPT_ENCRYPTION: value,
    });
    assert.equal(plist.ITSAppUsesNonExemptEncryption, value === "true");
  }
});
