// Explicitly registered by device pickers/recorders. Never register a URI read
// from an API response: a remote item must not gain access to device files.
const selectedMedia = new Set<string>();

export function rememberLocalMedia(uri: string) {
  if (!/^(blob:|file:\/\/|content:\/\/|data:(image|video|audio)\/)/.test(uri)) {
    throw new Error(
      "Local media must come from this device's picker or recorder.",
    );
  }
  selectedMedia.add(uri);
}

export function forgetLocalMedia(uri: string) {
  selectedMedia.delete(uri);
}

export function localPlaybackSource(
  uri: string | null | undefined,
  localDraft: boolean,
) {
  return localDraft && uri && selectedMedia.has(uri) ? { uri } : null;
}
