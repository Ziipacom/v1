import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Image, Platform, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import Constants from "expo-constants";
import type { NativeAd } from "react-native-google-mobile-ads";
import { Action } from "./ui";
import { useZiipa } from "../provider";
import { color, styles, useTheme } from "../theme";

type AdsSdk = typeof import("react-native-google-mobile-ads");
type Placement = "discover" | "marketplace";
type SponsoredAd = { sdk: AdsSdk; nativeAd: NativeAd };

const testAdsEnabled =
  (Platform.OS === "android" || Platform.OS === "ios") &&
  Constants.expoConfig?.extra?.admobTestAds === true;
const releaseAdsEnabled =
  (Platform.OS === "android" || Platform.OS === "ios") &&
  Constants.expoConfig?.extra?.admobReleaseAds === true;
const releaseUnits = {
  android: {
    discover: "ca-app-pub-4702540477449660/2400055673",
    marketplace: "ca-app-pub-4702540477449660/7703132055",
  },
  ios: {
    discover: "ca-app-pub-4702540477449660/6289327663",
    marketplace: "ca-app-pub-4702540477449660/2284176037",
  },
};

let consent = {
  sdk: null as AdsSdk | null,
  canRequestAds: false,
  privacyRequired: false,
};
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const getConsent = () => consent;
type ConsentInfo = Pick<
  Awaited<ReturnType<AdsSdk["AdsConsent"]["getConsentInfo"]>>,
  "canRequestAds" | "privacyOptionsRequirementStatus"
>;
function updateConsent(sdk: AdsSdk, info: ConsentInfo) {
  consent = {
    sdk,
    canRequestAds: info.canRequestAds,
    privacyRequired: info.privacyOptionsRequirementStatus ===
      sdk.AdsConsentPrivacyOptionsRequirementStatus.REQUIRED,
  };
  for (const listener of listeners) listener();
}
let preparingConsent: Promise<void> | undefined;
function prepareConsent() {
  preparingConsent ??= (async () => {
    const sdk = await import("react-native-google-mobile-ads");
    updateConsent(sdk, await sdk.AdsConsent.gatherConsent());
  })().catch(() => { preparingConsent = undefined; });
  return preparingConsent;
}

let initializingAds: Promise<unknown> | undefined;
function initializeAds(sdk: AdsSdk) {
  initializingAds ??= (async () => {
    const ads = sdk.default();
    await ads.setRequestConfiguration({
      maxAdContentRating: sdk.MaxAdContentRating.G,
    });
    ads.setAppMuted(true);
    await ads.initialize();
  })().catch((error: unknown) => {
    initializingAds = undefined;
    throw error;
  });
  return initializingAds;
}

function useServingPermission(active: boolean) {
  const { api, session } = useZiipa();
  const token = session?.access_token;
  const [lease, setLease] = useState<string | null>(null);
  useEffect(() => {
    if (!releaseAdsEnabled || !active || !token) return;
    const accountToken = token;
    let stopped = false;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let expiration: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const result = await api<{ enabled: boolean }>(`/api/mobile/ads/${Platform.OS}`);
        if (stopped) return;
        clearTimeout(expiration);
        setLease(result.enabled === true ? accountToken : null);
        if (result.enabled === true)
          expiration = setTimeout(() => setLease(null), 45_000);
      } catch {
        if (!stopped) setLease(null);
      } finally {
        if (!stopped) refresh = setTimeout(check, 25_000);
      }
    }
    void check();
    return () => {
      stopped = true;
      clearTimeout(refresh);
      clearTimeout(expiration);
      setLease(null);
    };
  }, [active, api, token]);
  return active && !!token && lease === token;
}

export function AdPrivacyOptions() {
  const { sdk, privacyRequired } = useSyncExternalStore(subscribe, getConsent);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if ((!testAdsEnabled && !releaseAdsEnabled) || sdk) return;
    let active = true;
    void (async () => {
      const adsSdk = await import("react-native-google-mobile-ads");
      const info = await adsSdk.AdsConsent.getConsentInfo();
      if (active && !consent.sdk)
        updateConsent(adsSdk, { ...info, canRequestAds: false });
    })().catch(() => {});
    return () => { active = false; };
  }, [sdk]);
  if (!sdk || !privacyRequired) return null;
  async function openOptions(adsSdk: AdsSdk) {
    setBusy(true);
    setFailed(false);
    updateConsent(adsSdk, {
      canRequestAds: false,
      privacyOptionsRequirementStatus: adsSdk.AdsConsentPrivacyOptionsRequirementStatus.REQUIRED,
    });
    try {
      if (!preparingConsent) await adsSdk.AdsConsent.requestInfoUpdate();
      updateConsent(adsSdk, await adsSdk.AdsConsent.showPrivacyOptionsForm());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Action secondary title="Ad privacy choices" busy={busy} onPress={() => void openOptions(sdk)} />
      {failed && <Text style={styles.small}>Ad privacy choices could not open. Try again.</Text>}
    </>
  );
}

