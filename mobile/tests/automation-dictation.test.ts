import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type EventName = "start" | "result" | "error" | "end" | "nomatch";
type Context = {
  owner?: string;
  enabled: boolean;
  value: string;
  maxLength?: number;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dictation(
  options: {
    permission?: Promise<{ granted: boolean }>;
    supported?: boolean;
    missingModule?: boolean;
    abortEmitsEnd?: boolean;
    web?: boolean;
    appState?: string;
    autoStart?: boolean;
  } = {},
) {
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/lib/automation-dictation.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const context: Context = { owner: "owner-one", enabled: true, value: "" };
  const hooks: any[] = [];
  const effects: (() => void)[] = [];
  const listeners = new Map<EventName, Set<(value: any) => void>>();
  const lifecycle = new Map<string, (...args: any[]) => void>();
  const changes: string[] = [];
  const timers = new Map<number, { milliseconds: number; fn: () => void }>();
  let cursor = 0,
    timerId = 0,
    permissionRequests = 0,
    stops = 0,
    aborts = 0,
    output: any;
  const starts: any[] = [];
  const emit = (name: EventName, value: any = null) => {
    [...(listeners.get(name) || [])].forEach((listener) => listener(value));
  };
  const module = {
    isRecognitionAvailable: () => options.supported !== false,
    requestPermissionsAsync: () => {
      permissionRequests++;
      return options.permission || Promise.resolve({ granted: true });
    },
    start(value: unknown) {
      starts.push(value);
      if (options.autoStart !== false) emit("start");
    },
    stop() {
      stops++;
    },
    abort() {
      aborts++;
      if (options.abortEmitsEnd !== false) emit("end");
    },
    addListener(name: EventName, callback: (value: any) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
      return { remove: () => listeners.get(name)!.delete(callback) };
    },
  };
  const react = {
    useRef(initial: unknown) {
      const index = cursor++;
      return (hooks[index] ||= { current: initial });
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in hooks))
        hooks[index] =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
      return [
        hooks[index],
        (value: any) => {
          hooks[index] =
            typeof value === "function" ? value(hooks[index]) : value;
        },
      ];
    },
    useMemo(fn: () => unknown, dependencies: unknown[]) {
      const index = cursor++;
      if (
        !hooks[index] ||
        dependencies.some((value, i) => value !== hooks[index].dependencies[i])
      )
        hooks[index] = { value: fn(), dependencies };
      return hooks[index].value;
    },
    useCallback(fn: unknown, dependencies: unknown[]) {
      return react.useMemo(() => fn, dependencies);
    },
    useEffect(effect: () => (() => void) | undefined, dependencies: unknown[]) {
      const index = cursor++,
        previous = hooks[index];
      if (
        !previous ||
        dependencies.some((value, i) => value !== previous.dependencies[i])
      ) {
        const next = {
          dependencies,
          cleanup: undefined as undefined | (() => void),
        };
        hooks[index] = next;
        effects.push(() => {
          previous?.cleanup?.();
          next.cleanup = effect();
        });
      }
    },
  };
  const target = {
    visibilityState: "visible",
    addEventListener: (name: string, callback: () => void) =>
      lifecycle.set(name, callback),
    removeEventListener: (name: string) => lifecycle.delete(name),
  };
  const exports: any = {};
  new Function(
    "exports",
    "require",
    "setTimeout",
    "clearTimeout",
    "document",
    "window",
    code,
  )(
    exports,
    (name: string) => {
      if (name === "react") return react;
      if (name === "react-native")
        return {
          AppState: {
            currentState: options.appState || "active",
            addEventListener: (_event: string, callback: () => void) => {
              lifecycle.set("app", callback);
              return { remove: () => lifecycle.delete("app") };
            },
          },
        };
      if (name === "expo-speech-recognition") {
        if (options.missingModule) throw new Error("Native module missing");
        return { ExpoSpeechRecognitionModule: module };
      }
      throw new Error(`Unexpected dictation dependency ${name}`);
    },
    (fn: () => void, milliseconds: number) => {
      const id = ++timerId;
      timers.set(id, { fn, milliseconds });
      return id;
    },
    (id: number) => timers.delete(id),
    options.web ? target : undefined,
    options.web ? target : undefined,
  );
  const flush = () => {
    while (effects.length) effects.shift()!();
  };
  const render = (
    changesToContext: Partial<Context> = {},
    runEffects = true,
  ) => {
    Object.assign(context, changesToContext);
    cursor = 0;
    output = exports.useAutomationDictation({
      ...context,
      onChange: (text: string) => {
        context.value = text;
        changes.push(text);
      },
    });
    if (runEffects) flush();
    return output;
  };
  render();
  render();
  return {
    render,
    flush,
    context,
    changes,
    starts,
    emit,
    target,
    get api() {
      return output;
    },
    counts: () => ({ permissionRequests, stops, aborts }),
    savedResult: () => [...(listeners.get("result") || [])][0],
    listenerCount: () =>
      [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0),
    background: () => lifecycle.get("app")?.("background"),
    blur: () => lifecycle.get("blur")?.(),
    hide: () => {
      target.visibilityState = "hidden";
      lifecycle.get("visibilitychange")?.();
    },
    fire(milliseconds: number) {
      const found = [...timers].find(
        ([, entry]) => entry.milliseconds === milliseconds,
      );
      assert.ok(found, `Expected a ${milliseconds}ms deadline`);
      timers.delete(found[0]);
      found[1].fn();
    },
    unmount() {
      hooks.forEach((entry) => entry?.cleanup?.());
    },
    result(transcript: string, isFinal = false) {
      emit("result", { isFinal, results: [{ transcript }] });
    },
  };
}

