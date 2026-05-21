import { h } from "../h.js";
import { clampSidebarWidth } from "./sidebarWidth.js";

export interface SidebarResizerOptions {
  readonly target: HTMLElement;
  readonly initialPx: number;
  readonly onLivePx: (px: number) => void;
  readonly onCommitPx: (px: number) => void;
}

export class SidebarResizer {
  readonly element: HTMLElement;
  private activePointerId: number | null = null;
  private targetLeftPx = 0;

  constructor(private readonly opts: SidebarResizerOptions) {
    this.applyWidth(opts.initialPx);
    this.element = h("div", {
      className: "sidebar-resizer",
      attrs: { role: "separator", "aria-orientation": "vertical", "aria-label": "Resize sidebar" },
      on: {
        pointerdown: (e) => this.onPointerDown(e),
        pointermove: (e) => this.onPointerMove(e),
        pointerup: (e) => this.onPointerUp(e),
        pointercancel: (e) => this.onPointerUp(e),
        dblclick: () => this.onDoubleClick(),
      },
    });
  }

  setWidth(px: number): void {
    this.applyWidth(px);
  }

  private applyWidth(px: number): void {
    const clamped = clampSidebarWidth(px);
    this.opts.target.style.setProperty("--ct-sidebar-width", `${clamped}px`);
    this.opts.onLivePx(clamped);
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.activePointerId = e.pointerId;
    this.targetLeftPx = this.opts.target.getBoundingClientRect().left;
    this.element.setPointerCapture(e.pointerId);
    this.element.classList.add("dragging");
    document.body.classList.add("sidebar-resizing");
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.activePointerId !== e.pointerId) return;
    this.applyWidth(e.clientX - this.targetLeftPx);
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.activePointerId !== e.pointerId) return;
    this.activePointerId = null;
    this.element.releasePointerCapture(e.pointerId);
    this.element.classList.remove("dragging");
    document.body.classList.remove("sidebar-resizing");
    const committed = clampSidebarWidth(this.opts.target.getBoundingClientRect().width);
    this.opts.onCommitPx(committed);
  }

  private onDoubleClick(): void {
    this.applyWidth(300);
    this.opts.onCommitPx(300);
  }
}
