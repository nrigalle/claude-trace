import { describe, expect, it } from "vitest";
import { normalizeDetailLayout, DETAIL_BLOCKS } from "../../media/src/state/Store";

const ALL_IDS = DETAIL_BLOCKS.map((b) => b.id);

describe("normalizeDetailLayout — the persisted, global dashboard layout", () => {
  it("with no saved layout, returns every block visible at full width in canonical order", () => {
    const layout = normalizeDetailLayout(undefined);
    expect(layout.map((c) => c.id)).toEqual(ALL_IDS);
    expect(layout.every((c) => c.visible)).toBe(true);
    expect(layout.every((c) => c.span === 2)).toBe(true);
  });

  it("ignores non-array / garbage input and falls back to all blocks", () => {
    for (const junk of [null, 42, "x", {}, true]) {
      expect(normalizeDetailLayout(junk).map((c) => c.id)).toEqual(ALL_IDS);
    }
  });

  it("honors a saved order and appends any blocks missing from the saved data", () => {
    const saved = [
      { id: "timeline", visible: true, span: 2 },
      { id: "cost", visible: true, span: 1 },
    ];
    const layout = normalizeDetailLayout(saved);
    expect(layout.slice(0, 2).map((c) => c.id)).toEqual(["timeline", "cost"]);
    const appended = layout.slice(2);
    expect(appended.map((c) => c.id)).toEqual(ALL_IDS.filter((id) => id !== "timeline" && id !== "cost"));
    expect(appended.every((c) => c.visible && c.span === 2)).toBe(true);
  });

  it("preserves visibility: an explicit visible:false hides; omitted defaults to visible", () => {
    const layout = normalizeDetailLayout([
      { id: "cards", visible: false },
      { id: "charts" },
    ]);
    expect(layout.find((c) => c.id === "cards")!.visible).toBe(false);
    expect(layout.find((c) => c.id === "charts")!.visible).toBe(true);
  });

  it("clamps span to exactly 1 or 2 (1 stays half, everything else becomes full)", () => {
    const layout = normalizeDetailLayout([
      { id: "cards", visible: true, span: 1 },
      { id: "charts", visible: true, span: 2 },
      { id: "cost", visible: true, span: 99 },
      { id: "files", visible: true, span: 0 },
      { id: "memory", visible: true },
    ]);
    expect(layout.find((c) => c.id === "cards")!.span).toBe(1);
    expect(layout.find((c) => c.id === "charts")!.span).toBe(2);
    expect(layout.find((c) => c.id === "cost")!.span).toBe(2);
    expect(layout.find((c) => c.id === "files")!.span).toBe(2);
    expect(layout.find((c) => c.id === "memory")!.span).toBe(2);
  });

  it("drops unknown ids and de-duplicates repeated ids (first wins)", () => {
    const layout = normalizeDetailLayout([
      { id: "ghost", visible: true },
      { id: "cards", visible: false, span: 1 },
      { id: "cards", visible: true, span: 2 },
    ]);
    expect(layout.filter((c) => c.id === "cards")).toHaveLength(1);
    expect(layout.find((c) => c.id === "cards")).toEqual({ id: "cards", visible: false, span: 1 });
    expect(layout.some((c) => (c.id as string) === "ghost")).toBe(false);
    expect(layout).toHaveLength(ALL_IDS.length);
  });

  it("always returns exactly the six known blocks, no more no fewer", () => {
    const layout = normalizeDetailLayout([{ id: "cards", visible: false }]);
    expect(new Set(layout.map((c) => c.id))).toEqual(new Set(ALL_IDS));
  });
});
