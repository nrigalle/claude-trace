import { describe, expect, it } from "vitest";
import {
  aggregateByFile,
  fileEditActionForTool,
  type RawFileEdit,
} from "../../src/domain/fileEdits";

const raw = (overrides: Partial<RawFileEdit>): RawFileEdit => ({
  ts: 0,
  filePath: "/x/y/src/file.ts",
  added: 0,
  removed: 0,
  action: "edit",
  changes: [],
  ...overrides,
});

describe("fileEditActionForTool", () => {
  it("maps Write, Edit, MultiEdit to their actions", () => {
    expect(fileEditActionForTool("Write")).toBe("write");
    expect(fileEditActionForTool("Edit")).toBe("edit");
    expect(fileEditActionForTool("MultiEdit")).toBe("multiedit");
  });

  it("returns null for unrelated tools", () => {
    expect(fileEditActionForTool("Bash")).toBeNull();
    expect(fileEditActionForTool("Read")).toBeNull();
    expect(fileEditActionForTool("NotebookEdit")).toBeNull();
  });
});

describe("aggregateByFile — no predicate", () => {
  it("returns an empty array when no edits exist", () => {
    expect(aggregateByFile([])).toEqual([]);
  });

  it("groups edits to the same file into a single summary", () => {
    const result = aggregateByFile([
      raw({ ts: 1, added: 3, removed: 1 }),
      raw({ ts: 2, added: 2, removed: 0 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.count).toBe(2);
    expect(result[0]!.added).toBe(5);
    expect(result[0]!.removed).toBe(1);
    expect(result[0]!.latestTs).toBe(2);
  });

  it("computes the dominant action with Write taking precedence", () => {
    expect(
      aggregateByFile([raw({ action: "edit" }), raw({ action: "write" })])[0]!.dominantAction,
    ).toBe("write");
  });

  it("falls back to multiedit when no write was made", () => {
    expect(
      aggregateByFile([raw({ action: "edit" }), raw({ action: "multiedit" })])[0]!.dominantAction,
    ).toBe("multiedit");
  });

  it("falls back to edit when only edits were made", () => {
    expect(
      aggregateByFile([raw({ action: "edit" }), raw({ action: "edit" })])[0]!.dominantAction,
    ).toBe("edit");
  });

  it("sorts results by latest timestamp descending", () => {
    const result = aggregateByFile([
      raw({ ts: 100, filePath: "/x/old.ts" }),
      raw({ ts: 300, filePath: "/x/new.ts" }),
      raw({ ts: 200, filePath: "/x/mid.ts" }),
    ]);
    expect(result.map((r) => r.fileName)).toEqual(["new.ts", "mid.ts", "old.ts"]);
  });
});

describe("aggregateByFile — predicate", () => {
  it("includes only files matching the predicate", () => {
    const predicate = (p: string) => p.endsWith(".ts");
    const result = aggregateByFile(
      [
        raw({ filePath: "/x/keep.ts" }),
        raw({ filePath: "/x/skip.md" }),
        raw({ filePath: "/x/also-keep.ts" }),
      ],
      predicate,
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.fileName).sort()).toEqual(["also-keep.ts", "keep.ts"]);
  });

  it("returns an empty array when no path satisfies the predicate", () => {
    const result = aggregateByFile(
      [raw({ filePath: "/x/file.ts" })],
      () => false,
    );
    expect(result).toEqual([]);
  });
});
