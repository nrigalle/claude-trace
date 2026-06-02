import { describe, expect, it } from "vitest";
import { extractProposedPipeline } from "../../../src/features/pipelines/domain/assistantProposal";
import { toPipelineId } from "../../../src/features/pipelines/domain/types";

const base = {
  id: toPipelineId("p-existing"),
  name: "Existing name",
  createdAtMs: 100,
  nowMs: 999,
};

const workerBlock = (id: string, name = "Step") =>
  `{ "id": "${id}", "kind": "worker", "name": "${name}", "prompt": "Do it", "model": "claude-sonnet-4-6", "effort": "high" }`;

const validPipelineJson = (name: string, blocks: string[]): string =>
  `{ "name": "${name}", "blocks": [${blocks.join(",")}], "triggers": [] }`;

describe("extractProposedPipeline", () => {
  it("extracts and validates a fenced json proposal, preserving identity", () => {
    const text = `Here is the workflow.\n\n\`\`\`json\n${validPipelineJson("Cleaned flow", [workerBlock("b1")])}\n\`\`\`\n`;
    const result = extractProposedPipeline(text, base);
    expect(result.hadJson).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.pipeline).not.toBeNull();
    expect(result.pipeline!.id).toBe(base.id);
    expect(result.pipeline!.name).toBe("Cleaned flow");
    expect(result.pipeline!.createdAtMs).toBe(100);
    expect(result.pipeline!.updatedAtMs).toBe(999);
    expect(result.pipeline!.blocks).toHaveLength(1);
  });

  it("returns no proposal when the assistant only asks a question", () => {
    const result = extractProposedPipeline("What should happen after the emails are cleaned?", base);
    expect(result.hadJson).toBe(false);
    expect(result.pipeline).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it("reports errors when the json is present but not a valid pipeline", () => {
    const text = '```json\n{ "name": "Bad", "blocks": [{ "id": "b1", "kind": "worker" }] }\n```';
    const result = extractProposedPipeline(text, base);
    expect(result.hadJson).toBe(true);
    expect(result.pipeline).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("takes the LAST json block when several are present", () => {
    const text = [
      "First draft:",
      "```json",
      validPipelineJson("Draft one", [workerBlock("a1", "One")]),
      "```",
      "Revised:",
      "```json",
      validPipelineJson("Draft two", [workerBlock("b1", "Two"), workerBlock("b2", "Three")]),
      "```",
    ].join("\n");
    const result = extractProposedPipeline(text, base);
    expect(result.pipeline!.name).toBe("Draft two");
    expect(result.pipeline!.blocks).toHaveLength(2);
  });

  it("falls back to the current name when the proposal omits one", () => {
    const text = `\`\`\`json\n{ "blocks": [${workerBlock("b1")}], "triggers": [] }\n\`\`\``;
    const result = extractProposedPipeline(text, base);
    expect(result.pipeline!.name).toBe("Existing name");
  });

  it("parses a raw object even without a code fence", () => {
    const text = `Sure: ${validPipelineJson("No fence", [workerBlock("b1")])}`;
    const result = extractProposedPipeline(text, base);
    expect(result.hadJson).toBe(true);
    expect(result.pipeline!.name).toBe("No fence");
  });
});
