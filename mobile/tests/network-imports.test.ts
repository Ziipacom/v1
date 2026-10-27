import assert from "node:assert/strict";
import test from "node:test";
import { emptyNetworkHub } from "../src/lib/network-hub.ts";
import {
  importAuthorizationUrl,
  importPortalUrl,
  importTargets,
  importTargetInput,
  readImportConnect,
} from "../src/lib/network-imports.ts";

const origin = "https://api.ziipa.com";
const ticket = "A".repeat(54);
const authorize = (provider = "facebook") =>
  `${origin}/api/social/oauth/${provider}/authorize?ticket=${ticket}`;

test("read consent launches only a canonical Ziipa one-time ticket for the selected provider", () => {
  for (const provider of ["facebook", "instagram", "tiktok"] as const)
    assert.equal(
      importAuthorizationUrl(provider, authorize(provider), origin),
      authorize(provider),
    );
  assert.equal(
    importAuthorizationUrl(
      "facebook",
      authorize().replace(origin, "https://ziipa.com"),
      origin,
    ),
    authorize().replace(origin, "https://ziipa.com"),
  );
  for (const value of [
    authorize("instagram"),
    authorize() + "&next=https://evil.test",
    authorize() + "&ticket=" + ticket,
    authorize() + "#fragment",
    authorize().replace(ticket, "short"),
    authorize().replace("api.ziipa.com", "api.ziipa.com.evil.test"),
    authorize().replace("https://", "https://secret@"),
    authorize().replace("https://", "http://"),
    "https://www.facebook.com/dialog/oauth?client_id=x",
    "https://api.ziipa.com/api/social/oauth/facebook/callback?ticket=" + ticket,
  ])
    assert.throws(() => importAuthorizationUrl("facebook", value, origin));
  assert.throws(() =>
    importAuthorizationUrl("youtube", authorize("youtube"), origin),
  );
});

test("native handoff is exactly the Ziipa portal and loopback requires explicit development context", () => {
  assert.equal(
    importPortalUrl("https://ziipa.com/portal"),
    "https://ziipa.com/portal",
  );
  for (const value of [
    "https://evil.test/portal",
    "https://ziipa.com/portal?token=secret",
    "https://ziipa.com/portal#x",
    "https://user:pass@ziipa.com/portal",
    "https://ziipa.com/studio/",
    "http://ziipa.com/portal",
  ])
    assert.throws(() => importPortalUrl(value));
  assert.throws(() =>
    importPortalUrl("http://127.0.0.1:5178/portal", "http://127.0.0.1:5178"),
  );
  assert.equal(
    importPortalUrl(
      "http://127.0.0.1:5178/portal",
      "http://127.0.0.1:5178",
      true,
    ),
    "http://127.0.0.1:5178/portal",
  );
});

test("readiness distinguishes setup, browser consent and native portal handoff without connected state", () => {
  const setup = {
    status: "setup_required",
    auth_url: null,
    detail: "Enable reviewed read permissions",
    requirements: ["Read scope"],
  };
  assert.equal(readImportConnect(setup).status, "setup_required");
  assert.equal(
    readImportConnect({
      ...setup,
      status: "authorization_required",
      auth_url: authorize(),
    }).status,
    "authorization_required",
  );
  assert.equal(
    readImportConnect({
      ...setup,
      status: "browser_sign_in_required",
      connect_via_portal: "https://ziipa.com/portal",
    }).status,
    "browser_sign_in_required",
  );
  for (const invalid of [
    { ...setup, status: "connected" },
    { ...setup, auth_url: authorize() },
    { ...setup, status: "authorization_required" },
    { ...setup, status: "browser_sign_in_required" },
    { ...setup, requirements: [{ secret: "not text" }] },
  ])
    assert.throws(() => readImportConnect(invalid));
});

test("target selection uses only a current server choice and revision, never a profile shortcut or arbitrary target", () => {
  const account = emptyNetworkHub().providers.find(
    (row) => row.provider === "facebook",
  )!;
  Object.assign(account, {
    status: "connected",
    auth_type: "oauth",
    revision: "a39a0bde-a91e-4e5b-a58d-8348460db961",
    import_targets: [
      {
        id: "123",
        name: "Creator Page",
        kind: "page",
        url: "https://www.facebook.com/123",
      },
    ],
  });
  assert.equal(importTargets(account)[0].name, "Creator Page");
  assert.deepEqual(importTargetInput(account, "123"), {
    target_id: "123",
    revision: account.revision,
  });
  assert.throws(() => importTargetInput(account, "foreign"));
  assert.throws(() => importTargetInput({ ...account, revision: null }, "123"));
  assert.deepEqual(
    importTargets({
      ...account,
      status: "linked",
      auth_type: "public_profile",
    }),
    [],
  );
  assert.throws(() =>
    importTargets({
      ...account,
      import_targets: [...account.import_targets!, ...account.import_targets!],
    }),
  );
  assert.throws(() =>
    importTargets({
      ...account,
      import_targets: [{ ...account.import_targets![0], id: "bad\nidentity" }],
    }),
  );
  assert.equal(
    account.selected_import_target_id,
    undefined,
    "validation never changes selection or starts importing",
  );
});
