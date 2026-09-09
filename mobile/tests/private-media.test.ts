import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import {
  privateMediaBlob,
  privateMediaLease,
  privatePlaybackRequest,
} from "../src/lib/private-media.ts";

const id = "209fbea3-2a64-45cc-a656-aeec2f900971";
const path = "/api/creator/media/" + id;
const options = () => ({
  path,
  token: "owner-one-token",
  apiOrigin: "https://api.ziipa.test",
  trustedOrigins: ["https://api.ziipa.test"],
  signal: new AbortController().signal,
});
const media = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "video/mp4", "content-length": "3" },
  });

test("private playback authenticates only the exact trusted owned-media endpoint", () => {
  const request = privatePlaybackRequest(options());
  assert.equal(request.url, "https://api.ziipa.test" + path);
  assert.deepEqual(request.init.headers, {
    Authorization: "Bearer owner-one-token",
  });
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.cache, "no-store");
  for (const bad of [
    "https://evil.test" + path,
    "https://api.ziipa.test.evil.test" + path,
    path + "?token=abc",
    path + "/edit",
    "file:///private.mp4",
    "blob:https://api.ziipa.test/private",
  ])
    assert.throws(() => privatePlaybackRequest({ ...options(), path: bad }));
  assert.throws(() =>
    privatePlaybackRequest({ ...options(), apiOrigin: "https://evil.test" }),
  );
  assert.throws(() =>
    privatePlaybackRequest({
      ...options(),
      token: "ziipa-portal-cookie:1:123",
    }),
  );
});

test("private media bounds actual bytes even when content-length is absent or misleading", async () => {
  const fetcher = async () =>
    new Response(new Uint8Array(9), {
      headers: { "content-type": "video/mp4", "content-length": "1" },
    });
  await assert.rejects(
    () => privateMediaBlob(options(), fetcher as typeof fetch, 8),
    /playback limit/,
  );
  const badType = async () =>
    new Response("secret upstream error", {
      headers: { "content-type": "text/html" },
    });
  await assert.rejects(
    () => privateMediaBlob(options(), badType as typeof fetch),
    (error: Error) => !error.message.includes("secret upstream error"),
  );
  const empty = async () =>
    new Response(new Uint8Array(), {
      headers: { "content-type": "audio/mpeg" },
    });
  await assert.rejects(
    () => privateMediaBlob(options(), empty as typeof fetch),
    /empty/,
  );
});

test("identity/source cancellation aborts pending fetch and revokes its object URL once", async () => {
  const controller = new AbortController();
  let requests = 0;
  let revoked = 0;
  const urls = {
    createObjectURL: () => "blob:owned-private-test",
    revokeObjectURL: () => {
      revoked++;
    },
  } as unknown as typeof URL;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(init?.signal?.aborted, false);
    return media();
  };
  const lease = await privateMediaLease(
    { ...options(), signal: controller.signal },
    fetcher as typeof fetch,
    urls,
  );
  assert.equal(requests, 1);
  controller.abort();
  lease.dispose();
  assert.equal(revoked, 1);
  await assert.rejects(
    () =>
      privateMediaLease(
        { ...options(), signal: controller.signal },
        fetcher as typeof fetch,
        urls,
      ),
    /cancelled/,
  );
  assert.equal(requests, 1);
});

test("late completion after account change never creates a playable object URL", async () => {
  const controller = new AbortController();
  let created = false;
  const fetcher = async () => {
    controller.abort();
    return media();
  };
  const urls = {
    createObjectURL: () => {
      created = true;
      return "blob:wrong-account";
    },
    revokeObjectURL: () => {},
  } as unknown as typeof URL;
  await assert.rejects(
    () =>
      privateMediaLease(
        { ...options(), signal: controller.signal },
        fetcher as typeof fetch,
        urls,
      ),
    /cancelled/,
  );
  assert.equal(created, false);
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
test("real Fetch removes the bearer on an API-to-storage cross-origin redirect", async () => {
  let storageAuthorization: string | undefined;
  let apiAuthorization: string | undefined;
  const storage = createServer((request, response) => {
    storageAuthorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "video/mp4" });
    response.end(new Uint8Array([1, 2, 3]));
  });
  const storageOrigin = await listen(storage);
  const api = createServer((request, response) => {
    apiAuthorization = request.headers.authorization;
    response.writeHead(307, {
      Location: storageOrigin + "/signed-private-video",
    });
    response.end();
  });
  const apiOrigin = await listen(api);
  try {
    const blob = await privateMediaBlob({
      ...options(),
      apiOrigin,
      trustedOrigins: [apiOrigin],
    });
    assert.equal(blob.size, 3);
    assert.equal(apiAuthorization, "Bearer owner-one-token");
    assert.equal(storageAuthorization, undefined);
  } finally {
    await close(api);
    await close(storage);
  }
});
