const { withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");

// The private first-device beta does not enroll in remote push. Keeping this
// first in the plugin list makes its mod callback run after the later plugins'
// callbacks (Expo mods are composed in reverse registration order).
module.exports = function withInternalTestflight(config) {
  if (config.extra?.buildScope !== "ios-internal-testflight")
    throw new Error(
      "The internal TestFlight plugin requires its explicit build scope.",
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
