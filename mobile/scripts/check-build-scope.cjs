// Production checks remain a separate, unchanged contract. The first private
// iPhone beta has an explicit target, never a renamed production-check bypass.
const env = process.env;
const scopes = {
  "ios-internal-testflight": "./check-ios-internal-testflight.cjs",
  "ios-external-testflight": "./check-ios-external-testflight.cjs",
};
const requested = [env.ZIIPA_BUILD_SCOPE, env.EXPO_PUBLIC_BUILD_SCOPE];
if (requested.some((value) => value !== undefined && value !== "")) {
  const scope = requested[0];
  if (
    !Object.hasOwn(scopes, scope || "") ||
    requested.some((value) => value !== scope) ||
    env.EAS_BUILD_PROFILE !== scope ||
    env.EAS_BUILD_PLATFORM !== "ios"
  ) {
    console.error(
      "Build blocked: a limited TestFlight scope requires its exact iOS profile and both matching scope markers.",
    );
    process.exit(1);
  }
  require(scopes[scope]);
} else {
  if (Object.hasOwn(scopes, env.EAS_BUILD_PROFILE || "")) {
    console.error(
      "Build blocked: the limited TestFlight profile is missing its explicit scope markers.",
    );
    process.exit(1);
  }
  require("./check-release.cjs");
}
