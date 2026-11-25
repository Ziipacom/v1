import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as readiness from "../src/lib/wallet-readiness.ts";
import * as walletTypes from "../src/lib/wallet-types.ts";

type Node = { type: any; props: Record<string, any> };
const address = "0x" + "1".repeat(40);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(mintReady = true) {
  const hooks: any[] = [],
    effects: (() => void)[] = [],
    calls: { path: string; body?: any }[] = [];
  let cursor = 0,
    connected: any = null,
    connections = 0,
    signatures = 0,
    transactions = 0;
  const config = {
    testnet_only: true,
    storage: "pinata_ipfs",
    chains: [
      {
        id: 84532,
        name: "Base Sepolia",
        currency: "ETH",
        contracts: mintReady ? { collectibles: address } : {},
      },
    ],
  };
  const initialItem = {
    id: "owned",
    title: "My creation",
    media_id: "owned-media",
    creator_id: 7,
  };
  const api = async (path: string, body?: any) => {
    calls.push({ path, body });
    if (path.endsWith("/challenge"))
      return { id: "proof", message: "Sign ownership proof" };
    if (path.endsWith("/verify"))
      return { id: "wallet", address, chain_id: 84532 };
    if (path.endsWith("/metadata") && body)
      return { id: "metadata", document: { name: initialItem.title } };
    if (path.endsWith("/intents") && body)
      return {
        id: "intent",
        kind: "mint_nft",
        status: "prepared",
        summary: {},
        transaction: { to: address },
        result: {},
      };
    return [];
  };
  const exports: Record<string, any> = {};
  const jsx = (type: any, props: any) => ({ type, props });
  new Function(
    "exports",
    "require",
    "__DEV__",
    ts.transpileModule(
      readFileSync(
        new URL("../src/screens/wallet.tsx", import.meta.url),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
  )(
    exports,
    (name: string) => {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react")
        return {
          useState(initial: any) {
            const i = cursor++;
            if (!(i in hooks))
              hooks[i] = typeof initial === "function" ? initial() : initial;
            return [
              hooks[i],
              (value: any) => {
                hooks[i] =
                  typeof value === "function" ? value(hooks[i]) : value;
              },
            ];
          },
          useRef(initial: any) {
            const i = cursor++;
            if (!(i in hooks)) hooks[i] = { current: initial };
            return hooks[i];
          },
          useEffect(fn: () => void, deps: any[]) {
            const i = cursor++;
            if (!(i in hooks) || deps?.some((v, j) => v !== hooks[i]?.[j])) {
              hooks[i] = deps;
              effects.push(fn);
            }
          },
        };
      if (name === "react-native")
        return new Proxy(
          { Platform: { OS: "web" } },
          { get: (target: any, key) => target[key] ?? key },
        );
      if (name === "lucide-react-native")
        return new Proxy({}, { get: (_, key) => key });
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
            session: { access_token: "synthetic", user: { id: 7 } },
            data: { drafts: [initialItem] },
            api,
          }),
        };
      if (name === "../lib/api") return { request: async () => config };
      if (name === "../lib/wallet-connector")
        return {
          currentWallet: () => connected,
          walletConnectConfigured: true,
          browserWalletAvailable: () => true,
          observeWallet() {},
          connectWallet: async (_: number, method: string) => {
            connections++;
            connected = { address, chainId: 84532, method };
            return connected;
          },
          signWalletProof: async () => {
            signatures++;
            return "synthetic-proof";
          },
          sendWalletTransaction: async () => {
            transactions++;
            return "hash";
          },
        };
      if (name === "../lib/wallet-readiness") return readiness;
      if (name === "../lib/wallet-types") return walletTypes;
      if (name === "../lib/wallet-pending")
        return { readPending: async () => null };
      if (name === "../lib/editor-source")
        return { sourceMintItem: (value: any) => value };
      if (name === "../lib/rewards-types")
        return { emptyRewardDraft: () => ({ enabled: false }) };
      if (name === "expo-crypto")
        return { randomUUID: () => "synthetic-request" };
      return new Proxy({}, { get: (_, key) => key });
    },
    false,
  );
  function walk(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (!value?.props) return [];
    if (typeof value.type === "function") return walk(value.type(value.props));
    return [value, ...walk(value.props.children)];
  }
  function render() {
    cursor = 0;
    const nodes = walk(
      exports.WalletScreen({
        initialItem,
        navigation: { canGoBack: () => false, navigate() {} },
      }),
    );
    while (effects.length) effects.shift()!();
    return nodes;
  }
  const button = (label: string) =>
    render().find(
      (node) =>
        node.type === "Pressable" && node.props.accessibilityLabel === label,
    )!;
  return {
    render,
    button,
    calls,
    exports,
    counts: () => ({ connections, signatures, transactions }),
    selected: () => connected?.method,
  };
}

