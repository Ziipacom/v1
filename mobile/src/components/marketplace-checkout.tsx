import { useEffect, useRef, useState } from "react";
import { Linking, Platform, Text, View, Switch } from "react-native";
import * as Crypto from "expo-crypto";
import { useZiipa } from "../provider";
import { money, type Listing } from "../lib/commerce";
import { Action, Notice, Pill } from "./ui";
import { Disclosure } from "./disclosure";
import { InfoTip } from "./info-tip";
import { styles } from "../theme";

type Setup = {
  enabled: boolean;
  mode: "sandbox";
  providers: { stripe: boolean; paypal: boolean };
};
type Seller = {
  connected: boolean;
  ready: boolean;
  configured: boolean;
  mode: "sandbox";
};
type Order = {
  id: string;
  title: string;
  price_cents: number;
  status: string;
  mode: "sandbox";
  provider: "stripe" | "paypal";
};

export function marketplaceCheckoutReady(
  setup: Setup | null,
  provider: "stripe" | "paypal",
) {
  return (
    setup?.enabled === true &&
    setup.mode === "sandbox" &&
    setup.providers?.[provider] === true
  );
}

function paymentFeedback(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  switch (message) {
    case "The seller must finish sandbox payment setup before checkout.":
      return "This seller hasn’t connected payments yet.";
    case "Approve this order on PayPal before confirming the test purchase.":
      return "Approve this order on PayPal first.";
    case "The provider receipt does not match this test order.":
    case "Seller settlement could not be verified for this test order.":
      return "We couldn’t verify this order. Check your order history.";
    case "This beta checkout supports physical merchandise only. Digital purchases require a separate platform-billing and delivery setup.":
      return "Checkout is available for merchandise only.";
    default:
      return message &&
        !/\b(?:sandbox|test mode|test order|test account)\b/i.test(message)
        ? message
        : "Payments are unavailable right now. Try again later.";
  }
}

function orderStatusLabel(status: string) {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "paid":
      return "Complete";
    case "expired":
      return "Expired";
    default:
      return "Status unavailable";
  }
}

