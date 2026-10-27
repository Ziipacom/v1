import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const mobile = fileURLToPath(new URL("../", import.meta.url));
const scope = "ios-internal-testflight";
const productionHash =
  "86f3055ff985b0da4deebd2f035e72cc4a1e43b9f57fbf9f7383f0534c40f622";
const publicScripts = [
  "check-release.cjs",
  "check-build-scope.cjs",
  "check-ios-internal-testflight.cjs",
] as const;
const source = JSON.parse(readFileSync(path.join(mobile, "eas.json"), "utf8"));
const baselineEnv: Record<string, string> = {
  ...source.build.production.env,
  ...source.build[scope].env,
  EAS_BUILD_PLATFORM: "ios",
  EAS_BUILD_PROFILE: scope,
};

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Child checkers receive public profile values and Windows runtime necessities
// only. No inherited account credentials, dotenv, EAS token or signing inputs.
function environment(values: Record<string, string> = baselineEnv) {
  return {
    SystemRoot: process.env.SystemRoot || "",
    WINDIR: process.env.WINDIR || "",
    NODE_ENV: "test" as const,
    EXPO_NO_DOTENV: "1",
    ...values,
  };
}

function withFixture<T>(change: (eas: any) => void, run: (directory: string) => T) {
  const tempBase = realpathSync(tmpdir());
  const directory = mkdtempSync(
    path.join(tempBase, "ziipa-internal-profile-fixture-"),
  );
  try {
    mkdirSync(path.join(directory, "scripts"));
    for (const name of publicScripts)
      copyFileSync(
        path.join(mobile, "scripts", name),
        path.join(directory, "scripts", name),
      );
    const eas = structuredClone(source);
    change(eas);
    writeFileSync(path.join(directory, "eas.json"), JSON.stringify(eas));
    assert.deepEqual(readdirSync(directory).sort(), ["eas.json", "scripts"]);
    assert.deepEqual(readdirSync(path.join(directory, "scripts")).sort(), [...publicScripts].sort());
    return run(directory);
  } finally {
    // Verify the absolute, resolved target before Windows recursive cleanup.
    const actual = realpathSync(directory);
    const relative = path.relative(tempBase, actual);
    assert.equal(lstatSync(directory).isSymbolicLink(), false);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.startsWith(".."), false);
    assert.match(path.basename(actual), /^ziipa-internal-profile-fixture-/);
    assert.equal(path.dirname(actual), tempBase);
    assert.equal(actual, directory);
    rmSync(actual, { recursive: true, force: false });
    assert.equal(existsSync(directory), false);
  }
}

