import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const media = {
  id: "owned-media",
  url: "/api/creator/media/owned-media",
  content_type: "video/mp4",
};
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const file = {
  uri: "file:///owned.mp4",
  name: "owned.mp4",
  mimeType: "video/mp4",
  size: 100,
};

/** Execute the real API and deadline modules; only native/browser transports and time are replaced. */
function harness(
  platform: "native" | "web",
  options: {
    portal?: boolean;
    fetch?: (url: string, init?: any) => Promise<any>;
    upload?: () => Promise<any>;
    cancel?: () => unknown;
  } = {},
) {
  let now = 0,
    nextTimer = 0,
    cancellations = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: { url: string; init?: any }[] = [];
  let progress: ((event: any) => void) | undefined;
  const clock = {
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
    },
  };
  function evaluate(path: string, require: (name: string) => unknown) {
    const exported: Record<string, any> = {};
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    new Function(
      "exports",
      "require",
      "fetch",
      "setTimeout",
      "clearTimeout",
      "AbortController",
      compiled,
    )(
      exported,
      require,
      async (url: string, init?: any) => {
        calls.push({ url, init });
        if (options.fetch) return options.fetch(url, init);
        if (url.startsWith("blob:"))
          return { blob: async () => ({ size: 100 }) };
        if (url.endsWith("/presign"))
          return response({
            id: media.id,
            mode: "direct",
            url: "https://owned-storage.example/upload",
            headers: { "Content-Type": "video/mp4" },
          });
        if (url === "https://owned-storage.example/upload")
          return response(null);
        return response(media);
      },
      clock.setTimeout,
      clock.clearTimeout,
      AbortController,
    );
    return exported;
  }
  const deadline = evaluate("../src/lib/request-deadline.ts", () => {
    throw new Error("Unexpected deadline dependency");
  });
  const api = evaluate(
    `../src/lib/api${platform === "web" ? ".web" : ""}.ts`,
    (name) => {
      if (name === "./request-deadline") return deadline;
      if (name === "./config")
        return {
          portalMode: !!options.portal,
          validateOrigin: () => "https://api.ziipa.test",
          authorizationHeaders: (token?: string) =>
            token && !options.portal
              ? { Authorization: `Bearer ${token}` }
              : {},
        };
      if (name === "expo-secure-store") return {};
      if (name === "expo-file-system/legacy")
        return {
          FileSystemUploadType: { BINARY_CONTENT: 0 },
          FileSystemSessionType: { FOREGROUND: 0 },
          createUploadTask(
            url: string,
            _uri: string,
            init: unknown,
            callback: typeof progress,
          ) {
            calls.push({ url, init });
            progress = callback;
            return {
              uploadAsync:
                options.upload ||
                (() => Promise.resolve({ status: 200, body: "" })),
              cancelAsync() {
                cancellations++;
                return options.cancel?.();
              },
            };
          },
        };
      throw new Error(`Unexpected API dependency ${name}`);
    },
  );
  return {
    api,
    deadline,
    calls,
    clock,
    timers,
    progress: (sent: number) =>
      progress?.({ totalBytesSent: sent, totalBytesExpectedToSend: 100 }),
    cancellations: () => cancellations,
  };
}

