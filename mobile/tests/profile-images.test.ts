import assert from "node:assert/strict";
import test from "node:test";
import {
  PROFILE_IMAGE_MAX_BYTES,
  PROFILE_IMAGE_TYPES,
  PROFILE_SAMPLE_COVERS,
  profileImageConfig,
  profileImageFile,
  uploadProfileImage,
  waitForProfilePickerResume,
  confirmProfileImageSave,
} from "../src/lib/profile-images.ts";

const advertised = {
  profile_images: {
    version: 1,
    max_bytes: PROFILE_IMAGE_MAX_BYTES,
    content_types: [...PROFILE_IMAGE_TYPES],
    cover_samples: [...PROFILE_SAMPLE_COVERS],
  },
};
const supported = profileImageConfig(advertised)!;
const saved = {
  avatar_media_id: "owned-image",
  avatar_url: "/api/creator/profile-images/avatar-id",
  cover_media_id: null,
  cover_url: null,
  cover_sample: null,
};
const asset = {
  uri: "file:///cache/chosen.jpg",
  name: "chosen.jpg",
  mimeType: "image/jpeg",
  size: 512,
};

function scenario(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const patches: unknown[] = [];
  let stored = { ...saved };
  const options = {
    kind: "avatar" as const,
    config: supported,
    valid: () => true,
    pick: async () => {
      calls.push("pick");
      return asset;
    },
    measure: async () => {
      calls.push("measure");
      return asset.size;
    },
    refreshConfig: async () => {
      calls.push("config");
      return advertised;
    },
    upload: async () => {
      calls.push("upload");
      return { id: "owned-image" };
    },
    save: async (patch: unknown) => {
      calls.push("save");
      patches.push(patch);
      stored = { ...stored, ...(patch as any) };
      return stored;
    },
    read: async () => {
      calls.push("read");
      return stored;
    },
    ...overrides,
  };
  return { calls, patches, options, run: () => uploadProfileImage(options) };
}

test("profile images require the exact static-image protocol and bounded size before enabling a picker", () => {
  assert.ok(profileImageConfig(advertised));
  for (const profile_images of [
    undefined,
    { ...advertised.profile_images, version: 2 },
    { ...advertised.profile_images, max_bytes: PROFILE_IMAGE_MAX_BYTES + 1 },
    { ...advertised.profile_images, max_bytes: 0 },
    {
      ...advertised.profile_images,
      content_types: ["image/svg+xml", "image/png", "image/jpeg"],
    },
    {
      ...advertised.profile_images,
      cover_samples: ["https://other.example/picture.png"],
    },
  ]) {
    assert.equal(profileImageConfig({ profile_images }), null);
  }
});

test("unsupported or unverified server support cannot open the picker or upload anything", async () => {
  const check = scenario({ config: null });
  await assert.rejects(check.run(), /Confirm profile image support/);
  assert.deepEqual(check.calls, []);
});

test("avatar saving preflights again before bytes and saves only the uploaded owned ID", async () => {
  const check = scenario();
  assert.deepEqual(await check.run(), saved);
  assert.deepEqual(check.calls, [
    "pick",
    "measure",
    "config",
    "upload",
    "save",
    "read",
  ]);
  assert.deepEqual(check.patches, [{ avatar_media_id: "owned-image" }]);
});

test("cover uploads preserve unrelated profile settings by using a partial patch", async () => {
  const check = scenario({ kind: "cover" });
  await check.run();
  assert.deepEqual(check.patches, [{ cover_media_id: "owned-image" }]);
});

test("an advertised protocol change after choosing a file prevents any upload", async () => {
  const check = scenario({ refreshConfig: async () => ({}) });
  await assert.rejects(check.run(), /Nothing was uploaded/);
  assert.deepEqual(check.calls, ["pick", "measure"]);
});

test("profile upload rejects oversized metadata before reading the selected file", async () => {
  const check = scenario({
    pick: async () => ({ ...asset, size: PROFILE_IMAGE_MAX_BYTES + 1 }),
  });
  await assert.rejects(check.run(), /no larger than 10 MB/);
  assert.deepEqual(check.calls, []);
});

test("actual image size is checked before the second preflight and upload", async () => {
  const check = scenario({ measure: async () => PROFILE_IMAGE_MAX_BYTES + 1 });
  await assert.rejects(check.run(), /no larger than 10 MB/);
  assert.deepEqual(check.calls, ["pick"]);
});

test("remote URLs never reach local measurement or an authenticated upload", async () => {
  const check = scenario({
    pick: async () => ({ ...asset, uri: "https://other.example/photo.jpg" }),
  });
  await assert.rejects(check.run(), /from this device/);
  assert.deepEqual(check.calls, []);
});

test("only JPG, PNG or WebP are accepted; supported extensions cover generic MIME reports", () => {
  assert.equal(
    profileImageFile(
      { ...asset, mimeType: "application/octet-stream" },
      512,
      supported,
    ).mimeType,
    "image/jpeg",
  );
  for (const mimeType of [
    "image/svg+xml",
    "image/gif",
    "video/mp4",
    "image/heic",
  ])
    assert.throws(
      () => profileImageFile({ ...asset, mimeType }, 512, supported),
      /static JPG/,
    );
  for (const size of [0, NaN, Infinity, -1, 1.5])
    assert.throws(
      () => profileImageFile(asset, size, supported),
      /non-empty image/,
    );
});

