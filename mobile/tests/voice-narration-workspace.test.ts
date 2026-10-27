import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as narration from "../src/lib/voice-narration.ts";

type Node = { type: any; props: Record<string, any> };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ready = () => ({
  version: 1,
  provider: "cloudflare",
  model: "@cf/deepgram/aura-1",
  available: true,
  detail: "Verified free service",
  max_text_chars: 300,
  max_duration_seconds: 30,
  requires_consent: true,
  voices: narration.narrationVoiceIds.map((id) => ({
    id,
    label: id,
    language: "en-GB",
    accent: "British",
    gender: "feminine",
    available: true,
  })),
  clone: {
    available: false,
    verified: false,
    max_reference_seconds: 20,
    max_reference_bytes: 2097152,
    detail: "Cloning unavailable; no private runtime.",
  },
});
const wav = () => narration.narrationWave(new Uint8Array(4410));
const audio = () => ({
  version: 1,
  provider: "cloudflare",
  model: "@cf/deepgram/aura-1",
  voice_id: "athena",
  format: "wav",
  sample_rate: 22050,
  duration_seconds: 0.1,
  sha256: createHash("sha256").update(wav()).digest("hex"),
  audio_base64: Buffer.from(wav()).toString("base64"),
  detail: "Generated audio",
});

