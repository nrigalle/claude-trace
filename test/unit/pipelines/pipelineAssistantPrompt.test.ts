import { describe, expect, it } from "vitest";
import { systemPromptFor } from "../../../src/features/pipelines/infra/PipelineAssistant";
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
    const current = pipeline("p-current", "Current");
    const others = [pipeline("p-clean", "Email cleanup"), pipeline("p-report", "Weekly report")];
    const prompt = systemPromptFor(current, others);
    expect(prompt).toContain("Email cleanup");
    expect(prompt).toContain("Weekly report");
    expect(prompt).toContain("<existing_workflows>");
    // a compact catalog lets it see what exists at a glance
    expect(prompt).toContain("<workflow_catalog>");
    expect(prompt).toContain('"Email cleanup"');
    // it should be told to never go looking for workflow files on disk
    expect(prompt.toLowerCase()).toContain("never go looking for workflow files");
    expect(prompt).toContain("~/.claude-trace/automations");
    // and the current workflow is still provided
    expect(prompt).toContain("<current_workflow>");
    expect(prompt).toContain("Current");
  });

  it("states there are none when the user has no other workflows", () => {
    const prompt = systemPromptFor(pipeline("p1", "Only one"), []);
    expect(prompt).toContain("no other saved workflows yet");
  });
});
