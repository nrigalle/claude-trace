import { describe, expect, it } from "vitest";
import {
  buildClaudeCommand,
  PERMISSION_MODES,
  type PermissionMode,
} from "../../../src/shared/permissionModes";
import { MODEL_OPTIONS, type ModelChoice } from "../../../src/shared/models";

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

  it("appends an initial prompt as a shell-quoted positional after every flag", () => {
    expect(
      buildClaudeCommand({ mode: "acceptEdits", model: "claude-opus-4-7", initialPrompt: "fix the auth bug" }),
    ).toBe("claude --model claude-opus-4-7 --permission-mode acceptEdits 'fix the auth bug'");
  });

  it("escapes single quotes and shell metacharacters in the initial prompt", () => {
    expect(buildClaudeCommand({ mode: "default", initialPrompt: "it's $HOME; rm" })).toBe(
      "claude 'it'\\''s $HOME; rm'",
    );
  });

  it("emits a shell-quoted --name so the session is named in Claude's own UI", () => {
    expect(buildClaudeCommand({ mode: "default", name: "Reviewer 1" })).toBe("claude --name 'Reviewer 1'");
    expect(buildClaudeCommand({ mode: "default", name: "   " })).toBe("claude");
    expect(buildClaudeCommand({ mode: "default", name: null })).toBe("claude");
  });

  it("ignores a blank or whitespace-only initial prompt", () => {
    expect(buildClaudeCommand({ mode: "default", initialPrompt: "   " })).toBe("claude");
    expect(buildClaudeCommand({ mode: "default", initialPrompt: null })).toBe("claude");
  });

  it("injects a shell-quoted --settings before --name and the prompt (hook wiring)", () => {
    expect(
      buildClaudeCommand({
        mode: "plan",
        sessionId: "id1",
        name: "Rev 1",
        settingsPath: "/home/me/.claude-trace/hooks/id1.json",
        initialPrompt: "go",
      }),
    ).toBe(
      "claude --session-id id1 --permission-mode plan --settings '/home/me/.claude-trace/hooks/id1.json' --name 'Rev 1' 'go'",
    );
  });

  it("omits --settings when no path is given", () => {
    expect(buildClaudeCommand({ mode: "default", settingsPath: null })).toBe("claude");
    expect(buildClaudeCommand({ mode: "default", settingsPath: "  " })).toBe("claude");
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
});
