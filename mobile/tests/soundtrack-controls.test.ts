import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as controls from "../src/lib/soundtrack-controls.ts";

test("a stalled native audio seek has a deadline rather than leaving preview permanently busy", async () => {
  let resolve!: () => void;
  const stalled = new Promise<void>((done) => {
    resolve = done;
  });
  await assert.rejects(
    controls.boundedAudioPreviewSeek(stalled, 1),
    /timed out/,
  );
  resolve();
  await controls.boundedAudioPreviewSeek(Promise.resolve(), 50);
});

test("audio offset accepts the existing API range and rejects unsafe or ambiguous input", () => {
  for (const value of [0, 0.125, 7.25, 86400]) {
    assert.equal(controls.validateSoundtrackStart(value), value);
  }
  for (const value of [-1, Infinity, NaN, 86400.001, "12", null, true]) {
    assert.throws(() => controls.validateSoundtrackStart(value), /0 to 86400/);
  }
  assert.equal(controls.parseSoundtrackStart(" 7.125 "), 7.125);
  assert.equal(controls.parseSoundtrackStart(".5"), 0.5);
  assert.equal(controls.parseSoundtrackStart("1."), 1);
  for (const value of [
    "",
    "-1",
    "1e2",
    "0x10",
    "2:30",
    "1,5",
    "1.2345",
    "NaN",
  ]) {
    assert.throws(() => controls.parseSoundtrackStart(value));
  }
});

test("audio duration is never fabricated and an offset must leave actual selected audio", () => {
  for (const value of [0, -1, NaN, Infinity, undefined, "30"]) {
    assert.equal(controls.knownAudioDuration(value), null);
  }
  assert.equal(controls.knownAudioDuration(0.125), 0.125);
  assert.equal(controls.validateSoundtrackStart(20, null), 20);
  assert.equal(controls.validateSoundtrackStart(19.999, 20), 19.999);
  assert.throws(
    () => controls.validateSoundtrackStart(20, 20),
    /before the end/,
  );
  assert.throws(
    () => controls.validateSoundtrackStart(21, 20),
    /before the end/,
  );
});

test("explicit audio preview restarts at its source offset and can resume inside the region", () => {
  assert.equal(controls.soundtrackPreviewPosition(12, 0, 30, false), 12);
  assert.equal(controls.soundtrackPreviewPosition(12, 17, 30, false), 17);
  assert.equal(controls.soundtrackPreviewPosition(12, 30, 30, false), 12);
  assert.equal(controls.soundtrackPreviewPosition(12, 17, 30, true), 12);
  assert.equal(controls.soundtrackPreviewPosition(12, NaN, null, false), 12);
  assert.throws(() => controls.soundtrackPreviewPosition(30, 0, 30, false));
});

type Node = { type: any; props: Record<string, any> };
async function workspace() {
  const hooks: any[] = [];
  let cursor = 0;
  const effects: (() => void)[] = [];
  const durations: (number | null)[] = [],
    starts: number[] = [],
    order: string[] = [];
  const file = (uri: string) => ({
    uri,
    name: "Owned audio.wav",
    size: 1000,
    mimeType: "audio/wav",
  });
  const props: any = {
    purpose: "soundtrack",
    volume: 70,
    selectedFile: file("file:one"),
    selectedName: "Attached song",
    start: 0,
    onVolumeChange() {},
    onUpload() {},
    onUseOwned() {},
    onUseGenerated() {},
    onAuditionStart() {
      order.push("pause-edit");
    },
    onStartChange(value: number) {
      starts.push(value);
      props.start = value;
    },
    onDurationChange(value: number | null) {
      durations.push(value);
    },
    onRemove() {
      order.push("remove");
      props.selectedFile = null;
      props.start = 0;
    },
  };
  const react = {
    useState(initial: any) {
      const index = cursor++;
      hooks[index] ??= {
        value: typeof initial === "function" ? initial() : initial,
      };
      return [
        hooks[index].value,
        (next: any) => {
          hooks[index].value =
            typeof next === "function" ? next(hooks[index].value) : next;
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      return (hooks[index] ??= { current: initial });
    },
    useCallback(fn: any, deps: any[]) {
      const index = cursor++,
        previous = hooks[index];
      if (!previous || deps.some((value, n) => value !== previous.deps[n]))
        hooks[index] = { fn, deps };
      return hooks[index].fn;
    },
    useEffect(fn: () => void, deps: any[] = []) {
      const index = cursor++,
        previous = hooks[index];
      if (!previous || deps.some((value, n) => value !== previous.deps[n])) {
        hooks[index] = { deps };
        effects.push(fn);
      }
    },
  };
  const jsx = (type: any, value: any) => ({ type, props: value || {} });
  const api = async () => ({ items: [], media: [] });
  const capture = () => () => true;
  const exports: any = {};
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/components/music-workspace.tsx", import.meta.url),
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
  new Function("exports", "require", code)(exports, (name: string) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native")
      return {
        Text: "Text",
        View: "View",
        Pressable: "Pressable",
        ActivityIndicator: "ActivityIndicator",
      };
    if (name === "@react-navigation/native")
      return { useIsFocused: () => true };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => String(key) });
    if (name === "./ui")
      return {
        Action: "Action",
        Field: "Field",
        Notice: "Notice",
        Pill: "Pill",
      };
    if (name === "./desktop-layout")
      return { useDesktopLayout: () => ({ desktop: false }) };
    if (name === "../provider")
      return {
        useZiipa: () => ({
          session: { access_token: "account", user: { id: 1 } },
          api,
        }),
      };
    if (name === "../lib/use-operation-scope")
      return { useOperationScope: () => capture };
    if (name === "./audio-audition") return { MusicAudition: "MusicAudition" };
    if (name === "./voice-narration-workspace")
      return { VoiceNarrationWorkspace: "VoiceNarrationWorkspace" };
    if (name === "../lib/music-composer")
      return {
        musicStyles: [],
        musicMoods: [],
        musicPlan: () => ({ summary: "plan", voices: [] }),
        ownedAudioTracks: () => [
          {
            media_id: "candidate",
            name: "Candidate",
            size: 100,
            rightsExpired: false,
          },
        ],
      };
    if (name === "../lib/ai-music" || name === "../lib/generated-music-file")
      return {};
    if (name === "../lib/soundtrack-controls") return controls;
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    throw new Error(name);
  });
  let tree: Node;
  function render() {
    cursor = 0;
    const wrapper = exports.MusicWorkspace(props);
    tree = wrapper.type(wrapper.props);
    for (const effect of effects.splice(0)) effect();
    return tree;
  }
  function nodes(value: any): Node[] {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(nodes);
    return [value, ...nodes(value.props?.children)];
  }
  const find = (type: string, property: string, value: string) => {
    const node = nodes(tree).find(
      (node) => node.type === type && node.props[property] === value,
    );
    assert.ok(node, `Missing ${type} ${value}`);
    return node;
  };
  render();
  await Promise.resolve();
  render();
  return {
    props,
    file,
    render,
    nodes: () => nodes(tree),
    find,
    starts,
    durations,
    order,
  };
}

