import type { ExpoConfig } from "expo/config";

const production = process.env.APP_VARIANT === "production";
const portal = process.env.EXPO_PUBLIC_PORTAL_MODE === "true";
const identifier = process.env.ZIIPA_APP_ID || "com.ziipa.app";
const projectId = process.env.EXPO_EAS_PROJECT_ID;
const internalTestflight = process.env.ZIIPA_BUILD_SCOPE === "ios-internal-testflight" ||
  process.env.EXPO_PUBLIC_BUILD_SCOPE === "ios-internal-testflight";
const externalTestflight = process.env.ZIIPA_BUILD_SCOPE === "ios-external-testflight" ||
  process.env.EXPO_PUBLIC_BUILD_SCOPE === "ios-external-testflight";
const limitedTestflight = internalTestflight || externalTestflight;
const limitedScope = internalTestflight ? "ios-internal-testflight" : "ios-external-testflight";
if (limitedTestflight && (
  process.env.ZIIPA_BUILD_SCOPE !== limitedScope ||
  process.env.EXPO_PUBLIC_BUILD_SCOPE !== limitedScope ||
  !production || portal || identifier !== "com.ziipa.app" ||
  process.env.EXPO_OWNER !== "ziipa" ||
  projectId !== "a130b762-6812-4963-9ebd-5d103a24084e" ||
  process.env.ZIIPA_APPLE_TEAM_ID !== "L6WH6BD2N5" ||
  process.env.ZIIPA_ASC_APP_ID !== "6827668999" ||
  process.env.EXPO_PUBLIC_API_URL !== "https://api.ziipa.com" ||
  process.env.EXPO_PUBLIC_ENABLE_DEMO !== "false" ||
  process.env.EXPO_PUBLIC_ENABLE_CONCEPTS !== "false"
)) throw new Error("The limited iOS beta requires its matching scope, production identity, live HTTPS API and disabled demo/concept flags.");
if (externalTestflight && process.env.EXPO_PUBLIC_PRIVACY_URL !== "https://ziipa.com/privacy-beta")
  throw new Error("External beta preparation requires the exact Ziipa beta privacy URL; publication and review remain separate checks.");
// Owner-provided Firebase client configuration (an EAS file variable or local
// path), never the FCM service-account private key. Web exports do not use it.
const googleServicesFile = portal
  ? undefined
  : process.env.GOOGLE_SERVICES_JSON?.trim();
// Omit unreviewed export declarations instead of assuming an exemption.
const encryptionDeclaration = process.env.ZIIPA_USES_NON_EXEMPT_ENCRYPTION;
const encryptionReviewed = process.env.ZIIPA_ENCRYPTION_REVIEWED === "true";
const cameraPermission =
  "Allow Ziipa to preview your camera for recording or livestreaming. Video is only broadcast when you choose Go live.";
const microphonePermission =
  "Allow Ziipa to use your microphone for recordings, livestreams and voice-to-text. Livestream audio starts only when you choose Go live.";
const photoLibraryPermission =
  "Allow Ziipa to access the photos and videos you choose to upload for your creations, profile avatar and cover artwork.";
const config: ExpoConfig = {
  name: production ? "Ziipa" : "Ziipa Preview",
  slug: "ziipa",
  version: "1.0.14",
  platforms: limitedTestflight ? ["ios"] : portal
    ? ["web"]
    : production
      ? ["ios", "android"]
      : ["ios", "android", "web"],
  web: {
    bundler: "metro",
    name: portal ? "Ziipa Studio" : "Ziipa mobile preview",
    favicon: "./assets/brand/ziipa-favicon.png",
  },
  ...(portal ? { experiments: { baseUrl: "/studio" } } : {}),
  owner: process.env.EXPO_OWNER || undefined,
  scheme: production ? "ziipa" : "ziipa-preview",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  icon: "./assets/brand/ziipa-favicon.png",
  ios: {
    ...(limitedTestflight ? { appleTeamId: "L6WH6BD2N5" } : {}),
    bundleIdentifier: production ? identifier : `${identifier}.preview`,
    buildNumber: "1",
    supportsTablet: false,
    infoPlist: {
      ...(!limitedTestflight && encryptionReviewed &&
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
      NSPhotoLibraryUsageDescription: photoLibraryPermission,
      ...(production
        ? {}
        : { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } }),
    },
  },
  android: {
    allowBackup: false,
    package: production ? identifier : `${identifier}.preview`,
    ...(googleServicesFile ? { googleServicesFile } : {}),
    versionCode: 15,
    adaptiveIcon: {
      foregroundImage: "./assets/brand/ziipa-favicon.png",
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
    ...(limitedTestflight ? ["./scripts/with-internal-testflight.cjs"] : []),
    [
      "expo-notifications",
      {
        defaultChannel: "ziipa-private-updates",
        color: "#5420ab",
        enableBackgroundRemoteNotifications: false,
      },
    ],
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
        photosPermission: photoLibraryPermission,
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
      "expo-speech-recognition",
      {
        microphonePermission,
        speechRecognitionPermission:
          "Allow Ziipa to turn your spoken requests into editable text.",
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
    "./plugins/with-commerce.cjs",
  ],
  extra: {
    ...(projectId ? { eas: { projectId } } : {}),
    variant: production ? "production" : "preview",
    ...(internalTestflight ? { buildScope: "ios-internal-testflight", publicReleaseAllowed: false, deviceQA: "pending", exportCompliance: "pending-owner-final-binary-review" } : {}),
    ...(externalTestflight ? { buildScope: "ios-external-testflight", publicReleaseAllowed: false, externalDistributionAllowed: false, deviceQA: "pending", exportCompliance: "pending-owner-final-binary-review", policyPublication: "pending-owner-review-and-publication", reviewerAccount: "pending-owner-setup", appleBetaReview: "pending" } : {}),
  },
};
export default config;
