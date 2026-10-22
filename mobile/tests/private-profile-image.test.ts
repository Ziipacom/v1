import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { privateProfileImageBlob, privateProfileImageLease, privateProfileImageRequest, trustedProfileImagePath } from "../src/lib/private-profile-image.ts";

const path = "/api/creator/profile-images/209fbea3-2a64-45cc-a656-aeec2f900971";
const options = () => ({ path, token: "owner-session", apiOrigin: "https://api.ziipa.test", trustedOrigins: ["https://api.ziipa.test"], signal: new AbortController().signal });
const image = (type = "image/png") => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": type, "content-length": "4" } });

test("profile image credentials are confined to one exact inline owner route without redirects or cookies", () => {
  const request = privateProfileImageRequest(options());
  assert.equal(request.url, "https://api.ziipa.test" + path);
  assert.deepEqual(request.init.headers, { Authorization: "Bearer owner-session" });
  assert.equal(request.init.credentials, "omit"); assert.equal(request.init.redirect, "error");
  assert.equal(request.init.cache, "no-store"); assert.equal(request.init.referrerPolicy, "no-referrer");
  assert.equal(trustedProfileImagePath(request.url, options().trustedOrigins), path);
  for (const bad of ["https://evil.test" + path, "https://api.ziipa.test.evil.test" + path, path + "?token=abc", path + "/edit", path + "#x", path.replace("profile-images", "media"), "file:///private.png", "blob:owned", "data:image/png;base64,aGVsbG8="])
    assert.throws(() => privateProfileImageRequest({ ...options(), path: bad }));
  for (const token of ["", "ziipa-portal-cookie:1:123", "bearer\nsecret", "x".repeat(257)]) assert.throws(() => privateProfileImageRequest({ ...options(), token }));
  for (const apiOrigin of ["https://evil.test", "https://api.ziipa.test/path", "http://api.ziipa.test", "https://api.ziipa.test?query=1"])
    assert.throws(() => privateProfileImageRequest({ ...options(), apiOrigin }));
});

test("owner image fetch supports only static-image content types and never exposes upstream diagnostics", async () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    const blob = await privateProfileImageBlob(options(), async (_, init) => { assert.equal(init.redirect, "error"); return image(type); });
    assert.equal(blob.type, type); assert.equal(blob.size, 4);
  }
  for (const type of ["image/svg+xml", "image/gif", "video/mp4", "text/html"]) await assert.rejects(
    privateProfileImageBlob(options(), async () => image(type)), /supported static profile image/);
  let calls = 0;
  await assert.rejects(privateProfileImageBlob(options(), async () => { calls++; return new Response("private upstream token must stay hidden", { status: 503 }); }),
    (cause: Error) => !cause.message.includes("token"));
  assert.equal(calls, 1, "failure must not replay requests or downgrade authentication");
});

