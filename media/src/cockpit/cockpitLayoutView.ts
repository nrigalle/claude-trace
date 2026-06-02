import type { LayoutNode } from "../../../src/features/cockpit/domain/splitTree";
import { h } from "../ui/h.js";

const ROW_HEIGHT_PER_WEIGHT = 150;

type SplitNode = Extract<LayoutNode, { readonly kind: "split" }>;

interface LayoutViewDeps {
  tile(id: string): HTMLElement | null;
  setResizing(value: boolean): void;
  fitVisible(): void;
  saveLayout(): void;
}

export const renderLayoutNode = (node: LayoutNode, deps: LayoutViewDeps): HTMLElement => {
  if (node.kind === "leaf") return deps.tile(node.id) ?? h("div");
  const container = h("div", { className: `tc-split tc-split-${node.dir}` });
  node.children.forEach((child, i) => {
    if (i > 0) container.appendChild(createDivider(node, i - 1, deps));
    const weight = node.sizes[i] ?? 1;
    const cell = h("div", { className: "tc-split-cell" }, renderLayoutNode(child, deps));
    cell.style.flexGrow = String(weight);
    if (node.dir === "col") cell.style.minHeight = `${weight * ROW_HEIGHT_PER_WEIGHT}px`;
    container.appendChild(cell);
  });
  return container;
};

const createDivider = (node: SplitNode, index: number, deps: LayoutViewDeps): HTMLElement => {
  const horizontal = node.dir === "row";
  const handle = h("div", { className: `tc-divider tc-divider-${horizontal ? "v" : "h"}` });
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    deps.setResizing(true);
    const prev = handle.previousElementSibling as HTMLElement;
    const next = handle.nextElementSibling as HTMLElement;
    const startPos = horizontal ? e.clientX : e.clientY;
    const prevPx = horizontal ? prev.offsetWidth : prev.offsetHeight;
    const nextPx = horizontal ? next.offsetWidth : next.offsetHeight;
    const totalPx = prevPx + nextPx;
    const totalW = (node.sizes[index] ?? 1) + (node.sizes[index + 1] ?? 1);
    const move = (ev: PointerEvent): void => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
      const np = Math.max(80, Math.min(totalPx - 80, prevPx + delta));
      const ratio = np / totalPx;
      const a = totalW * ratio;
      const b = totalW * (1 - ratio);
      node.sizes[index] = a;
      node.sizes[index + 1] = b;
      prev.style.flexGrow = String(a);
      next.style.flexGrow = String(b);
      if (!horizontal) {
        prev.style.minHeight = `${a * ROW_HEIGHT_PER_WEIGHT}px`;
        next.style.minHeight = `${b * ROW_HEIGHT_PER_WEIGHT}px`;
      }
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      deps.setResizing(false);
      deps.fitVisible();
      deps.saveLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  return handle;
};
