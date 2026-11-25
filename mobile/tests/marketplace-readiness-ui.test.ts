import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as commerce from "../src/lib/commerce.ts";
import * as walletReadiness from "../src/lib/wallet-readiness.ts";

type Node = { type: unknown; props: Record<string, any> };
const walk = (value: any): Node[] =>
  Array.isArray(value)
    ? value.flatMap(walk)
    : value?.props
      ? [value, ...walk(value.props.children)]
      : [];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const listing = {
  id: "listing-one",
  revision: 2,
  seller_id: 8,
  kind: "merchandise",
  status: "published",
  price_cents: 1200,
} as commerce.Listing;
const order = {
  id: "order-one",
  title: "Owned product",
  price_cents: 1200,
  mode: "sandbox",
  provider: "paypal",
  status: "pending",
};
const available = {
  enabled: true,
  mode: "sandbox",
  providers: { stripe: false, paypal: true },
};

function compile(path: string, imports: (name: string) => any) {
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  new Function(
    "exports",
    "require",
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText,
  )(exports, imports);
  return exports;
}

/** Real component hooks and handlers with synthetic responses; no network or payment SDK. */
function ui(fetcher: (path: string, body?: unknown) => Promise<any>) {
  const slots: any[] = [],
    effects = new Map<number, { deps?: any[]; cleanup?: () => void }>();
  const queued: (() => void)[] = [],
    calls: { path: string; body?: any }[] = [],
    links: string[] = [];
  let cursor = 0,
    uuid = 0;
  const context = {
    session: { access_token: "owner-one", user: { id: 7 } },
    api: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      return fetcher(path, body);
    },
  };
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  const exports = compile(
    "../src/components/marketplace-checkout.tsx",
    (name) => {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react")
        return {
          useState(initial: any) {
            const slot = cursor++;
            if (!(slot in slots))
              slots[slot] = typeof initial === "function" ? initial() : initial;
            return [
              slots[slot],
              (value: any) => {
                slots[slot] =
                  typeof value === "function" ? value(slots[slot]) : value;
              },
            ];
          },
          useRef(initial: unknown) {
            const slot = cursor++;
            return (slots[slot] ||= { current: initial });
          },
          useEffect(action: () => any, deps?: any[]) {
            const slot = cursor++,
              previous = effects.get(slot);
            if (
              !previous ||
              !deps ||
              deps.some(
                (value, index) => !Object.is(value, previous.deps?.[index]),
              )
            ) {
              previous?.cleanup?.();
              effects.set(slot, { deps });
              queued.push(() => {
                effects.get(slot)!.cleanup = action();
              });
            }
          },
        };
      if (name === "react-native")
        return {
          View: "View",
          Text: "Text",
          Switch: "Switch",
          Platform: { OS: "ios" },
          Linking: {
            openURL: async (url: string) => {
              links.push(url);
            },
          },
        };
      if (name === "expo-crypto")
        return { randomUUID: () => `synthetic-${++uuid}` };
      if (name === "../provider") return { useZiipa: () => context };
      if (name === "../lib/commerce") return commerce;
      if (name === "./ui")
        return { Action: "Action", Notice: "Notice", Pill: "Pill" };
      if (name === "./disclosure") return { Disclosure: "Disclosure" };
      if (name === "../theme") return { styles: {} };
      throw new Error(name);
    },
  );
  const render = (
    component: "MarketplaceCheckout" | "MarketplacePaymentSettings",
    props: any = {},
  ) => {
    cursor = 0;
    const nodes = walk(exports[component](props));
    while (queued.length) queued.shift()!();
    return nodes;
  };
  return { render, calls, links, context, exports };
}
const action = (nodes: Node[], title: string) =>
  nodes.find((node) => node.type === "Action" && node.props.title === title)!;

test("checkout fails closed for unavailable services, inconsistent enabled flags and non-test mode", async () => {
  for (const setup of [
    { ...available, enabled: false },
    { ...available, mode: "live" },
    { ...available, providers: { stripe: false, paypal: false } },
  ]) {
    const h = ui(async () => setup);
    h.render("MarketplaceCheckout", { listing });
    await flush();
    const nodes = h.render("MarketplaceCheckout", { listing });
    const button = action(nodes, "Checkout unavailable");
    assert.equal(button.props.disabled, true);
    button.props.onPress();
    await flush();
    assert.equal(h.calls.length, 1);
    const text = JSON.stringify(nodes);
    assert.match(text, /Checkout is unavailable/);
    assert.doesNotMatch(
      text,
      /provider setup|sandbox setup|developer|credentials/i,
    );
  }
});

