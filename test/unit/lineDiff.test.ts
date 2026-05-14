import { describe, expect, it } from "vitest";
import { lineDiffFromToolInput, ZERO_DIFF } from "../../src/domain/lineDiff";

describe("lineDiffFromToolInput", () => {
  it("returns ZERO_DIFF for non-editing tools", () => {
    expect(lineDiffFromToolInput("Bash", { command: "ls" })).toEqual(ZERO_DIFF);
    expect(lineDiffFromToolInput("Read", { file_path: "/x" })).toEqual(ZERO_DIFF);
    expect(lineDiffFromToolInput("Unknown", {})).toEqual(ZERO_DIFF);
  });

  it("Write counts every line in content as added, none removed", () => {
    expect(lineDiffFromToolInput("Write", { content: "a\nb\nc" })).toEqual({ added: 3, removed: 0 });
    expect(lineDiffFromToolInput("Write", { content: "one" })).toEqual({ added: 1, removed: 0 });
  });

  it("Write with empty or missing content is a no-op", () => {
    expect(lineDiffFromToolInput("Write", { content: "" })).toEqual(ZERO_DIFF);
    expect(lineDiffFromToolInput("Write", {})).toEqual(ZERO_DIFF);
  });

  it("Edit counts new_string as added and old_string as removed", () => {
    expect(
      lineDiffFromToolInput("Edit", { old_string: "a\nb", new_string: "c\nd\ne" }),
    ).toEqual({ added: 3, removed: 2 });
  });

  it("Edit handles single-line swaps", () => {
    expect(
      lineDiffFromToolInput("Edit", { old_string: "x = 1", new_string: "x = 2" }),
    ).toEqual({ added: 1, removed: 1 });
  });

  it("MultiEdit sums all edit entries", () => {
    const input = {
      edits: [
        { old_string: "a", new_string: "b\nc" },
        { old_string: "d\ne\nf", new_string: "g" },
      ],
    };
    expect(lineDiffFromToolInput("MultiEdit", input)).toEqual({ added: 3, removed: 4 });
  });

  it("MultiEdit returns ZERO_DIFF when edits array is missing or malformed", () => {
    expect(lineDiffFromToolInput("MultiEdit", {})).toEqual(ZERO_DIFF);
    expect(lineDiffFromToolInput("MultiEdit", { edits: "not-an-array" })).toEqual(ZERO_DIFF);
  });

  it("NotebookEdit uses old_source/new_source fields", () => {
    expect(
      lineDiffFromToolInput("NotebookEdit", { old_source: "a\nb", new_source: "x" }),
    ).toEqual({ added: 1, removed: 2 });
  });
});
