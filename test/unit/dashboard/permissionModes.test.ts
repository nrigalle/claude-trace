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
    ["claude-opus-4-8", "claude --model 'claude-opus-4-8[1m]'"],
    ["claude-opus-4-7", "claude --model 'claude-opus-4-7[1m]'"],
    ["claude-sonnet-4-6", "claude --model 'claude-sonnet-4-6[1m]'"],
  ])("emits the 1M-context model %s as the single-quoted `%s`", (model, expected) => {
    expect(buildClaudeCommand({ mode: "default", model })).toBe(expected);
  });

  it("single-quotes the model so the [1m] bracket is never glob-expanded by the shell", () => {
    const out = buildClaudeCommand({ mode: "default", model: "claude-opus-4-8" });
    expect(out).toContain("--model 'claude-opus-4-8[1m]'");
    expect(out).not.toContain("--model claude-opus-4-8[1m]");
  });

  it("does NOT append [1m] to a non 1M-context model (haiku), but still quotes it", () => {
    expect(buildClaudeCommand({ mode: "default", model: "claude-haiku-4-5" })).toBe(
      "claude --model 'claude-haiku-4-5'",
    );
  });

  it("emits --model before --permission-mode in stable order", () => {
    expect(buildClaudeCommand({ mode: "acceptEdits", model: "claude-opus-4-7" })).toBe(
      "claude --model 'claude-opus-4-7[1m]' --permission-mode acceptEdits",
    );
  });

  it("combines --resume, --model, and --permission-mode in stable order", () => {
    expect(
      buildClaudeCommand({ mode: "plan", resumeId: "abc123", model: "claude-sonnet-4-6" }),
    ).toBe("claude --resume abc123 --model 'claude-sonnet-4-6[1m]' --permission-mode plan");
  });

  it("appends an initial prompt as a shell-quoted positional after every flag", () => {
    expect(
      buildClaudeCommand({ mode: "acceptEdits", model: "claude-opus-4-7", initialPrompt: "fix the auth bug" }),
    ).toBe("claude --model 'claude-opus-4-7[1m]' --permission-mode acceptEdits 'fix the auth bug'");
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

  it("does NOT add --effort when effort is 'default'", () => {
    expect(buildClaudeCommand({ mode: "default", effort: "default" })).toBe("claude");
  });

  it("adds --effort <level> for low/medium/high/xhigh/max", () => {
    expect(buildClaudeCommand({ mode: "default", effort: "low" })).toBe("claude --effort low");
    expect(buildClaudeCommand({ mode: "default", effort: "medium" })).toBe("claude --effort medium");
    expect(buildClaudeCommand({ mode: "default", effort: "high" })).toBe("claude --effort high");
    expect(buildClaudeCommand({ mode: "default", effort: "xhigh" })).toBe("claude --effort xhigh");
    expect(buildClaudeCommand({ mode: "default", effort: "max" })).toBe("claude --effort max");
  });

  it("emits --effort after --model and before --permission-mode in stable order", () => {
    expect(
      buildClaudeCommand({ mode: "acceptEdits", model: "claude-opus-4-8", effort: "xhigh" }),
    ).toBe("claude --model 'claude-opus-4-8[1m]' --effort xhigh --permission-mode acceptEdits");
  });
});

describe("buildClaudeCommand — Windows PowerShell quoting", () => {
  it("defaults to POSIX single-quote escaping (backslash form) when no shell is given", () => {
    expect(buildClaudeCommand({ mode: "default", name: "it's" })).toBe("claude --name 'it'\\''s'");
  });

  it("escapes an embedded single quote by DOUBLING it for PowerShell, not the POSIX backslash form", () => {
    expect(buildClaudeCommand({ mode: "default", name: "it's" }, "powershell")).toBe(
      "claude --name 'it''s'",
    );
  });

  it("quotes the model so the [1m] bracket stays literal under PowerShell too", () => {
    expect(buildClaudeCommand({ mode: "default", model: "claude-opus-4-7" }, "powershell")).toBe(
      "claude --model 'claude-opus-4-7[1m]'",
    );
  });

  it("keeps a Windows settings path (backslashes and spaces) literal inside PowerShell single quotes", () => {
    expect(
      buildClaudeCommand(
        { mode: "default", settingsPath: "C:\\Users\\Jane Doe\\.claude-trace\\hooks\\id1.json" },
        "powershell",
      ),
    ).toBe("claude --settings 'C:\\Users\\Jane Doe\\.claude-trace\\hooks\\id1.json'");
  });

  it("escapes an apostrophe in the initial prompt by doubling for PowerShell", () => {
    expect(buildClaudeCommand({ mode: "default", initialPrompt: "don't break" }, "powershell")).toBe(
      "claude 'don''t break'",
    );
  });
});

describe("MODEL_OPTIONS catalog", () => {
  it("uses Opus 4.8 as the first visible launch model", () => {
    expect(MODEL_OPTIONS[0]!.id).toBe("claude-opus-4-8");
    expect(MODEL_OPTIONS[0]!.label).toBe("Opus 4.8");
  });

  it("lists only 1M-context launch models", () => {
    expect(MODEL_OPTIONS.map((m) => m.id)).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
  });

  it("does not decorate Opus 4.8 with a new tag", () => {
    expect(MODEL_OPTIONS[0]!.label.toLowerCase()).not.toContain("new");
  });

  it("Opus 4.8 supports the full effort range including xhigh", () => {
    const opus48 = MODEL_OPTIONS.find((m) => m.id === "claude-opus-4-8")!;
    expect(opus48.effortLevels).toContain("low");
    expect(opus48.effortLevels).toContain("xhigh");
    expect(opus48.effortLevels).toContain("max");
  });

  it("Sonnet 4.6 supports effort but NOT xhigh", () => {
    const sonnet = MODEL_OPTIONS.find((m) => m.id === "claude-sonnet-4-6")!;
    expect(sonnet.effortLevels.length).toBeGreaterThan(0);
    expect(sonnet.effortLevels).not.toContain("xhigh");
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
