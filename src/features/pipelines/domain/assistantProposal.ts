import { parsePipeline, PIPELINE_SCHEMA_VERSION } from "./parse";
import { validatePipeline } from "./validate";
import type { Pipeline, PipelineId } from "./types";

export interface ProposedPipeline {
  readonly pipeline: Pipeline | null;
  readonly hadJson: boolean;
  readonly errors: readonly string[];
}

export interface ProposalBase {
  readonly id: PipelineId;
  readonly name: string;
  readonly createdAtMs: number;
  readonly nowMs: number;
}

const FENCE = /```(?:json|jsonc)?\s*\r?\n([\s\S]*?)```/g;

// The workflow assistant proposes a complete pipeline as a fenced JSON block.
// Extract the last such block, coerce it onto the current pipeline's identity,
// and validate it. Returns the validated pipeline, or the validation errors so
// the caller can tell the assistant to fix it.
export const extractProposedPipeline = (text: string, base: ProposalBase): ProposedPipeline => {
  const candidate = lastJsonObject(text);
  if (candidate === null) return { pipeline: null, hadJson: false, errors: [] };

  const merged: Record<string, unknown> = {
    ...candidate,
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    id: base.id,
    name: typeof candidate["name"] === "string" && candidate["name"].trim() !== ""
      ? candidate["name"]
      : base.name,
    createdAtMs: base.createdAtMs,
    updatedAtMs: base.nowMs,
    triggers: Array.isArray(candidate["triggers"]) ? candidate["triggers"] : [],
  };

  const pipeline = parsePipeline(merged);
  if (!pipeline) {
    return { pipeline: null, hadJson: true, errors: ["The proposed workflow JSON is not a valid pipeline shape."] };
  }
  const validationErrors = validatePipeline(pipeline);
  if (validationErrors.length > 0) {
    return { pipeline: null, hadJson: true, errors: validationErrors.map((e) => e.message) };
  }
  return { pipeline, hadJson: true, errors: [] };
};

const lastJsonObject = (text: string): Record<string, unknown> | null => {
  let last: Record<string, unknown> | null = null;
  for (const match of text.matchAll(FENCE)) {
    const body = match[1];
    if (body === undefined) continue;
    const obj = tryParseObject(body);
    if (obj && Array.isArray(obj["blocks"])) last = obj;
  }
  if (last) return last;
  // Fall back to a raw object literal if the assistant forgot the fence.
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    const obj = tryParseObject(text.slice(braceStart, braceEnd + 1));
    if (obj && Array.isArray(obj["blocks"])) return obj;
  }
  return null;
};

const tryParseObject = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
};
