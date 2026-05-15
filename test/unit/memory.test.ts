import { describe, expect, it } from "vitest";
import { isAutoMemoryFile } from "../../src/domain/memory";

describe("isAutoMemoryFile", () => {
  it("accepts a markdown file in any project memory dir", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-proj/memory/notes.md")).toBe(true);
    expect(isAutoMemoryFile("/Users/x/.claude/projects/-Users-x-app/memory/topic.md")).toBe(true);
  });

  it("accepts files in nested memory subdirectories", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-p/memory/feedback/style.md")).toBe(true);
  });

  it("rejects the MEMORY.md index file", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-p/memory/MEMORY.md")).toBe(false);
  });

  it("rejects non-markdown files inside a memory dir", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-p/memory/notes.txt")).toBe(false);
  });

  it("rejects paths outside any memory dir", () => {
    expect(isAutoMemoryFile("/home/u/.claude/projects/-home-u-p/transcript.jsonl")).toBe(false);
    expect(isAutoMemoryFile("/home/u/code/project/CLAUDE.md")).toBe(false);
    expect(isAutoMemoryFile("/home/u/.claude/CLAUDE.md")).toBe(false);
  });

  it("rejects empty or malformed input", () => {
    expect(isAutoMemoryFile("")).toBe(false);
    expect(isAutoMemoryFile("relative/path.md")).toBe(false);
  });
});
