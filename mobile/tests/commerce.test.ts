import assert from "node:assert/strict";
import test from "node:test";
import {
  centsFromText,
  editListing,
  marketplaceSearch,
  storePhotoPath,
} from "../src/lib/commerce.ts";
import { destinationFromSearch, destinationSearch } from "../src/lib/desktop-navigation.ts";
import { assertInternalBetaRequest } from "../src/lib/internal-beta-policy.ts";

test("prices use exact cents and reject exponents, negatives, excess decimals and overflow", () => {
  assert.equal(centsFromText("7.99"), 799);
  assert.equal(centsFromText(" 12.5 "), 1250);
  for (const value of ["1e2", "-5", "3.333", "1,000", "1000000.01", "NaN", ""])
    assert.equal(centsFromText(value), null);
});
test("listing edits contain only accepted input fields", () => {
  const input = {
    id: "example",
    revision: 2,
    status: "published",
    title: "Original",
    description: "Facts",
    kind: "digital",
    category: "music",
    price_cents: 799,
    currency: "USD",
    photo_ids: [],
    descriptor: "",
    overlay: "price",
    condition: "not_applicable",
    delivery: "WAV",
    rights_confirmed: true,
    adult_seller: true,
    seller_id: 3,
    checkout_ready: true,
    photos: [],
  };
  const value = editListing(input as never);
  assert.equal(value.revision, 2);
  assert.ok(!("checkout_ready" in value));
  assert.ok(!("seller_id" in value));
});
test("product photo requests cannot carry session headers to external origins or private source files", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    storePhotoPath(`/api/store/listings/${id}/photos/${id}`),
    `/api/store/listings/${id}/photos/${id}`,
  );
  for (const value of [
    "https://evil.test/photo.png",
    "/api/store/../account/export",
    "/api/store/listings/x/photos/y",
    "/api/store/listings/" + id + "/photos/" + id + "?token=secret",
  ])
    assert.equal(storePhotoPath(value), null);
});
test("filters keep literal search text and monetary units; pagination preserves selected seller", () => {
  const path = marketplaceSearch({
    q: "ambient & calm",
    category: "music",
    kind: "digital",
    sort: "price_low",
    minimum: "1.99",
    maximum: "12",
    after: 24,
    sellerId: 5,
  });
  const params = new URLSearchParams(path.split("?")[1]);
  assert.equal(params.get("q"), "ambient & calm");
  assert.equal(params.get("min_price"), "199");
  assert.equal(params.get("max_price"), "1200");
  assert.equal(params.get("seller_id"), "5");
  assert.equal(params.get("after"), "24");
});
test("Store tabs and storefront links survive desktop reload without exposing product drafts", () => {
  assert.equal(destinationSearch("Store", { tab: "sell" }), "?view=store&tab=sell");
  assert.deepEqual(destinationFromSearch("?view=store&tab=browse&sellerId=9"), {
    screen: "Store",
    params: { tab: "browse", sellerId: 9 },
  });
  assert.equal(destinationFromSearch("?view=store&tab=bad"), null);
  assert.equal(destinationFromSearch("?view=store&sellerId=-1"), null);
});

test("limited iPhone beta can review packages but cannot start a purchase", () => {
  assert.doesNotThrow(() => assertInternalBetaRequest(true, "/api/services/catalog", "GET"));
  assert.throws(
    () => assertInternalBetaRequest(true, "/api/services/purchase-context", "POST"),
    /Purchases are unavailable/,
  );
  assert.doesNotThrow(() =>
    assertInternalBetaRequest(false, "/api/services/purchase-context", "POST"),
  );
});
