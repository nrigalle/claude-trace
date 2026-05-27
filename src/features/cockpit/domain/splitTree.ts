export type SplitDir = "row" | "col";
export type DropEdge = "left" | "right" | "top" | "bottom";

export type LayoutNode =
  | { readonly kind: "leaf"; readonly id: string }
  | { readonly kind: "split"; readonly dir: SplitDir; readonly sizes: number[]; readonly children: LayoutNode[] };

export const leaf = (id: string): LayoutNode => ({ kind: "leaf", id });

export const leafIds = (node: LayoutNode | null): string[] => {
  if (!node) return [];
  if (node.kind === "leaf") return [node.id];
  return node.children.flatMap(leafIds);
};

const avg = (sizes: readonly number[]): number =>
  sizes.length === 0 ? 1 : sizes.reduce((a, b) => a + b, 0) / sizes.length;

export const addLeaf = (root: LayoutNode | null, id: string): LayoutNode => {
  if (!root) return leaf(id);
  if (root.kind === "split") {
    return { kind: "split", dir: root.dir, children: [...root.children, leaf(id)], sizes: [...root.sizes, avg(root.sizes)] };
  }
  return { kind: "split", dir: "row", sizes: [1, 1], children: [root, leaf(id)] };
};

export const removeLeaf = (root: LayoutNode | null, id: string): LayoutNode | null => {
  if (!root) return null;
  if (root.kind === "leaf") return root.id === id ? null : root;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, i) => {
    const next = removeLeaf(child, id);
    if (next) {
      children.push(next);
      sizes.push(root.sizes[i] ?? 1);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: "split", dir: root.dir, sizes, children };
};

const insertNextTo = (
  node: LayoutNode,
  targetId: string,
  axis: SplitDir,
  before: boolean,
  draggedId: string,
): LayoutNode => {
  if (node.kind === "leaf") {
    if (node.id !== targetId) return node;
    const kids = before ? [leaf(draggedId), node] : [node, leaf(draggedId)];
    return { kind: "split", dir: axis, sizes: [1, 1], children: kids };
  }
  const directIdx = node.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
  if (directIdx !== -1 && node.dir === axis) {
    const at = before ? directIdx : directIdx + 1;
    const children = [...node.children];
    const sizes = [...node.sizes];
    children.splice(at, 0, leaf(draggedId));
    sizes.splice(at, 0, avg(node.sizes));
    return { kind: "split", dir: node.dir, sizes, children };
  }
  return { kind: "split", dir: node.dir, sizes: [...node.sizes], children: node.children.map((c) => insertNextTo(c, targetId, axis, before, draggedId)) };
};

export const dock = (root: LayoutNode, draggedId: string, targetId: string, edge: DropEdge): LayoutNode => {
  if (draggedId === targetId) return root;
  const without = removeLeaf(root, draggedId);
  if (!without) return root;
  const axis: SplitDir = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  return insertNextTo(without, targetId, axis, before, draggedId);
};

export const syncTree = (root: LayoutNode | null, presentIds: readonly string[]): LayoutNode | null => {
  const present = new Set(presentIds);
  let next = root;
  for (const id of leafIds(root)) {
    if (!present.has(id)) next = removeLeaf(next, id);
  }
  const have = new Set(leafIds(next));
  for (const id of presentIds) {
    if (!have.has(id)) next = addLeaf(next, id);
  }
  return next;
};