test("picker cancellation performs no upload or save", async () => {
  const check = scenario({ pick: async () => null });
  assert.equal(await check.run(), null);
  assert.deepEqual(check.calls, []);
});

test("a changed account or screen scope discards a late picker response", async () => {
  let valid = true;
  const check = scenario({
    valid: () => valid,
    pick: async () => {
      valid = false;
      return asset;
    },
  });
  assert.equal(await check.run(), null);
  assert.deepEqual(check.calls, []);
});

test("leaving the foreground during upload cannot apply the image to the profile", async () => {
  let valid = true;
  const check = scenario({
    valid: () => valid,
    upload: async () => {
      valid = false;
      return { id: "late-private-media" };
    },
  });
  assert.equal(await check.run(), null);
  assert.deepEqual(check.calls, ["pick", "measure", "config"]);
  assert.deepEqual(check.patches, []);
});

test("late save responses cannot update a replacement account's UI", async () => {
  let valid = true;
  const check = scenario({
    valid: () => valid,
    save: async () => {
      valid = false;
      return saved;
    },
  });
  assert.equal(await check.run(), null);
});

test("failed uploads and profile mutations are never automatically replayed", async () => {
  let uploads = 0;
  const uploadFailure = scenario({
    upload: async () => {
      uploads++;
      throw new Error("Upload outcome unknown");
    },
  });
  await assert.rejects(uploadFailure.run(), /outcome unknown/);
  assert.equal(uploads, 1);
  assert.deepEqual(uploadFailure.patches, []);
  let saves = 0;
  const saveFailure = scenario({
    save: async () => {
      saves++;
      throw new Error("Save outcome unknown");
    },
  });
  await assert.rejects(saveFailure.run(), /outcome unknown/);
  assert.equal(saves, 1);
});

test("Android result-before-resume waits for the Activity before uploading, without reopening the picker", async () => {
  let foreground = true;
  let notify = () => {};
  let unsubscribed = 0;
  let picked = 0;
  const check = scenario({
    valid: () => foreground,
    pick: async () => {
      picked++;
      foreground = false;
      const resumed = await waitForProfilePickerResume({
        isForeground: () => foreground,
        sameScope: () => true,
        subscribe: (listener) => {
          notify = listener;
          return () => {
            unsubscribed++;
          };
        },
      });
      return resumed ? asset : null;
    },
  });
  const result = check.run();
  await Promise.resolve();
  assert.deepEqual(
    check.calls,
    [],
    "no file read, upload or profile mutation while backgrounded",
  );
  foreground = true;
  notify();
  assert.deepEqual(await result, saved);
  assert.equal(picked, 1);
  assert.equal(unsubscribed, 1);
  assert.deepEqual(check.calls, [
    "measure",
    "config",
    "upload",
    "save",
    "read",
  ]);
});

test("one write is read back before declaring success, and unrelated other-device fields are preserved", async () => {
  let writes = 0,
    reads = 0;
  const elsewhere = {
    ...saved,
    cover_sample: "/media/ocean.jpg",
    cover_url: "/media/ocean.jpg",
  };
  const result = await confirmProfileImageSave({
    patch: { avatar_media_id: "owned-image" },
    valid: () => true,
    save: async () => {
      writes++;
      return saved;
    },
    read: async () => {
      reads++;
      return elsewhere;
    },
  });
  assert.deepEqual(result, elsewhere);
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

test("a successful POST without durable matching readback is unconfirmed and never replayed", async () => {
  for (const read of [
    async () => ({ ...saved, avatar_media_id: null }),
    async () => {
      throw new Error("offline");
    },
  ]) {
    let writes = 0,
      reads = 0;
    await assert.rejects(
      confirmProfileImageSave({
        patch: { avatar_media_id: "owned-image" },
        valid: () => true,
        save: async () => {
          writes++;
          return saved;
        },
        read: async () => {
          reads++;
          return read();
        },
      }),
    );
    assert.equal(writes, 1);
    assert.equal(reads, 1);
  }
});

test("cover readback verifies mutually exclusive uploaded-media and gallery-sample fields", async () => {
  await assert.rejects(
    confirmProfileImageSave({
      patch: { cover_sample: "/media/ocean.jpg" },
      valid: () => true,
      save: async () => saved,
      read: async () => ({
        ...saved,
        cover_sample: "/media/ocean.jpg",
        cover_media_id: "old-upload",
      }),
    }),
    /could not be confirmed/,
  );
});

test("a canceled account or navigation scope cannot resume a completed picker", async () => {
  let current = true;
  let foreground = false;
  let notify = () => {};
  let removed = 0;
  const result = waitForProfilePickerResume({
    isForeground: () => foreground,
    sameScope: () => current,
    subscribe: (listener) => {
      notify = listener;
      return () => {
        removed++;
      };
    },
  });
  current = false;
  foreground = true;
  notify();
  assert.equal(await result, false);
  assert.equal(removed, 1);
});

test("a picker that never resumes stops after its bounded wait", async () => {
  let removed = 0;
  assert.equal(
    await waitForProfilePickerResume({
      isForeground: () => false,
      sameScope: () => true,
      subscribe: () => () => {
        removed++;
      },
      timeoutMs: 5,
    }),
    false,
  );
  assert.equal(removed, 1);
});