async function connect(h: ReturnType<typeof harness>) {
  h.render();
  await flush();
  assert.equal(
    h.render().find((node) => node.type === "WorkflowProgress")!.props
      .activeStep,
    0,
  );
  h.button("Continue").props.onPress();
  h.button("Continue").props.onPress();
  const nodes = h.render();
  assert.equal(
    nodes.find((node) => node.type === "WorkflowProgress")!.props.activeStep,
    2,
  );
  assert.equal(
    nodes.filter(
      (node) =>
        node.type === "Pressable" &&
        node.props.accessibilityLabel === "Connect & verify",
    ).length,
    1,
  );
  assert.deepEqual(h.counts(), {
    connections: 0,
    signatures: 0,
    transactions: 0,
  });
  h.button("Browser wallet").props.onPress();
  h.button("Connect & verify").props.onPress();
  await flush();
  assert.equal(h.selected(), "injected");
  assert.deepEqual(h.counts(), {
    connections: 1,
    signatures: 1,
    transactions: 0,
  });
  h.button("Continue").props.onPress();
}

test("Wallet steps require explicit connection, public storage consent and final external approval", async () => {
  const h = harness();
  await connect(h);
  assert.equal(
    h.render().find((node) => node.type === "WorkflowProgress")!.props
      .activeStep,
    3,
  );
  const review = () => h.button("Store metadata & review mint");
  assert.equal(review().props.disabled, true);
  review().props.onPress();
  await flush();
  assert.equal(
    h.calls.some((call) => call.body && call.path.endsWith("/metadata")),
    false,
  );
  h.render()
    .find(
      (node) =>
        node.type === "Switch" &&
        node.props.accessibilityLabel ===
          "I approve permanent public metadata storage",
    )!
    .props.onValueChange(true);
  assert.equal(review().props.disabled, false);
  review().props.onPress();
  await flush();
  assert.equal(
    h.calls.find((call) => call.body && call.path.endsWith("/metadata"))!.body
      .public_storage_consent,
    true,
  );
  assert.ok(
    h
      .render()
      .find(
        (node) =>
          node.type === "Action" && node.props.title === "Approve in wallet",
      ),
  );
  assert.equal(h.counts().transactions, 0);
});

test("Unavailable minting remains disabled after valid wallet proof and consent", async () => {
  const h = harness(false);
  await connect(h);
  h.render()
    .find(
      (node) =>
        node.type === "Switch" &&
        node.props.accessibilityLabel ===
          "I approve permanent public metadata storage",
    )!
    .props.onValueChange(true);
  const review = h.button("Store metadata & review mint");
  assert.equal(review.props.disabled, true);
  review.props.onPress();
  await flush();
  assert.equal(
    h.calls.some((call) => call.body && call.path.endsWith("/metadata")),
    false,
  );
  assert.equal(h.counts().transactions, 0);
});

test("Wallet errors hide raw diagnostics without claiming an uncertain transaction failed", () => {
  const message = harness().exports.walletErrorMessage;
  for (const error of [
    new Error("Synthetic fixture failed: DATABASE_URL=secret"),
    new Error("{raw provider payload}"),
    null,
  ]) {
    const text = message(error);
    assert.doesNotMatch(text, /fixture|DATABASE|secret|payload/);
    assert.match(text, /Activity before trying again/);
    assert.doesNotMatch(text, /nothing was sent|transaction failed/i);
  }
  assert.match(message({ code: 4001 }), /approval was declined/);
  assert.match(message(new Error("insufficient funds for gas")), /test funds/);
  assert.equal(
    message(new Error("Royalties must be between 0 and 10%.")),
    "Royalties must be between 0 and 10%.",
  );
});
