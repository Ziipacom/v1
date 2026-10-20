// Explicitly registered by device pickers/recorders. Never register a URI read
// from an API response: a remote item must not gain access to device files.
const selectedMedia = new Set<string>();
const draftLeases = new Map<string, string>();
const draftDisposers = new Map<string, () => Promise<void>>();
function releaseUnreferenced(uri: string) {
  if (Array.from(draftLeases.values()).includes(uri)) return;
  forgetLocalMedia(uri);
  const dispose = draftDisposers.get(uri);
  draftDisposers.delete(uri);
  if (dispose) void dispose().catch(() => {});
}
/** Session-only, picker-created draft attachments. Never populated from API JSON. */
export function retainDraftMedia(
  key: string,
  uri: string,
  release?: () => Promise<void>,
) {
  if (!selectedMedia.has(uri))
    throw new Error("Only a locally selected attachment may be retained.");
  const old = draftLeases.get(key);
  draftLeases.set(key, uri);
  if (release && !draftDisposers.has(uri)) draftDisposers.set(uri, release);
  if (old && old !== uri) releaseUnreferenced(old);
}
export function clearDraftMedia() {
  const uris = new Set(draftLeases.values());
  draftLeases.clear();
  for (const uri of uris) releaseUnreferenced(uri);
}
export function isRetainedDraftMedia(uri: string) {
  return Array.from(draftLeases.values()).includes(uri);
}

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