test("declared and streamed image bytes are bounded even with misleading length", async () => {
  for (const size of ["999999999", "garbage", "0"]) await assert.rejects(privateProfileImageBlob(options(), async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png", "content-length": size } })));
  await assert.rejects(privateProfileImageBlob(options(), async () => new Response(new Uint8Array(9), { headers: { "content-type": "image/png", "content-length": "1" } }), 8), /maximum size/);
  await assert.rejects(privateProfileImageBlob(options(), async () => new Response(new Uint8Array(), { headers: { "content-type": "image/png" } })), /empty/);
  await assert.rejects(privateProfileImageBlob(options(), async () => image(), 10 * 1024 * 1024 + 1));
});

test("redirected or unexpected-origin responses cannot become image blobs", async () => {
  for (const property of ["redirected", "url"] as const) {
    const response = image();
    Object.defineProperty(response, property, { value: property === "redirected" ? true : "https://evil.test/private.png" });
    await assert.rejects(privateProfileImageBlob(options(), async () => response), /unavailable/);
  }
});

test("account/source cancellation aborts fetch and revokes its image object URL exactly once", async () => {
  const controller = new AbortController(); let created = 0, revoked = 0, calls = 0;
  const urls = { createObjectURL: () => { created++; return "blob:private-avatar"; }, revokeObjectURL: () => { revoked++; } };
  const lease = await privateProfileImageLease({ ...options(), signal: controller.signal }, async () => { calls++; return image(); }, urls);
  assert.equal(lease.uri, "blob:private-avatar"); assert.equal(created, 1);
  controller.abort(); lease.dispose(); assert.equal(revoked, 1);
  await assert.rejects(privateProfileImageLease({ ...options(), signal: controller.signal }, async () => { calls++; return image(); }, urls), /canceled/);
  assert.equal(calls, 1); assert.equal(created, 1);
});

test("a late response after sign-out cannot create an image URL", async () => {
  const controller = new AbortController(); let created = 0;
  await assert.rejects(privateProfileImageLease({ ...options(), signal: controller.signal }, async () => { controller.abort(); return image(); },
    { createObjectURL: () => { created++; return "blob:wrong-account"; }, revokeObjectURL: () => {} }), /canceled/);
  assert.equal(created, 0);
});

test("actual web image hook never returns a revoked source when the same account returns to the foreground", async () => {
  const source = readFileSync(new URL("../src/lib/profile-image-source.web.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  // Minimal hook host: render reads state; passive effects run only when flushed.
  // This tests the actual exported hook's visibility handler and pre-effect result.
  const slots: { value?: any; deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const same = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    !!left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
      const index = cursor++, slot = slots[index] ||= {};
      if (!same(slot.deps, deps)) { slot.value = factory(); slot.deps = deps; }
      return slot.value;
    },
    useState: (initial: unknown) => {
      const index = cursor++, slot = slots[index] ||= { value: initial };
      return [slot.value, (next: unknown) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
    },
    useRef: (initial: unknown) => {
      const index = cursor++, slot = slots[index] ||= { value: { current: initial } };
      return slot.value;
    },
    useEffect: (effect: () => (() => void) | void, deps: readonly unknown[]) => {
      const index = cursor++, slot = slots[index] ||= {};
      if (!same(slot.deps, deps)) {
        slot.deps = deps;
        effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; });
      }
    },
  };
  const visibilityListeners = new Set<() => void>();
  const document = {
    visibilityState: "visible",
    addEventListener: (_: string, listener: () => void) => visibilityListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => visibilityListeners.delete(listener),
  };
  let requests = 0;
  const revoked: string[] = [];
  const exported: Record<string, any> = {};
  new Function("exports", "require", "document", compiled)(exported, (name: string) => {
    if (name === "react") return react;
    if (name === "./assets") return { localImages: {}, coverSource: (uri: string) => ({ uri }) };
    if (name === "./config") return { apiOrigin: "https://api.ziipa.test", canonicalApiOrigin: "https://api.ziipa.test", portalMode: false };
    if (name === "./private-profile-image") return {
      trustedProfileImagePath,
      privateProfileImageLease: async () => {
        const uri = `blob:profile-${++requests}`; let disposed = false;
        return { uri, dispose: () => { if (!disposed) { disposed = true; revoked.push(uri); } } };
      },
    };
    throw new Error(`Unexpected hook dependency ${name}`);
  }, document);
  const render = (token = "owner-session") => {
    cursor = 0;
    return exported.useProfileImageSource(path, token);
  };
  const flushEffects = () => { const pending = effects; effects = []; for (const effect of pending) effect(); };
  const visibility = (value: string) => { document.visibilityState = value; for (const listener of visibilityListeners) listener(); };
  try {
    assert.equal(render(), null); flushEffects(); await Promise.resolve();
    assert.deepEqual(render(), { uri: "blob:profile-1" });
    visibility("hidden"); assert.equal(render(), null); flushEffects();
    assert.deepEqual(revoked, ["blob:profile-1"]);
    visibility("visible");
    assert.equal(render(), null, "The first foreground render must not reuse the revoked URL before passive effects run.");
    flushEffects(); await Promise.resolve();
    assert.deepEqual(render(), { uri: "blob:profile-2" });
    assert.equal(render("different-account"), null, "Account changes mask old image data synchronously.");
  } finally {
    for (const slot of slots) slot.cleanup?.();
  }
});
