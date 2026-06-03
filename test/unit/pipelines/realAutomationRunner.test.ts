import { describe, expect, it } from "vitest";
import {
  buildOrchestratorPrompt,
  parseOrchestratorDecision,
} from "../../../src/features/pipelines/domain/orchestratorProtocol";
import { encodeCwdForProjects } from "../../../src/shared/projectPathEncoding";

describe("encodeCwdForProjects", () => {
  it("matches Claude Code's real rule: every non-alphanumeric becomes a dash (dots included)", () => {
    expect(encodeCwdForProjects("/Users/alex/.claude-trace/runs/r1/b1")).toBe(
      "-Users-alex--claude-trace-runs-r1-b1",
    );
  });

  it("dashes out dots, spaces and underscores (the chars the old encoder wrongly kept)", () => {
    expect(encodeCwdForProjects("/a/b c/d.e_f")).toBe("-a-b-c-d-e-f");
  });

  it("encodes Windows drive separators and backslashes", () => {
    expect(encodeCwdForProjects("C:\\Users\\alex\\project")).toBe("C--Users-alex-project");
  });
});

describe("parseOrchestratorDecision", () => {
  it("parses SUCCESS: prefix into a success decision with the summary trimmed", () => {
    expect(parseOrchestratorDecision("SUCCESS: tagline produced and approved")).toEqual({
      kind: "success",
      summary: "tagline produced and approved",
    });
  });

  it("parses NEEDS_INPUT: prefix into a needs-input decision", () => {
    expect(parseOrchestratorDecision("NEEDS_INPUT: must clarify target audience")).toEqual({
      kind: "needs-input",
      reason: "must clarify target audience",
    });
  });

  it("parses LOOP_DONE: prefix into a loop-done decision", () => {
    expect(parseOrchestratorDecision("LOOP_DONE: all three critics returned no change")).toEqual({
      kind: "loop-done",
      summary: "all three critics returned no change",
    });
  });

  it("ignores leading lines and matches the first prefix-bearing line", () => {
    const text = ["", "  ", "Thinking…", "SUCCESS: done"].join("\n");
    expect(parseOrchestratorDecision(text)).toEqual({
      kind: "success",
      summary: "done",
    });
  });

  it("falls back to needs-input when the orchestrator returns garbage so the workflow surfaces it to the user", () => {
    const decision = parseOrchestratorDecision("I'm not sure what to do");
    expect(decision.kind).toBe("needs-input");
    if (decision.kind === "needs-input") {
      expect(decision.reason).toMatch(/malformed/i);
    }
  });
});

describe("buildOrchestratorPrompt", () => {
  it("embeds the task goal and conversation tail inside labelled tags so the orchestrator can address each", () => {
    const prompt = buildOrchestratorPrompt(
      "Write a tagline under 8 words",
      "user: write one\nassistant: Focus. Finish more.",
    );
    expect(prompt).toContain("<task_goal>");
    expect(prompt).toContain("Write a tagline under 8 words");
    expect(prompt).toContain("<worker_conversation_tail>");
    expect(prompt).toContain("Focus. Finish more.");
    expect(prompt).toMatch(/SUCCESS:|NEEDS_INPUT:|LOOP_DONE:/);
  });

  it("substitutes a placeholder when the conversation tail is empty so the prompt is still well-formed", () => {
    const prompt = buildOrchestratorPrompt("goal", "");
    expect(prompt).toContain("(no events captured)");
  });
});
