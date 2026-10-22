import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as helpers from "../src/lib/profile-images.ts";

type Node = { type: unknown; props: Record<string, any> };
const advertised = {
  profile_images: {
    version: 1,
    max_bytes: helpers.PROFILE_IMAGE_MAX_BYTES,
    content_types: [...helpers.PROFILE_IMAGE_TYPES],
    cover_samples: [...helpers.PROFILE_SAMPLE_COVERS],
  },
};
const profile = {
  avatar_media_id: "owned-image",
  avatar_url: "/api/creator/profile-images/owned-image",
  cover_media_id: null,
  cover_url: null,
  cover_sample: null,
};

function controls(
  options: {
    status?: string;
    guest?: boolean;
    kind?: "avatar" | "cover";
    api?: (path: string, body?: unknown) => Promise<unknown>;
  } = {},
) {
  const source = readFileSync(
    new URL("../src/components/profile-image-controls.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  const status = options.status || "ready";
  const calls: string[] = [];
  const saved: unknown[] = [];
  const previews: string[] = [];
  const updates: { index: number; value: unknown }[] = [];
  let stateIndex = 0;
  const exported: Record<string, any> = {};
  new Function("exports", "require", compiled)(exported, (name: string) => {
    if (name === "react")
      return {
        useCallback: (callback: unknown) => callback,
        useEffect() {},
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => {
          const index = stateIndex++;
          const value =
            index === 0
              ? status === "ready"
                ? helpers.profileImageConfig(advertised)
                : null
              : index === 1
                ? status
                : initial;
          return [value, (value: unknown) => updates.push({ index, value })];
        },
      };
    if (name === "react/jsx-runtime")
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "react-native")
      return {
        AppState: {
          currentState: "active",
          addEventListener: () => ({ remove() {} }),
        },
        Image: "Image",
        Platform: { OS: "android" },
        Pressable: "Pressable",
        Text: "Text",
        View: "View",
      };
    if (name === "@react-navigation/native")
      return { useIsFocused: () => true };
    if (name === "expo-document-picker")
      return {
        getDocumentAsync: async (settings: unknown) => {
          calls.push("picker");
          assert.deepEqual(settings, {
            type: [...helpers.PROFILE_IMAGE_TYPES],
            copyToCacheDirectory: true,
            multiple: false,
          });
          return {
            canceled: false,
            assets: [
              {
                uri: "file:///cache/chosen.jpg",
                name: "chosen.jpg",
                mimeType: "image/jpeg",
                size: 500,
              },
            ],
          };
        },
      };
    if (name === "expo-file-system/legacy")
      return {
        cacheDirectory: "file:///cache/",
        getInfoAsync: async () => {
          calls.push("measure");
          return { exists: true, isDirectory: false, size: 500 };
        },
        deleteAsync: async (path: string) => {
          calls.push("cleanup");
          assert.equal(path, "file:///cache/chosen.jpg");
        },
      };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "./ui") return { Action: "Action", Notice: "Notice" };
    if (name === "../provider")
      return {
        useZiipa: () => ({
          session: options.guest ? null : { access_token: "fixture-token" },
          guest: options.guest ?? false,
          api: async (path: string, body?: unknown) => {
            calls.push(path === "/api/creator/config" ? "config" : "save");
            return options.api
              ? options.api(path, body)
              : path === "/api/creator/config"
                ? advertised
                : profile;
          },
        }),
      };
    if (name === "../lib/api")
      return {
        uploadMedia: async (_file: unknown, token: string) => {
          calls.push("upload");
          assert.equal(token, "fixture-token");
          return { id: "owned-image" };
        },
      };
    if (name === "../lib/assets")
      return { coverSource: (path: string) => path };
    if (name === "../lib/profile-images") return helpers;
    if (name === "../theme") return { color: {}, font: {}, styles: {} };
    throw new Error(`Unexpected profile image dependency ${name}`);
  });
  const tree = exported.ProfileImageControls({
    kind: options.kind || "avatar",
    profile: null,
    onSaved: (value: unknown) => saved.push(value),
    onPreviewSample: (path: string) => previews.push(path),
  });
  function walk(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    return [value, ...walk(value.props.children)];
  }
  return { nodes: walk(tree), calls, saved, previews, updates };
}

test("profile image controls disable unsupported uploads before opening any picker", async () => {
  for (const status of ["checking", "unsupported", "unavailable"]) {
    const ui = controls({ status });
    const upload = ui.nodes.find(
      (node) => node.props.title === "Upload profile photo",
    )!;
    assert.equal(upload.props.disabled, true);
    upload.props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(ui.calls, []);
  }
});

test("a verified upload opens the picker directly, saves the account image and cleans only its cache copy", async () => {
  const ui = controls();
  ui.nodes
    .find((node) => node.props.title === "Upload profile photo")!
    .props.onPress();
  assert.deepEqual(
    ui.calls,
    ["picker"],
    "the first synchronous action preserves browser user activation",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ui.calls, [
    "picker",
    "measure",
    "config",
    "upload",
    "save",
    "cleanup",
  ]);
  assert.deepEqual(ui.saved, [profile]);
});

test("gallery remains a clearly labeled local preview when account persistence is unavailable", async () => {
  const ui = controls({ kind: "cover", status: "unsupported" });
  ui.nodes
    .find(
      (node) => node.props.accessibilityLabel === "Use studio gallery cover",
    )!
    .props.onPress();
  assert.deepEqual(ui.previews, ["/media/studio.jpg"]);
  assert.deepEqual(ui.calls, []);
  assert.ok(
    ui.updates.some(
      ({ value }) =>
        value === "Cover preview only. It is not saved to your account.",
    ),
  );
});

test("a supported gallery selection persists a safe sample without uploading a file", async () => {
  let patch: unknown;
  const ui = controls({
    kind: "cover",
    api: async (path, body) => {
      if (path === "/api/creator/config") return advertised;
      patch = body;
      return profile;
    },
  });
  ui.nodes
    .find(
      (node) => node.props.accessibilityLabel === "Use studio gallery cover",
    )!
    .props.onPress();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ui.calls, ["config", "save"]);
  assert.deepEqual(patch, { cover_sample: "/media/studio.jpg" });
  assert.deepEqual(ui.saved, [profile]);
});

test("an older canceled capability check cannot replace a newer ready status", async () => {
  const pending: { resolve: (value: unknown) => void }[] = [];
  const ui = controls({
    status: "unavailable",
    api: () => new Promise((resolve) => pending.push({ resolve })),
  });
  const refresh = ui.nodes.find(
    (node) => node.props.title === "Refresh image support",
  )!;
  refresh.props.onPress();
  refresh.props.onPress();
  assert.equal(pending.length, 2);
  pending[1].resolve(advertised);
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending[0].resolve(advertised);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    ui.updates.filter(({ index }) => index === 1).at(-1)!.value,
    "ready",
  );
});
