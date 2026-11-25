import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { suggestedCreationCopy } from "../src/lib/creation-title.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const copy = {
  title: "A Shepherd in Spectacles",
  description: "A German shepherd wears green glasses.",
};

function fixture() {
  const slots: any[] = [];
  let index = 0,
    dirty = false,
    effects: (() => void)[] = [];
  const captured: string[] = [],
    filled: unknown[] = [],
    requests: string[] = [];
  const generation = deferred<unknown>();
  let owner = "owner-a",
    ready = true;
  const api = async (path: string, body?: any) => {
    requests.push(path);
    if (path.endsWith("/config"))
      return { available: true, metadata_version: 2 };
    assert.deepEqual(body, { image: "resized-jpeg", consent: true });
    return generation.promise;
  };
  let options: any = {
    sourceKey: "photo-a",
    visual: true,
    disabled: false,
    needsCopy: true,
    capture: {
      current: {
        isReady: () => ready,
        capture: async () => {
          captured.push(owner);
          return "resized-jpeg";
        },
      },
    },
    onFill: (value: unknown) => filled.push(value),
  };
  const compiled = ts.transpileModule(
    readFileSync(
      new URL("../src/lib/use-creation-autofill.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const exported: any = {};
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react")
      return {
        useRef: (value: any) => (slots[index++] ||= { current: value }),
        useState: (value: any) => {
          const slot = index++;
          slots[slot] ||= { value };
          return [
            slots[slot].value,
            (next: any) => {
              if (!Object.is(slots[slot].value, next)) dirty = true;
              slots[slot].value = next;
            },
          ];
        },
        useEffect: (callback: () => any, deps: unknown[]) => {
          const slot = index++,
            prior = slots[slot];
          if (
            !prior ||
            deps.some((value, n) => !Object.is(value, prior.deps[n]))
          )
            effects.push(() => {
              prior?.cleanup?.();
              slots[slot] = { deps, cleanup: callback() };
            });
        },
      };
    if (name === "../provider")
      return {
        useZiipa: () => ({
          api,
          session: { access_token: owner },
          guest: false,
        }),
      };
    if (name === "./creation-title") return { suggestedCreationCopy };
    throw new Error(name);
  });
  let result: any;
  function render(patch = {}) {
    options = { ...options, ...patch };
    for (let count = 0; count < 8; count++) {
      index = 0;
      dirty = false;
      effects = [];
      result = exported.useCreationAutofill(options);
      effects.forEach((effect) => effect());
      if (!dirty) return result;
    }
    throw new Error("Hook did not settle");
  }
  async function settle() {
    for (let count = 0; count < 10; count++) {
      await Promise.resolve();
      render();
    }
  }
  render();
  return {
    render,
    settle,
    captured,
    filled,
    requests,
    generation,
    enable: () => {
      result.setEnabled(true);
      render();
    },
    disable: () => {
      result.setEnabled(false);
      render();
    },
    account: (value: string) => {
      owner = value;
      render();
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    unmount: () => slots.forEach((slot) => slot?.cleanup?.()),
  };
}

test("consent enables automatic field filling with no suggestion or acceptance button", async () => {
  const f = fixture();
  await f.settle();
  assert.equal(f.requests.length, 0);
  f.enable();
  await f.settle();
  assert.deepEqual(f.requests, [
    "/api/editor/title/config",
    "/api/editor/title/suggest",
  ]);
  assert.deepEqual(f.captured, ["owner-a"]);
  f.generation.resolve(copy);
  await f.settle();
  assert.deepEqual(f.filled, [copy]);
  f.render();
  await f.settle();
  assert.equal(f.requests.length, 2);
  f.unmount();
});

test("account change or source change discards late automatic responses", async () => {
  for (const change of ["account", "source"] as const) {
    const f = fixture();
    f.enable();
    await f.settle();
    if (change === "account") f.account("owner-b");
    else f.render({ sourceKey: "photo-b", visual: false });
    f.generation.resolve(copy);
    await f.settle();
    assert.deepEqual(f.filled, []);
    f.unmount();
  }
});

test("turning AI off cancels a pending response and never silently retries it", async () => {
  const f = fixture();
  f.enable();
  await f.settle();
  f.disable();
  f.generation.resolve(copy);
  await f.settle();
  assert.deepEqual(f.filled, []);
  f.enable();
  await f.settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.render().message, "");
  f.unmount();
});

test("autofill stays idle when both fields are authored, or the source is audio-only", async () => {
  for (const patch of [{ needsCopy: false }, { visual: false }]) {
    const f = fixture();
    f.render(patch);
    f.enable();
    await f.settle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.captured.length, 0);
    f.unmount();
  }
});

test("a placeholder cannot be captured, and unmount cancels the readiness wait", async () => {
  const f = fixture();
  f.setReady(false);
  f.enable();
  await f.settle();
  assert.equal(f.requests.length, 0);
  f.unmount();
  await f.settle();
  assert.equal(f.captured.length, 0);
});