export function sandboxProviderLink(
  value: unknown,
  onboarding = false,
  provider: "stripe" | "paypal" = "stripe",
): string {
  if (typeof value !== "string")
    throw new Error("The payment provider did not return a link.");
  const url = new URL(value);
  const hosts =
    provider === "paypal"
      ? ["www.sandbox.paypal.com", "sandbox.paypal.com"]
      : [onboarding ? "connect.stripe.com" : "checkout.stripe.com"];
  if (
    url.protocol !== "https:" ||
    !hosts.includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("The payment provider returned an invalid link.");
  return value;
}

export function MarketplaceCheckout({ listing }: { listing: Listing }) {
  const { api, session } = useZiipa();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<"stripe" | "paypal">("stripe");
  const ready = marketplaceCheckoutReady(setup, provider);
  const request = useRef(Crypto.randomUUID());
  const lock = useRef(false);
  const owner = useRef(session?.access_token);
  owner.current = session?.access_token;
  const identity = useRef({ id: listing.id, revision: listing.revision });
  identity.current = { id: listing.id, revision: listing.revision };
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    generation.current++;
    lock.current = false;
    setBusy(false);
    setSetup(null);
    setOrder(null);
    setError("");
    request.current = Crypto.randomUUID();
    const token = session?.access_token;
    void api<Setup>("/api/store/payments/config")
      .then((result) => {
        if (active && owner.current === token) {
          setSetup(result);
          setProvider((previous) =>
            marketplaceCheckoutReady(result, previous)
              ? previous
              : marketplaceCheckoutReady(result, "stripe")
                ? "stripe"
                : marketplaceCheckoutReady(result, "paypal")
                  ? "paypal"
                  : previous,
          );
        }
      })
      .catch(() => {
        if (active) setError("Couldn’t load payment options. Try again later.");
      });
    return () => {
      active = false;
    };
  }, [api, session?.access_token, listing.id, listing.revision]);
  async function run(refresh = false, capture = false) {
    if (lock.current) return;
    if (!session) {
      setError("Sign in to review checkout and orders.");
      return;
    }
    if (!refresh && !ready) {
      setError("Checkout is unavailable right now.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    const token = owner.current;
    const epoch = generation.current;
    const current = () =>
      alive.current &&
      owner.current === token &&
      generation.current === epoch &&
      identity.current.id === listing.id &&
      identity.current.revision === listing.revision;
    try {
      if (refresh && order) {
        const receipt = await api<Order>(
          capture
            ? `/api/store/payments/paypal/orders/${order.id}/capture`
            : `/api/store/payments/orders/${order.id}/refresh`,
          {},
        );
        if (receipt.mode !== "sandbox")
          throw new Error(
            "We couldn’t verify this order. Check your order history.",
          );
        if (current()) setOrder(receipt);
      } else {
        const result = await api<{ url: string | null; order: Order }>(
          "/api/store/payments/checkout",
          {
            listing_id: listing.id,
            revision: listing.revision,
            request_id: request.current,
            platform: Platform.OS,
            provider,
          },
        );
        if (!current()) return;
        if (result.order.mode !== "sandbox")
          throw new Error(
            "We couldn’t open checkout securely. Try again later.",
          );
        setOrder(result.order);
        if (result.url)
          await Linking.openURL(
            sandboxProviderLink(result.url, false, provider),
          );
      }
    } catch (cause) {
      if (current()) setError(paymentFeedback(cause));
    } finally {
      if (current()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  if (listing.seller_id === session?.user.id)
    return <Notice text="Manage this listing in Sell." />;
  if (listing.kind !== "merchandise")
    return <Notice text="Digital purchases are unavailable." />;
  const methods = (["stripe", "paypal"] as const).filter((method) =>
    marketplaceCheckoutReady(setup, method),
  );
  return (
    <View style={{ gap: 10 }}>
      {methods.length > 0 && (
        <>
          <Text style={styles.label}>Payment method</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {methods.map((value) => (
              <Pill
                key={value}
                title={value === "stripe" ? "Card" : "PayPal"}
                active={provider === value}
                onPress={() => {
                  if (!busy && !order) {
                    setProvider(value);
                    request.current = Crypto.randomUUID();
                  }
                }}
              />
            ))}
          </View>
        </>
      )}
      {ready && <Text style={styles.small}>No charge or shipment</Text>}
      <Action
        title={
          order?.status === "paid"
            ? "Order complete"
            : ready
              ? `Checkout · ${money(listing.price_cents)}`
              : !setup && !error
                ? "Checking availability…"
                : "Checkout unavailable"
        }
        disabled={
          !ready ||
          listing.status !== "published" ||
          (!!order && order.status !== "pending") ||
          !!busy
        }
        busy={busy}
        onPress={() => void run()}
      />
      {order && (
        <>
          <Text style={styles.small}>
            Order {order.id.slice(0, 8)} · {orderStatusLabel(order.status)}
          </Text>
          <Action
            secondary
            title="Refresh order"
            disabled={busy}
            onPress={() => void run(true)}
          />
        </>
      )}
      {order?.provider === "paypal" && order.status === "approved" && (
        <Action
          title="Confirm order"
          disabled={busy}
          onPress={() => void run(true, true)}
        />
      )}
      {!!error && <Notice error text={error} />}
    </View>
  );
}

export function MarketplacePaymentSettings({
  sellerTools = true,
}: { sellerTools?: boolean } = {}) {
  const { api, session } = useZiipa();
  const [open, setOpen] = useState(false);
  const [seller, setSeller] = useState<Seller | null>(null);
  const [paypal, setPaypal] = useState<Seller | null>(null);
  const [paypalConsent, setPaypalConsent] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = useRef({
    token: session?.access_token,
    alive: true,
    locked: false,
    generation: 0,
  });
  scope.current.token = session?.access_token;
  useEffect(() => {
    scope.current.generation++;
    scope.current.locked = false;
    setOpen(false);
    setBusy(false);
    scope.current.alive = true;
    return () => {
      scope.current.alive = false;
    };
  }, []);
  useEffect(() => {
    setSeller(null);
    setPaypal(null);
    setPaypalConsent(false);
    setOrders([]);
    setError("");
  }, [session?.access_token, sellerTools]);
  async function run(
    connect = false,
    order?: Order,
    provider: "stripe" | "paypal" = "stripe",
    capture = false,
  ) {
    if (scope.current.locked) return;
    scope.current.locked = true;
    setBusy(true);
    setError("");
    const token = scope.current.token;
    const generation = scope.current.generation;
    const current = () =>
      scope.current.alive &&
      scope.current.token === token &&
      scope.current.generation === generation;
    try {
      if (connect) {
        if (
          !sellerTools ||
          (provider === "paypal"
            ? !paypal?.configured || !paypalConsent
            : !seller?.configured)
        )
          return;
        const result = await api<{ url: string; mode: "sandbox" }>(
          provider === "paypal"
            ? "/api/store/payments/paypal/seller/connect"
            : "/api/store/payments/seller/connect",
          provider === "paypal" ? { share_data_consent: paypalConsent } : {},
        );
        if (result.mode !== "sandbox")
          throw new Error(
            "We couldn’t open the payment account securely. Try again later.",
          );
        if (current())
          await Linking.openURL(
            sandboxProviderLink(result.url, true, provider),
          );
      } else {
        if (order)
          await api(
            capture
              ? `/api/store/payments/paypal/orders/${order.id}/capture`
              : `/api/store/payments/orders/${order.id}/refresh`,
            {},
          );
        if (!sellerTools) {
          const result = await api<{ orders: Order[] }>(
            "/api/store/payments/orders",
          );
          if (current()) setOrders(result.orders);
          return;
        }
        const results = await Promise.allSettled([
          api<Seller>("/api/store/payments/seller"),
          api<Seller>("/api/store/payments/paypal/seller"),
          api<{ orders: Order[] }>("/api/store/payments/orders"),
        ]);
        if (current()) {
          if (
            results[0].status === "fulfilled" &&
            results[0].value.mode === "sandbox"
          )
            setSeller(results[0].value);
          else setSeller(null);
          if (
            results[1].status === "fulfilled" &&
            results[1].value.mode === "sandbox"
          )
            setPaypal(results[1].value);
          else setPaypal(null);
          if (results[2].status === "fulfilled")
            setOrders(results[2].value.orders);
          if (results.some((result) => result.status === "rejected"))
            setError("Couldn’t refresh all payment details. Try again.");
        }
      }
    } catch (cause) {
      if (current()) setError(paymentFeedback(cause));
    } finally {
      if (current()) {
        scope.current.locked = false;
        setBusy(false);
      }
    }
  }
  return (
    <Disclosure
      title={sellerTools ? "Seller payments & orders" : "Your orders"}
      detail={
        !open && sellerTools && seller?.ready ? "Ready for orders" : undefined
      }
      expanded={open}
      onToggle={() => {
        setOpen(!open);
        if (!open) void run();
      }}
    >
      {sellerTools && (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={styles.label}>Card payments</Text>
            <InfoTip
              title="Payment accounts"
              content="Orders don’t charge buyers or send payouts. Use sample details when connecting a payment account."
            />
          </View>
          {seller?.configured ? (
            <>
              {seller.ready && (
                <Text style={styles.small}>Ready for orders</Text>
              )}
              <Action
                secondary
                title={
                  seller.ready
                    ? "Manage Stripe"
                    : seller.connected
                      ? "Finish connecting Stripe"
                      : "Connect Stripe"
                }
                disabled={busy}
                onPress={() => void run(true)}
              />
            </>
          ) : (
            <Text style={styles.small}>
              {busy && !seller ? "Checking…" : "Unavailable"}
            </Text>
          )}
          {paypal?.configured ? (
            <>
              <Text style={styles.label}>PayPal</Text>
              {paypal.ready && (
                <Text style={styles.small}>Ready for orders</Text>
              )}
              <View
                style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
              >
                <Switch
                  accessibilityLabel="Approve sharing my PayPal seller connection with Ziipa"
                  value={paypalConsent}
                  onValueChange={setPaypalConsent}
                  disabled={busy}
                />
                <Text style={[styles.small, { flex: 1 }]}>
                  Allow PayPal to share my seller connection and payment
                  permissions with Ziipa.
                </Text>
              </View>
              <Action
                secondary
                title={paypal.connected ? "Manage PayPal" : "Connect PayPal"}
                disabled={!paypalConsent || busy}
                onPress={() => void run(true, undefined, "paypal")}
              />
            </>
          ) : (
            <Text style={styles.small}>
              PayPal · {busy && !paypal ? "Checking…" : "Unavailable"}
            </Text>
          )}
        </>
      )}
      <Action
        secondary
        title={sellerTools ? "Refresh payments & orders" : "Refresh orders"}
        disabled={busy}
        onPress={() => void run()}
      />
      {orders.length === 0 && <Text style={styles.small}>No orders yet.</Text>}
      {orders.map((order) => (
        <View key={order.id} style={{ gap: 5, paddingVertical: 8 }}>
          <Text style={styles.body}>
            {order.title} · {money(order.price_cents)}
          </Text>
          <Text style={styles.small}>
            {order.provider === "stripe" ? "Card" : "PayPal"} ·{" "}
            {orderStatusLabel(order.status)} · Order {order.id.slice(0, 8)}
          </Text>
          <Action
            secondary
            title="Verify order"
            disabled={busy}
            onPress={() => void run(false, order)}
          />
          {order.provider === "paypal" && order.status === "approved" && (
            <Action
              title="Confirm order"
              disabled={busy}
              onPress={() => void run(false, order, "paypal", true)}
            />
          )}
        </View>
      ))}
      {!!error && <Notice error text={error} />}
    </Disclosure>
  );
}
