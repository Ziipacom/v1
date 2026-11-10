const admobTestAds =
  process.env.ZIIPA_ADMOB_TEST_ADS === "true" &&
  process.env.APP_VARIANT !== "production" &&
  process.env.EXPO_PUBLIC_PORTAL_MODE !== "true";

module.exports = {
  dependencies: admobTestAds
    ? {}
    : { "react-native-google-mobile-ads": { platforms: { android: null, ios: null } } },
};
