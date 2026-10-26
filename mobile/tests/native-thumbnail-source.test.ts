import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeThumbnailSourceTimeoutMs,
  prepareNativeThumbnailSource,
  type NativeThumbnailFetcher,
} from "../src/lib/native-thumbnail-source.ts";
import type { VideoSource } from "expo-video";

const origins = ["https://api.ziipa.test", "http://127.0.0.1:8018"];
const uri = `${origins[0]}/api/creator/media/11111111-1111-4111-8111-111111111111`;
const signed = `https://account.r2.cloudflarestorage.com/private/video.mp4?X-Amz-Signature=${"a".repeat(64)}`;
const source = {
  uri,
  headers: { Authorization: "Bearer fixture.token" },
  useCaching: false,
};
const freshSignal = () => new AbortController().signal;

function fixture(
  options: {
    url?: string;
    status?: number;
    headers?: Record<string, string>;
    chunks?: Uint8Array[];
    neverFinish?: boolean;
  } = {},
) {
  let cancelCalls = 0;
  const chunks = [...(options.chunks || [new Uint8Array([7])])];
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks.length) controller.enqueue(chunks.shift()!);
        else if (!options.neverFinish) controller.close();
      },
      cancel() {
        cancelCalls++;
      },
    }),
    {
      status: options.status || 206,
      headers: {
        "content-range": "bytes 0-0/4000",
        "content-type": "video/mp4",
        ...options.headers,
      },
    },
  );
  Object.defineProperty(response, "url", { value: options.url || signed });
  const requests: Request[] = [];
  const fetcher: NativeThumbnailFetcher = async (url, init) => {
    requests.push(new Request(url, init));
    return response;
  };
  return { response, fetcher, requests, canceled: () => cancelCalls };
}

test("protected source resolves a one-byte streaming response into an uncached signed source without account headers", async () => {
  const f = fixture();
  const result = await prepareNativeThumbnailSource(
    source,
    freshSignal(),
    f.fetcher,
    origins,
  );
  assert.deepEqual(result, { uri: signed, useCaching: false });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].headers.get("range"), "bytes=0-0");
  assert.equal(
    f.requests[0].headers.get("authorization"),
    "Bearer fixture.token",
  );
  assert.equal(f.requests[0].credentials, "omit");
  assert.equal(f.requests[0].redirect, "follow");
  assert.equal("headers" in (result as object), false);
  assert.equal(f.response.bodyUsed, true);
});

test("a same-source private range response preserves its original authorized source", async () => {
  const f = fixture({ url: uri, headers: { "content-length": "1" } });
  assert.equal(
    await prepareNativeThumbnailSource(
      source,
      freshSignal(),
      f.fetcher,
      origins,
    ),
    source,
  );
});

test("bundled and local URI sources do no network work", async () => {
  const fetcher: NativeThumbnailFetcher = async () => {
    throw new Error("Unexpected request");
  };
  for (const local of [
    27,
    "file:///data/private.mp4",
    { uri: "content://media/video/9" },
    null,
  ] as VideoSource[])
    assert.equal(
      await prepareNativeThumbnailSource(
        local,
        freshSignal(),
        fetcher,
        origins,
      ),
      local,
    );
});

test("untrusted media, credential URLs and malformed authorization fail before transmitting", async () => {
  const cases: VideoSource[] = [
    { ...source, uri: uri.replace("api.ziipa.test", "outside.test") },
    { ...source, uri: uri.replace("https://", "https://user:pass@") },
    { ...source, uri: `${uri}?token=private` },
    { ...source, uri: `${uri}#fragment` },
    { ...source, uri: uri.replace("/media/", "/profile-images/") },
    { uri },
    {
      ...source,
      headers: { Authorization: "Bearer fixture\r\nSecret: value" },
    },
    { ...source, headers: { Authorization: "Basic fixture" } },
    {
      ...source,
      headers: { Authorization: "Bearer fixture", Cookie: "session=fixture" },
    },
  ];
  for (const candidate of cases) {
    const f = fixture();
    await assert.rejects(
      prepareNativeThumbnailSource(
        candidate,
        freshSignal(),
        f.fetcher,
        origins,
      ),
    );
    assert.equal(f.requests.length, 0);
  }
});

