// Limited store betas require their exact profile, platform and dual markers.
// The unrestricted production release contract remains separate and unchanged.
const env = process.env;
const scopes = {
  "ios-internal-testflight": { platform: "ios", check: "./check-ios-internal-testflight.cjs" },
  "ios-external-testflight": { platform: "ios", check: "./check-ios-external-testflight.cjs" },
  "android-play-internal": { platform: "android", check: "./check-android-play-internal.cjs" },
};
const requested = [env.ZIIPA_BUILD_SCOPE, env.EXPO_PUBLIC_BUILD_SCOPE];
if (requested.some((value) => value !== undefined && value !== "")) {
  const scope = requested[0];
  if (
    !Object.hasOwn(scopes, scope || "") ||
    requested.some((value) => value !== scope) ||
    env.EAS_BUILD_PROFILE !== scope ||
    env.EAS_BUILD_PLATFORM !== scopes[scope].platform
  ) {
    console.error(
      "Build blocked: a limited store beta requires its exact profile, platform and both matching scope markers.",
    );
    process.exit(1);
  }
  const check = require(scopes[scope].check);
  if (scope === "android-play-internal") check.assertPlayInternalConfig(env);
} else {
  if (Object.hasOwn(scopes, env.EAS_BUILD_PROFILE || "")) {
    console.error(
      "Build blocked: the limited store beta profile is missing its explicit scope markers.",
    );
    process.exit(1);
  }
  require("./check-release.cjs");
}
