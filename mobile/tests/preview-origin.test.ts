import assert from "node:assert/strict";
import { test } from "node:test";
import { browserPreviewApiOrigin } from "../src/lib/preview-origin.ts";

const preview = {
  development: true,
  web: true,
  portal: false,
  pageHostname: "localhost",
};
test("local browser previews retain the API port while avoiding a LAN round trip", () => {
  assert.equal(
    browserPreviewApiOrigin("http://192.168.1.101:8018", preview),
    "http://localhost:8018",
  );
  assert.equal(
    browserPreviewApiOrigin("http://10.0.2.2:8018", {
      ...preview,
      pageHostname: "127.0.0.1",
    }),
    "http://127.0.0.1:8018",
  );
  assert.equal(
    browserPreviewApiOrigin("http://172.16.10.3:8018", {
      ...preview,
      pageHostname: "[::1]",
    }),
    "http://[::1]:8018",
  );
  assert.equal(
    browserPreviewApiOrigin("http://127.0.0.1:8018", preview),
    "http://localhost:8018",
  );
});
test("native, release, portal and LAN-browser configurations remain unchanged", () => {
  const configured = "http://192.168.1.101:8018";
  for (const environment of [
    { ...preview, web: false },
    { ...preview, development: false },
    { ...preview, portal: true },
    { ...preview, pageHostname: "192.168.1.101" },
    { ...preview, pageHostname: "ziipa.com" },
  ])
    assert.equal(browserPreviewApiOrigin(configured, environment), configured);
});
test("public, secure and invalid origins are never silently redirected to localhost", () => {
  for (const configured of [
    "https://api.ziipa.com",
    "https://192.168.1.101:8018",
    "http://192.168.1.101.evil.test:8018",
    "http://172.32.0.1:8018",
    "http://192.169.1.1:8018",
    "http://8.8.8.8:8018",
    "http://user:password@192.168.1.101:8018",
    "http://192.168.1.101:8018/path",
    "http://192.168.1.101:8018?redirect=1",
    "invalid",
  ])
    assert.equal(browserPreviewApiOrigin(configured, preview), configured);
});
