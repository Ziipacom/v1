import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as controls from "../src/lib/soundtrack-controls.ts";

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function audition() {
  const hooks: any[] = [],
    effects: (() => void)[] = [];
  let cursor = 0,
    plays = 0,
    pauses = 0;
  const seeks: number[] = [],
    durations: (number | null)[] = [];
  const context = { focused: true, source: { uri: "file:one" } };
  const status = {
    isLoaded: true,
    currentTime: 0,
    duration: 20,
    playing: false,
    didJustFinish: false,
  };
  const pending = { value: null as ReturnType<typeof deferred> | null };
  const callbacks = new Set<(state: string) => void>();
  let registeredPause: (() => void) | null = null;
  const player = {
    volume: 0,
    pause() {
      pauses++;
    },
    play() {
      plays++;
    },
    seekTo(value: number) {
      seeks.push(value);
      return pending.value?.promise || Promise.resolve();
    },
  };
  const react = {
    useRef(initial: any) {
      const index = cursor++;
      return (hooks[index] ??= { current: initial });
    },
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
    useCallback(fn: any, deps: any[]) {
      const index = cursor++,
        previous = hooks[index];
      if (!previous || deps.some((value, n) => value !== previous.deps[n]))
        hooks[index] = { fn, deps };
      return hooks[index].fn;
    },
    useEffect(fn: () => void | (() => void), deps: any[]) {
      const index = cursor++,
        previous = hooks[index];
      if (!previous || deps.some((value, n) => value !== previous.deps[n])) {
        hooks[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => {
          hooks[index].cleanup?.();
          hooks[index].cleanup = fn();
        });
      }
    },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: any = {};
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/components/audio-audition.tsx", import.meta.url),
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
        AppState: {
          currentState: "active",
          addEventListener(_name: string, callback: (state: string) => void) {
            callbacks.add(callback);
            return { remove: () => callbacks.delete(callback) };
          },
        },
      };
    if (name === "@react-navigation/native")
      return { useIsFocused: () => context.focused };
    if (name === "expo-audio")
      return {
        useAudioPlayer: () => player,
        useAudioPlayerStatus: () => status,
      };
    if (name === "lucide-react-native") return { Pause: "Pause", Play: "Play" };
    if (name === "./ui") return { Action: "Action" };
    if (name === "../provider")
      return { useZiipa: () => ({ session: { access_token: "account" } }) };
    if (name === "../lib/media-playback")
      return { usePlaybackSource: () => ({ source: context.source }) };
    if (name === "../lib/soundtrack-controls") return controls;
    if (name === "../theme") return { styles: {} };
    throw new Error(name);
  });
  const props = {
    audition: { name: "Song", uri: "file:one" },
    volume: 70,
    start: 5,
    onDuration(value: number | null) {
      durations.push(value);
    },
    onPauseReady(value: (() => void) | null) {
      registeredPause = value;
    },
  };
  let tree: any;
  function nodes(value: any): any[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object") return [];
    return [value, ...nodes(value.props?.children)];
  }
  function render() {
    cursor = 0;
    const wrapper = exports.MusicAudition(props);
    tree = wrapper.type(wrapper.props);
    for (const effect of effects.splice(0)) effect();
    return nodes(tree);
  }
  const action = () => render().find((node: any) => node.type === "Action");
  render();
  return {
    props,
    status,
    context,
    pending,
    seeks,
    durations,
    player,
    render,
    action,
    counts: () => ({ plays, pauses }),
    pause: () => registeredPause?.(),
    background: () => {
      for (const callback of callbacks) callback("background");
    },
    unmount: () => {
      for (const hook of hooks) hook?.cleanup?.();
    },
  };
}

test("audio preview waits for an explicit gesture and its selected source offset seek, then resumes or replays that region", async () => {
  const h = audition();
  try {
    assert.equal(h.counts().plays, 0);
    assert.deepEqual(h.seeks, []);
    assert.equal(h.player.volume, 0.7);
    h.pending.value = deferred();
    const playing = h.action().props.onPress();
    assert.deepEqual(h.seeks, [5]);
    assert.equal(h.counts().plays, 0);
    h.pending.value.resolve();
    await playing;
    h.render();
    assert.equal(h.counts().plays, 1);
    h.status.playing = true;
    await h.action().props.onPress();
    h.status.playing = false;
    h.status.currentTime = 8;
    h.pending.value = null;
    await h.action().props.onPress();
    assert.deepEqual(h.seeks, [5, 8]);
    h.status.currentTime = 20;
    h.status.didJustFinish = true;
    await h.action().props.onPress();
    assert.deepEqual(h.seeks, [5, 8, 5]);
  } finally {
    h.unmount();
  }
});

test("a pending audio seek cannot play after navigation, background, pause, offset/metadata changes or unmount", async () => {
  for (const leave of [
    (h: ReturnType<typeof audition>) => {
      h.context.focused = false;
      h.render();
    },
    (h: ReturnType<typeof audition>) => h.background(),
    (h: ReturnType<typeof audition>) => h.pause(),
    (h: ReturnType<typeof audition>) => {
      h.props.start = 9;
      h.render();
    },
    (h: ReturnType<typeof audition>) => {
      h.status.duration = 4;
      h.render();
    },
    (h: ReturnType<typeof audition>) => {
      h.status.isLoaded = false;
      h.render();
    },
    (h: ReturnType<typeof audition>) => h.unmount(),
  ]) {
    const h = audition();
    h.pending.value = deferred();
    const playing = h.action().props.onPress();
    leave(h);
    h.pending.value.resolve();
    await playing;
    assert.equal(h.counts().plays, 0);
    h.unmount();
  }
});

test("actual duration gates invalid audio starts; failed seeks expose a recoverable error without autoplay", async () => {
  const h = audition();
  try {
    assert.equal(h.durations.at(-1), 20);
    h.props.start = 20;
    assert.equal(h.action().props.disabled, true);
    assert.ok(
      h
        .render()
        .some((node) =>
          node.props?.children?.includes?.("Audio start must be before"),
        ),
    );
    h.props.start = 5;
    h.render();
    h.pending.value = deferred();
    const playing = h.action().props.onPress();
    h.pending.value.reject(new Error("private upstream details"));
    await playing;
    const nodes = h.render();
    assert.ok(
      nodes.some(
        (node) =>
          node.props?.children === "Audio preview could not seek. Try again.",
      ),
    );
    assert.equal(h.counts().plays, 0);
    h.status.isLoaded = false;
    h.render();
    assert.equal(h.durations.at(-1), null);
  } finally {
    h.unmount();
  }
});
