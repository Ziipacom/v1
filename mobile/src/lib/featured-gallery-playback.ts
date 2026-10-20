type FeaturedGalleryPlayback = {
  count: number;
  hasCurrent: boolean;
  ready: boolean;
  autoplay: boolean;
  reducedMotion: boolean;
  focused: boolean;
  foreground: boolean;
  hovered: boolean;
  focusWithin: boolean;
  mediaPaused: boolean;
  explicitPlayback: boolean;
  rotationEnabled: boolean;
};

/** Manual media playback never overrides lifecycle or starts automatic motion. */
export function featuredGalleryPlayback(input: FeaturedGalleryPlayback) {
  const requestedPaused =
    input.mediaPaused ||
    !input.ready ||
    (!input.explicitPlayback && (input.reducedMotion || !input.autoplay));
  return {
    requestedPaused,
    playbackPaused:
      !input.hasCurrent || !input.focused || !input.foreground || requestedPaused,
    rotationAllowed:
      input.count > 1 &&
      input.hasCurrent &&
      input.ready &&
      input.autoplay &&
      input.rotationEnabled &&
      input.focused &&
      input.foreground &&
      !input.reducedMotion &&
      !input.hovered &&
      !input.focusWithin,
  };
}
