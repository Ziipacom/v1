import assert from "node:assert/strict";
import test from "node:test";
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