/** Load a single sponsored ad while the placement is eligible and visible. */
export function useSponsoredAd(placement: Placement, eligible: boolean) {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    if (!testAdsEnabled && !releaseAdsEnabled) return;
    const listener = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => listener.remove();
  }, []);
  const active = eligible && focused && foreground;
  const permitted = useServingPermission(active);
  const enabled = active && (testAdsEnabled || permitted);
  const { sdk, canRequestAds } = useSyncExternalStore(subscribe, getConsent);
  const [ad, setAd] = useState<SponsoredAd | null>(null);

  useEffect(() => {
    if (enabled) void prepareConsent();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !sdk || !canRequestAds) return;
    let cancelled = false;
    let loaded: NativeAd | undefined;
    void (async () => {
      await initializeAds(sdk);
      if (cancelled) return;
      const unitId = testAdsEnabled
        ? placement === "discover" ? sdk.TestIds.NATIVE_VIDEO : sdk.TestIds.NATIVE
        : releaseUnits[Platform.OS === "ios" ? "ios" : "android"][placement];
      const nativeAd = await sdk.NativeAd.createForAdRequest(unitId, {
        requestNonPersonalizedAdsOnly: true,
        startVideoMuted: true,
      });
      if (cancelled) {
        nativeAd.destroy();
        return;
      }
      loaded = nativeAd;
      setAd({ sdk, nativeAd });
    })().catch(() => {
      // Empty inventory and request failures leave the organic feed intact.
    });
    return () => {
      cancelled = true;
      loaded?.destroy();
      setAd(null);
    };
  }, [enabled, sdk, canRequestAds, placement]);

  return enabled && canRequestAds ? ad : null;
}

export function SponsoredAdCard({ ad, tile = false }: { ad: SponsoredAd; tile?: boolean }) {
  useTheme();
  const { NativeAdView, NativeAsset, NativeAssetType, NativeMediaView } = ad.sdk;
  const { nativeAd } = ad;
  return (
    <NativeAdView
      nativeAd={nativeAd}
      style={{
        backgroundColor: color.panel,
        borderWidth: 1,
        borderColor: color.border,
        borderRadius: 12,
        padding: 10,
        gap: 8,
      }}
    >
      <Text style={[styles.small, { minHeight: 15 }]}>
        {testAdsEnabled ? "Sponsored · Test ad" : "Sponsored"}
      </Text>
      {nativeAd.mediaContent && (
        <NativeMediaView
          resizeMode="contain"
          style={{ width: "100%", aspectRatio: tile ? 1 : 16 / 9, minHeight: 120 }}
        />
      )}
      <View style={{ gap: 4 }}>
        {!!nativeAd.icon?.url && (
          <NativeAsset assetType={NativeAssetType.ICON}>
            <Image source={{ uri: nativeAd.icon.url }} style={{ width: 36, height: 36 }} />
          </NativeAsset>
        )}
        <NativeAsset assetType={NativeAssetType.HEADLINE}>
          <Text style={styles.label}>{nativeAd.headline}</Text>
        </NativeAsset>
        {!!nativeAd.advertiser && (
          <NativeAsset assetType={NativeAssetType.ADVERTISER}>
            <Text style={styles.small}>{nativeAd.advertiser}</Text>
          </NativeAsset>
        )}
        {!!nativeAd.body && (
          <NativeAsset assetType={NativeAssetType.BODY}>
            <Text style={styles.small}>{nativeAd.body}</Text>
          </NativeAsset>
        )}
        {!!nativeAd.callToAction && (
          <NativeAsset assetType={NativeAssetType.CALL_TO_ACTION}>
            <Text style={[styles.label, { color: color.lime }]}>{nativeAd.callToAction}</Text>
          </NativeAsset>
        )}
      </View>
    </NativeAdView>
  );
}
