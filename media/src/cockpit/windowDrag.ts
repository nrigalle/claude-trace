import type { DropEdge } from "../../../src/features/cockpit/domain/splitTree";

export interface WindowDragHost {
  tileFor(windowId: string): HTMLElement | undefined;
  tileElements(): Iterable<HTMLElement>;
  readonly folderBar: HTMLElement;
  moveToFolder(windowId: string, folder: string): void;
  dock(dragged: string, target: string, edge: DropEdge): void;
  dragEnded(): void;
}

export const wireWindowDrag = (host: WindowDragHost, head: HTMLElement, tile: HTMLElement, windowId: string): void => {
  head.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".tc-tab, .tc-tab-add, .tc-tab-pause"))) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        tile.classList.add("tc-tile-dragging");
        document.body.classList.add("tc-dragging-window");
      }
      tile.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`;
      highlightDrop(host, ev, windowId);
    };
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      tile.style.transform = "";
      tile.classList.remove("tc-tile-dragging");
      document.body.classList.remove("tc-dragging-window");
      clearDropHint(host);
      if (dragging) {
        const folder = folderUnder(ev);
        if (folder !== null) {
          host.moveToFolder(windowId, folder);
        } else {
          const hit = windowUnder(ev, windowId);
          if (hit) host.dock(windowId, hit.id, hit.edge);
        }
      }
      host.dragEnded();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
};

const windowUnder = (ev: PointerEvent, self: string): { id: string; edge: DropEdge } | null => {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const tile = el instanceof Element ? (el.closest(".tc-tile[data-window-id]") as HTMLElement | null) : null;
  const id = tile?.dataset["windowId"] ?? null;
  if (!id || id === self) return null;
  return { id, edge: edgeOf(tile!, ev) };
};

const edgeOf = (tile: HTMLElement, ev: PointerEvent): DropEdge => {
  const r = tile.getBoundingClientRect();
  const nx = (ev.clientX - (r.left + r.width / 2)) / (r.width / 2);
  const ny = (ev.clientY - (r.top + r.height / 2)) / (r.height / 2);
  if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? "right" : "left";
  return ny >= 0 ? "bottom" : "top";
};

const folderUnder = (ev: PointerEvent): string | null => {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const chip = el instanceof Element ? (el.closest(".tc-folder[data-folder]") as HTMLElement | null) : null;
  return chip?.getAttribute("data-folder") ?? null;
};

const highlightDrop = (host: WindowDragHost, ev: PointerEvent, self: string): void => {
  clearDropHint(host);
  const hit = windowUnder(ev, self);
  if (hit) {
    const tile = host.tileFor(hit.id);
    tile?.classList.add("tc-drop-target");
    tile?.setAttribute("data-drop-edge", hit.edge);
    return;
  }
  const folder = folderUnder(ev);
  if (folder !== null) {
    for (const chip of host.folderBar.querySelectorAll(`[data-folder="${folder}"]`)) chip.classList.add("drop-target");
  }
};

const clearDropHint = (host: WindowDragHost): void => {
  for (const tile of host.tileElements()) {
    tile.classList.remove("tc-drop-target");
    tile.removeAttribute("data-drop-edge");
  }
  for (const chip of host.folderBar.querySelectorAll(".drop-target")) chip.classList.remove("drop-target");
};
