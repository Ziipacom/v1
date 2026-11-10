const admobTestAds =
  process.env.ZIIPA_ADMOB_TEST_ADS === "true" &&
  process.env.APP_VARIANT !== "production" &&
  process.env.EXPO_PUBLIC_PORTAL_MODE !== "true";

const limitedTestflight = [
  process.env.ZIIPA_BUILD_SCOPE,
  process.env.EXPO_PUBLIC_BUILD_SCOPE,
].some((scope) => scope === "ios-internal-testflight" || scope === "ios-external-testflight");
const admobReleaseAds =
  process.env.ZIIPA_ADMOB_RELEASE_ADS === "true" &&
  process.env.APP_VARIANT === "production" &&
  process.env.EXPO_PUBLIC_PORTAL_MODE !== "true" &&
  !limitedTestflight &&
  (process.env.ZIIPA_APP_ID || "com.ziipa.app") === "com.ziipa.app";

module.exports = {
  dependencies: admobTestAds || admobReleaseAds
    ? {}
    : { "react-native-google-mobile-ads": { platforms: { android: null, ios: null } } },
};
