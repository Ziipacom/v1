import Purchases from "react-native-purchases";
import { iosLimitedTestflight } from "./config";
import type { PurchaseContext, PurchaseOption } from "./commerce";

async function identify(context: PurchaseContext) {
  if (iosLimitedTestflight)
    throw new Error("Purchases are unavailable in this limited iPhone beta.");
  if (!(await Purchases.isConfigured()))
    Purchases.configure({ apiKey: context.public_key, appUserID: context.app_user_id });
  else if ((await Purchases.getAppUserID()) !== context.app_user_id)
    await Purchases.logIn(context.app_user_id);
}
export async function serviceOptions(context: PurchaseContext): Promise<PurchaseOption[]> {
  await identify(context);
  const offerings = await Purchases.getOfferings();
  return (offerings.current?.availablePackages || []).flatMap((pkg) => {
    const plan = context.product_plans[pkg.product.identifier];
    return plan
      ? [
          {
            id: pkg.identifier,
            plan,
            title: pkg.product.title,
            price: pkg.product.priceString,
            purchase: async () => {
              if ((await Purchases.getAppUserID()) !== context.app_user_id)
                throw new Error("Account changed. Reload Services.");
              await Purchases.purchasePackage(pkg);
            },
          },
        ]
      : [];
  });
}
export async function restoreServices(context: PurchaseContext) {
  await identify(context);
  await Purchases.restorePurchases();
}
export async function clearPurchaseIdentity() {
  if ((await Purchases.isConfigured()) && !(await Purchases.isAnonymous()))
    await Purchases.logOut();
}
