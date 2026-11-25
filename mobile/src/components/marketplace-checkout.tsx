import { useEffect, useRef, useState } from "react";
import { Linking, Platform, Text, View, Switch } from "react-native";
import * as Crypto from "expo-crypto";
import { useZiipa } from "../provider";
import { money, type Listing } from "../lib/commerce";
import { Action, Notice, Pill } from "./ui";
import { Disclosure } from "./disclosure";
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

export function marketplaceCheckoutStatus(
  setup: Setup | null,
  provider: "stripe" | "paypal",
  failed = false,
) {
  if (marketplaceCheckoutReady(setup, provider))
    return "Test checkout · no real charge";
  if (!setup && !failed) return "Checking checkout availability…";
  return "Checkout is unavailable right now. No payment can be started here.";
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
        if (active)
          setError("Payment services are unavailable. Try again later.");
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
    if (!refresh && !marketplaceCheckoutReady(setup, provider)) {
      setError("Checkout is unavailable right now. No payment was started.");
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
            "This order could not be verified as a test order. Check your order history before continuing.",
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
            "This checkout could not be verified as a test order. No payment page was opened.",
          );
        setOrder(result.order);
        if (result.url)
          await Linking.openURL(
            sandboxProviderLink(result.url, false, provider),
          );
      }
    } catch (cause) {
      if (current()) setError((cause as Error).message);
    } finally {
      if (current()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  if (listing.seller_id === session?.user.id)
    return (
      <Notice text="This is your listing. Manage it from Sell; checkout is for buyers." />
    );
  if (listing.kind !== "merchandise")
    return (
      <Notice text="Digital purchases are unavailable. You can view this product’s public preview." />
    );
  return (
    <View style={{ gap: 10 }}>
      {(["stripe", "paypal"] as const).some((value) =>
        marketplaceCheckoutReady(setup, value),
      ) && (
        <>
          <Text style={styles.label}>Payment method</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(["stripe", "paypal"] as const)
              .filter((value) => marketplaceCheckoutReady(setup, value))
              .map((value) => (
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
      <Notice text={marketplaceCheckoutStatus(setup, provider, !!error)} />
      <Text style={styles.small}>
        Test mode · no real charge. Delivery, shipping and returns follow the
        seller’s description. A test order does not require real shipment.
      </Text>
      <Action
        title={
          order?.status === "paid"
            ? "Test order paid"
            : marketplaceCheckoutReady(setup, provider)
              ? `Test checkout · ${money(listing.price_cents)}`
              : "Checkout unavailable"
        }
        disabled={
          !marketplaceCheckoutReady(setup, provider) ||
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
            Order {order.id.slice(0, 8)} · {order.status}. After returning from
            checkout, refresh to verify the provider receipt.
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
          title="Confirm test purchase"
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
            "This connection could not be verified as a test account. No account page was opened.",
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
            setError(
              "Some payment status is unavailable. Refresh before checkout.",
            );
        }
      }
    } catch (cause) {
      if (current()) setError((cause as Error).message);
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
        !sellerTools
          ? "Review purchases and payment status"
          : seller?.ready
            ? "Test seller connected"
            : "Test payments only · no real charges"
      }
      expanded={open}
      onToggle={() => {
        setOpen(!open);
        if (!open) void run();
      }}
    >
      <Text style={styles.small}>
        Test orders only. No real charges or payouts are available.
      </Text>
      {sellerTools && (
        <>
          <Text style={styles.label}>Card payments</Text>
          {seller && (
            <Text style={styles.body}>
              {seller.ready
                ? "Ready for test orders"
                : seller.connected
                  ? "Finish connecting your test account"
                  : seller.configured
                    ? "Connect your test seller account"
                    : "Card payments are unavailable right now."}
            </Text>
          )}
          <Action
            title={
              !seller?.configured
                ? "Card connection unavailable"
                : seller.connected
                  ? "Manage test seller account"
                  : "Connect test seller"
            }
            disabled={!seller?.configured || busy}
            busy={busy}
            onPress={() => void run(true)}
          />
          <Text style={styles.label}>PayPal</Text>
          <Text style={styles.small}>
            {paypal?.ready
              ? "Ready for PayPal test orders"
              : paypal?.configured
                ? "Complete PayPal seller setup"
                : "PayPal payments are unavailable right now."}
          </Text>
          {paypal?.configured && (
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
                Allow PayPal to share my test seller connection and payment
                permissions with Ziipa.
              </Text>
            </View>
          )}
          <Action
            secondary
            title={
              paypal?.configured
                ? "Connect PayPal test seller"
                : "PayPal connection unavailable"
            }
            disabled={!paypal?.configured || !paypalConsent || busy}
            onPress={() => void run(true, undefined, "paypal")}
          />
          <Text style={styles.small}>
            Connections open a secure test-account page. Use test details only;
            no bank account or real payout is connected here.
          </Text>
        </>
      )}
      <Action
        secondary
        title={sellerTools ? "Refresh payments & orders" : "Refresh orders"}
        disabled={busy}
        onPress={() => void run()}
      />
      {orders.length === 0 && (
        <Text style={styles.small}>No test orders yet.</Text>
      )}
      {orders.map((order) => (
        <View key={order.id} style={{ gap: 5, paddingVertical: 8 }}>
          <Text style={styles.body}>
            {order.title} · {money(order.price_cents)}
          </Text>
          <Text style={styles.small}>
            {order.provider} · {order.status} · test order{" "}
            {order.id.slice(0, 8)}
          </Text>
          <Action
            secondary
            title="Verify order"
            disabled={busy}
            onPress={() => void run(false, order)}
          />
          {order.provider === "paypal" && order.status === "approved" && (
            <Action
              title="Confirm test purchase"
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
