const { withAndroidManifest } = require("expo/config-plugins");

// A banking/payment verification Activity must be able to return to checkout.
module.exports = function withCommerce(config) {
  return withAndroidManifest(config, (result) => {
    const activities = result.modResults.manifest.application?.[0]?.activity || [];
    const main = activities.find((activity) => activity.$?.["android:name"] === ".MainActivity");
    if (main) main.$["android:launchMode"] = "singleTop";
    return result;
  });
};
