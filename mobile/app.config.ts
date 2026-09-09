import type { ExpoConfig } from "expo/config";

const production = process.env.APP_VARIANT === "production";
const portal = process.env.EXPO_PUBLIC_PORTAL_MODE === "true";
const identifier = process.env.ZIIPA_APP_ID || "com.ziipa.app";
const projectId = process.env.EXPO_EAS_PROJECT_ID;
// Omit unreviewed export declarations instead of assuming an exemption.
const encryptionDeclaration = process.env.ZIIPA_USES_NON_EXEMPT_ENCRYPTION;
const encryptionReviewed = process.env.ZIIPA_ENCRYPTION_REVIEWED === "true";
const cameraPermission =
  "Allow Ziipa to preview your camera for recording or livestreaming. Video is only broadcast when you choose Go live.";
const microphonePermission =
  "Allow Ziipa to include your microphone in recordings or livestreams. Audio is only broadcast when you choose Go live.";
const config: ExpoConfig = {
  name: production ? "Ziipa" : "Ziipa Preview",
  slug: "ziipa",
  version: "1.0.0",
  platforms: portal
    ? ["web"]
    : production
      ? ["ios", "android"]
      : ["ios", "android", "web"],
  web: {
    bundler: "metro",
    name: portal ? "Ziipa Studio" : "Ziipa mobile preview",
  },
  ...(portal ? { experiments: { baseUrl: "/studio" } } : {}),
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
      ...(encryptionReviewed &&
      (encryptionDeclaration === "true" || encryptionDeclaration === "false")
        ? {
            ITSAppUsesNonExemptEncryption: encryptionDeclaration === "true",
            ...(encryptionDeclaration === "true" &&
            process.env.ZIIPA_APPLE_ENCRYPTION_COMPLIANCE_CODE
              ? {
                  ITSEncryptionExportComplianceCode:
                    process.env.ZIIPA_APPLE_ENCRYPTION_COMPLIANCE_CODE,
                }
              : {}),
          }
        : {}),
      NSCameraUsageDescription: cameraPermission,
      NSMicrophoneUsageDescription: microphonePermission,
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
      "android.permission.SYSTEM_ALERT_WINDOW",
      "com.google.android.gms.permission.AD_ID",
    ],
  },
  plugins: [
    ["expo-secure-store", { configureAndroidBackup: true }],
    [
      "expo-camera",
      {
        cameraPermission,
        microphonePermission,
        recordAudioAndroid: true,
        barcodeScannerEnabled: false,
      },
    ],
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
        cameraPermission,
        microphonePermission,
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "@config-plugins/react-native-webrtc",
      {
        cameraPermission,
        microphonePermission,
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
