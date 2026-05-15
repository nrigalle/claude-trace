import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySection } from "../../../media/src/ui/panels/MemorySection";
import { toSessionId, type FileEditSummary, type SessionDetail } from "../../../src/domain/types";

const baseDetail = (overrides: Partial<SessionDetail>): SessionDetail => ({
  session_id: toSessionId("s"),
  title: null,
  event_count: 0,
  tool_count: 0,
  tools: [],
  duration_ms: 0,
  started_at: null,
  ended_at: null,
  cwd: null,
  cost: null,
  context_window: null,
  model: null,
  last_modified_ms: 0,
  events: [],
  tool_stats: [],
  context_timeline: [],
  cost_timeline: [],
  memory_edits: [],
  ...overrides,
});

const edit = (overrides: Partial<FileEditSummary>): FileEditSummary => ({
  filePath: "/home/u/.claude/projects/-p/memory/feedback.md",
  fileName: "feedback.md",
  latestTs: Date.UTC(2026, 4, 1, 10),
  count: 1,
  added: 3,
  removed: 0,
  dominantAction: "edit",
  ...overrides,
});

describe("MemorySection — visibility", () => {
  it("is hidden when there are no memory edits", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({ memory_edits: [] }));
    expect(view.element().hidden).toBe(true);
  });

  it("becomes visible when memory edits arrive", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({ memory_edits: [edit({})] }));
    expect(view.element().hidden).toBe(false);
  });

  it("hides again when edits disappear", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({ memory_edits: [edit({})] }));
    view.update(baseDetail({ memory_edits: [] }));
    expect(view.element().hidden).toBe(true);
  });
});

describe("MemorySection — rendering", () => {
  it("renders one row per file", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({
      memory_edits: [
        edit({ filePath: "/a/b/memory/x.md", fileName: "x.md" }),
        edit({ filePath: "/a/b/memory/y.md", fileName: "y.md" }),
      ],
    }));
    expect(view.element().querySelectorAll(".file-edits-row")).toHaveLength(2);
  });

  it("shows the count chip only when count > 1", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({ memory_edits: [edit({ count: 3 })] }));
    const countEl = view.element().querySelector<HTMLElement>(".file-edits-row-count")!;
    expect(countEl.hidden).toBe(false);
    expect(countEl.textContent).toBe("×3");
  });

  it("hides the count chip when count is 1", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({ memory_edits: [edit({ count: 1 })] }));
    expect(view.element().querySelector<HTMLElement>(".file-edits-row-count")!.hidden).toBe(true);
  });

  it("renders write-only diffs as +N", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({
      memory_edits: [edit({ dominantAction: "write", added: 12, removed: 0 })],
    }));
    expect(view.element().querySelector(".file-edits-row-diff")!.textContent).toBe("+12");
  });

  it("renders edit diffs as +N / -M", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({
      memory_edits: [edit({ dominantAction: "edit", added: 5, removed: 2 })],
    }));
    expect(view.element().querySelector(".file-edits-row-diff")!.textContent).toBe("+5 / -2");
  });
});

describe("MemorySection — DOM identity across updates", () => {
  it("reuses the same row element when the file persists", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    document.body.appendChild(view.element());
    view.update(baseDetail({ memory_edits: [edit({ added: 1 })] }));
    const before = view.element().querySelector(".file-edits-row");
    view.update(baseDetail({ memory_edits: [edit({ added: 9 })] }));
    const after = view.element().querySelector(".file-edits-row");
    expect(after).toBe(before);
  });

  it("removes rows for files that drop out of the list", () => {
    const view = new MemorySection({ onOpenFile: () => {}, onOpenFolder: () => {} });
    view.update(baseDetail({
      memory_edits: [
        edit({ filePath: "/a/memory/keep.md", fileName: "keep.md" }),
        edit({ filePath: "/a/memory/drop.md", fileName: "drop.md" }),
      ],
    }));
    expect(view.element().querySelectorAll(".file-edits-row")).toHaveLength(2);
    view.update(baseDetail({
      memory_edits: [edit({ filePath: "/a/memory/keep.md", fileName: "keep.md" })],
    }));
    expect(view.element().querySelectorAll(".file-edits-row")).toHaveLength(1);
    expect(view.element().querySelector(".file-edits-row-name")!.textContent).toBe("keep.md");
  });
});

describe("MemorySection — actions", () => {
  let onOpenFile: ReturnType<typeof vi.fn>;
  let onOpenFolder: ReturnType<typeof vi.fn>;
  let view: MemorySection;

  beforeEach(() => {
    onOpenFile = vi.fn();
    onOpenFolder = vi.fn();
    view = new MemorySection({ onOpenFile, onOpenFolder });
  });

  it("Open button invokes onOpenFile with the absolute path", () => {
    view.update(baseDetail({
      memory_edits: [edit({ filePath: "/a/b/memory/x.md", fileName: "x.md" })],
    }));
    view.element().querySelector<HTMLButtonElement>(".file-edits-row-open")!.click();
    expect(onOpenFile).toHaveBeenCalledWith("/a/b/memory/x.md");
  });

  it("Open folder button invokes onOpenFolder", () => {
    view.update(baseDetail({ memory_edits: [edit({})] }));
    view.element().querySelector<HTMLButtonElement>(".file-edits-folder")!.click();
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });
});
