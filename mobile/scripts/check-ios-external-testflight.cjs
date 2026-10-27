const fs = require("node:fs");
const path = require("node:path");
const env = process.env;
const scope = "ios-external-testflight";
const expected = {
  EXPO_NO_DOTENV: "1",
  EAS_BUILD_PLATFORM: "ios",
  EAS_BUILD_PROFILE: scope,
  ZIIPA_BUILD_SCOPE: scope,
  EXPO_PUBLIC_BUILD_SCOPE: scope,
  APP_VARIANT: "production",
  EXPO_OWNER: "ziipa",
  EXPO_EAS_PROJECT_ID: "a130b762-6812-4963-9ebd-5d103a24084e",
  ZIIPA_APP_ID: "com.ziipa.app",
  ZIIPA_APPLE_TEAM_ID: "L6WH6BD2N5",
  ZIIPA_ASC_APP_ID: "6827668999",
  EXPO_PUBLIC_API_URL: "https://api.ziipa.com",
  EXPO_PUBLIC_PORTAL_MODE: "false",
  EXPO_PUBLIC_ENABLE_DEMO: "false",
  EXPO_PUBLIC_ENABLE_CONCEPTS: "false",
  EXPO_PUBLIC_PRIVACY_URL: "https://ziipa.com/privacy-beta",
  EXPO_PUBLIC_SUPPORT_EMAIL: "ziipaziipa@gmail.com",
  ZIIPA_TESTFLIGHT_DISTRIBUTION: "limited-external-preparation",
  ZIIPA_TESTFLIGHT_DEVICE_QA: "pending",
  ZIIPA_TESTFLIGHT_EXPORT_COMPLIANCE: "pending-owner-final-binary-review",
  ZIIPA_TESTFLIGHT_POLICY_STATUS: "pending-owner-review-and-publication",
  ZIIPA_TESTFLIGHT_REVIEWER_STATUS: "pending-owner-setup",
  ZIIPA_TESTFLIGHT_APPLE_BETA_REVIEW: "pending",
  ZIIPA_TESTFLIGHT_EXTERNAL_DISTRIBUTION: "blocked-until-owner-checks-and-apple-approval",
  ZIIPA_TESTFLIGHT_PUBLIC_RELEASE: "forbidden",
};
const errors = Object.entries(expected)
  .filter(([name, value]) => env[name] !== value)
  .map(([name]) => `${name} does not match the limited external preparation target.`);
try {
  const eas = JSON.parse(fs.readFileSync(path.join(__dirname, "../eas.json"), "utf8"));
  const profile = eas.build?.[scope];
  const production = eas.build?.production;
  const effective = { ...production, ...profile, ios: { ...production?.ios, ...profile?.ios } };
  if (
    production?.extends != null ||
    Object.keys(production?.ios || {}).length !== 0 ||
    Object.keys(profile?.ios || {}).length !== 0 ||
    profile?.extends !== "production" ||
    effective.distribution !== "store" ||
    effective.credentialsSource !== "remote" ||
    effective.environment !== "preview" ||
    effective.developmentClient === true || effective.ios.simulator === true ||
    effective.autoSubmit === true || effective.autoSubmitWithProfile != null ||
    effective.autoIncrement !== true || eas.cli?.appVersionSource !== "remote" ||
    eas.submit?.[scope]?.ios?.ascAppId !== expected.ZIIPA_ASC_APP_ID ||
    eas.submit?.[scope]?.ios?.appleTeamId !== expected.ZIIPA_APPLE_TEAM_ID
  ) errors.push("The external preparation profile does not match the pinned Ziipa store identity and manual submission target.");
  const resolvedEnv = { ...production?.env, ...profile?.env };
  if (Object.entries(expected).some(([name, value]) => !name.startsWith("EAS_BUILD_") && resolvedEnv[name] !== value))
    errors.push("The resolved external profile environment does not match the fixed preparation scope.");
} catch {
  errors.push("The dedicated external TestFlight preparation profile could not be verified.");
}
if (errors.length) {
  console.error("External TestFlight preparation blocked:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log("Limited external iOS beta PREPARATION only. Existing-account sign-in uses the live Ziipa API; registration, wallet actions, new network imports and remote push remain unavailable. Privacy publication, reviewer setup, device QA and Apple beta review are pending. This check authorizes no external distribution, tester invitation or public App Store release. The owner must verify those prerequisites and final-binary export compliance separately. Production release checks remain unchanged.");
