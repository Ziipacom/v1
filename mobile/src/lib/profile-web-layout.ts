import type { ProfileCardBounds, ProfileViewport } from "./profile-preview";

export type ProfileWebLayout = {
  bounds: Record<string, ProfileCardBounds>;
  viewport: ProfileViewport;
};

/** Web layout events describe positions at the time of that event. Read the
 * current DOM rectangles together so nested scrolling and later layout shifts
 * cannot mix a stale feed offset with a fresh scroll offset. */
export function measureProfileWebLayout(
  scroller: Element,
  cards: ReadonlyMap<string, Element>,
  windowHeight: number,
): ProfileWebLayout {
  const scrollRect = scroller.getBoundingClientRect();
  const top = Math.max(0, scrollRect.top);
  const bottom = Math.min(windowHeight, scrollRect.bottom);
  const bounds: Record<string, ProfileCardBounds> = {};
  if (scroller.isConnected) {
    for (const [id, card] of cards) {
      if (!card.isConnected) continue;
      const rect = card.getBoundingClientRect();
      bounds[id] = { top: rect.top, height: rect.height };
    }
  }
  return {
    bounds,
    viewport: { top, height: Math.max(0, bottom - top), gridTop: 0 },
  };
}

export function sameProfileWebLayout(
  previous: ProfileWebLayout,
  next: ProfileWebLayout,
) {
  return (
    previous.viewport.top === next.viewport.top &&
    previous.viewport.height === next.viewport.height &&
    Object.keys(previous.bounds).length === Object.keys(next.bounds).length &&
    Object.entries(next.bounds).every(
      ([id, bounds]) =>
        previous.bounds[id]?.top === bounds.top &&
        previous.bounds[id]?.height === bounds.height,
    )
  );
}

/** One observer set for the whole feed; no extra player or media request per
 * card. A single animation frame batches related scroll/layout notifications. */
export function observeProfileWebLayout(
  scroller: Element,
  cards: ReadonlyMap<string, Element>,
  receive: (layout: ProfileWebLayout) => void,
) {
  const doc = scroller.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  let stopped = false;
  let frame: number | null = null;
  let previous: ProfileWebLayout | null = null;
  const measure = () => {
    frame = null;
    if (stopped) return;
    const next = measureProfileWebLayout(scroller, cards, win.innerHeight);
    if (!previous || !sameProfileWebLayout(previous, next)) {
      previous = next;
      receive(next);
    }
  };
  const schedule = () => {
    if (!stopped && frame === null) frame = win.requestAnimationFrame(measure);
  };
  // Capture also observes a containing page scroll, not only this ScrollView.
  win.addEventListener("scroll", schedule, true);
  win.addEventListener("resize", schedule);
  const resize =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  resize?.observe(scroller);
  if (scroller.firstElementChild) resize?.observe(scroller.firstElementChild);
  for (const card of cards.values()) resize?.observe(card);
  const intersection =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(schedule, {
          root: scroller,
          threshold: [0, 0.5, 1],
        });
  for (const card of cards.values()) intersection?.observe(card);
  doc.fonts?.addEventListener("loadingdone", schedule);
  void doc.fonts?.ready.then(schedule);
  measure();
  return () => {
    stopped = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    win.removeEventListener("scroll", schedule, true);
    win.removeEventListener("resize", schedule);
    doc.fonts?.removeEventListener("loadingdone", schedule);
    resize?.disconnect();
    intersection?.disconnect();
  };
}
