import { Image, type ImageSource } from "expo-image";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

export type TitleImageCapture = { isReady: () => boolean; capture: () => Promise<string> };

/** A fresh JPEG strips metadata. Only this small preview goes to visual inference. */
export async function encodeTitleImage(
  source: Parameters<typeof ImageManipulator.manipulate>[0],
): Promise<string> {
  const context = ImageManipulator.manipulate(source);
  let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
  let uri: string | undefined;
  const releaseImage = () => {
    if (!rendered) return;
    if (Platform.OS === "web") {
      const owned = (rendered as unknown as { uri?: string }).uri;
      if (owned?.startsWith("blob:")) URL.revokeObjectURL(owned);
    }
    rendered.release();
    rendered = undefined;
  };
  try {
    const loaded = await context.renderAsync();
    rendered = loaded;
    if (loaded.width > 512 || loaded.height > 512) {
      context.resize(
        loaded.width >= loaded.height ? { width: 512 } : { height: 512 },
      );
      releaseImage();
      rendered = await context.renderAsync();
    }
    const image = await rendered.saveAsync({
      format: SaveFormat.JPEG,
      compress: 0.7,
      base64: true,
    });
    uri = image.uri;
    if (!image.base64 || image.base64.length > 196608)
      throw new Error(
        "This preview is too large for a title suggestion. Please enter a title.",
      );
    return image.base64;
  } finally {
    releaseImage();
    context.release();
    if (uri && Platform.OS === "web" && uri.startsWith("blob:"))
      URL.revokeObjectURL(uri);
    if (uri && Platform.OS !== "web")
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}

export async function capturePhotoTitle(
  source: ImageSource | number,
): Promise<string> {
  const image = await Image.loadAsync(source, {
    maxWidth: 512,
    maxHeight: 512,
  });
  try {
    return await encodeTitleImage(image);
  } finally {
    if (Platform.OS === "web") {
      const owned = (image as unknown as { uri?: string }).uri;
      if (owned?.startsWith("blob:")) URL.revokeObjectURL(owned);
    }
    image.release();
  }
}

/** Web has no Expo video-thumbnail API. Decode one frame, then dispose it. */
export async function captureWebVideoTitle(
  uri: string,
  time: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let done = false;
    const finish = (value?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.onloadeddata = video.onseeked = video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      if (value) resolve(value);
      else
        reject(
          new Error(
            "A video frame could not be read. Try another frame or enter a title.",
          ),
        );
    };
    const draw = () => {
      if (done) return;
      try {
        const scale = Math.min(
          1,
          512 / Math.max(video.videoWidth, video.videoHeight),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context || !video.videoWidth) return finish();
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const jpeg = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
        finish(jpeg && jpeg.length <= 196608 ? jpeg : undefined);
      } catch {
        finish();
      }
    };
    const timer = setTimeout(() => finish(), 10000);
    video.onloadeddata = () => {
      const target = Math.max(0, Math.min(time, video.duration - 0.05));
      if (Math.abs(video.currentTime - target) < 0.01) draw();
      else {
        video.onseeked = draw;
        video.currentTime = target;
      }
    };
    video.onerror = () => finish();
    video.src = uri;
  });
}
