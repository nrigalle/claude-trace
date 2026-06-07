import type {
  ApprovalBlock,
  Block,
  BlockId,
  ConditionBlock,
  EvaluatorBlock,
  FileBlock,
  HttpBlock,
  InputBlock,
  LlmBlock,
  LoopBlock,
  MapBlock,
  ParallelBlock,
  Pipeline,
  PoolBlock,
  ReduceBlock,
  ScriptBlock,
  WaitBlock,
  WorkerBlock,
} from "./types";
import { assertNever } from "../../../shared/assertNever";
import { isValidVarName } from "./interpolate";
import { isValidRecurrence } from "./schedule";

export type ValidationCode =
  | "empty-name"
  | "no-blocks"
  | "block-empty-name"
  | "block-empty-prompt"
  | "duplicate-block-id"
  | "parallel-needs-worker"
  | "loop-needs-iterations"
  | "loop-needs-target"
  | "loop-empty-goal"
  | "merger-empty-goal"
  | "script-empty-code"
  | "http-empty-url"
  | "http-invalid-url"
  | "file-empty-path"
  | "invalid-output-var"
  | "condition-empty-expression"
  | "wait-invalid-duration"
  | "reduce-empty-input"
  | "evaluator-empty-goal"
  | "map-empty-list"
  | "map-invalid-item-var"
  | "pool-empty-list"
  | "pool-invalid-item-var"
  | "pool-invalid-concurrency"
  | "input-no-columns"
  | "input-column-empty-key"
  | "input-duplicate-column-key"
  | "input-enum-needs-options"
  | "loop-target-missing"
  | "loop-target-not-earlier"
  | "condition-target-missing"
  | "condition-target-not-later"
  | "trigger-invalid-schedule"
  | "trigger-empty-token";

export interface ValidationError {
  readonly code: ValidationCode;
  readonly message: string;
  readonly blockId?: BlockId;
}

export const validatePipeline = (p: Pipeline): readonly ValidationError[] => {
  const errors: ValidationError[] = [];

  if (p.name.trim().length === 0) {
    errors.push({ code: "empty-name", message: "Pipeline name is required." });
  }

  if (p.blocks.length === 0) {
    errors.push({ code: "no-blocks", message: "Pipeline must contain at least one block." });
    return errors;
  }

  const seen = new Set<BlockId>();
  const indexOf = new Map<BlockId, number>();
  p.blocks.forEach((b, i) => { if (!indexOf.has(b.id)) indexOf.set(b.id, i); });
  for (const b of p.blocks) {
    if (seen.has(b.id)) {
      errors.push({
        code: "duplicate-block-id",
        message: `Duplicate block id ${b.id}.`,
        blockId: b.id,
      });
    }
    seen.add(b.id);
    errors.push(...validateBlock(b));
  }

  p.blocks.forEach((b, i) => {
    if (b.kind === "loop" && b.loopBackToBlockId !== null) {
      const target = indexOf.get(b.loopBackToBlockId);
      if (target === undefined) {
        errors.push({ code: "loop-target-missing", message: `Loop "${b.name}" loops back to a block that does not exist.`, blockId: b.id });
      } else if (target >= i) {
        errors.push({ code: "loop-target-not-earlier", message: `Loop "${b.name}" must loop back to an earlier block.`, blockId: b.id });
      }
    }
    if (b.kind === "condition" && b.skipToBlockId !== null) {
      const target = indexOf.get(b.skipToBlockId);
      if (target === undefined) {
        errors.push({ code: "condition-target-missing", message: `Condition "${b.name}" skips to a block that does not exist.`, blockId: b.id });
      } else if (target <= i) {
        errors.push({ code: "condition-target-not-later", message: `Condition "${b.name}" must skip ahead to a later block (or end).`, blockId: b.id });
      }
    }
  });

  for (const t of p.triggers) {
    if (t.kind === "schedule" && !isValidRecurrence(t.recurrence)) {
      errors.push({ code: "trigger-invalid-schedule", message: "Schedule trigger needs a valid interval or a day and time." });
    }
    if (t.kind === "webhook" && t.token.trim().length === 0) {
      errors.push({ code: "trigger-empty-token", message: "Webhook trigger needs a secret token." });
    }
  }

  return errors;
};