test("attached audio controls apply an offset only after review, reject an end offset, then remove without deleting library files", async () => {
  const h = await workspace();
  let audition = h.nodes().find((node) => node.type === "MusicAudition")!;
  audition.props.onPauseReady(() => h.order.push("pause-audition"));
  audition.props.onDuration(10);
  h.render();
  assert.equal(h.durations.at(-1), 10);
  h.find(
    "Field",
    "label",
    "Start within audio file (seconds)",
  ).props.onChangeText("10");
  h.render();
  assert.deepEqual(h.starts, []);
  h.find("Action", "title", "Apply audio start").props.onPress();
  h.render();
  assert.deepEqual(h.starts, []);
  assert.ok(
    h
      .nodes()
      .some(
        (node) =>
          node.type === "Notice" && /before the end/.test(node.props.text),
      ),
  );
  h.find(
    "Field",
    "label",
    "Start within audio file (seconds)",
  ).props.onChangeText("2.125");
  h.render();
  h.find("Action", "title", "Apply audio start").props.onPress();
  h.render();
  h.render();
  assert.deepEqual(h.starts, [2.125]);
  audition = h.nodes().find((node) => node.type === "MusicAudition")!;
  assert.equal(audition.props.start, 2.125);
  h.find("Action", "title", "Remove attached audio").props.onPress();
  h.render();
  assert.deepEqual(h.order, [
    "pause-audition",
    "pause-edit",
    "pause-audition",
    "pause-edit",
    "remove",
  ]);
  assert.equal(h.durations.at(-1), null);
  assert.equal(
    h.nodes().some((node) => node.props?.title === "Remove attached audio"),
    false,
  );
});

test("candidate auditions start at zero and cannot overwrite selected audio metadata; late previous-source metadata is ignored", async () => {
  const h = await workspace();
  const original = h.nodes().find((node) => node.type === "MusicAudition")!;
  original.props.onDuration(10);
  h.render();
  h.find("Action", "title", "Preview audio").props.onPress();
  h.render();
  const candidate = h.nodes().find((node) => node.type === "MusicAudition")!;
  assert.equal(candidate.props.start, 0);
  assert.equal(candidate.props.onDuration, undefined);
  assert.equal(h.durations.at(-1), 10);
  h.props.selectedFile = h.file("file:two");
  h.render();
  h.render();
  assert.equal(h.durations.at(-1), null);
  original.props.onDuration(999);
  h.render();
  assert.equal(h.durations.at(-1), null);
});

test("audio creation source has no soundtrack offset or remove controls", async () => {
  const h = await workspace();
  h.nodes()
    .find((node) => node.type === "MusicAudition")!
    .props.onDuration(20);
  h.render();
  h.props.purpose = "creation";
  h.render();
  assert.equal(h.durations.at(-1), null);
  assert.equal(
    h.nodes().find((node) => node.type === "MusicAudition")!.props.onDuration,
    undefined,
  );
  assert.equal(
    h.nodes().some((node) => node.props?.title === "Remove attached audio"),
    false,
  );
  assert.equal(
    h
      .nodes()
      .some(
        (node) => node.props?.label === "Start within audio file (seconds)",
      ),
    false,
  );
});
