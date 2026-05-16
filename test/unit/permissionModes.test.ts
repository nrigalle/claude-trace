import { describe, expect, it } from "vitest";
import {
  buildClaudeCommand,
  PERMISSION_MODES,
  type PermissionMode,
} from "../../src/domain/permissionModes";

describe("buildClaudeCommand", () => {
  it("emits a bare 'claude' invocation for the default mode (no flag)", () => {
    expect(buildClaudeCommand("default")).toBe("claude");
  });

  it.each<[PermissionMode, string]>([
    ["acceptEdits", "claude --permission-mode acceptEdits"],
    ["plan", "claude --permission-mode plan"],
    ["auto", "claude --permission-mode auto"],
    ["dontAsk", "claude --permission-mode dontAsk"],
    ["bypassPermissions", "claude --permission-mode bypassPermissions"],
  ])("emits %s as `%s`", (mode, expected) => {
    expect(buildClaudeCommand(mode)).toBe(expected);
  });
});

describe("PERMISSION_MODES catalog", () => {
  it("lists exactly the six modes documented by the Claude Code CLI", () => {
    const modes = PERMISSION_MODES.map((o) => o.mode);
    expect(modes).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ]);
  });

  it("places the dangerous bypass option last so the safe choices appear first", () => {
    expect(PERMISSION_MODES[PERMISSION_MODES.length - 1]!.mode).toBe("bypassPermissions");
  });

  it("gives every option a non-empty label and one-line description", () => {
    for (const option of PERMISSION_MODES) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.oneLine.length).toBeGreaterThan(0);
    }
  });
});
