import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyPublicGalleryForm,
  mergePublicGalleryRefresh,
  publicGalleryDirty,
  publicGalleryFailure,
  publicGalleryInput,
  publicGalleryRequest,
  publicGallerySlug,
  readPublicGallerySettings,
  trustedPublicGalleryUrl,
} from "../src/lib/public-gallery.ts";

const config = (changes: Record<string, unknown> = {}) => ({
  slug: null,
  enabled: false,
  revision: 0,
  public_url: null,
  profile_public: true,
  pending_render_count: 0,
  ...changes,
});

test("gallery addresses normalize on save and reject reserved or malformed names", () => {
  assert.equal(publicGallerySlug("  MY-CREATOR-23  "), "my-creator-23");
  assert.equal(publicGallerySlug(" "), null);
  assert.equal(publicGallerySlug("a".repeat(40)), "a".repeat(40));
  for (const slug of [
    "ab",
    "a".repeat(41),
    "-creator",
    "creator-",
    "two--words",
    "two words",
    "x/y",
    "a_b",
    "ziipa",
    "settings",
    "PROFILE",
    "api",
  ]) {
    assert.throws(() => publicGallerySlug(slug));
  }
});

test("gallery copy/open/share URLs are exact server-returned canonical addresses, never arbitrary links", () => {
  assert.equal(
    trustedPublicGalleryUrl("https://ziipa.com/g/my-creator", "my-creator"),
    "https://ziipa.com/g/my-creator",
  );
  assert.equal(trustedPublicGalleryUrl(null, null), null);
  for (const url of [
    "http://ziipa.com/g/my-creator",
    "https://www.ziipa.com/g/my-creator",
    "https://ziipa.com.evil.test/g/my-creator",
    "https://evil.test/g/my-creator",
    "https://user:pass@ziipa.com/g/my-creator",
    "https://ziipa.com/g/my-creator?token=private",
    "https://ziipa.com/g/my-creator#details",
    "https://ziipa.com/g/my-creator?",
    "https://ziipa.com/g/my-creator#",
    "https://ziipa.com/g/other",
    "https://ziipa.com/g/my-creator/",
    "https://ziipa.com:444/g/my-creator",
    "https://ziipa.com/g/%6dy-creator",
    "https://ziipa.com/g/../g/my-creator",
    "javascript:alert(1)",
    "file:///g/my-creator",
    "/g/my-creator",
  ])
    assert.throws(() => trustedPublicGalleryUrl(url, "my-creator"));
  assert.throws(() =>
    trustedPublicGalleryUrl("http://127.0.0.1:5178/g/my-creator", "my-creator"),
  );
  assert.equal(
    trustedPublicGalleryUrl(
      "http://127.0.0.1:5178/g/my-creator",
      "my-creator",
      true,
    ),
    "http://127.0.0.1:5178/g/my-creator",
  );
  assert.throws(() =>
    trustedPublicGalleryUrl(
      "http://10.0.2.2:5178/g/my-creator",
      "my-creator",
      true,
    ),
  );
});

test("owner gallery schema requires actual settings, privacy, revision and render counts", () => {
  assert.deepEqual(readPublicGallerySettings(config()), config());
  assert.deepEqual(
    readPublicGallerySettings(
      config({ slug: "my-creator", pending_render_count: 2 }),
    ),
    config({ slug: "my-creator", pending_render_count: 2 }),
  );
  for (const change of [
    { enabled: "true" },
    { enabled: true },
    { revision: -1 },
    { revision: 1.1 },
    { profile_public: undefined },
    { pending_render_count: undefined },
    { pending_render_count: -1 },
    { pending_render_count: Infinity },
    { pending_render_count: 1.5 },
    { slug: "UPPERCASE" },
    { public_url: "https://ziipa.com/g/my-creator" },
  ])
    assert.throws(() => readPublicGallerySettings(config(change)));
});

test("private profiles can reserve a disabled address; enabling needs explicit public profile state", () => {
  const saved = readPublicGallerySettings(config({ profile_public: false }));
  const form = {
    saved,
    slug: "my-creator",
    enabled: false,
    needsReview: false,
  };
  assert.deepEqual(publicGalleryInput(form), {
    slug: "my-creator",
    enabled: false,
    revision: 0,
  });
  assert.throws(
    () => publicGalleryInput({ ...form, enabled: true }),
    /public profile visibility/,
  );
  assert.throws(
    () => publicGalleryInput({ ...form, needsReview: true }),
    /Refresh and review/,
  );
  for (const enabled of [true, false]) {
    assert.throws(
      () => publicGalleryInput({ ...form, slug: "", enabled }),
      /reserved names stay/,
    );
    assert.throws(
      () => publicGalleryRequest({ ...form, slug: "", enabled }),
      /reserved names stay/,
    );
  }
});

test("focus refresh keeps unsaved choices and requires review when another client changed revision", () => {
  const first = readPublicGallerySettings(
    config({ slug: "first-name", revision: 1 }),
  );
  const clean = mergePublicGalleryRefresh(emptyPublicGalleryForm(), first);
  assert.equal(publicGalleryDirty(clean), false);
  const dirty = { ...clean, slug: "My-Next-Name", enabled: true };
  const remote = readPublicGallerySettings(
    config({ slug: "other-client", revision: 2 }),
  );
  const refreshed = mergePublicGalleryRefresh(dirty, remote);
  assert.equal(refreshed.slug, "My-Next-Name");
  assert.equal(refreshed.enabled, true);
  assert.equal(refreshed.needsReview, true);
  assert.throws(() => publicGalleryInput(refreshed), /Refresh and review/);
  const reviewed = mergePublicGalleryRefresh(refreshed, remote, true);
  assert.deepEqual(publicGalleryInput(reviewed), {
    slug: "my-next-name",
    enabled: true,
    revision: 2,
  });
});

test("gallery failures distinguish deployment, taken names, concurrency and uncertain writes", () => {
  assert.equal(publicGalleryFailure({ status: 404 }).kind, "deployment");
  assert.equal(
    publicGalleryFailure({
      status: 409,
      message: "That gallery address is already reserved. Choose another.",
    }).kind,
    "taken",
  );
  assert.equal(
    publicGalleryFailure({
      status: 409,
      message: "Gallery settings changed. Refresh before saving.",
    }).kind,
    "conflict",
  );
  assert.equal(
    publicGalleryFailure({ outcome: "unconfirmed" }, true).kind,
    "unconfirmed",
  );
  assert.equal(publicGalleryFailure({ status: 500 }, true).kind, "unconfirmed");
  assert.equal(
    publicGalleryFailure(new Error("private upstream details"), true).kind,
    "unconfirmed",
  );
  assert.equal(publicGalleryFailure({ status: 422 }).kind, "validation");
  assert.doesNotMatch(
    publicGalleryFailure(new Error("private upstream details")).message,
    /private upstream/,
  );
});

test("turning off a public gallery uses the narrow revision-only revocation route despite an invalid unfinished rename", () => {
  const saved = readPublicGallerySettings(
    config({
      slug: "my-creator",
      enabled: true,
      revision: 3,
      public_url: "https://ziipa.com/g/my-creator",
    }),
  );
  assert.deepEqual(
    publicGalleryRequest({
      saved,
      slug: "unfinished__rename",
      enabled: false,
      needsReview: false,
    }),
    {
      path: "/api/creator/gallery/disable",
      body: { revision: 3 },
      slug: "my-creator",
      enabled: false,
      revision: 3,
      revoking: true,
    },
  );
});
