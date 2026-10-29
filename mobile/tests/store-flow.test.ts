import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as commerce from "../src/lib/commerce.ts";
import * as flow from "../src/lib/store-flow.ts";

type Node = { type: unknown; props: Record<string, any> };
const walk = (value: any): Node[] =>
  Array.isArray(value)
    ? value.flatMap(walk)
    : value && typeof value === "object" && "props" in value
      ? [value, ...walk(value.props.children)]
      : [];

function wizard() {
  const slots: any[] = [];
  let cursor = 0;
  const saves: string[] = [];
  let generations = 0;
  const props: any = {
    step: "create",
    draft: commerce.emptyListing(),
    price: "",
    prompt: "",
    consent: false,
    busy: "",
    preview: null,
    storeName: "Test store",
    storeEnabled: false,
    onStep: (value: string) => {
      props.step = value;
    },
    onChange: (value: any) => {
      props.draft = { ...props.draft, ...value };
    },
    onPrice: (value: string) => {
      props.price = value;
    },
    onPrompt: (value: string) => {
      props.prompt = value;
    },
    onConsent: () => {
      props.consent = !props.consent;
    },
    onGenerate: () => {
      generations++;
    },
    onSave: (value: string) => saves.push(value),
    onUpload() {},
    onStore() {},
    onProducts() {},
    onEnableStore: () => {
      props.storeEnabled = !props.storeEnabled;
    },
  };
  const jsx = (type: any, props: any) =>
    typeof type === "function" ? type(props) : { type, props };
  const exported: Record<string, any> = {};
  new Function(
    "exports",
    "require",
    ts.transpileModule(
      readFileSync(
        new URL("../src/components/store-sell-wizard.tsx", import.meta.url),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
  )(exported, (name: string) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react")
      return {
        useState(initial: unknown) {
          const slot = cursor++;
          if (!(slot in slots)) slots[slot] = initial;
          return [
            slots[slot],
            (value: any) => {
              slots[slot] = value;
            },
          ];
        },
      };
    if (name === "react-native" || name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "./ui")
      return { Action: "Action", Field: "Field", Pill: "Pill" };
    if (name === "./floating") return { FloatButton: "FloatButton" };
    if (name === "./disclosure")
      return {
        Disclosure: ({ children, expanded, ...rest }: any) =>
          jsx("Disclosure", {
            ...rest,
            expanded,
            children: expanded ? children : null,
          }),
      };
    if (name === "../lib/commerce") return commerce;
    if (name === "../lib/store-flow") return flow;
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    throw new Error(name);
  });
  const render = () => {
    cursor = 0;
    return walk(exported.StoreSellWizard(props));
  };
  const action = (title: string) =>
    render().find(
      (node) => node.type === "Action" && node.props.title === title,
    )!;
  const click = (title: string) => {
    const node = action(title);
    assert.ok(node && !node.props.disabled, title);
    node.props.onPress();
  };
  return {
    props,
    render,
    action,
    click,
    saves,
    generations: () => generations,
  };
}

test("AI listing copy preserves seller pricing, media, delivery and ownership decisions", () => {
  const draft = {
    ...commerce.emptyListing(),
    price_cents: 1299,
    photo_ids: ["seller-photo"],
    delivery: "WAV, personal use only",
    rights_confirmed: false,
    adult_seller: false,
  };
  const result = flow.applyListingSuggestion(draft, {
    title: "My EP",
    description: "Seller-provided facts",
    descriptor: "Original music",
    storefront_name: "Music store",
  });
  assert.equal(result.title, "My EP");
  assert.equal(result.overlay, "editorial");
  assert.equal(result.price_cents, 1299);
  assert.equal(result.delivery, draft.delivery);
  assert.deepEqual(result.photo_ids, draft.photo_ids);
  assert.equal(result.rights_confirmed, false);
  assert.equal(result.adult_seller, false);
  assert.equal(result.status, "draft");
  assert.equal(draft.title, "");
});

test("Sell begins with one creation step and AI requires explicit description consent", () => {
  const ui = wizard();
  assert.equal(ui.action("Create for Me").props.disabled, true);
  ui.props.prompt = "My original ambient EP";
  assert.equal(ui.action("Create for Me").props.disabled, true);
  ui.props.consent = true;
  ui.click("Create for Me");
  assert.equal(ui.generations(), 1);
  assert.equal(
    ui
      .render()
      .some((node) => node.type === "Field" && node.props.label === "Title"),
    false,
  );
  assert.equal(
    ui
      .render()
      .filter(
        (node) =>
          node.props.accessibilityRole === "tab" &&
          node.props.accessibilityState.selected,
      ).length,
    1,
  );
});

test("manual Sell flow stays usable without AI and requires an explicit valid price", () => {
  const ui = wizard();
  ui.props.prompt = "An original hoodie, size M";
  ui.click("Continue without AI");
  assert.equal(ui.props.step, "review");
  assert.equal(ui.props.draft.description, ui.props.prompt);
  assert.equal(ui.generations(), 0);
  ui.props.draft.title = "My hoodie";
  for (const value of ["", "1e2", "-1", "2.345"]) {
    ui.props.price = value;
    assert.equal(ui.action("Continue to publish").props.disabled, true);
  }
  ui.props.price = "0";
  ui.click("Continue to publish");
  assert.equal(ui.props.step, "publish");
  assert.deepEqual(ui.saves, []);
});

test("publishing remains a seller action after photos, rights, age and storefront visibility choices", () => {
  const ui = wizard();
  Object.assign(ui.props, { step: "publish", price: "7.99" });
  ui.props.draft.title = "Original album";
  ui.props.draft.photo_ids = ["photo"];
  assert.equal(ui.action("Publish listing").props.disabled, true);
  ui.props.draft.rights_confirmed = true;
  ui.props.draft.adult_seller = true;
  assert.equal(ui.action("Publish listing").props.disabled, true);
  ui.props.storeEnabled = true;
  assert.deepEqual(ui.saves, []);
  ui.click("Publish listing");
  assert.deepEqual(ui.saves, ["published"]);
  ui.props.busy = "Publishing product";
  assert.equal(ui.action("Publish listing").props.disabled, true);
});
