import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedSdp,
  checkedIngest,
  checkedLivepeerEdge,
  checkedLivePlayback,
  checkedWhipUrl,
  liveStatusLabel,
  verifiedLive,
} from "../src/lib/live-types.ts";

test("only fresh server-confirmed incoming media is labeled LIVE", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const value = {
    live: true,
    status: "live" as const,
    checked_at: "2026-09-09T11:59:55Z",
  };
  assert.equal(verifiedLive(value, now), true);
  assert.match(liveStatusLabel(value, now), /^LIVE/);
  assert.equal(
    verifiedLive({ ...value, checked_at: "2026-09-09T11:59:39Z" }, now),
    false,
  );
  assert.equal(
    verifiedLive({ ...value, checked_at: "2026-09-09T13:00:00Z" }, now),
    false,
  );
  assert.equal(verifiedLive({ ...value, checked_at: null }, now), false);
  assert.equal(
    verifiedLive({ ...value, status: "awaiting_media" }, now),
    false,
  );
  assert.equal(verifiedLive({ ...value, live: false }, now), false);
});

test("WHIP input only accepts the official stream-key endpoint", () => {
  const good = "https://playback.livepeer.studio/webrtc/private-key123";
  assert.equal(checkedWhipUrl(good), good);
  for (const url of [
    "http://playback.livepeer.studio/webrtc/private-key123",
    good + "?secret=true",
    good + "#x",
    "https://evil.test/webrtc/private-key123",
    "https://playback.livepeer.studio.evil.test/webrtc/private-key123",
    good.replace("private-key123", "../private-key123"),
    null,
  ])
    assert.throws(() => checkedWhipUrl(url));
});

test("discovered media edges require an approved HTTPS Livepeer hostname", () => {
  assert.equal(
    checkedLivepeerEdge(
      "https://nyc-prod-catalyst-0.lp-playback.studio:443/webrtc/video+testkey123",
    ).hostname,
    "nyc-prod-catalyst-0.lp-playback.studio",
  );
  assert.equal(
    checkedLivepeerEdge("https://edge.livepeer.studio/webrtc/video+key123")
      .hostname,
    "edge.livepeer.studio",
  );
  for (const url of [
    "https://livepeer.studio.evil.test/ingest",
    "https://user:pass@livepeer.studio/ingest",
    "https://127.0.0.1/ingest",
    "http://edge.livepeer.studio/ingest",
    "https://livepeer.studio:8000/ingest",
  ])
    assert.throws(() => checkedLivepeerEdge(url));
});

test("ingest configuration must belong to the selected broadcast and match its key", () => {
  const value = {
    stream_id: "broadcast-one",
    whip_url: "https://playback.livepeer.studio/webrtc/private-key123",
    stream_key: "private-key123",
    rtmp_server: "rtmp://rtmp.livepeer.studio/live",
    detail: "Secret",
  };
  assert.equal(checkedIngest(value, "broadcast-one"), value);
  assert.throws(() => checkedIngest(value, "broadcast-two"));
  assert.throws(() =>
    checkedIngest({ ...value, stream_key: "another-key456" }, "broadcast-one"),
  );
  assert.throws(() =>
    checkedIngest(
      { ...value, rtmp_server: "rtmp://evil.test/live" },
      "broadcast-one",
    ),
  );
});

test("public playback cannot target arbitrary, credential-bearing or local sources", () => {
  const good = "https://livepeercdn.studio/hls/public123/index.m3u8";
  assert.equal(checkedLivePlayback(good), good);
  for (const url of [
    "http://livepeercdn.studio/hls/a.m3u8",
    "https://evil.test/a.m3u8",
    good + "?token=abc",
    "https://user:secret@livepeercdn.studio/a.m3u8",
    "file:///a.m3u8",
    "blob:https://localhost/a",
    "https://livepeercdn.studio/../private.m3u8",
  ])
    assert.equal(checkedLivePlayback(url), null);
});

test("SDP answer is size-bounded, typed, and never returns provider error text", async () => {
  const valid = "v=0\r\ns=Livepeer\r\n";
  assert.equal(
    await boundedSdp(
      new Response(valid, { headers: { "Content-Type": "application/sdp" } }),
    ),
    valid,
  );
  await assert.rejects(
    () => boundedSdp(new Response("secret-stream-key", { status: 403 })),
    (error: Error) => !error.message.includes("secret-stream-key"),
  );
  await assert.rejects(
    () =>
      boundedSdp(
        new Response("v=0" + "a".repeat(256 * 1024), {
          headers: { "Content-Type": "application/sdp" },
        }),
      ),
    /oversized/,
  );
  await assert.rejects(
    () =>
      boundedSdp(
        new Response("not-sdp", {
          headers: { "Content-Type": "application/sdp" },
        }),
      ),
    /invalid/,
  );
});