test("dictation never starts or asks for microphone access on mount; unavailable native modules preserve typing", async () => {
  for (const options of [{}, { supported: false }, { missingModule: true }]) {
    const h = dictation(options);
    assert.equal(h.starts.length, 0);
    assert.equal(h.counts().permissionRequests, 0);
    if (options.supported === false || options.missingModule) {
      assert.equal(h.api.supported, false);
      await h.api.start();
      assert.match(h.render().error, /unavailable/);
      assert.equal(h.counts().permissionRequests, 0);
      assert.deepEqual(h.changes, []);
    }
    h.unmount();
  }
});

test("explicit permission and one-shot recognition edit the captured draft without duplicating interim words", async () => {
  const h = dictation();
  h.render({ value: "Please" });
  await h.api.start();
  assert.equal(h.render().listening, true);
  assert.equal(h.counts().permissionRequests, 1);
  assert.equal(h.starts[0].continuous, false);
  assert.equal(h.starts[0].interimResults, true);
  assert.equal(h.starts[0].recordingOptions.persist, false);
  h.result("plan");
  h.render();
  h.result("plan my release", true);
  assert.deepEqual(h.changes, ["Please plan", "Please plan my release"]);
  assert.equal(h.render().listening, false);
  assert.equal(h.counts().aborts, 1);
  h.unmount();
});

test("signed-out, disabled and already-backgrounded scopes cannot start or request permission", async () => {
  for (const changes of [{ owner: undefined }, { enabled: false }]) {
    const h = dictation();
    h.render(changes);
    await h.api.start();
    assert.equal(h.counts().permissionRequests, 0);
    assert.equal(h.starts.length, 0);
    h.unmount();
  }
  const background = dictation({ appState: "background" });
  await background.api.start();
  assert.equal(background.counts().permissionRequests, 0);
  background.unmount();
  const hidden = dictation({ web: true });
  hidden.target.visibilityState = "hidden";
  await hidden.api.start();
  assert.equal(hidden.counts().permissionRequests, 0);
  hidden.unmount();
});

test("results cannot modify the draft before the new recognizer acknowledges start", async () => {
  const h = dictation({ autoStart: false });
  await h.api.start();
  h.result("unexpected old result", true);
  assert.deepEqual(h.changes, []);
  h.emit("start");
  h.result("new result", true);
  assert.deepEqual(h.changes, ["new result"]);
  h.unmount();
});

test("a pending permission request is serialized and cancel defeats a late grant", async () => {
  const permission = deferred<{ granted: boolean }>(),
    h = dictation({ permission: permission.promise });
  const pending = h.api.start();
  await h.api.start();
  assert.equal(h.counts().permissionRequests, 1);
  assert.equal(h.render().pending, true);
  h.api.cancel();
  permission.resolve({ granted: true });
  await pending;
  assert.equal(h.starts.length, 0);
  assert.equal(h.render().pending, false);
  h.unmount();
});

