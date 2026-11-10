import { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import Constants from "expo-constants";
import type { NativeAd } from "react-native-google-mobile-ads";
import { color, styles, useTheme } from "../theme";

type AdsSdk = typeof import("react-native-google-mobile-ads");
type Placement = "discover" | "marketplace";
type SponsoredAd = { sdk: AdsSdk; nativeAd: NativeAd };

const testAdsEnabled =
  (Platform.OS === "android" || Platform.OS === "ios") &&
  Constants.expoConfig?.extra?.admobTestAds === true;
let readySdk: Promise<AdsSdk | null> | undefined;

function prepareAds() {
  readySdk ??= (async () => {
    const sdk = await import("react-native-google-mobile-ads");
    const consent = await sdk.AdsConsent.gatherConsent();
    if (
      !consent.canRequestAds ||
      consent.privacyOptionsRequirementStatus ===
        sdk.AdsConsentPrivacyOptionsRequirementStatus.REQUIRED
    ) {
      return null;
    }
    const ads = sdk.default();
    await ads.setRequestConfiguration({
      maxAdContentRating: sdk.MaxAdContentRating.G,
    });
    ads.setAppMuted(true);
    await ads.initialize();
    return sdk;
  })().catch(() => null);
  return readySdk;
}

/** Load one Google demo ad while the placement is eligible and in focus. */
export function useSponsoredAd(placement: Placement, eligible: boolean) {
  const focused = useIsFocused();
  const enabled = testAdsEnabled && eligible && focused;
  const [ad, setAd] = useState<SponsoredAd | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let loaded: NativeAd | undefined;
    void (async () => {
      const sdk = await prepareAds();
      if (!sdk || cancelled) return;
      const unitId = placement === "discover" ? sdk.TestIds.NATIVE_VIDEO : sdk.TestIds.NATIVE;
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
  }, [enabled, placement]);

  return enabled ? ad : null;
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
      <Text style={styles.small}>Sponsored · Test ad</Text>
      <NativeMediaView
        resizeMode="contain"
        style={{ width: "100%", aspectRatio: tile ? 1 : 16 / 9, minHeight: 120 }}
      />
      <View style={{ gap: 4 }}>
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
