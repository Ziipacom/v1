import { File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import type { UploadFile } from "./api";
import { rememberLocalMedia, forgetLocalMedia } from "./local-media";
import { validateMusicWave } from "./music-composer";

export type GeneratedMusicFile = {
  file: UploadFile;
  release: () => Promise<void>;
};

export async function generatedMusicFile(
  bytes: Uint8Array,
): Promise<GeneratedMusicFile> {
  validateMusicWave(bytes);
  const name = `ziipa-music-${Crypto.randomUUID()}.wav`;
  const target = new File(Paths.cache, name);
  let created = false;
  try {
    target.create({ overwrite: false });
    created = true;
    target.write(bytes);
    if (!target.exists || target.size !== bytes.length)
      throw new Error(
        "The generated audio could not be saved to device cache.",
      );
    rememberLocalMedia(target.uri);
  } catch (error) {
    if (created && target.exists) target.delete();
    throw error;
  }
  let released = false;
  return {
    file: {
      uri: target.uri,
      name: "ziipa-created-music.wav",
      mimeType: "audio/wav",
      size: bytes.length,
    },
    release: async () => {
      if (released) return;
      released = true;
      forgetLocalMedia(target.uri);
      if (target.exists) target.delete();
    },
  };
}