test("redirect destination cannot downgrade, leak credentials or escape signed R2", async () => {
  for (const url of [
    signed.replace("https://", "http://"),
    signed.replace(
      "account.r2.cloudflarestorage.com",
      "account.r2.cloudflarestorage.com.evil.test",
    ),
    signed.replace(
      "account.r2.cloudflarestorage.com",
      "r2.cloudflarestorage.com",
    ),
    signed.replace("https://", "https://user:pass@"),
    signed.replace(".com/", ".com:443/"),
    `${signed}#private`,
    signed.replace("X-Amz-Signature", "other"),
    `${signed}&X-Amz-Signature=${"b".repeat(64)}`,
    uri.replace(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ),
  ]) {
    const f = fixture({ url });
    await assert.rejects(
      prepareNativeThumbnailSource(source, freshSignal(), f.fetcher, origins),
    );
    assert.equal(f.canceled(), 1);
  }
});

test("full-body, invalid range and non-video responses are canceled without reading media", async () => {
  const cases: Parameters<typeof fixture>[0][] = [
    { status: 200 },
    { status: 401 },
    { headers: { "content-range": "bytes 0-1/4000" } },
    { headers: { "content-range": "bytes 0-0/*" } },
    { headers: { "content-range": "bytes 0-0/0" } },
    { headers: { "content-type": "application/json" } },
    { headers: { "content-length": "4000" } },
  ];
  for (const options of cases) {
    const f = fixture(options);
    await assert.rejects(
      prepareNativeThumbnailSource(source, freshSignal(), f.fetcher, origins),
    );
    assert.equal(f.canceled(), 1);
    assert.equal(f.response.bodyUsed, true);
  }
});

test("streaming limits reject oversized chunks, extra chunks and empty bodies", async () => {
  for (const chunks of [
    [new Uint8Array([1, 2])],
    [new Uint8Array([1]), new Uint8Array([2])],
    [],
  ]) {
    const f = fixture({ chunks });
    await assert.rejects(
      prepareNativeThumbnailSource(source, freshSignal(), f.fetcher, origins),
    );
  }
});

test("an already aborted owner starts no request, including a local source", async () => {
  const owner = new AbortController();
  owner.abort();
  const f = fixture();
  await assert.rejects(
    prepareNativeThumbnailSource(source, owner.signal, f.fetcher, origins),
    { name: "AbortError" },
  );
  await assert.rejects(
    prepareNativeThumbnailSource(27, owner.signal, f.fetcher, origins),
    { name: "AbortError" },
  );
  assert.equal(f.requests.length, 0);
});

test("native fetch errors never expose an authenticated URL or header", async () => {
  await assert.rejects(
    prepareNativeThumbnailSource(
      source,
      freshSignal(),
      async () => {
        throw new Error(`${signed} Authorization: Bearer fixture.token`);
      },
      origins,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Native thumbnail source unavailable" &&
      !JSON.stringify(error).includes("fixture.token"),
  );
});

test("owner abort cancels a pending body and cannot publish a late capability", async () => {
  const owner = new AbortController();
  const f = fixture({ neverFinish: true });
  const pending = prepareNativeThumbnailSource(
    source,
    owner.signal,
    f.fetcher,
    origins,
  );
  while (!f.response.bodyUsed) await Promise.resolve();
  owner.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.canceled(), 1);
  assert.equal(f.requests[0].signal.aborted, true);
});

test("late fetch responses after owner abort are canceled even if fetch ignores abort", async () => {
  const owner = new AbortController();
  const f = fixture();
  let finish!: (response: Response) => void;
  let fetched = false;
  const fetcher: NativeThumbnailFetcher = async () => {
    fetched = true;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  };
  const pending = prepareNativeThumbnailSource(
    source,
    owner.signal,
    fetcher,
    origins,
  );
  while (!fetched) await Promise.resolve();
  owner.abort();
  await assert.rejects(pending, { name: "AbortError" });
  finish(f.response);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.canceled(), 1);
});

test("five-second deadline rejects non-cooperative requests and aborts their signal", async () => {
  const realTimeout = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let expire!: () => void;
  let requestedSignal!: AbortSignal;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    assert.equal(ms, nativeThumbnailSourceTimeoutMs);
    expire = fn;
    return 1;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
  try {
    const pending = prepareNativeThumbnailSource(
      source,
      freshSignal(),
      async (_url, init) => {
        requestedSignal = init.signal;
        return new Promise(() => undefined);
      },
      origins,
    );
    await Promise.resolve();
    expire();
    await assert.rejects(pending, { name: "TimeoutError" });
    assert.equal(requestedSignal.aborted, true);
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.clearTimeout = realClear;
  }
});
