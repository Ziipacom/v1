const { withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");

// Both limited iOS beta preparation targets do not enroll in remote push. Keeping this
// first in the plugin list makes its mod callback run after the later plugins'
// callbacks (Expo mods are composed in reverse registration order).
module.exports = function withInternalTestflight(config) {
  if (!["ios-internal-testflight", "ios-external-testflight"].includes(config.extra?.buildScope))
    throw new Error(
      "The limited TestFlight plugin requires its explicit build scope.",
    );
  config = withEntitlementsPlist(config, (value) => {
    delete value.modResults["aps-environment"];
    return value;
  });
  return withInfoPlist(config, (value) => {
    if (Array.isArray(value.modResults.UIBackgroundModes))
      value.modResults.UIBackgroundModes =
        value.modResults.UIBackgroundModes.filter(
          (mode) => mode !== "remote-notification",
        );
    return value;
  });
};
