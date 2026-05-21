import { describe, expect, it } from "vitest";
import {
  buildClaudeCommand,
  PERMISSION_MODES,
  type PermissionMode,
} from "../../src/domain/permissionModes";
import { MODEL_OPTIONS, type ModelChoice } from "../../src/domain/models";

describe("buildClaudeCommand", () => {
  it("emits a bare 'claude' invocation for the default mode (no flag)", () => {
    expect(buildClaudeCommand({ mode: "default" })).toBe("claude");
  });

  it.each<[PermissionMode, string]>([
    ["acceptEdits", "claude --permission-mode acceptEdits"],
    ["plan", "claude --permission-mode plan"],
    ["auto", "claude --permission-mode auto"],
    ["dontAsk", "claude --permission-mode dontAsk"],
    ["bypassPermissions", "claude --permission-mode bypassPermissions"],
  ])("emits %s as `%s`", (mode, expected) => {
    expect(buildClaudeCommand({ mode })).toBe(expected);
  });

  it("adds --resume <id> when a resumeId is provided", () => {
    expect(buildClaudeCommand({ mode: "default", resumeId: "abc123" })).toBe("claude --resume abc123");
  });

  it("combines --resume <id> and --permission-mode <mode> in stable order", () => {
    expect(buildClaudeCommand({ mode: "acceptEdits", resumeId: "abc123" })).toBe(
      "claude --resume abc123 --permission-mode acceptEdits",
    );
  });

  it("does NOT add --model when model is 'default'", () => {
    expect(buildClaudeCommand({ mode: "default", model: "default" })).toBe("claude");
  });

  it("does NOT add --model when model is omitted", () => {
    expect(buildClaudeCommand({ mode: "default" })).toBe("claude");
  });

  it.each<[ModelChoice, string]>([
    ["claude-opus-4-7", "claude --model claude-opus-4-7"],
    ["claude-sonnet-4-6", "claude --model claude-sonnet-4-6"],
    ["claude-haiku-4-5", "claude --model claude-haiku-4-5"],
  ])("emits model %s as `%s`", (model, expected) => {
    expect(buildClaudeCommand({ mode: "default", model })).toBe(expected);
  });

  it("emits --model before --permission-mode in stable order", () => {
    expect(buildClaudeCommand({ mode: "acceptEdits", model: "claude-opus-4-7" })).toBe(
      "claude --model claude-opus-4-7 --permission-mode acceptEdits",
    );
  });

  it("combines --resume, --model, and --permission-mode in stable order", () => {
    expect(
      buildClaudeCommand({ mode: "plan", resumeId: "abc123", model: "claude-sonnet-4-6" }),
    ).toBe("claude --resume abc123 --model claude-sonnet-4-6 --permission-mode plan");
  });
});

describe("MODEL_OPTIONS catalog", () => {
  it("offers a 'default' (no flag) option as the first entry", () => {
    expect(MODEL_OPTIONS[0]!.id).toBe("default");
  });

  it("lists exactly the three current Anthropic models plus default", () => {
    expect(MODEL_OPTIONS.map((m) => m.id)).toEqual([
      "default",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("gives every option a non-empty label and one-line description", () => {
    for (const option of MODEL_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.oneLine.length).toBeGreaterThan(0);
    }
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