test("denied permission and unsupported recognizers do not erase an existing draft", async () => {
  const h = dictation({ permission: Promise.resolve({ granted: false }) });
  h.render({ value: "Keep this draft" });
  await h.api.start();
  assert.equal(h.starts.length, 0);
  assert.match(h.render().error, /permission/);
  assert.equal(h.context.value, "Keep this draft");
  h.unmount();
});

test("recognition appends safely within the text limit and does not split a surrogate pair", async () => {
  const h = dictation();
  h.render({ value: "Hey", maxLength: 5 });
  await h.api.start();
  h.result("😀hello");
  assert.deepEqual(h.changes, ["Hey "]);
  assert.equal(h.render().listening, true);
  h.api.cancel();
  h.render({ value: "Plan", maxLength: 12 });
  await h.api.start();
  h.result("a long release");
  assert.equal(h.context.value, "Plan a long ");
  assert.equal(h.render().listening, false);
  h.unmount();
});

test("stop accepts the final result; cancel discards only later events and keeps already recognized text", async () => {
  const h = dictation();
  await h.api.start();
  h.result("draft");
  const old = h.savedResult();
  h.api.stop();
  assert.equal(h.counts().stops, 1);
  assert.equal(h.render().pending, true);
  h.result("draft my launch", true);
  assert.equal(h.context.value, "draft my launch");
  h.api.cancel();
  old({ isFinal: true, results: [{ transcript: "stale overwrite" }] });
  assert.equal(h.context.value, "draft my launch");
  h.unmount();
});

test("an account change invalidates old result callbacks before passive cleanup and a new capture uses the new draft", async () => {
  const h = dictation();
  await h.api.start();
  const old = h.savedResult();
  h.render({ owner: "owner-two", value: "Second account" }, false);
  old({ isFinal: true, results: [{ transcript: "private old words" }] });
  assert.deepEqual(h.changes, []);
  h.flush();
  await h.api.start();
  h.result("new words", true);
  assert.equal(h.context.value, "Second account new words");
  old({ isFinal: true, results: [{ transcript: "late old words" }] });
  assert.equal(h.context.value, "Second account new words");
  h.unmount();
});

test("cancel waits for native end acknowledgement before attaching a new capture to the singleton", async () => {
  const h = dictation({ abortEmitsEnd: false });
  await h.api.start();
  h.api.cancel();
  h.render({ owner: "owner-two", value: "New owner" });
  await h.api.start();
  assert.equal(h.starts.length, 1);
  assert.match(h.render().error, /still stopping/);
  h.result("old global result", true);
  assert.deepEqual(h.changes, []);
  h.emit("end");
  await h.api.start();
  assert.equal(h.starts.length, 2);
  h.result("new result", true);
  assert.equal(h.context.value, "New owner new result");
  h.emit("end");
  h.unmount();
});

test("backgrounding, browser blur/hide, disabled scope and unmount stop capture and reject later words", async () => {
  for (const event of ["background", "blur", "hide", "disable", "unmount"]) {
    const h = dictation({ web: true });
    await h.api.start();
    const old = h.savedResult();
    if (event === "background") h.background();
    else if (event === "blur") h.blur();
    else if (event === "hide") h.hide();
    else if (event === "disable") h.render({ enabled: false });
    else h.unmount();
    old({ isFinal: true, results: [{ transcript: "late words" }] });
    assert.equal(h.counts().aborts, 1);
    assert.deepEqual(h.changes, []);
    if (event !== "unmount") h.unmount();
  }
});

test("capture and stopping have finite deadlines, retaining typed or recognized text", async () => {
  const h = dictation();
  h.render({ value: "Keep" });
  await h.api.start();
  h.result("the heard words");
  h.fire(60000);
  assert.equal(h.context.value, "Keep the heard words");
  assert.match(h.render().error, /one minute/);
  await h.api.start();
  h.api.stop();
  h.fire(3000);
  assert.equal(h.render().pending, false);
  assert.equal(h.counts().aborts, 2);
  h.unmount();
});

test("recognizer errors are understandable and never display raw provider error details", async () => {
  for (const code of [
    "not-allowed",
    "service-not-allowed",
    "network",
    "no-speech",
    "audio-capture",
    "unknown",
  ]) {
    const h = dictation();
    await h.api.start();
    h.emit("error", { error: code, message: "sensitive provider diagnostic" });
    assert.ok(h.render().error);
    assert.equal(h.api.error.includes("sensitive"), false);
    h.unmount();
  }
});
