// Production checks remain a separate, unchanged contract. The first private
// iPhone beta has an explicit target, never a renamed production-check bypass.
const env = process.env;
const scope = "ios-internal-testflight";
const requested = [env.ZIIPA_BUILD_SCOPE, env.EXPO_PUBLIC_BUILD_SCOPE];
if (requested.some((value) => value !== undefined && value !== "")) {
  if (
    requested.some((value) => value !== scope) ||
    env.EAS_BUILD_PROFILE !== scope ||
    env.EAS_BUILD_PLATFORM !== "ios"
  ) {
    console.error(
      "Build blocked: internal TestFlight scope requires its exact iOS profile and both matching scope markers.",
    );
    process.exit(1);
  }
  require("./check-ios-internal-testflight.cjs");
} else {
  if (env.EAS_BUILD_PROFILE === scope) {
    console.error(
      "Build blocked: the internal TestFlight profile is missing its explicit scope markers.",
    );
    process.exit(1);
  }
  require("./check-release.cjs");
}
