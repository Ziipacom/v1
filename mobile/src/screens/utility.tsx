import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { PromotionHub } from "../components/promotion-hub";
import { WalletScreen } from "./wallet";
import { InboxContent } from "./account-messages";

import type { RootStack } from "../lib/types";
export function UtilityScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Utility">) {
  const kind = route.params.kind;
  if (kind === "wallet")
    return (
      <WalletScreen
        key={route.params.item?.id || "wallet"}
        navigation={navigation}
        initialItem={route.params.item}
      />
    );
  if (kind === "promote")
    return (
      <PromotionHub navigation={navigation} initialItem={route.params.item} />
    );
  return <InboxContent navigation={navigation} />;
}
