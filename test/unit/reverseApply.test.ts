import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FileChange } from "../../src/domain/fileEdits";
import { computeBeforeContent } from "../../src/domain/reverseApply";

const edit = (
  oldString: string,
  newString: string,
  overrides: { ts?: number } = {},
): FileChange => ({
  kind: "edit",
  ts: overrides.ts ?? 0,
  oldString,
  newString,
});

const write = (content: string, overrides: { ts?: number } = {}): FileChange => ({
  kind: "write",
  ts: overrides.ts ?? 0,
  content,
});

describe("computeBeforeContent", () => {
  it("returns current content unchanged when there are no changes", () => {
    const result = computeBeforeContent("alpha\nbeta", []);
    expect(result).toEqual({ ok: true, before: "alpha\nbeta" });
  });

  it("reverses a single edit by replacing newString with oldString", () => {
    const current = "const a = 2;\nconst b = 3;";
    const result = computeBeforeContent(current, [edit("const a = 1;", "const a = 2;")]);
    expect(result).toEqual({ ok: true, before: "const a = 1;\nconst b = 3;" });
  });

  it("reverses multiple edits in last-to-first order", () => {
    const current = "z\nbeta\ny";
    const changes: FileChange[] = [
      edit("a", "alpha", { ts: 1 }),
      edit("alpha", "x", { ts: 2 }),
      edit("x", "z", { ts: 3 }),
    ];
    const result = computeBeforeContent(current, changes);
    expect(result).toEqual({ ok: true, before: "a\nbeta\ny" });
  });

  it("returns empty before when the change list contains any write", () => {
    const result = computeBeforeContent("anything", [
      edit("foo", "bar"),
      write("entirely new content"),
    ]);
    expect(result).toEqual({ ok: true, before: "" });
  });

  it("reports drift when newString is not present in current content", () => {
    const result = computeBeforeContent("real content", [edit("foo", "missing")]);
    expect(result).toEqual({ ok: false, reason: "drift" });
  });

  it("reports drift when newString appears more than once (ambiguous reverse target)", () => {
    const current = "TOKEN here and TOKEN there";
    const result = computeBeforeContent(current, [edit("X", "TOKEN")]);
    expect(result).toEqual({ ok: false, reason: "drift" });
  });

  it("reports drift on an edit with an empty newString (no anchor to reverse)", () => {
    const result = computeBeforeContent("hello world", [edit("hi ", "")]);
    expect(result).toEqual({ ok: false, reason: "drift" });
  });

  it("handles edits whose newString is shorter than oldString", () => {
    const result = computeBeforeContent("x", [edit("aaa", "x")]);
    expect(result).toEqual({ ok: true, before: "aaa" });
  });

  it("does not match overlapping occurrences with itself", () => {
    const result = computeBeforeContent("ababab", [edit("Y", "abab")]);
    expect(result).toEqual({ ok: true, before: "Yab" });
  });

  it("round-trips a forward-applied edit chain (property)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 32 }),
        fc.array(fc.uuidV(4), { minLength: 1, maxLength: 5 }),
        (seed, tokens) => {
          const sentinel0 = tokens[0]!;
          const initial = `${seed}${sentinel0}`;
          let working = initial;
          const changes: FileChange[] = [];
          let prev = sentinel0;
          for (let i = 1; i < tokens.length; i++) {
            const next = tokens[i]!;
            if (next === prev) continue;
            working = working.replace(prev, next);
            changes.push(edit(prev, next, { ts: i }));
            prev = next;
          }
          const result = computeBeforeContent(working, changes);
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.before).toBe(initial);
        },
      ),
      { numRuns: 100 },
    );
  });
});
