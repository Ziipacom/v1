import type { ExpoConfig } from "expo/config";

const production = process.env.APP_VARIANT === "production";
const identifier = process.env.ZIIPA_APP_ID || "com.ziipa.app";
const projectId = process.env.EXPO_EAS_PROJECT_ID;
const config: ExpoConfig = {
  name: production ? "Ziipa" : "Ziipa Preview",
  slug: "ziipa",
  version: "1.0.0",
  platforms: production ? ["ios", "android"] : ["ios", "android", "web"],
  web: { bundler: "metro", name: "Ziipa mobile preview" },
  owner: process.env.EXPO_OWNER || undefined,
  scheme: production ? "ziipa" : "ziipa-preview",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  icon: "./assets/brand/app-icon.png",
  ios: {
    bundleIdentifier: production ? identifier : `${identifier}.preview`,
    buildNumber: "1",
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      ...(production
        ? {}
        : { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } }),
    },
  },
  android: {
    allowBackup: false,
    package: production ? identifier : `${identifier}.preview`,
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: "./assets/brand/app-icon.png",
      backgroundColor: "#110D1C",
    },
    blockedPermissions: [
      "android.permission.READ_CONTACTS",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "com.google.android.gms.permission.AD_ID",
    ],
  },
  plugins: [
    ["expo-secure-store", { configureAndroidBackup: true }],
    [
      "expo-splash-screen",
      {
        backgroundColor: "#110D1C",
        image: "./assets/brand/ziipa-logo.png",
        imageWidth: 180,
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: false,
        cameraPermission:
          "Allow Ziipa to take photos and record videos when you choose Record in Creator Studio.",
        microphonePermission:
          "Allow Ziipa to record audio with videos you create in Creator Studio.",
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission:
          "Allow Ziipa to record audio with videos you create in Creator Studio.",
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-video",
      { supportsBackgroundPlayback: false, supportsPictureInPicture: false },
    ],
    [
      "expo-build-properties",
      { android: { usesCleartextTraffic: !production } },
    ],
    "expo-asset",
    "expo-font",
    "expo-image",
  ],
  extra: {
    ...(projectId ? { eas: { projectId } } : {}),
    variant: production ? "production" : "preview",
  },
};
export default config;