function ui(
  options: {
    generation?: Promise<unknown>;
    start?: Promise<void>;
    unavailable?: boolean;
  } = {},
) {
  const hooks: any[] = [],
    effects: (() => void)[] = [];
  let cursor = 0,
    starts = 0,
    stops = 0,
    cancels = 0,
    files = 0,
    releases = 0,
    attachments = 0;
  const order: string[] = [];
  const calls: { path: string; body?: unknown }[] = [];
  const context = { token: "account-a", focused: true, app: "active" };
  const events = new Map<string, (state: string) => void>();
  const capture = () => {
    const token = context.token;
    return () =>
      token === context.token && context.focused && context.app === "active";
  };
  const recording = {
    async start() {
      order.push("microphone-start");
      starts++;
      await options.start;
    },
    async stop() {
      stops++;
      return wav();
    },
    cancel() {
      cancels++;
    },
  };
  const api = async (path: string, body?: unknown) => {
    calls.push({ path, body });
    return body
      ? await (options.generation || Promise.resolve(audio()))
      : {
          ...ready(),
          available: !options.unavailable,
          voices: ready().voices.map((voice) => ({
            ...voice,
            available: !options.unavailable,
          })),
        };
  };
  function memo(fn: any, deps: unknown[]) {
    const slot = cursor++;
    if (
      !hooks[slot] ||
      deps.some((dep, n) => !Object.is(dep, hooks[slot].deps[n]))
    )
      hooks[slot] = { value: fn, deps };
    return hooks[slot].value;
  }
  const react = {
    useState(initial: any) {
      const slot = cursor++;
      if (!(slot in hooks))
        hooks[slot] = typeof initial === "function" ? initial() : initial;
      return [
        hooks[slot],
        (next: any) => {
          hooks[slot] = typeof next === "function" ? next(hooks[slot]) : next;
        },
      ];
    },
    useRef(initial: any) {
      const slot = cursor++;
      return (hooks[slot] ||= { current: initial });
    },
    useCallback: memo,
    useEffect(fn: () => any, deps: unknown[]) {
      const slot = cursor++;
      const old = hooks[slot];
      if (!old || deps.some((dep, n) => !Object.is(dep, old.deps[n]))) {
        const value = { deps, cleanup: undefined as any };
        hooks[slot] = value;
        effects.push(() => {
          old?.cleanup?.();
          value.cleanup = fn();
        });
      }
    },
  };
  const jsx = (type: any, props: any, key?: string) => ({ type, props, key });
  const compiled = ts.transpileModule(
    readFileSync(
      new URL(
        "../src/components/voice-narration-workspace.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exports: any = {};
  new Function("exports", "require", compiled)(exports, (name: string) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native")
      return {
        AppState: {
          currentState: context.app,
          addEventListener: (event: string, fn: (state: string) => void) => {
            events.set(event, fn);
            return { remove: () => events.delete(event) };
          },
        },
        Pressable: "Pressable",
        Text: "Text",
        View: "View",
      };
    if (name === "@react-navigation/native")
      return { useIsFocused: () => context.focused };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "expo-crypto")
      return {
        CryptoDigestAlgorithm: { SHA256: "SHA-256" },
        digest: async (_: unknown, bytes: ArrayBuffer) => {
          const result = createHash("sha256")
            .update(new Uint8Array(bytes))
            .digest();
          return result.buffer.slice(
            result.byteOffset,
            result.byteOffset + result.byteLength,
          );
        },
      };
    if (name === "./ui")
      return {
        Action: "Action",
        Field: "Field",
        Notice: "Notice",
        Pill: "Pill",
      };
    if (name === "../provider")
      return {
        useZiipa: () => ({ api, session: { access_token: context.token } }),
      };
    if (name === "../lib/use-operation-scope")
      return { useOperationScope: () => capture };
    if (name === "../lib/voice-capture")
      return { useVoiceCapture: () => recording };
    if (name === "../lib/generated-music-file")
      return {
        generatedMusicFile: async () => {
          files++;
          return {
            file: {
              uri: `blob:voice-${files}`,
              name: "voice.wav",
              mimeType: "audio/wav",
              size: wav().length,
            },
            release: async () => {
              releases++;
            },
          };
        },
      };
    if (name === "../lib/voice-narration") return narration;
    if (name === "../theme") return { color: {}, styles: {} };
    if (name === "./audio-audition") return { MusicAudition: "MusicAudition" };
    throw new Error(name);
  });
  const props = {
    purpose: "creation",
    attachedFileUri: undefined as string | null | undefined,
    busy: false,
    onBusyChange() {},
    onAuditionStart() {
      order.push("parent-pause");
    },
    onUseGenerated() {
      attachments++;
    },
  };
  function nodes(node: any): Node[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== "object" || !node.props) return [];
    if (typeof node.type === "function") return nodes(node.type(node.props));
    return [node, ...nodes(node.props.children)];
  }
  let mountedKey: string | undefined;
  function render() {
    cursor = 0;
    const scoped = exports.VoiceNarrationWorkspace(props);
    if (mountedKey !== undefined && mountedKey !== scoped.key) {
      for (const hook of hooks) hook?.cleanup?.();
      hooks.length = 0;
    }
    mountedKey = scoped.key;
    const result = nodes(scoped);
    while (effects.length) effects.shift()!();
    return result;
  }
  const action = (title: string) =>
    render().find(
      (node) => node.type === "Action" && node.props.title.startsWith(title),
    )!;
  const consent = (prefix: string) =>
    render().find(
      (node) =>
        node.type === "Pressable" &&
        node.props.accessibilityRole === "checkbox" &&
        node.props.accessibilityLabel.startsWith(prefix),
    )!;
  return {
    render,
    action,
    consent,
    calls,
    context,
    attachment(value: string | null | undefined) {
      props.attachedFileUri = value;
    },
    order,
    counts: () => ({ starts, stops, cancels, files, releases, attachments }),
    background() {
      context.app = "background";
      events.get("change")?.("background");
    },
    unmount() {
      for (const hook of hooks) hook?.cleanup?.();
    },
    script(value: string) {
      render()
        .find((node) => node.type === "Field")!
        .props.onChangeText(value);
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("removing the parent's attached narration retires its preview without disposing the parent-owned file again", async () => {
  const h = ui();
  try {
    h.render();
    await settle();
    h.script("An attached take.");
    h.consent("Send only this script").props.onPress();
    h.action("Generate AI narration").props.onPress();
    await settle();
    await settle();
    h.attachment("blob:voice-1");
    h.action("Use as audio creation").props.onPress();
    h.render();
    assert.equal(h.counts().attachments, 1);
    assert.ok(h.render().some((node) => node.type === "MusicAudition"));
    h.attachment(null);
    h.render();
    assert.equal(
      h.render().some((node) => node.type === "MusicAudition"),
      false,
    );
    assert.equal(h.counts().releases, 0);
  } finally {
    h.unmount();
  }
  assert.equal(h.counts().releases, 0);
});

test("an un-attached narration candidate survives removal of another parent soundtrack", async () => {
  const h = ui();
  try {
    h.attachment("blob:old-soundtrack");
    h.render();
    await settle();
    h.script("A private candidate.");
    h.consent("Send only this script").props.onPress();
    h.action("Generate AI narration").props.onPress();
    await settle();
    await settle();
    h.attachment(null);
    h.render();
    assert.ok(h.render().some((node) => node.type === "MusicAudition"));
    assert.equal(h.counts().releases, 0);
  } finally {
    h.unmount();
  }
  assert.equal(h.counts().releases, 1);
});
test("voice UI never requests microphone or generation on mount, and Record requires separate explicit consent", async () => {
  const h = ui();
  try {
    h.render();
    await settle();
    assert.equal(h.counts().starts, 0);
    assert.equal(h.calls.filter((call) => call.body).length, 0);
    assert.equal(h.action("Record my voice").props.disabled, true);
    h.consent("I consent to microphone").props.onPress();
    assert.equal(h.action("Record my voice").props.disabled, false);
    h.action("Record my voice").props.onPress();
    await settle();
    assert.equal(h.counts().starts, 1);
    h.action("Stop recording").props.onPress();
    await settle();
    assert.equal(h.counts().files, 1);
    assert.equal(h.counts().attachments, 0);
    h.action("Use as audio creation").props.onPress();
    assert.equal(h.counts().attachments, 1);
  } finally {
    h.unmount();
  }
});
test("account-keyed narration workspace releases an old take and resets script/consent before another account can audition or attach", async () => {
  const h = ui();
  try {
    h.render();
    await settle();
    h.script("Private account A script.");
    h.consent("Send only this script").props.onPress();
    h.action("Generate AI narration").props.onPress();
    await settle();
    await settle();
    assert.equal(h.counts().files, 1);
    h.context.token = "account-b";
    const nodes = h.render();
    assert.equal(
      nodes.find((node) => node.type === "MusicAudition"),
      undefined,
    );
    assert.equal(nodes.find((node) => node.type === "Field")?.props.value, "");
    assert.equal(
      h.consent("Send only this script").props.accessibilityState.checked,
      false,
    );
    assert.equal(h.counts().releases, 1);
    assert.equal(h.counts().attachments, 0);
  } finally {
    h.unmount();
  }
});
test("account switch rejects a late narration generation before any file or attachment is created", async () => {
  const pending = deferred<unknown>(),
    h = ui({ generation: pending.promise });
  try {
    h.render();
    await settle();
    h.script("Account A.");
    h.consent("Send only this script").props.onPress();
    h.action("Generate AI narration").props.onPress();
    h.context.token = "account-b";
    h.render();
    pending.resolve(audio());
    await settle();
    await settle();
    assert.equal(h.counts().files, 0);
    assert.equal(h.counts().attachments, 0);
  } finally {
    h.unmount();
  }
});
test("Record synchronously pauses both the local take and parent audition before microphone capture", async () => {
  const h = ui();
  try {
    h.render();
    await settle();
    h.script("A take.");
    h.consent("Send only this script").props.onPress();
    h.action("Generate AI narration").props.onPress();
    await settle();
    await settle();
    h.render()
      .find((node) => node.type === "MusicAudition")!
      .props.onPauseReady(() => h.order.push("local-pause"));
    h.consent("I consent to microphone").props.onPress();
    h.action("Record my voice").props.onPress();
    await settle();
    assert.deepEqual(h.order, [
      "local-pause",
      "parent-pause",
      "microphone-start",
    ]);
    h.action("Cancel and discard").props.onPress();
  } finally {
    h.unmount();
  }
});
test("preset UI sends only the consented script, validates bytes, and requires explicit attach", async () => {
  const h = ui();
  try {
    h.render();
    await settle();
    h.script("Hello creators.");
    h.consent("Send only this script").props.onPress();
    assert.equal(h.action("Generate AI narration").props.disabled, false);
    h.action("Generate AI narration").props.onPress();
    await settle();
    await settle();
    assert.deepEqual(h.calls.find((call) => call.body)?.body, {
      version: 1,
      text: "Hello creators.",
      voice_id: "athena",
      consent: true,
      expected_provider: "cloudflare",
    });
    assert.equal(h.counts().files, 1);
    assert.equal(h.counts().attachments, 0);
    h.background();
    assert.equal(h.counts().releases, 1);
  } finally {
    h.unmount();
  }
});
test("backgrounding during preset generation rejects the late account-scoped result before creating a local file", async () => {
  const pending = deferred<unknown>(),
    h = ui({ generation: pending.promise });
  try {
    h.render();
    await settle();
    h.script("Hello.");
    h.consent("Send only this script").props.onPress();
    h.action("Generate AI narration").props.onPress();
    h.background();
    pending.resolve(audio());
    await settle();
    await settle();
    assert.equal(h.counts().files, 0);
    assert.equal(h.counts().attachments, 0);
  } finally {
    h.unmount();
  }
});
test("unavailable preset is disabled; a backgrounded in-flight Record grant cannot keep capturing", async () => {
  const pending = deferred<void>(),
    h = ui({ start: pending.promise, unavailable: true });
  try {
    h.render();
    await settle();
    h.script("Hello.");
    h.consent("Send only this script").props.onPress();
    assert.equal(h.action("Generate AI narration").props.disabled, true);
    h.consent("I consent to microphone").props.onPress();
    h.action("Record my voice").props.onPress();
    await settle();
    h.background();
    pending.resolve();
    await settle();
    assert.ok(h.counts().cancels > 0);
    assert.equal(h.counts().files, 0);
    assert.equal(h.counts().attachments, 0);
  } finally {
    h.unmount();
  }
});