const validateBlock = (b: Block): readonly ValidationError[] => {
  switch (b.kind) {
    case "worker":
      return validateWorker(b);
    case "parallel":
      return validateParallel(b);
    case "loop":
      return validateLoop(b);
    case "script":
      return validateScript(b);
    case "http":
      return validateHttp(b);
    case "file":
      return validateFile(b);
    case "condition":
      return validateCondition(b);
    case "wait":
      return validateWait(b);
    case "reduce":
      return validateReduce(b);
    case "llm":
      return validateLlm(b);
    case "evaluator":
      return validateEvaluator(b);
    case "map":
      return validateMap(b);
    case "pool":
      return validatePool(b);
    case "approval":
      return validateApproval(b);
    case "input":
      return validateInput(b);
    default:
      return assertNever(b);
  }
};

const validateApproval = (b: ApprovalBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Approval block name is required.", blockId: b.id });
  }
  return errors;
};

const validateInput = (b: InputBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Input block name is required.", blockId: b.id });
  }
  if (b.columns.length === 0) {
    errors.push({ code: "input-no-columns", message: "Input block needs at least one column.", blockId: b.id });
  }
  const seenKeys = new Set<string>();
  for (const c of b.columns) {
    if (c.key.trim().length === 0) {
      errors.push({ code: "input-column-empty-key", message: "Every input column needs a key.", blockId: b.id });
    } else if (seenKeys.has(c.key)) {
      errors.push({ code: "input-duplicate-column-key", message: `Duplicate input column key "${c.key}".`, blockId: b.id });
    }
    seenKeys.add(c.key);
    if (c.type === "enum" && c.options.length === 0) {
      errors.push({ code: "input-enum-needs-options", message: `Dropdown column "${c.label}" needs at least one option.`, blockId: b.id });
    }
  }
  validateOutputVar(b.outputVar, b.id, errors);
  return errors;
};

const validateLlm = (b: LlmBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "LLM block name is required.", blockId: b.id });
  }
  if (b.prompt.trim().length === 0) {
    errors.push({ code: "block-empty-prompt", message: "LLM block needs a prompt.", blockId: b.id });
  }
  validateOutputVar(b.outputVar, b.id, errors);
  return errors;
};

const validateEvaluator = (b: EvaluatorBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Evaluator block name is required.", blockId: b.id });
  }
  if (b.goal.trim().length === 0) {
    errors.push({ code: "evaluator-empty-goal", message: "Evaluator needs a goal to judge against.", blockId: b.id });
  }
  return errors;
};

const validateMap = (b: MapBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Map block name is required.", blockId: b.id });
  }
  if (b.listVar.trim().length === 0) {
    errors.push({ code: "map-empty-list", message: "Map needs a list variable to iterate over.", blockId: b.id });
  }
  if (!isValidVarName(b.itemVar)) {
    errors.push({ code: "map-invalid-item-var", message: "Map item variable must be a valid identifier.", blockId: b.id });
  }
  if (b.prompt.trim().length === 0) {
    errors.push({ code: "block-empty-prompt", message: "Map needs a prompt to run per item.", blockId: b.id });
  }
  validateOutputVar(b.outputVar, b.id, errors);
  return errors;
};

const validatePool = (b: PoolBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Worker pool name is required.", blockId: b.id });
  }
  if (b.listVar.trim().length === 0) {
    errors.push({ code: "pool-empty-list", message: "Worker pool needs a list of items to drain.", blockId: b.id });
  }
  if (!isValidVarName(b.itemVar)) {
    errors.push({ code: "pool-invalid-item-var", message: "Worker pool item variable must be a valid identifier.", blockId: b.id });
  }
  if (!Number.isInteger(b.concurrency) || b.concurrency < 1 || b.concurrency > 20) {
    errors.push({ code: "pool-invalid-concurrency", message: "Worker pool concurrency must be a whole number between 1 and 20.", blockId: b.id });
  }
  if (b.prompt.trim().length === 0) {
    errors.push({ code: "block-empty-prompt", message: "Worker pool needs a prompt to run per item.", blockId: b.id });
  }
  validateOutputVar(b.outputVar, b.id, errors);
  return errors;
};

const validateCondition = (b: ConditionBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Condition block name is required.", blockId: b.id });
  }
  if (b.expression.trim().length === 0) {
    errors.push({ code: "condition-empty-expression", message: "Condition needs an expression to evaluate.", blockId: b.id });
  }
  return errors;
};

