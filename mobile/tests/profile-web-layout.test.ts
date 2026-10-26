import assert from "node:assert/strict";
import test from "node:test";
import {
  measureProfileWebLayout,
  observeProfileWebLayout,
  type ProfileWebLayout,
} from "../src/lib/profile-web-layout.ts";
import {
  profileCardVisible,
  profileVideoSelection,
} from "../src/lib/profile-preview.ts";
import type { Item } from "../src/lib/types.ts";

function fixture() {
  const winEvents = new EventTarget();
  const fontEvents = new EventTarget();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let finishFonts!: () => void;
  const win = Object.assign(winEvents, {
    innerHeight: 720,
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame(frame: number) {
      frames.delete(frame);
    },
  });
  const doc = {
    defaultView: win,
    fonts: Object.assign(fontEvents, {
      ready: new Promise<void>((resolve) => (finishFonts = resolve)),
    }),
  };
  const makeNode = (top: number, height: number) => {
    const rect = { top, height, bottom: top + height };
    return {
      rect,
      isConnected: true,
      ownerDocument: doc,
      getBoundingClientRect: () => rect,
    };
  };
  const scroller = Object.assign(makeNode(77, 643), {
    firstElementChild: makeNode(77, 1282),
  });
  const first = makeNode(660, 320);
  const second = makeNode(998, 320);
  const cards = new Map([
    ["first", first as unknown as Element],
    ["second", second as unknown as Element],
  ]);
  const observers: {
    callback: () => void;
    nodes: Element[];
    disconnected: boolean;
  }[] = [];
  class Observer {
    state: (typeof observers)[number];
    constructor(callback: () => void) {
      this.state = { callback, nodes: [], disconnected: false };
      observers.push(this.state);
    }
    observe(node: Element) {
      this.state.nodes.push(node);
    }
    disconnect() {
      this.state.disconnected = true;
    }
  }
  return {
    win,
    scroller: scroller as unknown as Element,
    first,
    second,
    cards,
    observers,
    Observer,
    frames,
    finishFonts: () => finishFonts(),
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    },
  };
}

const videos = ["first", "second"].map(
  (id) =>
    ({ id, media_url: `/test/${id}.mp4`, content_type: "video/mp4" }) as Item,
);

test("cold desktop scroll reads both visible cards without requiring a resize", () => {
  const f = fixture();
  const oldResize = globalThis.ResizeObserver;
  const oldIntersection = globalThis.IntersectionObserver;
  globalThis.ResizeObserver = f.Observer as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver =
    f.Observer as unknown as typeof IntersectionObserver;
  const snapshots: ProfileWebLayout[] = [];
  const stop = observeProfileWebLayout(f.scroller, f.cards, (s) =>
    snapshots.push(s),
  );
  try {
    assert.equal(
      profileVideoSelection(videos, snapshots[0].bounds, snapshots[0].viewport),
      null,
    );
    // The reported desktop position: viewport 77..720, cards 22..342 and
    // 360..680. These fresh rectangles must supersede pre-scroll RN layouts.
    Object.assign(f.first.rect, { top: 22, bottom: 342 });
    Object.assign(f.second.rect, { top: 360, bottom: 680 });
    f.win.dispatchEvent(new Event("scroll"));
    f.win.dispatchEvent(new Event("scroll"));
    assert.equal(f.frames.size, 1, "scroll notifications share one frame");
    f.flush();
    const current = snapshots.at(-1)!;
    assert.equal(
      profileCardVisible(current.bounds.first, current.viewport),
      true,
    );
    assert.equal(
      profileCardVisible(current.bounds.second, current.viewport),
      true,
    );
    assert.equal(
      profileVideoSelection(videos, current.bounds, current.viewport),
      "second",
    );
    assert.equal(snapshots.length, 2);
    f.win.dispatchEvent(new Event("scroll"));
    f.flush();
    assert.equal(
      snapshots.length,
      2,
      "unchanged geometry does not rerender players",
    );
  } finally {
    stop();
    globalThis.ResizeObserver = oldResize;
    globalThis.IntersectionObserver = oldIntersection;
  }
});

test("font, card intersection and viewport resize changes refresh the same geometry", async () => {
  const f = fixture();
  const oldResize = globalThis.ResizeObserver;
  const oldIntersection = globalThis.IntersectionObserver;
  globalThis.ResizeObserver = f.Observer as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver =
    f.Observer as unknown as typeof IntersectionObserver;
  const snapshots: ProfileWebLayout[] = [];
  const stop = observeProfileWebLayout(f.scroller, f.cards, (s) =>
    snapshots.push(s),
  );
  try {
    Object.assign(f.second.rect, { top: 300, bottom: 620 });
    f.finishFonts();
    await Promise.resolve();
    f.flush();
    assert.equal(
      profileCardVisible(
        snapshots.at(-1)!.bounds.second,
        snapshots.at(-1)!.viewport,
      ),
      true,
    );
    Object.assign(f.second.rect, { top: 700, bottom: 1020 });
    f.observers[1].callback();
    f.flush();
    assert.equal(
      profileCardVisible(
        snapshots.at(-1)!.bounds.second,
        snapshots.at(-1)!.viewport,
      ),
      false,
    );
    f.win.innerHeight = 1100;
    // The containing scroll area changes too when the window grows.
    Object.assign((f.scroller as any).rect, { height: 1023, bottom: 1100 });
    f.win.dispatchEvent(new Event("resize"));
    f.flush();
    assert.equal(
      profileCardVisible(
        snapshots.at(-1)!.bounds.second,
        snapshots.at(-1)!.viewport,
      ),
      true,
    );
    assert.equal(
      f.observers[0].nodes.length,
      4,
      "observe viewport, content and both cards",
    );
    assert.equal(f.observers[1].nodes.length, 2);
  } finally {
    stop();
    globalThis.ResizeObserver = oldResize;
    globalThis.IntersectionObserver = oldIntersection;
  }
});

test("disposed filters or accounts cannot receive queued geometry or font callbacks", async () => {
  const f = fixture();
  const snapshots: ProfileWebLayout[] = [];
  const stop = observeProfileWebLayout(f.scroller, f.cards, (s) =>
    snapshots.push(s),
  );
  f.win.dispatchEvent(new Event("scroll"));
  const queued = [...f.frames.values()];
  stop();
  assert.equal(f.frames.size, 0);
  Object.assign(f.second.rect, { top: 300, bottom: 620 });
  queued.forEach((callback) => callback(0));
  f.finishFonts();
  await Promise.resolve();
  f.win.dispatchEvent(new Event("resize"));
  f.flush();
  assert.equal(snapshots.length, 1);
});

test("clipping to the actual browser viewport ignores detached cards", () => {
  const f = fixture();
  Object.assign((f.scroller as any).rect, { top: -100, bottom: 900 });
  f.second.isConnected = false;
  const snapshot = measureProfileWebLayout(f.scroller, f.cards, 720);
  assert.deepEqual(snapshot.viewport, { top: 0, height: 720, gridTop: 0 });
  assert.deepEqual(Object.keys(snapshot.bounds), ["first"]);
});
