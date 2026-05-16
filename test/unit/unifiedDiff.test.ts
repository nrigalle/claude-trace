import { describe, expect, it } from "vitest";
import { buildUnifiedDiff } from "../../src/domain/unifiedDiff";
import type { FileChange, FileEditSummary } from "../../src/domain/fileEdits";

const summary = (overrides: Partial<FileEditSummary>): FileEditSummary => ({
  filePath: "/repo/src/auth.ts",
  fileName: "auth.ts",
  latestTs: 0,
  count: 1,
  added: 0,
  removed: 0,
  dominantAction: "edit",
  changes: [],
  ...overrides,
});

const editChange = (overrides: Partial<Extract<FileChange, { kind: "edit" }>>): FileChange => ({
  kind: "edit",
  ts: Date.UTC(2026, 4, 14, 12, 4),
  oldString: "const a = 1;",
  newString: "const a = 2;",
  ...overrides,
});

const writeChange = (overrides: Partial<Extract<FileChange, { kind: "write" }>>): FileChange => ({
  kind: "write",
  ts: Date.UTC(2026, 4, 14, 14, 5),
  content: "line 1\nline 2",
  ...overrides,
});

describe("buildUnifiedDiff", () => {
  it("emits standard --- / +++ header lines", () => {
    const out = buildUnifiedDiff(summary({ changes: [editChange({})] }));
    expect(out).toContain("--- a//repo/src/auth.ts");
    expect(out).toContain("+++ b//repo/src/auth.ts");
  });

  it("prefixes every old_string line with a minus and every new_string line with a plus", () => {
    const out = buildUnifiedDiff(summary({
      changes: [editChange({
        oldString: "alpha\nbeta",
        newString: "gamma\ndelta\nepsilon",
      })],
    }));
    expect(out).toContain("-alpha");
    expect(out).toContain("-beta");
    expect(out).toContain("+gamma");
    expect(out).toContain("+delta");
    expect(out).toContain("+epsilon");
  });

  it("renders write content as all-plus lines", () => {
    const out = buildUnifiedDiff(summary({
      changes: [writeChange({ content: "first\nsecond\nthird" })],
    }));
    expect(out).toContain("+first");
    expect(out).toContain("+second");
    expect(out).toContain("+third");
    expect(bodyLines(out).filter((l) => l.startsWith("-"))).toHaveLength(0);
  });

  it("labels each hunk with Edit or Write and a clock time", () => {
    const out = buildUnifiedDiff(summary({
      changes: [editChange({}), writeChange({})],
    }));
    expect(out).toMatch(/@@ Edit at \d{2}:\d{2}/);
    expect(out).toMatch(/@@ Write at \d{2}:\d{2}/);
  });

  it("numbers hunks when more than one change is present", () => {
    const out = buildUnifiedDiff(summary({
      changes: [editChange({}), editChange({})],
    }));
    expect(out).toContain("change 1 of 2");
    expect(out).toContain("change 2 of 2");
  });

  it("omits hunk numbering when there is exactly one change", () => {
    const out = buildUnifiedDiff(summary({ changes: [editChange({})] }));
    expect(out).not.toContain("change 1 of");
  });

  it("handles trailing newlines in content without producing an empty plus line", () => {
    const out = buildUnifiedDiff(summary({
      changes: [writeChange({ content: "only line\n" })],
    }));
    expect(out.split("\n").filter((l) => l === "+")).toHaveLength(0);
    expect(out).toContain("+only line");
  });

  it("returns content even when changes carry empty strings", () => {
    const out = buildUnifiedDiff(summary({
      changes: [editChange({ oldString: "", newString: "x" })],
    }));
    expect(out).toContain("+x");
    expect(bodyLines(out).filter((l) => l.startsWith("-"))).toHaveLength(0);
  });
});

const bodyLines = (diff: string): string[] =>
  diff.split("\n").filter((line) => !line.startsWith("---") && !line.startsWith("+++"));
