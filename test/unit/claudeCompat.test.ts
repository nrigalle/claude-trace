import { describe, expect, it } from "vitest";
import { claudeCompatVerdict, parseClaudeVersion, TESTED_CLAUDE_MAJOR } from "../../src/shared/claudeCompat";

describe("claudeCompat — guards against untested Claude Code internals", () => {
  it("parses the CLI banner format", () => {
    expect(parseClaudeVersion("2.1.153 (Claude Code)")).toBe("2.1.153");
    expect(parseClaudeVersion("garbage")).toBeNull();
  });

  it("a current-major version is tested", () => {
    const v = claudeCompatVerdict(`${TESTED_CLAUDE_MAJOR}.0.1 (Claude Code)`);
    expect(v).toEqual({ kind: "tested", version: `${TESTED_CLAUDE_MAJOR}.0.1` });
  });

  it("a newer major is flagged untested so the user sees the status warning", () => {
    const v = claudeCompatVerdict(`${TESTED_CLAUDE_MAJOR + 1}.0.0 (Claude Code)`);
    expect(v.kind).toBe("untested");
  });

  it("a failed probe means the claude CLI is missing", () => {
    expect(claudeCompatVerdict(null)).toEqual({ kind: "missing" });
    expect(claudeCompatVerdict("command not found")).toEqual({ kind: "missing" });
  });
});
