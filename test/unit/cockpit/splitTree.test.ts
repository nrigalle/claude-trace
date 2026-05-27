import { describe, expect, it } from "vitest";
import { addLeaf, dock, leaf, leafIds, removeLeaf, syncTree, type LayoutNode } from "../../../src/features/cockpit/domain/splitTree";

describe("splitTree — add and remove", () => {
  it("a single window is a bare leaf", () => {
    expect(addLeaf(null, "a")).toEqual({ kind: "leaf", id: "a" });
  });

  it("the second window makes a row split (side by side)", () => {
    const t = addLeaf(addLeaf(null, "a"), "b");
    expect(t).toEqual({ kind: "split", dir: "row", sizes: [1, 1], children: [leaf("a"), leaf("b")] });
  });

  it("further windows append to the root split rather than nesting deeper", () => {
    const t = addLeaf(addLeaf(addLeaf(null, "a"), "b"), "c");
    expect(t.kind).toBe("split");
    expect(leafIds(t)).toEqual(["a", "b", "c"]);
    expect((t as { children: LayoutNode[] }).children).toHaveLength(3);
  });

  it("removing a leaf collapses a now-single-child split", () => {
    const t = addLeaf(addLeaf(null, "a"), "b");
    expect(removeLeaf(t, "b")).toEqual({ kind: "leaf", id: "a" });
  });

  it("removing the only leaf yields an empty tree", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("removing drops the matching size so weights stay aligned", () => {
    const t: LayoutNode = { kind: "split", dir: "row", sizes: [3, 1, 2], children: [leaf("a"), leaf("b"), leaf("c")] };
    const out = removeLeaf(t, "b") as { sizes: number[] };
    expect(out.sizes).toEqual([3, 2]);
  });
});

describe("splitTree — dock (drag a window onto an edge)", () => {
  it("docking to the right of a lone window makes a row split", () => {
    const t = dock(addLeaf(addLeaf(null, "a"), "b"), "b", "a", "right");
    expect(leafIds(t)).toEqual(["a", "b"]);
    expect((t as { dir: string }).dir).toBe("row");
  });

  it("docking below a window nests a column perpendicular to the row parent", () => {
    const start: LayoutNode = { kind: "split", dir: "row", sizes: [1, 1, 1], children: [leaf("a"), leaf("b"), leaf("c")] };
    const out = dock(start, "c", "a", "bottom");
    expect((out as { dir: string }).dir).toBe("row");
    const first = (out as { children: LayoutNode[] }).children[0]!;
    expect(first.kind).toBe("split");
    expect((first as { dir: string }).dir).toBe("col");
    expect(leafIds(first)).toEqual(["a", "c"]);
  });

  it("docking the only other window below makes a simple column split", () => {
    const start: LayoutNode = { kind: "split", dir: "row", sizes: [1, 1], children: [leaf("a"), leaf("b")] };
    const out = dock(start, "b", "a", "bottom");
    expect((out as { dir: string }).dir).toBe("col");
    expect(leafIds(out)).toEqual(["a", "b"]);
  });

  it("docking a window beside a same-axis sibling flattens instead of nesting", () => {
    const start: LayoutNode = { kind: "split", dir: "row", sizes: [1, 1, 1], children: [leaf("a"), leaf("b"), leaf("c")] };
    const out = dock(start, "c", "a", "right") as { children: LayoutNode[]; dir: string };
    expect(out.dir).toBe("row");
    expect(out.children).toHaveLength(3);
    expect(leafIds(out)).toEqual(["a", "c", "b"]);
  });

  it("docking onto itself is a no-op", () => {
    const t = addLeaf(addLeaf(null, "a"), "b");
    expect(dock(t, "a", "a", "right")).toBe(t);
  });

  it("every dock preserves the full set of windows", () => {
    const edges = ["left", "right", "top", "bottom"] as const;
    let t = addLeaf(addLeaf(addLeaf(addLeaf(null, "a"), "b"), "c"), "d");
    for (const e of edges) t = dock(t, "d", "a", e);
    expect([...leafIds(t)].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("splitTree — syncTree keeps the tree matching the live windows", () => {
  it("adds windows that appeared and removes windows that are gone", () => {
    const t = addLeaf(addLeaf(null, "a"), "b");
    const out = syncTree(t, ["a", "c"]);
    expect([...leafIds(out)].sort()).toEqual(["a", "c"]);
  });

  it("an empty set of windows yields an empty tree", () => {
    expect(syncTree(addLeaf(null, "a"), [])).toBeNull();
  });

  it("starting from nothing builds a tree of all present windows", () => {
    expect([...leafIds(syncTree(null, ["a", "b", "c"]))].sort()).toEqual(["a", "b", "c"]);
  });
});