test("available payment method is selected without a purchase; explicit repeated taps create one test checkout", async () => {
  const h = ui(async (path) =>
    path.endsWith("/config")
      ? available
      : {
          order,
          url: "https://www.sandbox.paypal.com/checkout?token=synthetic",
        },
  );
  h.render("MarketplaceCheckout", { listing });
  await flush();
  const nodes = h.render("MarketplaceCheckout", { listing });
  assert.equal(h.calls.length, 1);
  assert.equal(
    nodes.find((node) => node.type === "Pill")?.props.title,
    "PayPal",
  );
  const button = nodes.find(
    (node) =>
      node.type === "Action" && node.props.title.startsWith("Test checkout"),
  )!;
  assert.equal(button.props.disabled, false);
  button.props.onPress();
  button.props.onPress();
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.provider, "paypal");
  assert.equal(h.calls[1].body.revision, listing.revision);
  assert.equal(h.links.length, 1);
  const after = h.render("MarketplaceCheckout", { listing });
  assert.equal(
    after.some((node) => node.props.title === "Test order paid"),
    false,
  );
});

test("unverified live-mode checkout response cannot open a payment page or claim a paid test order", async () => {
  const h = ui(async (path) =>
    path.endsWith("/config")
      ? available
      : {
          order: { ...order, mode: "live", status: "paid" },
          url: "https://www.sandbox.paypal.com/checkout",
        },
  );
  h.render("MarketplaceCheckout", { listing });
  await flush();
  h.render("MarketplaceCheckout", { listing })
    .find(
      (node) =>
        node.type === "Action" && node.props.title.startsWith("Test checkout"),
    )!
    .props.onPress();
  await flush();
  assert.deepEqual(h.links, []);
  const after = h.render("MarketplaceCheckout", { listing });
  assert.equal(
    after.some((node) => node.props.title === "Test order paid"),
    false,
  );
  assert.ok(
    after.some((node) =>
      /could not be verified as a test order/.test(node.props.text || ""),
    ),
  );
});

test("late checkout response after a listing change cannot open the previous payment page", async () => {
  let resolve!: (value: any) => void;
  const held = new Promise((done) => {
    resolve = done;
  });
  const h = ui(async (path) => (path.endsWith("/config") ? available : held));
  h.render("MarketplaceCheckout", { listing });
  await flush();
  h.render("MarketplaceCheckout", { listing })
    .find(
      (node) =>
        node.type === "Action" && node.props.title.startsWith("Test checkout"),
    )!
    .props.onPress();
  h.render("MarketplaceCheckout", {
    listing: { ...listing, id: "listing-two" },
  });
  await flush();
  resolve({ order, url: "https://www.sandbox.paypal.com/checkout" });
  await flush();
  assert.deepEqual(h.links, []);
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("/checkout")).length,
    1,
  );
});

test("late checkout acknowledgement from a previous account cannot open a payment page", async () => {
  let resolve!: (value: any) => void;
  const held = new Promise((done) => {
    resolve = done;
  });
  const h = ui(async (path) => (path.endsWith("/config") ? available : held));
  h.render("MarketplaceCheckout", { listing });
  await flush();
  h.render("MarketplaceCheckout", { listing })
    .find(
      (node) =>
        node.type === "Action" && node.props.title.startsWith("Test checkout"),
    )!
    .props.onPress();
  h.context.session = { access_token: "owner-two", user: { id: 9 } };
  h.render("MarketplaceCheckout", { listing });
  await flush();
  resolve({ order, url: "https://www.sandbox.paypal.com/checkout" });
  await flush();
  assert.deepEqual(h.links, []);
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("/checkout")).length,
    1,
  );
});

test("payment pages remain restricted to exact secure provider hosts", () => {
  const h = ui(async () => available);
  const link = h.exports.sandboxProviderLink;
  assert.equal(
    link("https://checkout.stripe.com/test/synthetic"),
    "https://checkout.stripe.com/test/synthetic",
  );
  for (const invalid of [
    "http://checkout.stripe.com/test",
    "https://checkout.stripe.com.evil.test",
    "https://user:secret@checkout.stripe.com",
    "https://checkout.stripe.com:8443",
    "https://www.paypal.com/checkout",
    "javascript:alert(1)",
  ])
    assert.throws(() => link(invalid));
});

test("buyer order history exposes no seller connection guide and reads only own orders", async () => {
  const h = ui(async () => ({ orders: [] }));
  const nodes = h.render("MarketplacePaymentSettings", { sellerTools: false });
  const disclosure = nodes.find((node) => node.type === "Disclosure")!;
  assert.equal(disclosure.props.title, "Your orders");
  disclosure.props.onToggle();
  await flush();
  assert.deepEqual(
    h.calls.map((call) => call.path),
    ["/api/store/payments/orders"],
  );
  const after = h.render("MarketplacePaymentSettings", { sellerTools: false });
  assert.equal(
    after.some((node) => node.type === "Switch"),
    false,
  );
  assert.equal(
    after.some((node) => /Connect.*seller/.test(node.props.title || "")),
    false,
  );
});

