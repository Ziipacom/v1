# Native livestream implementation and validation

Updated September 9, 2026. This is an internal-preview change, not an App Store or Play approval claim.

## Implemented

- Native `react-native-webrtc` 124.0.8, Expo config plugin 15.0.2, Expo SDK 57 / React Native 0.86.3.
- Private phone-camera preview followed by a separate, consent-gated Go live action. Audio and video capture are not acquired automatically.
- Send-only audio/video WHIP to owner-authorized Livepeer ingest. Provider API keys stay on FastAPI; ingest credentials stay in component memory.
- Front/rear camera switch, microphone mute/unmute, explicit Stop, and optional external RTMP encoder controls with a hidden stream key.
- Foreground-only capture. Cancellation, late permission results, failed/partial permission grants, track loss, transport timeout, backgrounding and unmount clean up capture/native handles. Public LIVE labels still come exclusively from fresh provider status.
- At most four approved HTTPS edge-discovery requests; every redirect is checked before following it. Negotiation has a 25-second timeout and a 256 KB SDP ceiling, without account cookies or bearer headers.
- An older binary or Expo Go missing the native module displays a rebuild notice and retains the external encoder option.

## Evidence

- Strict TypeScript passes.
- 39 mobile tests pass after the final publishing/security integration, including seven native capture/WHIP security and lifecycle cases. No actual camera, microphone or live stream was used in automated tests.
- Android prebuild passes. Generated manifest contains camera/microphone/network permissions and excludes overlay, contacts and storage-reading permissions.
- iOS config introspection contains explicit camera/microphone recording and livestream purpose strings, with no background camera/audio modes.
- Read-only HEAD discovery with an intentionally invalid test key successfully resolved the official regional `nyc-prod-catalyst-0.lp-playback.studio` edge. No provider stream was created.
- The actual downloaded WebRTC ARM64 `libjingle_peerconnection_so.so` has `0x4000` (16 KB) ELF LOAD segment alignment, verified using the installed NDK's `llvm-readelf`.
- Android SDK 36, build tools 36.0.0, NDK 27.1.12297006 and CMake 3.22.1 are installed in the ignored local `.local/android-sdk` directory. JDK 21 is used. No emulator or system image was installed.
- Android ARM64 release compilation succeeded: first full build **9m 36s / 881 tasks**, final incremental build with the completed publishing/security changes **2m 8s / 805 tasks**. The final APK's v2 signature, package identity, SDK versions and 16 KB ZIP alignment were verified. All 26 packaged ARM64 native libraries pass 16 KB ELF alignment checks. The 5,986,620-byte application bundle has the Hermes bytecode header.

Final APK: [Ziipa Native Live Preview — Android ARM64](../artifacts/Ziipa-Native-Live-Preview-2026-09-09-arm64.apk), **71,174,207 bytes**. Package `com.ziipa.app.preview`, version `1.0.0` / code `1`, Android 7+ (minimum SDK24), target SDK36. SHA-256: `554b3223d985855c5b386d4655d788d2723a88beba5054c731a971329342aa75`. [Machine-readable evidence](../artifacts/native-live-build-verification.json) and a SHA-256 sidecar accompany it. Build logs are retained in the ignored `.local/native-live-stage-build.log` and `.local/native-live-final-build.log` files.

**API deployment remains separate:** this APK calls `https://api.ziipa.com`, matching the existing preview environment. Compiling the APK does not deploy FastAPI. New live, rendering and social publishing functions require their updated cloud API routes and real provider configuration before they work from this binary. No server API key is bundled. Private recording and sample review remain separate from a public broadcast.

The config plugin declares Expo >=56; its published version table does not independently prove SDK57 compatibility. Native compilation and device testing are required. The OneDrive host requires a scoped Expo entry-point lookup fallback, applied by `scripts/fix-prebuild-onedrive.cjs` during postinstall. The fallback uses `lstat` only on Windows when the existing glob fails, preserves real symlinks and rejects ambiguous entry points.

## Rebuild

Use the existing `eas.json` preview environment for internal preview builds. Windows CMake/Ninja requires a short physical checkout/build directory without spaces (this host uses `C:\ziipa-native-build`). A substituted app drive alone is insufficient because Expo autolinking canonicalizes dependency paths. Do not copy secrets, old binaries, generated native folders or `node_modules` into the build stage; install the locked dependencies there.

For a local Windows build, set `ANDROID_HOME` / `ANDROID_SDK_ROOT` to a short path for the installed SDK, `JAVA_HOME` to JDK 21, `APP_VARIANT=preview`, `EXPO_PUBLIC_API_URL=https://api.ziipa.com`, `EXPO_PUBLIC_ENABLE_DEMO=true`, `EXPO_PUBLIC_ENABLE_CONCEPTS=true`, `EXPO_PUBLIC_PORTAL_MODE=false` and `NODE_ENV=production`. Then run:

```powershell
npm ci
npx expo prebuild --platform android --no-install
./android/gradlew.bat -p android assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=3 --console=plain
```

Local preview release builds currently use the generated debug signing key. They are suitable only for internal installation, not store submission. Do not replace the production signing key or upload this preview APK as a production release.

If Android reports a conflicting existing app signature, do not discard its data casually. Preserve any local drafts before choosing whether to uninstall an older preview signed with a different key. No device was installed, uninstalled, or accessed for camera testing during this build.

## Device acceptance still required

1. Install the rebuilt native app on an Android ARM64 phone. Verify both granted/denied permission flows, private preview, front/rear camera and microphone mute. Camera/mic must stop after back navigation, lock, backgrounding, interruptions and cancellation during permission prompts.
2. Configure the live API and owner account with a real Livepeer server key. Deliberately start a public broadcast only with informed consent from everyone shown/heard and rights to the content.
3. Watch from a separate device. Verify audio/video, fresh LIVE status, mute, flip, network loss, retry, and verified End without orphan streams.
4. Build iOS on a Mac using the Expo57-supported Xcode version, CocoaPods and valid signing. Repeat permission, AVAudioSession interruption, camera orientation, mute and lifecycle checks on physical iPhones.
5. Complete store signing, privacy declarations, moderation/reporting, device QA and store review before any public release. Automated compile/tests do not prove device audiovisual quality or provider readiness.

Primary references: [Expo57](https://docs.expo.dev/versions/v57.0.0/), [WebRTC Expo setup](https://github.com/react-native-webrtc/react-native-webrtc), [Expo config plugin](https://github.com/expo/config-plugins/tree/main/packages/react-native-webrtc), [iOS installation](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/Documentation/iOSInstallation.md), [Livepeer client SDK](https://github.com/livepeer/livepeer.js).
