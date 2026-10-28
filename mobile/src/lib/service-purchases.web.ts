import { Purchases } from "@revenuecat/purchases-js";
import type { PurchaseContext, PurchaseOption } from "./commerce";

let instance: Purchases | null = null;
let identity = "";
async function identify(context: PurchaseContext) {
  if (!instance)
    instance = Purchases.configure({ apiKey: context.public_key, appUserId: context.app_user_id });
  else if (identity !== context.app_user_id) await instance.changeUser(context.app_user_id);
  identity = context.app_user_id;
  return instance;
}
export async function serviceOptions(context: PurchaseContext): Promise<PurchaseOption[]> {
  const client = await identify(context);
  const offerings = await client.getOfferings();
  return (offerings.current?.availablePackages || []).flatMap((pkg) => {
    const plan = context.product_plans[pkg.product.identifier];
    return plan
      ? [
          {
            id: pkg.identifier,
            plan,
            title: pkg.product.title,
            price: pkg.product.price.formattedPrice,
            purchase: async () => {
              if (identity !== context.app_user_id)
                throw new Error("Account changed. Reload Services.");
              await client.purchase({ rcPackage: pkg });
            },
          },
        ]
      : [];
  });
}
export async function restoreServices(context: PurchaseContext) {
  const client = await identify(context);
  await client.getCustomerInfo();
}
export async function clearPurchaseIdentity() {
  if (instance) await instance.changeUser(Purchases.generateRevenueCatAnonymousAppUserId());
  identity = "";
}
