import { describe, expect, it } from "vitest";
import { currentWorkflowBlock, systemPromptFor } from "../../../src/features/pipelines/infra/PipelineAssistant";
import { toPipelineId, type Pipeline } from "../../../src/features/pipelines/domain/types";

const pipeline = (id: string, name: string): Pipeline => ({
  id: toPipelineId(id),
  name,
  createdAtMs: 1,
  updatedAtMs: 1,
  blocks: [
    { id: "w1", kind: "worker", name: "Step", prompt: "Do it", model: "claude-sonnet-4-6", effort: "high" },
  ],
  triggers: [],
});

describe("workflow assistant system prompt", () => {
  it("includes the user's other saved workflows in full so the assistant need not hunt for them", () => {
    const others = [pipeline("p-clean", "Email cleanup"), pipeline("p-report", "Weekly report")];
    const prompt = systemPromptFor(others);
    expect(prompt).toContain("Email cleanup");
    expect(prompt).toContain("Weekly report");
    expect(prompt).toContain("<existing_workflows>");
    expect(prompt).toContain("<workflow_catalog>");
    expect(prompt).toContain('"Email cleanup"');
    expect(prompt.toLowerCase()).toContain("never go looking for workflow files");
    expect(prompt).toContain("~/.claude-trace/automations");
  });

  it("sends the current workflow fresh each turn (not frozen in the system prompt)", () => {
    const current = pipeline("p-current", "Current");
    const block = currentWorkflowBlock(current);
    expect(block).toContain("<current_workflow>");
    expect(block).toContain("Current");
    expect(systemPromptFor([])).not.toContain("<current_workflow>");
    expect(systemPromptFor([])).toContain("<session_context>");
  });

  it("states there are none when the user has no other workflows", () => {
    const prompt = systemPromptFor([]);
    expect(prompt).toContain("no other saved workflows yet");
  });

  it("tells the assistant to ask in plain text rather than via an interactive picker (terminal-like panel)", () => {
    const prompt = systemPromptFor([]);
    expect(prompt.toLowerCase()).toContain("plain text");
    expect(prompt.toLowerCase()).toContain("no interactive picker");
  });

  it("pins the assistant to producing a Claude Trace JSON workflow, never files or CI YAML", () => {
    const prompt = systemPromptFor([]);
    expect(prompt).toContain("Claude Trace Workflow Builder");
    expect(prompt).toContain("GitHub Actions");
    expect(prompt.toLowerCase()).toContain("reference");
  });
});
