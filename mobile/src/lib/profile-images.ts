import type { UploadFile } from "./api";
import type { ProfileImages } from "./types";

export const PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const PROFILE_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const PROFILE_SAMPLE_COVERS = [
  "/media/studio.jpg",
  "/media/dj.jpg",
  "/media/gaming.jpg",
  "/media/ocean.jpg",
  "/media/sintel.png",
  "/brand/ziipa-background.png",
] as const;
export type ProfileImageConfig = {
  version: 1;
  max_bytes: number;
  content_types: string[];
  cover_samples: string[];
};
export type ProfileImagePatch = {
  avatar_media_id?: string | null;
  cover_media_id?: string | null;
  cover_sample?: string | null;
};
export type ProfileImageAsset = {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
};

/** One acknowledged write, then a readback. Never retry an uncertain mutation. */
export async function confirmProfileImageSave(options: {
  patch: ProfileImagePatch;
  valid: () => boolean;
  save: (patch: ProfileImagePatch) => Promise<ProfileImages>;
  read: () => Promise<ProfileImages>;
}): Promise<ProfileImages | null> {
  if (!options.valid()) return null;
  await options.save(options.patch);
  if (!options.valid()) return null;
  let stored: ProfileImages;
  try {
    stored = await options.read();
  } catch {
    if (!options.valid()) return null;
    throw new Error(
      "The image save could not be verified. Refresh saved images before trying again; the upload and save will not be repeated automatically.",
    );
  }
  if (!options.valid()) return null;
  const expected = { ...options.patch };
  if (expected.cover_media_id != null) expected.cover_sample = null;
  if (expected.cover_sample != null) expected.cover_media_id = null;
  if (
    Object.entries(expected).some(
      ([key, value]) => stored[key as keyof ProfileImages] !== value,
    )
  )
    throw new Error(
      "Your image change could not be confirmed, or was changed on another device. Refresh saved images before trying again. Nothing will be uploaded or saved again automatically.",
    );
  return stored;
}

/** Android may resolve its picker before the Activity has emitted its resume. */
export function waitForProfilePickerResume(options: {
  isForeground: () => boolean;
  sameScope: () => boolean;
  subscribe: (notify: () => void) => () => void;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!options.sameScope()) return Promise.resolve(false);
  if (options.isForeground()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (resumed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(resumed);
    };
    const check = () => {
      if (!options.sameScope()) finish(false);
      else if (options.isForeground()) finish(true);
    };
    const timer = setTimeout(
      () => finish(options.sameScope() && options.isForeground()),
      options.timeoutMs ?? 2000,
    );
    unsubscribe = options.subscribe(check);
    if (done) unsubscribe();
    else check();
  });
}

/** Verify the advertised protocol before opening a picker or uploading bytes. */
export function profileImageConfig(value: unknown): ProfileImageConfig | null {
  const config = (value as { profile_images?: Record<string, unknown> } | null)
    ?.profile_images;
  if (
    !config ||
    config.version !== 1 ||
    !Number.isSafeInteger(config.max_bytes) ||
    (config.max_bytes as number) < 1 ||
    (config.max_bytes as number) > PROFILE_IMAGE_MAX_BYTES ||
    !Array.isArray(config.content_types) ||
    config.content_types.length !== 3 ||
    !PROFILE_IMAGE_TYPES.every((type) =>
      (config.content_types as unknown[]).includes(type),
    ) ||
    !Array.isArray(config.cover_samples) ||
    !config.cover_samples.every(
      (path) =>
        typeof path === "string" &&
        (PROFILE_SAMPLE_COVERS as readonly string[]).includes(path),
    )
  )
    return null;
  return config as ProfileImageConfig;
}

export function profileImageFile(
  asset: ProfileImageAsset,
  size: number,
  config: ProfileImageConfig,
): UploadFile {
  if (!Number.isSafeInteger(size) || size < 1 || size > config.max_bytes)
    throw new Error(
      `Choose a non-empty image no larger than ${Math.floor(config.max_bytes / 1024 / 1024)} MB.`,
    );
  if (!/^(file|content|blob|data):/i.test(asset.uri))
    throw new Error("Choose an image from this device.");
  const name = asset.name?.trim() || "ziipa-profile-image";
  const reported = (asset.mimeType || "").toLowerCase().split(";")[0];
  const extension = name.toLowerCase().split(".").pop() || "";
  const inferred: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  const mimeType =
    reported && reported !== "application/octet-stream"
      ? reported
      : inferred[extension];
  if (!config.content_types.includes(mimeType))
    throw new Error(
      "Choose a static JPG, PNG or WebP image. Animated images and SVG files are not supported.",
    );
  return { uri: asset.uri, name, mimeType, size };
}

/** Side effects are injected so cancellation and no-replay behavior can be tested. */
export async function uploadProfileImage(options: {
  kind: "avatar" | "cover";
  config: ProfileImageConfig | null;
  valid: () => boolean;
  pick: () => Promise<ProfileImageAsset | null>;
  measure: (asset: ProfileImageAsset) => Promise<number>;
  refreshConfig: () => Promise<unknown>;
  upload: (file: UploadFile) => Promise<{ id: string }>;
  save: (patch: ProfileImagePatch) => Promise<ProfileImages>;
  read: () => Promise<ProfileImages>;
}): Promise<ProfileImages | null> {
  if (!options.config)
    throw new Error(
      "Confirm profile image support before choosing a file. Refresh the status and try again.",
    );
  if (!options.valid()) return null;
  const asset = await options.pick();
  if (!asset || !options.valid()) return null;
  if (!/^(file|content|blob|data):/i.test(asset.uri))
    throw new Error("Choose an image from this device.");
  if (
    asset.size != null &&
    (asset.size < 1 || asset.size > options.config.max_bytes)
  )
    throw new Error("Choose a non-empty image no larger than 10 MB.");
  const size = await options.measure(asset);
  if (!options.valid()) return null;
  const file = profileImageFile(asset, size, options.config);
  const current = profileImageConfig(await options.refreshConfig());
  if (!options.valid()) return null;
  if (!current)
    throw new Error(
      "This Ziipa server needs the profile image update before it can save your image. Nothing was uploaded.",
    );
  profileImageFile(asset, size, current);
  const media = await options.upload(file);
  if (!options.valid()) return null;
  return confirmProfileImageSave({
    patch:
      options.kind === "avatar"
        ? { avatar_media_id: media.id }
        : { cover_media_id: media.id },
    valid: options.valid,
    save: options.save,
    read: options.read,
  });
}
