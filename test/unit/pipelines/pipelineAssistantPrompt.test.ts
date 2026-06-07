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

  it("documents the worker pool block kind with its concurrency knob so the assistant can propose it", () => {
    const prompt = systemPromptFor([]);
    expect(prompt).toContain("pool:");
    expect(prompt).toContain("concurrency");
    expect(prompt.toLowerCase()).toContain("tool-enabled");
  });

  it("keeps variable guidance aligned with prompt-only bare variable compatibility", () => {
    const prompt = systemPromptFor([]);
    expect(prompt).toContain("Always write generated workflow prompts with the ${vars.NAME} form");
    expect(prompt).toContain("Runtime tolerates bare ${NAME} only inside prompt fields");
    expect(prompt).toContain("script/http/file fields stay strict");
  });

  it("documents the input table block so the assistant proposes it instead of inventing one", () => {
    const prompt = systemPromptFor([]);
    expect(prompt).toContain("input:");
    expect(prompt).toContain("columns");
    expect(prompt).toContain("outputVar");
    expect(prompt.toLowerCase()).toContain("enum");
    expect(prompt.toLowerCase()).toContain("table");
  });

  it("pins the discriminator to kind (not type) and ships a literal JSON exemplar to stop schema drift", () => {
    const prompt = systemPromptFor([]);
    expect(prompt).toContain('"kind"');
    expect(prompt.toLowerCase()).toContain('never \"type\"');
    expect(prompt).toMatch(/worker, llm, parallel, loop, map, pool/);
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"kind": "input"');
  });

  it("is read-only and routes repo changes to a paste-ready prompt for a separate session, never editing the repo itself", () => {
    const prompt = systemPromptFor([]);
    expect(prompt.toLowerCase()).toContain("read-only");
    expect(prompt).toContain("cannot edit files or run commands");
    expect(prompt).toMatch(/separate Claude Code session/i);
    expect(prompt).toContain("```text");
  });
});
