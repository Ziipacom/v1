export type ProductKind = "digital" | "merchandise";
export type ProductCategory = "music" | "video" | "art" | "merch" | "other";
export type Storefront = { name: string; description: string; enabled: boolean; revision: number };
export type ListingDraft = {
  id?: string;
  revision: number;
  title: string;
  description: string;
  kind: ProductKind;
  category: ProductCategory;
  price_cents: number;
  currency: "USD";
  photo_ids: string[];
  descriptor: string;
  overlay: "none" | "price" | "editorial";
  condition: "not_applicable" | "new" | "like_new" | "good" | "fair";
  delivery: string;
  status: "draft" | "published" | "sold" | "archived";
  rights_confirmed: boolean;
  adult_seller: boolean;
};
export type Listing = Omit<ListingDraft, "status"> & {
  id: string;
  status: ListingDraft["status"] | "hidden";
  seller_id: number;
  store_name: string;
  photos: string[];
  checkout_ready: boolean;
  created_at: string;
};
export type StoreMine = { storefront: Storefront; listings: Listing[] };
export type MarketPage = {
  items: Listing[];
  next: number | null;
  checkout_ready: boolean;
  storefront?: { seller_id: number; name: string; description: string } | null;
};
export type Suggestion = {
  title: string;
  description: string;
  storefront_name: string;
  descriptor: string;
};
export type ServicePlan = {
  id: string;
  name: string;
  monthly_price_cents: number;
  storage_gib: number;
  summary: string;
};
export type Services = {
  catalog: {
    pricing_status: string;
    currency: string;
    plans: ServicePlan[];
    features: {
      id: string;
      name: string;
      cost_driver: string;
      free: string;
      upgrade: string;
      status: string;
      activation: string;
    }[];
  };
  billing_enabled: boolean;
  available_platforms: string[];
  grants: { plan: string; expires_at: string; store: string; sandbox: boolean }[];
  storage: { used_bytes: number; limit_bytes: number };
  purchase_requirements: string;
};
export type PurchaseContext = {
  app_user_id: string;
  public_key: string;
  product_plans: Record<string, string>;
};
export type PurchaseOption = {
  id: string;
  plan: string;
  title: string;
  price: string;
  purchase: () => Promise<void>;
};

export const productCategories: { id: ProductCategory; title: string }[] = [
  { id: "music", title: "Music" },
  { id: "video", title: "Video" },
  { id: "art", title: "Art & design" },
  { id: "merch", title: "Merchandise" },
  { id: "other", title: "Other" },
];
export const emptyListing = (): ListingDraft => ({
  revision: 0,
  title: "",
  description: "",
  kind: "digital",
  category: "music",
  price_cents: 0,
  currency: "USD",
  photo_ids: [],
  descriptor: "",
  overlay: "price",
  condition: "not_applicable",
  delivery: "",
  status: "draft",
  rights_confirmed: false,
  adult_seller: false,
});
export function editListing(value: Listing): ListingDraft {
  const fields = emptyListing();
  return Object.fromEntries(
    Object.keys({ id: undefined, ...fields }).map((key) => [
      key,
      key === "status" && value.status === "hidden" ? "draft" : value[key as keyof Listing],
    ]),
  ) as ListingDraft;
}
export function centsFromText(value: string): number | null {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, decimal = ""] = value.trim().split(".");
  const result = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  return result <= 100000000 ? result : null;
}
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const photoPath = new RegExp(`^/api/store/listings/${uuid}/photos/${uuid}$`, "i");
const ownedPhoto = new RegExp(`^/api/creator/media/${uuid}$`, "i");
/** Never send session headers to a URL from a listing, a model or an external seller. */
export function storePhotoPath(value: unknown): string | null {
  return typeof value === "string" && (photoPath.test(value) || ownedPhoto.test(value))
    ? value
    : null;
}
export function marketplaceSearch(input: {
  q: string;
  category: string;
  kind: string;
  sort: string;
  minimum?: string;
  maximum?: string;
  after?: number;
  sellerId?: number;
}) {
  const query = new URLSearchParams();
  if (input.q.trim()) query.set("q", input.q.trim().slice(0, 120));
  if (input.category !== "all") query.set("category", input.category);
  if (input.kind !== "all") query.set("kind", input.kind);
  query.set("sort", input.sort);
  for (const [key, value] of [
    ["min_price", input.minimum],
    ["max_price", input.maximum],
  ] as const) {
    if (!value?.trim()) continue;
    const cents = centsFromText(value);
    if (cents === null) throw new Error("Enter a valid price with up to two decimal places.");
    query.set(key, String(cents));
  }
  if (input.after !== undefined) query.set("after", String(input.after));
  if (input.sellerId) query.set("seller_id", String(input.sellerId));
  return "/api/store/listings?" + query;
}
