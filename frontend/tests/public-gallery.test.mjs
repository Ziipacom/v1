import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const exported = {};
const source = readFileSync(
  new URL("../lib/public-gallery.ts", import.meta.url),
  "utf8",
);
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  { exports: exported },
);
const {
  parsePublicGallery,
  parsePublicGalleryItem,
  mergePublicGalleryItems,
  publicCreationLink,
} = exported;
const id = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const media = `/api/public/galleries/my-gallery/items/${id}/media`;
const item = {
  id,
  title: "My film",
  description: "A published film",
  creator: "Creator",
  category: "video",
  tags: ["film"],
  media_url: media,
  content_type: "video/mp4",
  cover: null,
  visibility: "published",
  demo: false,
  created_at: "2026-10-27T14:00:00Z",
};
const gallery = {
  slug: "my-gallery",
  name: "Creator",
  avatar_url: null,
  cover_url: null,
  items: [item],
  next_cursor: null,
  unavailable_count: 2,
};

test("public gallery consumes only the current gallery’s anonymous media and artwork", () => {
  const parsed = parsePublicGallery(
    {
      ...gallery,
      avatar_url: `/api/public/galleries/my-gallery/artwork/avatar/${otherId}`,
    },
    "my-gallery",
  );
  assert.equal(parsed.items[0].media_url, media);
  assert.equal(parsed.unavailable_count, 2);
  assert.equal(
    parsed.avatar_url,
    `/api/public/galleries/my-gallery/artwork/avatar/${otherId}`,
  );
});

test("public gallery rejects credential-bearing, private, cross-gallery and arbitrary media paths", () => {
  for (const url of [
    `/api/creator/media/${id}`,
    `https://api.ziipa.com${media}`,
    `https://user:pass@evil.test/video.mp4`,
    media + "?token=secret",
    media.replace("my-gallery", "another-gallery"),
    "file:///private/clip.mp4",
  ])
    assert.throws(() =>
      parsePublicGalleryItem({ ...item, media_url: url }, "my-gallery"),
    );
  assert.throws(() =>
    parsePublicGallery(
      { ...gallery, cover_url: "/brand/unknown-upload.svg" },
      "my-gallery",
    ),
  );
});

test("unpublished and sample records cannot appear as public gallery creations", () => {
  for (const visibility of ["draft", "hidden", undefined])
    assert.throws(() =>
      parsePublicGalleryItem({ ...item, visibility }, "my-gallery"),
    );
  assert.throws(() =>
    parsePublicGalleryItem({ ...item, demo: true }, "my-gallery"),
  );
  assert.throws(() =>
    parsePublicGallery({ ...gallery, slug: "different" }, "my-gallery"),
  );
});

test("public response bounds reject malformed media, pagination and counts", () => {
  for (const content_type of ["text/html", "image/svg+xml?script=1", ""])
    assert.throws(() =>
      parsePublicGalleryItem({ ...item, content_type }, "my-gallery"),
    );
  for (const next_cursor of ["../account", "?token=secret", "x".repeat(513)])
    assert.throws(() =>
      parsePublicGallery({ ...gallery, next_cursor }, "my-gallery"),
    );
  for (const unavailable_count of [-1, 1.5, "2"])
    assert.throws(() =>
      parsePublicGallery({ ...gallery, unavailable_count }, "my-gallery"),
    );
  assert.throws(() =>
    parsePublicGallery(
      { ...gallery, items: Array(25).fill(item) },
      "my-gallery",
    ),
  );
});

test("only declared bundled covers can accompany the current uploaded gallery artwork", () => {
  for (const cover_url of [
    "/media/studio.jpg",
    "/media/dj.jpg",
    "/media/gaming.jpg",
    "/media/ocean.jpg",
    "/media/sintel.png",
    "/brand/ziipa-background.png",
  ])
    assert.equal(
      parsePublicGallery({ ...gallery, cover_url }, "my-gallery").cover_url,
      cover_url,
    );
  for (const cover_url of [
    "/media/secret.jpg",
    "/media/studio.jpg?token=x",
    "https://example.com/cover.jpg",
  ])
    assert.throws(() =>
      parsePublicGallery({ ...gallery, cover_url }, "my-gallery"),
    );
  assert.throws(() =>
    parsePublicGallery(
      { ...gallery, avatar_url: "/media/studio.jpg" },
      "my-gallery",
    ),
  );
});

test("overlapping public pages retain each creation once without changing previous records", () => {
  const first = parsePublicGalleryItem(item, "my-gallery");
  const second = { ...first, id: otherId };
  const previous = [first];
  const result = mergePublicGalleryItems(previous, [first, second, second]);
  assert.equal(result.map((row) => row.id).join(","), `${id},${otherId}`);
  assert.equal(previous.length, 1);
});

test("public gallery and creation permalinks never encode arbitrary navigation", () => {
  assert.equal(publicCreationLink("my-gallery"), "/g/my-gallery");
  assert.equal(
    publicCreationLink("my-gallery", id),
    `/g/my-gallery?post=${id}`,
  );
  for (const slug of [
    "../portal",
    "ab",
    "A-name",
    "x".repeat(41),
    "name?next=evil",
  ])
    assert.throws(() => publicCreationLink(slug));
  assert.throws(() => publicCreationLink("my-gallery", "../secret"));
});
