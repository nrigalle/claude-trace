import { describe, expect, it } from "vitest";
import {
  aggregateMemoryEdits,
  isAutoMemoryFile,
  memoryActionForTool,
  type RawMemoryEdit,
} from "../../src/domain/memory";

const memPath = "/home/u/.claude/projects/-home-u-proj/memory/notes.md";

describe("isAutoMemoryFile", () => {
  it("accepts a markdown file in any project memory dir", () => {
    expect(isAutoMemoryFile(memPath)).toBe(true);
    expect(isAutoMemoryFile("/Users/x/.claude/projects/-Users-x-app/memory/topic.md")).toBe(true);
  });

  it("accepts files in nested memory subdirectories", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-p/memory/feedback/style.md")).toBe(true);
  });

  it("rejects the MEMORY.md index file", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-p/memory/MEMORY.md")).toBe(false);
  });

  it("rejects non-markdown files inside memory dir", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-p/memory/notes.txt")).toBe(false);
  });

  it("rejects files outside any memory dir", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-p/transcript.jsonl")).toBe(false);
    expect(isAutoMemoryFile("/home/u/code/project/CLAUDE.md")).toBe(false);
    expect(isAutoMemoryFile("/home/u/.claude/CLAUDE.md")).toBe(false);
  });

  it("rejects empty or malformed input", () => {
    expect(isAutoMemoryFile("")).toBe(false);
    expect(isAutoMemoryFile("relative/path.md")).toBe(false);
  });
});

describe("memoryActionForTool", () => {
  it("maps Write, Edit, MultiEdit to their actions", () => {
    expect(memoryActionForTool("Write")).toBe("write");
    expect(memoryActionForTool("Edit")).toBe("edit");
    expect(memoryActionForTool("MultiEdit")).toBe("multiedit");
  });

  it("returns null for any other tool", () => {
    expect(memoryActionForTool("Bash")).toBeNull();
    expect(memoryActionForTool("Read")).toBeNull();
    expect(memoryActionForTool("NotebookEdit")).toBeNull();
  });
});

describe("aggregateMemoryEdits", () => {
  const raw = (overrides: Partial<RawMemoryEdit>): RawMemoryEdit => ({
    ts: 0,
    filePath: memPath,
    added: 0,
    removed: 0,
    action: "edit",
    ...overrides,
  });

  it("returns an empty array for no edits", () => {
    expect(aggregateMemoryEdits([])).toEqual([]);
  });

  it("groups consecutive edits to the same file into one summary", () => {
    const result = aggregateMemoryEdits([
      raw({ ts: 1, added: 2, removed: 1, action: "edit" }),
      raw({ ts: 2, added: 3, removed: 0, action: "edit" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.count).toBe(2);
    expect(result[0]!.added).toBe(5);
    expect(result[0]!.removed).toBe(1);
    expect(result[0]!.latestTs).toBe(2);
  });

  it("uses 'write' as dominant action when any edit was a write", () => {
    const result = aggregateMemoryEdits([
      raw({ ts: 1, action: "edit" }),
      raw({ ts: 2, action: "write" }),
      raw({ ts: 3, action: "edit" }),
    ]);
    expect(result[0]!.dominantAction).toBe("write");
  });

  it("uses 'multiedit' when MultiEdit was used and there is no Write", () => {
    const result = aggregateMemoryEdits([
      raw({ ts: 1, action: "edit" }),
      raw({ ts: 2, action: "multiedit" }),
    ]);
    expect(result[0]!.dominantAction).toBe("multiedit");
  });

  it("uses 'edit' when only Edit was used", () => {
    const result = aggregateMemoryEdits([
      raw({ ts: 1, action: "edit" }),
      raw({ ts: 2, action: "edit" }),
    ]);
    expect(result[0]!.dominantAction).toBe("edit");
  });

  it("sorts files by latest timestamp descending", () => {
    const result = aggregateMemoryEdits([
      raw({ ts: 100, filePath: "/home/u/.claude/projects/-p/memory/old.md" }),
      raw({ ts: 300, filePath: "/home/u/.claude/projects/-p/memory/new.md" }),
      raw({ ts: 200, filePath: "/home/u/.claude/projects/-p/memory/mid.md" }),
    ]);
    expect(result.map((r) => r.fileName)).toEqual(["new.md", "mid.md", "old.md"]);
  });

  it("extracts the basename for display", () => {
    const result = aggregateMemoryEdits([
      raw({ filePath: "/a/b/c/memory/nested/topic.md" }),
    ]);
    expect(result[0]!.fileName).toBe("topic.md");
  });
});
