import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as remix from "../src/lib/remix.ts";
import type { Item } from "../src/lib/types.ts";

const source = "11111111-1111-4111-8111-111111111111",
  media = "22222222-2222-4222-8222-222222222222",
  request = "33333333-3333-4333-8333-333333333333",
  child = "44444444-4444-4444-8444-444444444444",
  job = "55555555-5555-4555-8555-555555555555";
const snapshot = (): remix.RemixSnapshot => ({
  available: true,
  allowed_modes: ["stitch", "split_screen", "use_sound"],
  policy: null,
  attribution: null,
  children: [],
});
const response = {
  uri: "file:///cache/response.mp4",
  name: "response.mp4",
  mimeType: "video/mp4",
  size: 1000,
};
const item = {
  id: source,
  creator_id: 99,
  title: "Source",
  description: "Source description",
  city: "",
  label: "Creation",
  creator: "Creator",
  demo: false,
  category: "video",
  tags: [],
  cover: "",
  media_url: "/api/creator/media/owned",
  content_type: "video/mp4",
} as Item;
const saved = {
  ...item,
  id: child,
  creator_id: 7,
  visibility: "draft",
  media_id: media,
  remix_of: source,
  title: "My remix",
};
const receipt = (status: remix.RemixReceipt["status"]) => ({
  item_id: child,
  job_id: job,
  status,
  detail: "Actual status",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Node = { type: any; props: Record<string, any>; key?: string };

function harness(
  options: {
    snapshot?: remix.RemixSnapshot;
    create?: () => Promise<unknown>;
    upload?: Promise<unknown>;
    pick?: Promise<unknown>;
    own?: boolean;
    apply?: unknown;
    resume?: boolean;
    dirty?: string;
    status?: remix.RemixReceipt["status"];
    statusRead?: () => Promise<unknown>;
    guest?: boolean;
  } = {},
) {
  const hooks: any[] = [],
    effects: (() => void)[] = [],
    timers: { fn: () => void; cleared: boolean }[] = [];
  const ctx = {
    token: "account-a",
    focused: true,
    mounted: true,
    dirty: options.dirty || (null as string | null),
    parentBusy: false,
  };
  let cursor = 0,
    uploads = 0,
    deleted = 0,
    opened = 0,
    recorded = 0,
    refreshed = 0,
    closes = 0;
  let currentSnapshot = options.snapshot || snapshot();
  const calls: { path: string; body?: any }[] = [],
    credits: string[] = [],
    order: string[] = [];
  const capture = () => {
    const token = ctx.token;
    return () => ctx.mounted && ctx.focused && token === ctx.token;
  };
  const api = async (path: string, body?: any) => {
    calls.push({ path, body });
    if (path.endsWith("/apply")) return options.apply || saved;
    if (path.endsWith("/policy")) {
      currentSnapshot = {
        ...currentSnapshot,
        policy: { ...body, revision: body.revision + 1 },
      };
      return currentSnapshot;
    }
    if (body) {
      order.push("create");
      return options.create ? await options.create() : receipt("queued");
    }
    return path.startsWith("/api/remix/projects/")
      ? options.statusRead
        ? await options.statusRead()
        : receipt(options.status || "ready")
      : currentSnapshot;
  };
  const useState = (initial: any) => {
    const slot = cursor++;
    if (!(slot in hooks))
      hooks[slot] = typeof initial === "function" ? initial() : initial;
    return [
      hooks[slot],
      (next: any) => {
        hooks[slot] = typeof next === "function" ? next(hooks[slot]) : next;
      },
    ];
  };
  const memo = (fn: any, deps: unknown[]) => {
    const slot = cursor++;
    if (
      !hooks[slot] ||
      deps.some((dep, i) => !Object.is(dep, hooks[slot].deps[i]))
    )
      hooks[slot] = { value: fn, deps };
    return hooks[slot].value;
  };
  const react = {
    useState,
    useCallback: memo,
    useRef: (initial: any) => {
      const slot = cursor++;
      return (hooks[slot] ||= { current: initial });
    },
    useEffect(fn: () => any, deps: unknown[]) {
      const slot = cursor++,
        old = hooks[slot];
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
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
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/components/remix-panel.tsx", import.meta.url),
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
  new Function("exports", "require", "setTimeout", "clearTimeout", code)(
    exports,
    (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react-native")
        return {
          AppState: {
            currentState: "active",
            addEventListener: () => ({ remove() {} }),
          },
          Platform: { OS: "ios" },
          Pressable: "Pressable",
          Text: "Text",
          View: "View",
        };
      if (name === "@react-navigation/native")
        return { useIsFocused: () => ctx.focused };
      if (name === "expo-crypto") return { randomUUID: () => request };
      if (name === "expo-file-system/legacy")
        return {
          cacheDirectory: "file:///cache/",
          getInfoAsync: async () => ({
            exists: true,
            isDirectory: false,
            size: 1000,
          }),
          deleteAsync: async () => {
            deleted++;
          },
        };
      if (name === "lucide-react-native")
        return new Proxy({}, { get: (_, key) => key });
      if (name === "./floating") return { Sheet: "Sheet" };
      if (name === "./ui")
        return {
          Action: "Action",
          IconButton: "IconButton",
          Field: "Field",
          Notice: "Notice",
          Pill: "Pill",
        };
      if (name === "./help-label") return { HelpLabel: "HelpLabel" };
      if (name === "./player") return { MediaPlayer: "MediaPlayer" };
      if (name === "./recorder") return { Recorder: "Recorder" };
      if (name === "../provider")
        return {
          useZiipa: () => ({
            api,
            guest: !!options.guest,
            session: { access_token: ctx.token, user: { id: 7 } },
            recordSavedItem: () => {
              recorded++;
            },
            refresh: async () => {
              refreshed++;
            },
          }),
        };
      if (name === "../lib/api")
        return {
          creatorMimeType: (_: string, type: string) => type,
          uploadLimit: 104857600,
          uploadMedia: async () => {
            uploads++;
            order.push("upload");
            return options.upload ? await options.upload : { id: media };
          },
        };
      if (name === "../lib/creator-media-picker")
        return {
          pickCreatorMedia: async () =>
            options.pick
              ? await options.pick
              : { canceled: false, assets: [response] },
        };
      if (name === "../lib/use-operation-scope")
        return { useOperationScope: () => capture };
      if (name === "../lib/remix") return remix;
      if (name === "../theme") return { color: {}, styles: {} };
      throw new Error(name);
    },
    (fn: () => void) => {
      const timer = { fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    (timer: any) => {
      if (timer) timer.cleared = true;
    },
  );
  const props = {
    item: options.resume
      ? saved
      : options.own
        ? { ...item, creator_id: 7 }
        : item,
    onClose() {
      closes++;
    },
    onOpenDraft() {
      opened++;
    },
    onViewItem(id: string) {
      credits.push(id);
    },
    onSignIn() {},
    unsavedKey: ctx.dirty,
    disabled: false,
    acquire() {
      if (ctx.parentBusy) return null;
      const token = ctx.token;
      ctx.parentBusy = true;
      return () => {
        if (token === ctx.token) ctx.parentBusy = false;
      };
    },
  };
  function nodes(node: any): Node[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== "object" || !node.props) return [];
    if (typeof node.type === "function") return nodes(node.type(node.props));
    return [node, ...nodes(node.props.children)];
  }
  let key: string | undefined;
  const render = () => {
    cursor = 0;
    props.unsavedKey = ctx.dirty;
    const wrapped = options.resume
      ? exports.RemixProjectStatus(props)
      : exports.RemixPanel(props);
    if (key !== undefined && key !== wrapped?.key) {
      hooks.forEach((hook) => hook?.cleanup?.());
      hooks.length = 0;
      // The existing Composer account-reset effect clears its shared save lock.
      ctx.parentBusy = false;
    }
    key = wrapped?.key;
    const result = nodes(wrapped);
    while (effects.length) effects.shift()!();
    return result;
  };
  return {
    render,
    ctx,
    calls,
    order,
    credits,
    action: (title: string) =>
      render().find(
        (node) => node.type === "Action" && node.props.title.startsWith(title),
      )!,
    pill: (title: string) =>
      render().find(
        (node) => node.type === "Pill" && node.props.title === title,
      )!,
    consent: (prefix: string) =>
      render().find(
        (node) =>
          node.type === "Pressable" &&
          node.props.accessibilityRole === "checkbox" &&
          node.props.accessibilityLabel.startsWith(prefix),
      )!,
    counts: () => ({ uploads, deleted, opened, recorded, refreshed, closes }),
    poll() {
      const timer = timers.find((timer) => !timer.cleared);
      assert.ok(timer);
      timer.cleared = true;
      timer.fn();
    },
    unmount() {
      ctx.mounted = false;
      hooks.forEach((hook) => hook?.cleanup?.());
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function choose(h: ReturnType<typeof harness>) {
  h.render();
  await settle();
  h.action("Upload").props.onPress();
  await settle();
  h.consent("I have permission").props.onPress();
}

test("compact Remix controls retain source preview, mode bounds and explicit Ziipa rights", async () => {
  const h = harness();
  try {
    h.render();
    await settle();
    let nodes = h.render();
    assert.equal(
      nodes.some((node) => node.type === "MediaPlayer"),
      false,
    );
    nodes
      .find((node) => node.props.accessibilityLabel === "Preview source")!
      .props.onPress();
    assert.ok(h.render().find((node) => node.type === "MediaPlayer"));
    assert.ok(
      nodes.find(
        (node) =>
          node.type === "IconButton" &&
          node.props.label === "Refresh permissions and availability",
      ),
    );
    assert.ok(
      nodes.find(
        (node) =>
          node.type === "HelpLabel" &&
          node.props.label === "Ziipa-only remix" &&
          node.props.help.includes("minting"),
      ),
    );
    for (const label of ["Start (s)", "Length (s)", "Title"])
      assert.ok(
        nodes.find(
          (node) => node.type === "Field" && node.props.label === label,
        ),
      );
    assert.ok(h.action("Upload"));
    assert.ok(h.action("Camera"));
    assert.equal(
      h.consent("I have permission").props.accessibilityLabel,
      "I have permission to use both clips on Ziipa.",
    );
    nodes
      .find(
        (node) =>
          node.props.accessibilityRole === "radio" &&
          node.props.accessibilityLabel === "Split screen",
      )!
      .props.onPress();
    nodes = h.render();
    assert.equal(
      nodes.find(
        (node) =>
          node.props.accessibilityRole === "radio" &&
          node.props.accessibilityLabel === "Split screen",
      )!.props.accessibilityState.checked,
      true,
    );
    assert.equal(h.action("Create private remix").props.disabled, true);
    assert.equal(h.counts().uploads, 0);
  } finally {
    h.unmount();
  }
});

test("Remix upload/create/poll/apply is explicit, private and opens only the applied owned draft", async () => {
  const h = harness();
  try {
    h.render();
    await settle();
    assert.equal(h.counts().uploads, 0);
    assert.equal(h.action("Create private remix").props.disabled, true);
    await choose(h);
    assert.equal(h.counts().uploads, 0);
    h.action("Create private remix").props.onPress();
    await settle();
    assert.equal(h.counts().refreshed, 1);
    assert.deepEqual(h.order, ["upload", "create"]);
    const posted = h.calls.find((call) => call.body?.request_id)!.body;
    assert.equal(posted.response_media_id, media);
    assert.equal(posted.rights_confirmed, true);
    assert.equal(posted.request_id, request);
    h.render();
    h.poll();
    await settle();
    h.action("Prepare editable draft").props.onPress();
    await settle();
    assert.equal(h.counts().recorded, 1);
    assert.equal(h.counts().opened, 0);
    h.action("Open draft in editor").props.onPress();
    assert.equal(h.counts().opened, 1);
  } finally {
    h.unmount();
  }
});
test("Unavailable matching worker or absent rights cannot upload or submit media", async () => {
  const offline = harness({ snapshot: { ...snapshot(), available: false } });
  try {
    await choose(offline);
    assert.equal(offline.action("Create private remix").props.disabled, true);
    offline.action("Create private remix").props.onPress();
    await settle();
    assert.equal(offline.counts().uploads, 0);
  } finally {
    offline.unmount();
  }
  const missing = harness();
  try {
    missing.render();
    await settle();
    missing.action("Upload").props.onPress();
    await settle();
    missing.action("Create private remix").props.onPress();
    await settle();
    assert.equal(missing.counts().uploads, 0);
  } finally {
    missing.unmount();
  }
});
test("Unconfirmed create retains identical request UUID/body and uploaded response for an explicit retry only", async () => {
  let attempt = 0;
  const h = harness({
    create: async () => {
      if (!attempt++)
        throw Object.assign(new Error("Unconfirmed"), {
          outcome: "unconfirmed",
        });
      return receipt("queued");
    },
  });
  try {
    await choose(h);
    h.action("Create private remix").props.onPress();
    await settle();
    assert.equal(h.calls.filter((call) => call.body?.request_id).length, 1);
    assert.equal(h.counts().uploads, 1);
    h.render();
    await settle();
    assert.equal(h.calls.filter((call) => call.body?.request_id).length, 1);
    h.action("Check the same remix request").props.onPress();
    await settle();
    const bodies = h.calls
      .filter((call) => call.body?.request_id)
      .map((call) => call.body);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(h.counts().uploads, 1);
  } finally {
    h.unmount();
  }
});
test("Account switch during upload prevents a stale create and releases the old owned cache file after upload settles", async () => {
  const upload = deferred<any>(),
    h = harness({ upload: upload.promise });
  try {
    await choose(h);
    h.action("Create private remix").props.onPress();
    await settle();
    h.ctx.token = "account-b";
    h.render();
    upload.resolve({ id: media });
    await settle();
    assert.equal(h.calls.filter((call) => call.body?.request_id).length, 0);
    assert.ok(h.counts().deleted > 0);
    assert.equal(h.counts().recorded, 0);
  } finally {
    h.unmount();
  }
});
test("Owner may save explicit inside-Ziipa permissions while processing is offline; another viewer has no permission editor", async () => {
  const h = harness({
    own: true,
    snapshot: {
      ...snapshot(),
      available: false,
      allowed_modes: [],
      policy: { revision: 0, audience: "disabled", modes: [] },
    },
  });
  try {
    h.render();
    await settle();
    assert.equal(h.action("Save remix permissions").props.disabled, true);
    h.pill("Everyone").props.onPress();
    h.consent("Stitch").props.onPress();
    h.consent("I own or have permission").props.onPress();
    h.action("Save remix permissions").props.onPress();
    await settle();
    assert.deepEqual(
      h.calls.find((call) => call.path.endsWith("/policy"))!.body,
      { revision: 0, audience: "everyone", modes: ["stitch"] },
    );
    assert.equal(h.counts().uploads, 0);
  } finally {
    h.unmount();
  }
  const other = harness();
  try {
    other.render();
    await settle();
    assert.equal(other.action("Save remix permissions"), undefined);
  } finally {
    other.unmount();
  }
});
test("Recording a response reuses the recorder but does not upload until a separate rights/Create action", async () => {
  const h = harness();
  try {
    h.render();
    await settle();
    h.action("Camera").props.onPress();
    const recording = h.render().find((node) => node.type === "Recorder")!;
    assert.equal(recording.props.mode, "record");
    assert.equal(
      h.render().some((node) => node.type === "MediaPlayer"),
      false,
    );
    recording.props.onCapture(response);
    await settle();
    assert.equal(h.counts().uploads, 0);
    assert.equal(h.action("Create private remix").props.disabled, true);
  } finally {
    h.unmount();
  }
});
test("Attribution links navigate only to validated parent/root IDs, and redacted credits are not invented", async () => {
  const h = harness({
    snapshot: {
      ...snapshot(),
      attribution: {
        parent: { id: child, title: "Parent", creator: "Creator A" },
        root: { id: source, title: "Root", creator: "Creator B" },
      },
    },
  });
  try {
    h.render();
    await settle();
    const links = h
      .render()
      .filter(
        (node) =>
          node.type === "Pressable" && node.props.accessibilityRole === "link",
      );
    assert.equal(links.length, 2);
    links.forEach((link) => link.props.onPress());
    assert.deepEqual(h.credits, [child, source]);
  } finally {
    h.unmount();
  }
});

test("A queued Remix reopens from its normal private draft, polls read-only and explicitly loads only applied media", async () => {
  let state: remix.RemixReceipt["status"] = "queued";
  const h = harness({ resume: true, statusRead: async () => receipt(state) });
  try {
    h.render();
    await settle();
    assert.ok(h.action("Refresh saved remix"));
    assert.equal(h.action("Prepare saved remix"), undefined);
    assert.deepEqual(
      h.calls.map((call) => call.path),
      [`/api/remix/projects/${child}`],
    );
    state = "ready";
    h.render();
    h.poll();
    await settle();
    assert.equal(h.counts().uploads, 0);
    assert.equal(h.counts().opened, 0);
    h.action("Prepare saved remix").props.onPress();
    await settle();
    assert.equal(h.counts().recorded, 1);
    assert.equal(h.counts().opened, 0);
    h.action("Load prepared remix").props.onPress();
    assert.equal(h.counts().opened, 1);
    assert.equal(h.calls.filter((call) => call.body).length, 1);
    assert.equal(
      h.calls.find((call) => call.body)!.path,
      `/api/remix/projects/${child}/apply`,
    );
  } finally {
    h.unmount();
  }
});

test("Resumed Remix replacement requires consent for the current exact unsaved editor revision", async () => {
  const h = harness({ resume: true, dirty: "revision-a" });
  try {
    h.render();
    await settle();
    assert.equal(h.action("Prepare saved remix").props.disabled, true);
    h.action("Prepare saved remix").props.onPress();
    await settle();
    assert.equal(h.calls.filter((call) => call.body).length, 0);
    h.consent("Replace my unsaved").props.onPress();
    h.ctx.dirty = "revision-b";
    assert.equal(h.action("Prepare saved remix").props.disabled, true);
    h.consent("Replace my unsaved").props.onPress();
    h.action("Prepare saved remix").props.onPress();
    await settle();
    h.ctx.dirty = "revision-c";
    assert.equal(h.action("Load prepared remix").props.disabled, true);
    h.action("Load prepared remix").props.onPress();
    assert.equal(h.counts().opened, 0);
    h.consent("Replace my unsaved").props.onPress();
    h.action("Load prepared remix").props.onPress();
    assert.equal(h.counts().opened, 1);
  } finally {
    h.unmount();
  }
});

test("Resumed Remix honors the editor save lock and releases its own apply lock after a failed request", async () => {
  const result = deferred<unknown>(),
    h = harness({ resume: true, apply: result.promise });
  try {
    h.render();
    await settle();
    h.ctx.parentBusy = true;
    h.action("Prepare saved remix").props.onPress();
    await settle();
    assert.equal(h.calls.filter((call) => call.body).length, 0);
    h.ctx.parentBusy = false;
    h.action("Prepare saved remix").props.onPress();
    await settle();
    assert.equal(h.ctx.parentBusy, true);
    assert.equal(h.action("Prepare saved remix").props.disabled, true);
    result.resolve({ ...saved, creator_id: 80 });
    await settle();
    assert.equal(h.ctx.parentBusy, false);
    assert.equal(h.counts().recorded, 0);
    assert.equal(h.action("Load prepared remix"), undefined);
    assert.ok(
      h.render().some((node) => node.type === "Notice" && node.props.error),
    );
  } finally {
    h.unmount();
  }
});

test("Resumed Remix discards a late apply after account switch and hides legacy attribution-only draft status", async () => {
  const result = deferred<unknown>(),
    h = harness({ resume: true, apply: result.promise });
  try {
    h.render();
    await settle();
    h.action("Prepare saved remix").props.onPress();
    await settle();
    h.ctx.token = "account-b";
    h.render();
    assert.equal(h.ctx.parentBusy, false);
    // A new account's save must not be unlocked by account A's late apply.
    h.ctx.parentBusy = true;
    result.resolve(saved);
    await settle();
    assert.equal(h.ctx.parentBusy, true);
    assert.equal(h.counts().recorded, 0);
    assert.equal(h.counts().opened, 0);
    assert.equal(h.action("Load prepared remix"), undefined);
  } finally {
    h.unmount();
  }
  const legacy = harness({
    resume: true,
    statusRead: async () => {
      throw Object.assign(new Error("Not found"), { status: 404 });
    },
  });
  try {
    legacy.render();
    await settle();
    assert.equal(legacy.render().length, 0);
    assert.equal(legacy.calls.filter((call) => call.body).length, 0);
  } finally {
    legacy.unmount();
  }
});
