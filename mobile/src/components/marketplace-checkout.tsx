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
type Seller = { connected: boolean; ready: boolean; configured: boolean };
type Order = {
  id: string;
  title: string;
  price_cents: number;
  status: string;
  mode: "sandbox";
  provider: "stripe" | "paypal";
};
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
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setSetup(null);
    setOrder(null);
    setError("");
    request.current = Crypto.randomUUID();
    const token = session?.access_token;
    void api<Setup>("/api/store/payments/config")
      .then((result) => {
        if (active && owner.current === token) setSetup(result);
      })
      .catch(() => {
        if (active) setError("Payment setup is unavailable. Try again later.");
      });
    return () => {
      active = false;
    };
  }, [api, session?.access_token, listing.id, listing.revision]);
  async function run(refresh = false, capture = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const token = owner.current;
    try {
      if (refresh && order) {
        const receipt = await api<Order>(
          capture
            ? `/api/store/payments/paypal/orders/${order.id}/capture`
            : `/api/store/payments/orders/${order.id}/refresh`,
          {},
        );
        if (alive.current && owner.current === token) setOrder(receipt);
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
        if (!alive.current || owner.current !== token) return;
        setOrder(result.order);
        if (result.url)
          await Linking.openURL(
            sandboxProviderLink(result.url, false, provider),
          );
      }
    } catch (cause) {
      if (alive.current && owner.current === token)
        setError((cause as Error).message);
    } finally {
      lock.current = false;
      if (alive.current && owner.current === token) setBusy(false);
    }
  }
  if (listing.seller_id === session?.user.id)
    return (
      <Notice text="This is your listing. Buyers can use test checkout after your seller payment setup is complete." />
    );
  if (listing.kind !== "merchandise")
    return (
      <Notice text="Digital purchasing is not available in this beta yet. Listing previews are free to view." />
    );
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.label}>Payment method</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(["stripe", "paypal"] as const).map((value) => (
          <Pill
            key={value}
            title={value === "stripe" ? "Card · Stripe" : "PayPal"}
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
      <Text style={styles.small}>
        Test mode · no real charge. Delivery, shipping and returns follow the
        seller’s description. A test order does not require real shipment.
      </Text>
      {setup && !setup.enabled && (
        <Notice text="The marketplace is waiting for payment-provider setup. No payment can be taken yet." />
      )}
      {!!setup && !setup.providers?.[provider] && (
        <Text style={styles.small}>
          {provider === "stripe" ? "Stripe" : "PayPal"} sandbox setup is
          pending.
        </Text>
      )}
      <Action
        title={
          order?.status === "paid"
            ? "Test order paid"
            : `Test checkout · ${money(listing.price_cents)}`
        }
        disabled={
          !setup?.providers?.[provider] ||
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

export function MarketplacePaymentSettings() {
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
  });
  scope.current.token = session?.access_token;
  useEffect(() => {
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
  }, [session?.access_token]);
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
    const current = () => scope.current.alive && scope.current.token === token;
    try {
      if (connect) {
        const result = await api<{ url: string }>(
          provider === "paypal"
            ? "/api/store/payments/paypal/seller/connect"
            : "/api/store/payments/seller/connect",
          provider === "paypal" ? { share_data_consent: paypalConsent } : {},
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
        const results = await Promise.allSettled([
          api<Seller>("/api/store/payments/seller"),
          api<Seller>("/api/store/payments/paypal/seller"),
          api<{ orders: Order[] }>("/api/store/payments/orders"),
        ]);
        if (current()) {
          if (results[0].status === "fulfilled") setSeller(results[0].value);
          if (results[1].status === "fulfilled") setPaypal(results[1].value);
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
      scope.current.locked = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <Disclosure
      title="Payments & orders"
      detail={
        seller?.ready
          ? "Test seller connected"
          : "Sandbox checkout and seller setup"
      }
      expanded={open}
      onToggle={() => {
        setOpen(!open);
        if (!open) void run();
      }}
    >
      <Text style={styles.small}>
        Stripe Connect and PayPal · sandbox only. Complete seller details on the
        provider’s secure page using test information. Bank linking is not
        connected.
      </Text>
      {seller && (
        <Text style={styles.body}>
          {seller.ready
            ? "Ready for test orders"
            : seller.connected
              ? "Finish seller onboarding"
              : seller.configured
                ? "Connect your test seller account"
                : "Provider setup pending"}
        </Text>
      )}
      <Action
        title={
          seller?.connected ? "Continue seller setup" : "Connect test seller"
        }
        disabled={!seller?.configured || busy}
        busy={busy}
        onPress={() => void run(true)}
      />
      <Text style={styles.label}>PayPal sandbox</Text>
      <Text style={styles.small}>
        {paypal?.ready
          ? "Ready for PayPal test orders"
          : paypal?.configured
            ? "Complete PayPal seller setup"
            : "Provider setup pending"}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Switch
          accessibilityLabel="Approve sharing my PayPal seller connection with Ziipa"
          value={paypalConsent}
          onValueChange={setPaypalConsent}
        />
        <Text style={[styles.small, { flex: 1 }]}>
          Allow PayPal to share my test seller connection and payment
          permissions with Ziipa.
        </Text>
      </View>
      <Action
        secondary
        title="Connect PayPal test seller"
        disabled={!paypal?.configured || !paypalConsent || busy}
        onPress={() => void run(true, undefined, "paypal")}
      />
      <Action
        secondary
        title="Refresh payments & orders"
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