for (const platform of ["native", "web"] as const) {
  test(`${platform}: request settles when fetch ignores abort and never replays a write`, async () => {
    const held = deferred();
    const h = harness(platform, { fetch: () => held.promise });
    const pending = h.api.request("/api/creator/items", "owner-token", {
      title: "Owned",
    });
    const rejected = assert.rejects(
      pending,
      (error: any) =>
        error instanceof h.api.ApiRequestError &&
        error.outcome === "unconfirmed" &&
        error.timedOut,
    );
    await flush();
    h.clock.advance(30000);
    await rejected;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].init.signal.aborted, true);
    let bodyReads = 0;
    held.resolve({
      ...response(media),
      json: async () => {
        bodyReads++;
        return media;
      },
    });
    await flush();
    assert.equal(bodyReads, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
  });

  test(`${platform}: response body is inside the deadline and malformed successful writes remain unconfirmed`, async () => {
    const h = harness(platform, {
      fetch: async () => ({
        ...response(null),
        json: () => deferred().promise,
      }),
    });
    const pending = h.api.request("/api/creator/items", "owner-token", {});
    const rejected = assert.rejects(
      pending,
      (error: any) => error.outcome === "unconfirmed" && error.timedOut,
    );
    await flush();
    h.clock.advance(30000);
    await rejected;
    const malformed = harness(platform, {
      fetch: async () => ({
        ...response(null),
        json: async () => {
          throw new Error("private response body");
        },
      }),
    });
    await assert.rejects(
      malformed.api.request("/api/creator/items", "owner-token", {}),
      (error: any) =>
        error.outcome === "unconfirmed" &&
        !error.message.includes("private response body"),
    );
  });

  test(`${platform}: known HTTP failures retain status even if their body stalls`, async () => {
    const h = harness(platform, {
      fetch: async () => ({
        ...response(null, 401),
        json: () => deferred().promise,
      }),
    });
    const pending = h.api.request("/api/me", "owner-token");
    const rejected = assert.rejects(
      pending,
      (error: any) => error instanceof h.api.ApiError && error.status === 401,
    );
    await flush();
    h.clock.advance(30000);
    await rejected;
    const rejectedWrite = harness(platform, {
      fetch: async () =>
        response({ detail: "Upload media before publishing." }, 422),
    });
    await assert.rejects(
      rejectedWrite.api.request("/api/creator/items", "owner-token", {}),
      (error: any) =>
        error instanceof rejectedWrite.api.ApiError &&
        error.status === 422 &&
        error.message === "Upload media before publishing.",
    );
  });

  test(`${platform}: read failures are unavailable, write failures unconfirmed, raw details stay private`, async () => {
    const h = harness(platform, {
      fetch: async () => {
        throw new Error("private signed-url credentials");
      },
    });
    await assert.rejects(
      h.api.request("/api/me", "owner-token"),
      (error: any) =>
        error.outcome === "unavailable" &&
        !error.timedOut &&
        !error.message.includes("credentials"),
    );
    await assert.rejects(
      h.api.request("/api/creator/items", "owner-token", {}),
      (error: any) =>
        error.outcome === "unconfirmed" &&
        !error.timedOut &&
        /may have completed/.test(error.message),
    );
    assert.equal(h.calls.length, 2);
    assert.equal(h.timers.size, 0);
  });

  test(`${platform}: metadata retains its longer deadline and normal completion clears timers`, async () => {
    const h = harness(platform, { fetch: () => deferred().promise });
    const pending = h.api.request("/api/web3/metadata", "owner-token", {});
    const rejected = assert.rejects(pending, (error: any) => error.timedOut);
    await flush();
    h.clock.advance(30000);
    assert.equal(h.calls[0].init.signal.aborted, false);
    h.clock.advance(90000);
    await rejected;
    const normal = harness(platform);
    assert.deepEqual(await normal.api.request("/api/me", "owner-token"), media);
    assert.equal(normal.timers.size, 0);
  });
}

for (const cancelKind of [
  "resolves",
  "rejects",
  "throws",
  "never settles",
] as const) {
  test(`native: stalled upload settles even when cancellation ${cancelKind}`, async () => {
    const held = deferred();
    const h = harness("native", {
      upload: () => held.promise,
      cancel: () => {
        if (cancelKind === "rejects")
          return Promise.reject(new Error("private cancellation details"));
        if (cancelKind === "throws")
          throw new Error("private cancellation details");
        if (cancelKind === "never settles") return deferred().promise;
      },
    });
    const progress: number[] = [];
    const pending = h.api.uploadMedia(file, "owner-token", (value: number) =>
      progress.push(value),
    );
    const rejected = assert.rejects(
      pending,
      (error: any) =>
        error instanceof h.deadline.OperationTimeoutError &&
        /not submitted a creation/.test(error.message),
    );
    await flush();
    h.progress(25);
    h.clock.advance(180000);
    await rejected;
    assert.equal(h.cancellations(), 1);
    h.progress(100);
    held.resolve({ status: 200, body: "" });
    await flush();
    assert.deepEqual(progress, [25]);
    assert.equal(
      h.calls.filter((call) => call.url.endsWith("/complete")).length,
      0,
    );
    assert.equal(h.timers.size, 0);
  });
}

test("native: successful direct upload completes once, keeps bearer off storage and ignores late progress", async () => {
  const h = harness("native");
  const progress: number[] = [];
  assert.deepEqual(
    await h.api.uploadMedia(file, "owner-token", (value: number) =>
      progress.push(value),
    ),
    media,
  );
  h.progress(75);
  assert.deepEqual(progress, [100]);
  assert.equal(h.cancellations(), 0);
  assert.equal(h.calls[1].init.headers.Authorization, undefined);
  assert.equal(h.calls[1].init.httpMethod, "PUT");
  assert.equal(h.calls[2].url.endsWith("/complete"), true);
  assert.equal(h.calls[2].init.headers.Authorization, "Bearer owner-token");
  assert.equal(h.timers.size, 0);
});

