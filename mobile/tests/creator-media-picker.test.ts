import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function harness(
  os: string,
  choice: "photos" | "files" | "cancel" | "dismiss",
  failure = false,
) {
  const calls: string[] = [];
  let settings: any;
  const selected = {
    uri: "file:///cache/video.mp4",
    fileName: "video.mp4",
    fileSize: 500,
    mimeType: "video/mp4",
    type: "video",
  };
  const mod: any = {};
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/lib/creator-media-picker.ts", import.meta.url),
      "utf8",
    ),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText;
  new Function("exports", "require", code)(mod, (name: string) => {
    if (name === "react-native")
      return {
        Platform: { OS: os },
        Alert: {
          alert(
            _title: string,
            _message: string,
            buttons: any[],
            options: any,
          ) {
            calls.push("choice");
            if (choice === "dismiss") options.onDismiss();
            else
              buttons[
                choice === "photos" ? 0 : choice === "files" ? 1 : 2
              ].onPress();
          },
        },
      };
    if (name === "expo-document-picker")
      return {
        getDocumentAsync: async (options: any) => {
          calls.push("files");
          settings = options;
          return {
            canceled: false,
            assets: [{ uri: "file:///cache/chosen.jpg", name: "chosen.jpg" }],
          };
        },
      };
    if (name === "expo-image-picker")
      return {
        UIImagePickerPreferredAssetRepresentationMode: {
          Compatible: "compatible",
        },
        VideoExportPreset: { HighestQuality: 3 },
        requestMediaLibraryPermissionsAsync() {
          throw Error("Full library access must not be requested");
        },
        launchImageLibraryAsync: async (options: any) => {
          calls.push("photos");
          settings = options;
          if (failure) throw Error("Photo provider unavailable");
          return { canceled: false, assets: [selected] };
        },
      };
    throw Error("Unexpected dependency " + name);
  });
  return { pick: mod.pickCreatorMedia, calls, settings: () => settings };
}

for (const os of ["ios", "android"]) {
  test(`${os}: Photos returns a cache asset with its real name, type and size`, async () => {
    const h = harness(os, "photos");
    assert.deepEqual(await h.pick(["image/*", "video/*", "audio/*"]), {
      canceled: false,
      assets: [
        {
          uri: "file:///cache/video.mp4",
          name: "video.mp4",
          size: 500,
          mimeType: "video/mp4",
        },
      ],
    });
    assert.deepEqual(h.calls, ["choice", "photos"]);
    assert.deepEqual(h.settings().mediaTypes, ["images", "videos"]);
    assert.equal(h.settings().allowsEditing, false);
    assert.equal(h.settings().allowsMultipleSelection, false);
    assert.equal(h.settings().videoExportPreset, 3);
    assert.equal(h.settings().exif, false);
    assert.equal(h.settings().base64, false);
  });
  test(`${os}: image-only uploads exclude videos and Files retains cache-copy behavior`, async () => {
    const photos = harness(os, "photos");
    await photos.pick(["image/jpeg"], "images");
    assert.deepEqual(photos.settings().mediaTypes, ["images"]);
    const files = harness(os, "files");
    await files.pick(["image/jpeg"], "images");
    assert.deepEqual(files.calls, ["choice", "files"]);
    assert.deepEqual(files.settings(), {
      type: ["image/jpeg"],
      copyToCacheDirectory: true,
      multiple: false,
    });
  });
  test(`${os}: cancel and dismiss do not open either picker`, async () => {
    for (const action of ["cancel", "dismiss"] as const) {
      const h = harness(os, action);
      assert.deepEqual(await h.pick(["image/*"]), {
        canceled: true,
        assets: [],
      });
      assert.deepEqual(h.calls, ["choice"]);
    }
  });
}
test("Web and audio-only selection directly invoke Files without losing user activation", async () => {
  for (const [os, library] of [
    ["web", "media"],
    ["ios", false],
    ["android", false],
  ] as const) {
    const h = harness(os, "cancel");
    const pending = h.pick(["audio/*"], library);
    assert.deepEqual(h.calls, ["files"]);
    await pending;
  }
});

test("the editor uploader enables multiple files and ordered selection of up to ten library photos", async () => {
  const library = harness("ios", "photos");
  await library.pick(["image/*", "video/*"], "media", () => true, true);
  assert.equal(library.settings().allowsMultipleSelection, true);
  assert.equal(library.settings().selectionLimit, 10);
  assert.equal(library.settings().orderedSelection, true);
  for (const os of ["web", "android"]) {
    const files = harness(os, "files");
    await files.pick(["image/*", "video/*"], "media", () => true, true);
    assert.equal(files.settings().multiple, true);
  }
});
test("Provider failures propagate instead of replacing the current media selection", async () => {
  const h = harness("ios", "photos", true);
  await assert.rejects(h.pick(["video/*"]), /Photo provider unavailable/);
});

test("an account change while the native source dialog is open prevents opening Photos or Files", async () => {
  for (const choice of ["photos", "files"] as const) {
    const h = harness("ios", choice);
    let current = true;
    const pending = h.pick(["image/*"], "media", () => current);
    current = false;
    assert.deepEqual(await pending, { canceled: true, assets: [] });
    assert.deepEqual(h.calls, ["choice"]);
  }
});

test("a late web or native picker result is discarded after its original account scope expires", async () => {
  for (const os of ["web", "ios", "android"]) {
    const h = harness(os, "photos");
    let checks = 0;
    // Native: initial scope, source dialog, then asynchronous picker result.
    // Web: initial scope, then asynchronous picker result.
    const result = await h.pick(
      ["image/*"],
      "images",
      () => ++checks < (os === "web" ? 2 : 3),
    );
    assert.deepEqual(result, { canceled: true, assets: [] });
    assert.deepEqual(h.calls, os === "web" ? ["files"] : ["choice", "photos"]);
  }
});
