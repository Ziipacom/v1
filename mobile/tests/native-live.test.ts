import assert from "node:assert/strict";
import test from "node:test";
import { NativeLiveSession } from "../src/lib/native-live-session.ts";
import { discoverNativeWhipEdge } from "../src/lib/native-live-whip.ts";

function stream(kinds = ["audio", "video"]) {
  const tracks = kinds.map((kind) => ({
    kind,
    enabled: true,
    stops: 0,
    stop() {
      this.stops++;
    },
  }));
  return {
    tracks,
    releases: 0,
    getTracks: () => tracks,
    release(all?: boolean) {
      assert.equal(all, true);
      this.releases++;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("cancelled permission request releases late camera and microphone", async () => {
  const session = new NativeLiveSession<ReturnType<typeof stream>>();
  const request = deferred<ReturnType<typeof stream>>();
  const acquisition = session.capture(() => request.promise);
  session.stop();
  const late = stream();
  request.resolve(late);
  assert.equal(await acquisition, null);
  assert.equal(session.stream, null);
  assert.equal(late.releases, 1);
  assert.deepEqual(
    late.tracks.map((track) => track.stops),
    [1, 1],
  );
});

test("stale capture never releases a newer preview or allows overlapping acquisition", async () => {
  const session = new NativeLiveSession<ReturnType<typeof stream>>();
  const old = deferred<ReturnType<typeof stream>>();
  const fresh = deferred<ReturnType<typeof stream>>();
  const obsolete = session.capture(() => old.promise);
  await assert.rejects(
    session.capture(async () => stream()),
    /already active/,
  );
  session.stop();
  const current = session.capture(() => fresh.promise);
  old.resolve(stream());
  assert.equal(await obsolete, null);
  await assert.rejects(
    session.capture(async () => stream()),
    /already active/,
  );
  const active = stream();
  fresh.resolve(active);
  assert.equal(await current, active);
  assert.equal(session.stream, active);
  assert.equal(active.releases, 0);
});

test("partial native permission grant is rejected and all acquired handles released", async () => {
  for (const kinds of [["video"], ["audio"], []]) {
    const session = new NativeLiveSession<ReturnType<typeof stream>>();
    const partial = stream(kinds);
    await assert.rejects(
      session.capture(async () => partial),
      /Both camera and microphone/,
    );
    assert.equal(session.stream, null);
    assert.equal(partial.releases, 1);
    assert.ok(partial.tracks.every((track) => track.stops === 1));
    assert.ok(await session.capture(async () => stream()));
    session.stop();
  }
});

test("mute changes only audio; repeated stop aborts transport and closes native handles once", async () => {
  const session = new NativeLiveSession<ReturnType<typeof stream>>();
  const capture = stream();
  await session.capture(async () => capture);
  const abort = new AbortController();
  session.abort = abort;
  let closes = 0;
  session.peer = {
    close() {
      closes++;
    },
  };
  session.mute(true);
  assert.deepEqual(
    capture.tracks.map((track) => track.enabled),
    [false, true],
  );
  session.mute(false);
  assert.deepEqual(
    capture.tracks.map((track) => track.enabled),
    [true, true],
  );
  session.stop();
  session.stop();
  assert.equal(abort.signal.aborted, true);
  assert.equal(closes, 1);
  assert.equal(capture.releases, 1);
  assert.deepEqual(
    capture.tracks.map((track) => track.stops),
    [1, 1],
  );
});

test("camera cleanup still runs if the native peer is already disposed", async () => {
  const session = new NativeLiveSession<ReturnType<typeof stream>>();
  const capture = stream();
  await session.capture(async () => capture);
  session.peer = {
    close() {
      throw new Error("disposed");
    },
  };
  assert.doesNotThrow(() => session.stop());
  assert.equal(capture.releases, 1);
  assert.equal(session.peer, null);
});

test("WHIP discovery never follows a redirect to an unapproved host or sends account credentials", async () => {
  const endpoint = "https://playback.livepeer.studio/webrtc/owner-test-stream";
  const calls: string[] = [];
  await assert.rejects(
    discoverNativeWhipEdge(
      endpoint,
      new AbortController().signal,
      async (url, init) => {
        calls.push(url);
        assert.equal(init.redirect, "manual");
        assert.equal(init.credentials, "omit");
        assert.deepEqual(Object.keys(init).sort(), [
          "credentials",
          "method",
          "redirect",
          "signal",
        ]);
        return {
          status: 307,
          headers: new Headers({
            location: "https://attacker.example/webrtc/owner-test-stream",
          }),
        };
      },
    ),
    /unsupported broadcast edge/,
  );
  assert.deepEqual(calls, [endpoint]);
});

test("WHIP discovery accepts approved regional edges, bounds loops and respects aborts", async () => {
  const endpoint = "https://playback.livepeer.studio/webrtc/owner-test-stream";
  const edge =
    "https://nyc-prod-catalyst-0.lp-playback.studio/webrtc/video+owner-test-stream";
  const result = await discoverNativeWhipEdge(
    endpoint,
    new AbortController().signal,
    async (url) => ({
      status: url === endpoint ? 307 : 200,
      headers: new Headers(url === endpoint ? { location: edge } : {}),
    }),
  );
  assert.equal(result.toString(), edge);
  let requests = 0;
  await assert.rejects(
    discoverNativeWhipEdge(endpoint, new AbortController().signal, async () => {
      requests++;
      return { status: 307, headers: new Headers({ location: endpoint }) };
    }),
    /Too many/,
  );
  assert.equal(requests, 4);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    discoverNativeWhipEdge(endpoint, abort.signal, async () => {
      throw new Error("Unexpected network request");
    }),
    /cancelled/,
  );
});
