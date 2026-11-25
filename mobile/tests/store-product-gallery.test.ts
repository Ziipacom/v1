import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { Listing } from "../src/lib/commerce.ts";

type Element = { type: unknown; props: Record<string, any> };

function gallery() {
  let selection = 0;
  const element = (type: unknown, props: Element["props"]) => ({ type, props });
  const imports = {
    "react/jsx-runtime": { jsx: element, jsxs: element },
    react: {
      useState: () => [selection, (value: number) => (selection = value)],
    },
    "react-native": { Image: "Image", Pressable: "Pressable", View: "View" },
    "lucide-react-native": {
      ChevronLeft: "ChevronLeft",
      ChevronRight: "ChevronRight",
      ImageIcon: "ImageIcon",
      Music: "Music",
      Play: "Play",
    },
    "../provider": { useZiipa: () => ({ session: null }) },
    "../lib/store-photo-source": { useStorePhotoSource: () => null },
    "../theme": { color: {} },
    "./store-media-preview": { StoreMediaPreview: "StoreMediaPreview" },
  };
  const source = readFileSync(
    new URL("../src/components/store-product-gallery.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {} as {
    StoreProductGallery: (props: { listing: Listing }) => Element;
  };
  new Function("exports", "require", compiled)(
    exports,
    (name: keyof typeof imports) => imports[name],
  );
  return (photos: string[], media?: Listing["media"]) =>
    exports.StoreProductGallery({ listing: { photos, media } as Listing });
}

function elements(value: Element | Element[] | undefined): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return value?.props ? [value, ...elements(value.props.children)] : [];
}

test("a single listing photo appears in one preview without repeated thumbnails", () => {
  const render = gallery();
  const tree = elements(render(["cover.jpg", "cover.jpg"]));
  assert.equal(
    tree.filter((node) => node.props.path === "cover.jpg").length,
    1,
  );
  assert.equal(
    tree.filter((node) => node.props.testID === "product-media-preview").length,
    1,
  );
  assert.ok(
    !tree.some((node) => node.props.testID === "product-media-thumbnails"),
  );
});

test("three thumbnails sit beside one preview and switch between product media", () => {
  const render = gallery();
  const listingPhotos = ["cover.jpg", "detail.jpg", "label.jpg"];
  const listingMedia = [
    { id: "video", path: "product.mp4", content_type: "video/mp4" },
  ];
  const firstPage = render(listingPhotos, listingMedia);
  assert.equal(firstPage.props.style.flexDirection, "row");
  const buttons = elements(firstPage).filter(
    (node) => node.type === "Pressable",
  );
  assert.equal(buttons.length, 3);
  buttons[1].props.onPress();
  assert.ok(
    elements(render(listingPhotos, listingMedia)).some(
      (node) => node.props.path === "detail.jpg" && node.props.contain,
    ),
  );
  elements(render(listingPhotos, listingMedia))
    .find((node) => node.props.label === "Next photos and media")!
    .props.onPress();
  const secondPage = elements(render(listingPhotos, listingMedia));
  assert.equal(
    secondPage.filter((node) => node.type === "Pressable").length,
    1,
  );
  assert.ok(
    secondPage.some(
      (node) =>
        node.type === "StoreMediaPreview" && node.props.path === "product.mp4",
    ),
  );
});