test("seller PayPal connection requires separate consent and opens a verified test-account page only", async () => {
  const h = ui(async (path) =>
    path.endsWith("/orders")
      ? { orders: [] }
      : path.endsWith("/connect")
        ? { mode: "sandbox", url: "https://www.sandbox.paypal.com/connect" }
        : { mode: "sandbox", configured: true, connected: false, ready: false },
  );
  h.render("MarketplacePaymentSettings")
    .find((node) => node.type === "Disclosure")!
    .props.onToggle();
  await flush();
  let nodes = h.render("MarketplacePaymentSettings");
  const blocked = action(nodes, "Connect PayPal test seller");
  assert.equal(blocked.props.disabled, true);
  blocked.props.onPress();
  await flush();
  assert.equal(
    h.calls.some((call) => call.path.endsWith("/connect")),
    false,
  );
  nodes.find((node) => node.type === "Switch")!.props.onValueChange(true);
  nodes = h.render("MarketplacePaymentSettings");
  assert.equal(
    action(nodes, "Connect PayPal test seller").props.disabled,
    false,
  );
  action(nodes, "Connect PayPal test seller").props.onPress();
  await flush();
  assert.equal(
    h.calls.find((call) => call.path.endsWith("/connect"))!.body
      .share_data_consent,
    true,
  );
  assert.deepEqual(h.links, ["https://www.sandbox.paypal.com/connect"]);
});

test("wallet readiness is honest and user-facing without contract or provider setup instructions", () => {
  const wallet = compile("../src/screens/wallet.tsx", (name) =>
    name === "../lib/wallet-readiness"
      ? walletReadiness
      : name === "../theme"
        ? { themedStyles: () => ({}) }
        : {},
  );
  const config = {
    testnet_only: true,
    storage: "pinata_ipfs",
    chains: [{ id: 84532, contracts: { collectibles: "0x" + "1".repeat(40) } }],
  };
  assert.equal(
    wallet.walletMintAvailability(config, 84532, "mint_nft").ready,
    true,
  );
  for (const state of [
    wallet.walletMintAvailability(null, 84532, "mint_nft"),
    wallet.walletMintAvailability(config, 84532, "create_token"),
    wallet.walletMintAvailability(
      { ...config, storage: "local_ipfs" },
      84532,
      "mint_nft",
    ),
  ]) {
    assert.equal(state.ready, false);
    assert.doesNotMatch(
      state.detail,
      /configur|contract|provider|deploy|credential/i,
    );
    assert.match(state.detail, /unchanged|keep working/);
  }
});

test("ordinary Wallet opens assets while an explicitly selected source opens creation review", () => {
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  let providerActions = 0;
  const wallet = compile("../src/screens/wallet.tsx", (name) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react")
      return {
        useState: (initial: any) => [
          typeof initial === "function" ? initial() : initial,
          () => {},
        ],
        useRef: (current: any) => ({ current }),
        useEffect() {},
      };
    if (name === "react-native")
      return {
        Platform: { OS: "ios" },
        Text: "Text",
        View: "View",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
      };
    if (name === "../components/desktop-layout")
      return { useDesktopLayout: () => ({ desktop: false }) };
    if (name === "../theme")
      return {
        themedStyles: () => ({}),
        themeValue: (value: any) => value,
        styles: {},
        color: {},
        font: {},
      };
    if (name === "../provider")
      return {
        useZiipa: () => ({
          session: { access_token: "owner", user: { id: 7 } },
          data: { drafts: [] },
        }),
      };
    if (name === "../lib/wallet-connector")
      return {
        currentWallet: () => null,
        connectWallet: () => {
          providerActions++;
        },
      };
    if (name === "../lib/wallet-readiness") return walletReadiness;
    if (name === "../lib/editor-source")
      return { sourceMintItem: (value: any) => value };
    if (name === "../lib/rewards-types")
      return { emptyRewardDraft: () => ({ enabled: false }) };
    if (name === "expo-crypto") return { randomUUID: () => "synthetic" };
    if (name === "../components/ui")
      return { Action: "Action", Notice: "Notice" };
    return {};
  });
  for (const initialItem of [
    undefined,
    { id: "owned", title: "My work", media_id: "source", demo: false },
  ]) {
    const route = wallet.WalletScreen({ navigation: {}, initialItem });
    const nodes = walk(route.type(route.props));
    const text = JSON.stringify(nodes);
    if (!initialItem) {
      assert.match(text, /YOUR WALLET/);
      assert.doesNotMatch(text, /Token Engine|Creation name/);
    } else assert.match(text, /Creation name/);
  }
  assert.equal(providerActions, 0);
});
