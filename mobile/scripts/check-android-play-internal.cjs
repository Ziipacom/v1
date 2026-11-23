const fs = require("node:fs");
const path = require("node:path");
const scope = "android-play-internal";
const expected = {
  EXPO_NO_DOTENV: "1",
  EXPO_OWNER: "ziipa",
  EXPO_EAS_PROJECT_ID: "a130b762-6812-4963-9ebd-5d103a24084e",
  APP_VARIANT: "production",
  ZIIPA_APP_ID: "com.ziipa.app",
  ZIIPA_BUILD_SCOPE: scope,
  EXPO_PUBLIC_BUILD_SCOPE: scope,
  EXPO_PUBLIC_API_URL: "https://api.ziipa.com",
  EXPO_PUBLIC_PRIVACY_URL: "https://ziipa.com/privacy-beta",
  EXPO_PUBLIC_SUPPORT_EMAIL: "ziipaziipa@gmail.com",
  EXPO_PUBLIC_PORTAL_MODE: "false",
  EXPO_PUBLIC_ENABLE_DEMO: "false",
  EXPO_PUBLIC_ENABLE_CONCEPTS: "false",
};

function assertPlayInternalConfig(env) {
  const errors = Object.entries(expected)
    .filter(([name, value]) => env[name] !== value)
    .map(([name]) => `${name} does not match the Ziipa internal Play target.`);
  if (
    (env.EAS_BUILD_PLATFORM && env.EAS_BUILD_PLATFORM !== "android") ||
    (env.EAS_BUILD_PROFILE && env.EAS_BUILD_PROFILE !== scope)
  ) errors.push("The internal Play target requires its Android profile.");
  if (
    env.GOOGLE_SERVICES_JSON ||
    env.ZIIPA_ADMOB_RELEASE_ADS === "true" ||
    env.ZIIPA_ADMOB_TEST_ADS === "true"
  ) errors.push("The internal Play target excludes Firebase enrollment and ads.");
  try {
    const eas = JSON.parse(fs.readFileSync(path.join(__dirname, "../eas.json"), "utf8"));
    const base = eas.build?.production;
    const profile = eas.build?.[scope];
    const resolved = { ...base, ...profile, android: { ...base?.android, ...profile?.android } };
    const resolvedEnv = { ...base?.env, ...profile?.env };
    if (
      profile?.extends !== "production" || base?.extends != null ||
      resolved.distribution !== "store" || resolved.credentialsSource !== "remote" ||
      resolved.environment !== "preview" || resolved.developmentClient === true ||
      resolved.autoIncrement !== false || eas.cli?.appVersionSource !== "remote" ||
      resolved.android.buildType !== "app-bundle" || resolved.android.withoutCredentials === true ||
      resolved.android.gradleCommand != null ||
      Object.keys(base?.android || {}).some((key) => key !== "buildType") ||
      Object.keys(profile?.android || {}).length !== 0 ||
      resolved.autoSubmit === true || resolved.autoSubmitWithProfile != null ||
      Object.entries(expected).some(([name, value]) => resolvedEnv[name] !== value)
    ) errors.push("The dedicated signed Android App Bundle profile could not be verified.");
  } catch {
    errors.push("The dedicated internal Play profile could not be read.");
  }
  if (errors.length)
    throw new Error("Internal Play preparation blocked:\n- " + errors.join("\n- "));
}
module.exports = { assertPlayInternalConfig };
