import { describe, expect, it } from "vitest";
import { buildCockpitHookSettings } from "../../src/features/cockpit/infra/cockpitHooks";

const cmd = (s: ReturnType<typeof buildCockpitHookSettings>, hook: string): string =>
  s.hooks[hook]![0]!.hooks[0]!.command;

describe("buildCockpitHookSettings — the agent-state signals that drive the orange border", () => {
  const settings = buildCockpitHookSettings("sess-1", "/sig");

  it("Stop and an input-blocking Notification mean WAITING — they write .stop / .notify markers", () => {
    expect(cmd(settings, "Stop")).toContain("/sig/sess-1.stop");
    expect(cmd(settings, "Notification")).toContain("/sig/sess-1.notify");
    expect(settings.hooks["Notification"]![0]!.matcher).toBe("permission_prompt|idle_prompt|elicitation_dialog");
  });

  it("Elicitation means WAITING and ElicitationResult means ACTIVE again — dedicated events for full input-dialog coverage", () => {
    expect(cmd(settings, "Elicitation")).toContain("/sig/sess-1.notify");
    expect(cmd(settings, "ElicitationResult")).toContain("/sig/sess-1.active");
  });

  it("the Stop hook only writes a marker and never blocks, so the 2026 8-iteration block cap (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP) never engages", () => {
    expect(cmd(settings, "Stop")).toMatch(/^mkdir -p /);
    expect(cmd(settings, "Stop")).not.toContain("decision");
    expect(cmd(settings, "Stop")).not.toContain("block");
  });

  it("BOTH UserPromptSubmit AND PreToolUse mean ACTIVE — PreToolUse's documented purpose is permission decisions, the activity signal is our extension so the border clears while the agent works (regression: border stuck on during answering)", () => {
    expect(cmd(settings, "UserPromptSubmit")).toContain("/sig/sess-1.active");
    expect(cmd(settings, "PreToolUse")).toContain("/sig/sess-1.active");
  });

  it("the marker command creates the signals dir and shell-quotes paths (handles spaces/quotes safely)", () => {
    const spaced = buildCockpitHookSettings("s", "/Users/a b/sig");
    expect(cmd(spaced, "Stop")).toContain("mkdir -p '/Users/a b/sig'");
    expect(cmd(spaced, "Stop")).toContain(": > '/Users/a b/sig/s.stop'");
  });

  it("every hook command is a `command` type entry", () => {
    for (const hook of ["Stop", "Notification", "Elicitation", "ElicitationResult", "UserPromptSubmit", "PreToolUse"]) {
      expect(settings.hooks[hook]![0]!.hooks[0]!.type).toBe("command");
    }
  });
});
