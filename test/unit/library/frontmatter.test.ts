import { describe, expect, it } from "vitest";
import { parseFile, serializeFile } from "../../../src/features/library/domain/frontmatter";

describe("parseFile", () => {
  it("returns empty frontmatter when source has none", () => {
    const result = parseFile("hello world\n");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("hello world\n");
  });

  it("parses scalar string, number, boolean, and null", () => {
    const result = parseFile("---\nname: alex\nrate: 42\nactive: true\nnote: null\n---\nbody");
    expect(result.frontmatter).toEqual({ name: "alex", rate: 42, active: true, note: null });
    expect(result.body).toBe("body");
  });

  it("parses inline list and block list of strings", () => {
    const inline = parseFile("---\ntags: [a, b, c]\n---\n");
    expect(inline.frontmatter["tags"]).toEqual(["a", "b", "c"]);
    const block = parseFile("---\nskills:\n  - one\n  - two\n---\n");
    expect(block.frontmatter["skills"]).toEqual(["one", "two"]);
  });

  it("preserves quoted strings with reserved characters", () => {
    const r = parseFile('---\ndescription: "a: with colon"\n---\n');
    expect(r.frontmatter["description"]).toBe("a: with colon");
  });

  it("parses block scalar bodies (pipe)", () => {
    const r = parseFile("---\nbody: |\n  one\n  two\n---\nmd");
    expect(r.frontmatter["body"]).toBe("one\ntwo");
    expect(r.body).toBe("md");
  });

  it("parses nested key/value object", () => {
    const r = parseFile("---\nmetadata:\n  author: alex\n  version: 1.2.0\n---\n");
    expect(r.frontmatter["metadata"]).toEqual({ author: "alex", version: "1.2.0" });
  });

  it("returns empty frontmatter on unterminated block (does not throw)", () => {
    const r = parseFile("---\nname: alex\n");
    expect(r.frontmatter).toEqual({});
    expect(r.body).toContain("name: alex");
  });
});

describe("serializeFile", () => {
  it("roundtrips a typical skill file", () => {
    const fm = { name: "code-review", description: "Reviews diffs", "allowed-tools": ["Read", "Grep"] };
    const body = "Use this skill when reviewing a PR.\n";
    const serialized = serializeFile(fm, body);
    const re = parseFile(serialized);
    expect(re.frontmatter["name"]).toBe("code-review");
    expect(re.frontmatter["description"]).toBe("Reviews diffs");
    expect(re.frontmatter["allowed-tools"]).toEqual(["Read", "Grep"]);
    expect(re.body).toBe(body);
  });

  it("quotes a value containing a colon", () => {
    const out = serializeFile({ description: "before: after" }, "");
    expect(out).toContain('description: "before: after"');
    const re = parseFile(out);
    expect(re.frontmatter["description"]).toBe("before: after");
  });

  it("writes multiline strings as block scalar", () => {
    const out = serializeFile({ description: "line one\nline two" }, "body");
    expect(out).toContain("description: |");
    const re = parseFile(out);
    expect(re.frontmatter["description"]).toBe("line one\nline two");
  });

  it("writes empty array as [] inline", () => {
    expect(serializeFile({ tags: [] }, "")).toContain("tags: []");
  });

  it("omits frontmatter section entirely when empty", () => {
    expect(serializeFile({}, "body only")).toBe("body only");
  });

  it("agent skills field roundtrips through serialize/parse", () => {
    const out = serializeFile({ name: "reviewer", skills: ["lint", "diff-read"] }, "prompt");
    const re = parseFile(out);
    expect(re.frontmatter["skills"]).toEqual(["lint", "diff-read"]);
  });
});