function runGate(
  directory: string,
  name: "check-build-scope.cjs" | "check-ios-internal-testflight.cjs",
  changes: Record<string, string> = {},
) {
  const result = spawnSync(
    process.execPath,
    [path.join(directory, "scripts", name)],
    {
      cwd: directory,
      env: environment({ ...baselineEnv, ...changes }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined, result.error?.message || "No child process error expected");
  return result;
}

test("public-only cloned internal profile passes both real gates without a release-checker change", () => {
  assert.equal(
    hash(readFileSync(path.join(mobile, "scripts/check-release.cjs"))),
    productionHash,
  );
  withFixture(
    () => {},
    (directory) => {
      for (const name of [
        "check-build-scope.cjs",
        "check-ios-internal-testflight.cjs",
      ] as const) {
        const result = runGate(directory, name);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Private owner\/team iOS beta/);
        assert.match(result.stdout, /Device QA is pending/);
        assert.match(result.stdout, /External testing\/public release is forbidden/);
      }
      assert.equal(
        hash(readFileSync(path.join(directory, "scripts/check-release.cjs"))),
        productionHash,
      );
    },
  );
});

const mutations: [string, (eas: any) => void][] = [
  ["missing beta profile", (eas) => delete eas.build[scope]],
  ["wrong parent", (eas) => (eas.build[scope].extends = "preview")],
  ["missing parent", (eas) => delete eas.build[scope].extends],
  ["deeper inherited parent", (eas) => (eas.build.production.extends = "development")],
  ["ad-hoc distribution", (eas) => (eas.build[scope].distribution = "internal")],
  ["local credential source", (eas) => (eas.build[scope].credentialsSource = "local")],
  ["wrong cloud environment", (eas) => (eas.build[scope].environment = "production")],
  ["development client", (eas) => (eas.build[scope].developmentClient = true)],
  ["inherited development client", (eas) => (eas.build.production.developmentClient = true)],
  ["automatic submit", (eas) => (eas.build[scope].autoSubmit = true)],
  ["inherited automatic submit", (eas) => (eas.build.production.autoSubmit = true)],
  ["automatic submit profile", (eas) => (eas.build[scope].autoSubmitWithProfile = "production")],
  ["inherited automatic submit profile", (eas) => (eas.build.production.autoSubmitWithProfile = "production")],
  ["wrong ASC application", (eas) => (eas.submit[scope].ios.ascAppId = "9999999999")],
  ["wrong Apple team", (eas) => (eas.submit[scope].ios.appleTeamId = "WRONGTEAM1")],
  ["missing ASC application", (eas) => delete eas.submit[scope].ios.ascAppId],
  ["missing Apple team", (eas) => delete eas.submit[scope].ios.appleTeamId],
  ["local version source", (eas) => (eas.cli.appVersionSource = "local")],
  ["disabled inherited version increment", (eas) => (eas.build.production.autoIncrement = false)],
  ["disabled beta version increment", (eas) => (eas.build[scope].autoIncrement = false)],
  ["false public scope in JSON", (eas) => (eas.build[scope].env.EXPO_PUBLIC_BUILD_SCOPE = "production")],
  ["missing private scope in JSON", (eas) => delete eas.build[scope].env.ZIIPA_BUILD_SCOPE],
  ["wrong inherited API origin", (eas) => (eas.build.production.env.EXPO_PUBLIC_API_URL = "https://unapproved.invalid")],
  ["wrong overridden API origin", (eas) => (eas.build[scope].env.EXPO_PUBLIC_API_URL = "https://unapproved.invalid")],
  ["wrong inherited app variant", (eas) => (eas.build.production.env.APP_VARIANT = "preview")],
  ["demo-enabled override", (eas) => (eas.build[scope].env.EXPO_PUBLIC_ENABLE_DEMO = "true")],
  ["falsely passed device QA", (eas) => (eas.build[scope].env.ZIIPA_TESTFLIGHT_DEVICE_QA = "passed")],
  ["falsely declared export compliance", (eas) => (eas.build[scope].env.ZIIPA_TESTFLIGHT_EXPORT_COMPLIANCE = "exempt")],
];

// EAS resolves platform-level fields after parent/base fields. This pinned
// scope intentionally forbids adding any iOS override without a new review.
for (const parent of ["production", scope]) {
  for (const [name, value] of [
    ["simulator", true],
    ["credentialsSource", "local"],
    ["distribution", "internal"],
    ["developmentClient", true],
    ["environment", "production"],
    ["autoIncrement", false],
    ["env", { EXPO_PUBLIC_BUILD_SCOPE: "production" }],
    ["image", "unreviewed-image"],
  ] as const)
    mutations.push([
      `${parent} iOS ${name} override`,
      (eas) => (eas.build[parent].ios = { [name]: value }),
    ]);
}

for (const [name, mutate] of mutations)
  test(`real profile and dispatch gates reject ${name} despite a matching process environment`, () => {
    withFixture(mutate, (directory) => {
      for (const script of [
        "check-build-scope.cjs",
        "check-ios-internal-testflight.cjs",
      ] as const) {
        const result = runGate(directory, script);
        assert.equal(result.status, 1, `${name}: ${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, /Internal TestFlight build blocked/);
      }
    });
  });

test("cloned dispatcher rejects mismatched platform, profile or either scope marker", () => {
  withFixture(
    () => {},
    (directory) => {
      const changesList: Record<string, string>[] = [
        { EAS_BUILD_PLATFORM: "android" },
        { EAS_BUILD_PROFILE: "production" },
        { ZIIPA_BUILD_SCOPE: "production" },
        { EXPO_PUBLIC_BUILD_SCOPE: "production" },
        { ZIIPA_BUILD_SCOPE: "", EXPO_PUBLIC_BUILD_SCOPE: "" },
        { ZIIPA_BUILD_SCOPE: "", EXPO_PUBLIC_BUILD_SCOPE: scope },
      ];
      for (const changes of changesList) {
        const result = runGate(directory, "check-build-scope.cjs", changes);
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, /Build blocked/);
      }
    },
  );
});

// The CLI is not an app dependency. A locally installed pinned major23 package
// can be supplied by this public path-only test variable; no installation,
// credentials, EAS command, network or account lookup is performed.
function installedEasJson(): string | null {
  if (process.env.ZIIPA_TEST_EAS_JSON_ROOT) {
    const candidate = path.resolve(process.env.ZIIPA_TEST_EAS_JSON_ROOT);
    const manifest = JSON.parse(
      readFileSync(path.join(candidate, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, "@expo/eas-json");
    assert.match(manifest.version, /^23\./);
    return path.join(candidate, "build/index.js");
  }
  try {
    const manifestPath = require.resolve("@expo/eas-json/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!/^23\./.test(manifest.version)) return null;
    return path.join(path.dirname(manifestPath), "build/index.js");
  } catch {
    return null;
  }
}

const offlineEasJson = installedEasJson();
test(
  "installed EAS23 schema and real resolver agree on the private iOS identity and inherited env without account access",
  { skip: offlineEasJson ? false : "Optional locally installed @expo/eas-json23 is absent" },
  () => {
    const probe = `
      const fs = require('node:fs');
      for (const name of ['node:http','node:https']) require(name).request = () => { throw new Error('Network forbidden'); };
      require('node:net').connect = () => { throw new Error('Network forbidden'); };
      require('node:tls').connect = () => { throw new Error('Network forbidden'); };
      global.fetch = () => { throw new Error('Network forbidden'); };
      const { EasJsonAccessor, EasJsonUtils } = require(process.argv[1]);
      (async () => {
        const accessor = EasJsonAccessor.fromRawString(fs.readFileSync(0, 'utf8'));
        const build = await EasJsonUtils.getBuildProfileAsync(accessor, 'ios', 'ios-internal-testflight');
        const submit = await EasJsonUtils.getSubmitProfileAsync(accessor, 'ios', 'ios-internal-testflight');
        console.log(JSON.stringify({build, submit}));
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ["-e", probe, offlineEasJson!], {
      env: environment({}),
      input: JSON.stringify(source),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 256 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message || "No child process error expected");
    assert.equal(result.status, 0, result.stderr);
    const { build, submit } = JSON.parse(result.stdout);
    assert.equal(build.distribution, "store");
    assert.equal(build.credentialsSource, "remote");
    assert.equal(build.environment, "preview");
    assert.notEqual(build.simulator, true);
    assert.notEqual(build.developmentClient, true);
    assert.equal(build.autoIncrement, true);
    assert.deepEqual(build.env, {
      ...source.build.production.env,
      ...source.build[scope].env,
    });
    assert.equal(submit.ascAppId, "6827668999");
    assert.equal(submit.appleTeamId, "L6WH6BD2N5");
    assert.equal(
      hash(readFileSync(path.join(mobile, "scripts/check-release.cjs"))),
      productionHash,
    );
  },
);
