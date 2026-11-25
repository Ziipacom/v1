/** Add mouse swiping to a web ScrollView without replacing native touch/trackpad scrolling. */
export function horizontalMouseDrag(node: HTMLElement): () => void {
  const doc = node.ownerDocument;
  const original = {
    cursor: node.style.cursor,
    userSelect: node.style.userSelect,
  };
  let start: {
    id: number;
    x: number;
    y: number;
    scroll: number;
    dragging: boolean;
  } | null = null;
  let suppressClick = false;
  node.style.cursor = "grab";
  node.style.userSelect = "none";
  const down = (event: PointerEvent) => {
    suppressClick = false;
    if (
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      !event.isPrimary ||
      node.scrollWidth <= node.clientWidth
    )
      return;
    start = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scroll: node.scrollLeft,
      dragging: false,
    };
  };
  const move = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (!start.dragging && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
      start.dragging = true;
      suppressClick = true;
      node.style.cursor = "grabbing";
    }
    if (!start.dragging) return;
    if (event.cancelable) event.preventDefault();
    node.scrollLeft = start.scroll - dx;
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== start?.id) return;
    start = null;
    node.style.cursor = "grab";
  };
  const click = (event: MouseEvent) => {
    // Keyboard activation has detail0. A fresh pointerdown resets suppression,
    // so a completed drag cannot consume the next genuine click.
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  node.addEventListener("pointerdown", down);
  doc.addEventListener("pointermove", move, { passive: false });
  doc.addEventListener("pointerup", up);
  doc.addEventListener("pointercancel", up);
  node.addEventListener("click", click, true);
  return () => {
    start = null;
    node.style.cursor = original.cursor;
    node.style.userSelect = original.userSelect;
    node.removeEventListener("pointerdown", down);
    doc.removeEventListener("pointermove", move);
    doc.removeEventListener("pointerup", up);
    doc.removeEventListener("pointercancel", up);
    node.removeEventListener("click", click, true);
  };
}
