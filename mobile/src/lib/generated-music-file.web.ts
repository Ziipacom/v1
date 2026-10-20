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
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: "audio/wav" });
  const uri = URL.createObjectURL(blob);
  try {
    rememberLocalMedia(uri);
  } catch (error) {
    URL.revokeObjectURL(uri);
    throw error;
  }
  let released = false;
  return {
    file: {
      uri,
      name: "ziipa-original-music.wav",
      mimeType: "audio/wav",
      size: blob.size,
    },
    release: async () => {
      if (released) return;
      released = true;
      forgetLocalMedia(uri);
      URL.revokeObjectURL(uri);
    },
  };
}