const validateWait = (b: WaitBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Wait block name is required.", blockId: b.id });
  }
  if (!Number.isFinite(b.durationMs) || b.durationMs < 0) {
    errors.push({ code: "wait-invalid-duration", message: "Wait duration must be a non-negative number of milliseconds.", blockId: b.id });
  }
  return errors;
};

const validateReduce = (b: ReduceBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Reduce block name is required.", blockId: b.id });
  }
  if (b.inputVar.trim().length === 0) {
    errors.push({ code: "reduce-empty-input", message: "Reduce needs an input variable to combine.", blockId: b.id });
  }
  if (b.mode === "llm" && b.mergerGoal.trim().length === 0) {
    errors.push({ code: "merger-empty-goal", message: "LLM reduce needs a merger goal.", blockId: b.id });
  }
  validateOutputVar(b.outputVar, b.id, errors);
  return errors;
};

const validateOutputVar = (
  outputVar: string | null,
  blockId: BlockId,
  errors: ValidationError[],
): void => {
  if (outputVar !== null && !isValidVarName(outputVar)) {
    errors.push({
      code: "invalid-output-var",
      message: `Output variable name "${outputVar}" must be a valid identifier (letters, digits, underscore).`,
      blockId,
    });
  }
};

const validateScript = (b: ScriptBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Script block name is required.", blockId: b.id });
  }
  if (b.code.trim().length === 0) {
    errors.push({ code: "script-empty-code", message: "Script block needs code to run.", blockId: b.id });
  }
  validateOutputVar(b.outputVar, b.id, errors);
  return errors;
};

const validateHttp = (b: HttpBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "HTTP block name is required.", blockId: b.id });
  }
  if (b.url.trim().length === 0) {
    errors.push({ code: "http-empty-url", message: "HTTP block needs a URL.", blockId: b.id });
  } else if (!/^https?:\/\//i.test(b.url) && !b.url.includes("${")) {
    errors.push({
      code: "http-invalid-url",
      message: "HTTP URL must start with http:// or https:// (or reference a variable).",
      blockId: b.id,
    });
  }
  validateOutputVar(b.outputVar, b.id, errors);
  return errors;
};

const validateFile = (b: FileBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "File block name is required.", blockId: b.id });
  }
  if (b.path.trim().length === 0) {
    errors.push({ code: "file-empty-path", message: "File block needs a path.", blockId: b.id });
  }
  validateOutputVar(b.outputVar, b.id, errors);
  return errors;
};

const validateWorker = (b: WorkerBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Block name is required.", blockId: b.id });
  }
  if (b.prompt.trim().length === 0) {
    errors.push({ code: "block-empty-prompt", message: "Block prompt is required.", blockId: b.id });
  }
  return errors;
};

const validateParallel = (b: ParallelBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Parallel block name is required.", blockId: b.id });
  }
  if (b.workers.length === 0) {
    errors.push({
      code: "parallel-needs-worker",
      message: "A Parallel block needs at least one parallel worker.",
      blockId: b.id,
    });
  }
  if (b.mergerGoal.trim().length === 0) {
    errors.push({
      code: "merger-empty-goal",
      message: "Merger goal is required: describe what merging the parallel results should produce.",
      blockId: b.id,
    });
  }
  for (const w of b.workers) {
    const sub = validateWorker(w);
    for (const e of sub) errors.push({ ...e, blockId: b.id });
  }
  return errors;
};

const validateLoop = (b: LoopBlock): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (b.name.trim().length === 0) {
    errors.push({ code: "block-empty-name", message: "Loop block name is required.", blockId: b.id });
  }
  if (!Number.isInteger(b.maxIterations) || b.maxIterations < 1) {
    errors.push({
      code: "loop-needs-iterations",
      message: "Loop max iterations must be a positive integer.",
      blockId: b.id,
    });
  }
  if (b.loopBackToBlockId === null) {
    errors.push({
      code: "loop-needs-target",
      message: "Loop must point to an earlier block to loop back to.",
      blockId: b.id,
    });
  }
  if (b.goal.trim().length === 0) {
    errors.push({
      code: "loop-empty-goal",
      message: "Loop goal is required: describe what the loop should achieve before it stops.",
      blockId: b.id,
    });
  }
  return errors;
};

export const isPipelineValid = (p: Pipeline): boolean =>
  validatePipeline(p).length === 0;
