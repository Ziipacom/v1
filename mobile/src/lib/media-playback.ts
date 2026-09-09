import { useMemo } from "react";
import { playbackSource } from "./assets";
import { localPlaybackSource } from "./local-media";

/** Native behavior is unchanged: Expo's native players support source headers. */
export function usePlaybackSource(
  path: string | null,
  token?: string,
  localDraft = false,
  _active = true,
  localUri?: string,
) {
  const source = useMemo(
    () =>
      localPlaybackSource(localUri, true) ||
      playbackSource(path, token, localDraft),
    [path, token, localDraft, localUri],
  );
  return { source, loading: false, error: "" };
}
