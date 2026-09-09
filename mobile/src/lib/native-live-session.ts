export type CaptureTrack = {
  kind: string;
  enabled: boolean;
  stop(): void;
};
export type CaptureStream = {
  getTracks(): CaptureTrack[];
  release(releaseTracks?: boolean): void;
};

export function releaseCapture(stream: CaptureStream) {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* Already released by the OS. */
    }
  }
  try {
    stream.release(true);
  } catch {
    /* Native cleanup must remain idempotent. */
  }
}

/** Owns native handles even when a permission request finishes after cancellation. */
export class NativeLiveSession<T extends CaptureStream> {
  generation = 0;
  stream: T | null = null;
  peer: { close(): void } | null = null;
  abort: AbortController | null = null;
  private acquiring = false;

  async capture(acquire: () => Promise<T>) {
    if (this.acquiring || this.stream)
      throw new Error("A camera preview is already active.");
    this.acquiring = true;
    const current = ++this.generation;
    try {
      const stream = await acquire();
      if (current !== this.generation) {
        releaseCapture(stream);
        return null;
      }
      // react-native-webrtc can return a partial stream when only one permission
      // is granted. Never silently start a video-only or audio-only broadcast.
      const tracks = stream.getTracks();
      if (
        !tracks.some((track) => track.kind === "audio") ||
        !tracks.some((track) => track.kind === "video")
      ) {
        releaseCapture(stream);
        throw new Error("Both camera and microphone permissions are required.");
      }
      this.stream = stream;
      return stream;
    } finally {
      if (current === this.generation) this.acquiring = false;
    }
  }

  mute(muted: boolean) {
    this.stream
      ?.getTracks()
      .filter((track) => track.kind === "audio")
      .forEach((track) => {
        track.enabled = !muted;
      });
  }

  stop() {
    this.generation++;
    this.acquiring = false;
    this.abort?.abort();
    this.abort = null;
    try {
      this.peer?.close();
    } catch {
      /* Already closed. */
    }
    this.peer = null;
    const stream = this.stream;
    this.stream = null;
    if (stream) releaseCapture(stream);
  }
}