test("native: API upload returns its acknowledgement without a completion call; malformed storage errors keep HTTP status", async () => {
  const h = harness("native", {
    fetch: async () => response({ mode: "api", headers: {} }),
    upload: async () => ({ status: 201, body: JSON.stringify(media) }),
  });
  assert.deepEqual(
    await h.api.uploadMedia(file, "owner-token", () => {}),
    media,
  );
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].init.headers.Authorization, "Bearer owner-token");
  const bad = harness("native", {
    upload: async () => ({
      status: 403,
      body: "<Error>private storage details</Error>",
    }),
  });
  await assert.rejects(
    bad.api.uploadMedia(file, "owner-token", () => {}),
    (error: any) =>
      error instanceof bad.api.ApiError &&
      error.status === 403 &&
      !error.message.includes("private"),
  );
  assert.equal(bad.calls.length, 2);
});

test("native: failed transfer or missing upload acknowledgement cannot advance into completion", async () => {
  const rejected = harness("native", {
    upload: async () => ({ status: 307, body: "" }),
  });
  await assert.rejects(
    rejected.api.uploadMedia(file, "owner-token", () => {}),
    (error: any) =>
      error instanceof rejected.api.ApiError && error.status === 307,
  );
  assert.equal(rejected.calls.length, 2);
  const missing = harness("native", {
    fetch: async () => response({ mode: "api", headers: {} }),
    upload: async () => ({ status: 201, body: "not JSON" }),
  });
  await assert.rejects(
    missing.api.uploadMedia(file, "owner-token", () => {}),
    /did not confirm the uploaded file/,
  );
  assert.equal(missing.calls.length, 2);
});

for (const stall of [
  "file fetch",
  "file body",
  "storage fetch",
  "storage body",
] as const) {
  test(`web: ${stall} cannot hang or continue into a later upload stage after its deadline`, async () => {
    const held = deferred();
    const h = harness("web", {
      fetch: async (url) => {
        if (url.startsWith("blob:")) {
          if (stall === "file fetch") return held.promise;
          return {
            blob: () =>
              stall === "file body"
                ? held.promise
                : Promise.resolve({ size: 100 }),
          };
        }
        if (url.endsWith("/presign"))
          return response({
            id: media.id,
            mode: "direct",
            url: "https://owned-storage.example/upload",
            headers: {},
          });
        if (stall === "storage fetch") return held.promise;
        return { ...response(null), json: () => held.promise };
      },
    });
    const progress: number[] = [];
    const pending = h.api.uploadMedia(
      { ...file, uri: "blob:owned" },
      "owner-token",
      (value: number) => progress.push(value),
    );
    const rejected = assert.rejects(
      pending,
      (error: any) => error instanceof h.deadline.OperationTimeoutError,
    );
    await flush();
    h.clock.advance(stall.startsWith("file") ? 30000 : 180000);
    await rejected;
    const before = h.calls.length;
    held.resolve(
      stall === "file body"
        ? { size: 100 }
        : stall === "storage body"
          ? null
          : { ...response(null), blob: async () => ({ size: 100 }) },
    );
    await flush();
    assert.equal(h.calls.length, before);
    assert.equal(
      h.calls.some((call) => call.url.endsWith("/complete")),
      false,
    );
    assert.deepEqual(progress, [0]);
    assert.equal(h.timers.size, 0);
  });
}

test("web: direct and same-origin API uploads preserve portal cookie/bearer boundaries", async () => {
  const direct = harness("web", { portal: true });
  assert.deepEqual(
    await direct.api.uploadMedia(
      { ...file, uri: "blob:owned" },
      "portal-marker",
      () => {},
    ),
    media,
  );
  assert.equal(direct.calls[1].init.credentials, "include");
  assert.equal(direct.calls[2].init.credentials, "omit");
  assert.equal(direct.calls[2].init.headers.Authorization, undefined);
  assert.equal(direct.calls[3].init.credentials, "include");
  const api = harness("web", {
    portal: true,
    fetch: async (url) => {
      if (url.startsWith("blob:")) return { blob: async () => ({ size: 100 }) };
      if (url.endsWith("/presign"))
        return response({ mode: "api", headers: {} });
      return response(media, 201);
    },
  });
  assert.deepEqual(
    await api.api.uploadMedia(
      { ...file, uri: "blob:owned" },
      "portal-marker",
      () => {},
    ),
    media,
  );
  assert.equal(api.calls.length, 3);
  assert.equal(api.calls[2].init.credentials, "include");
  assert.equal(api.calls[2].init.headers.Authorization, undefined);
});
