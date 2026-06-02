import { DEFAULT_MODEL_CHOICE } from "../../../src/shared/models";
import { assertNever } from "../../../src/shared/assertNever";
import type { Block, BlockKind, WorkerBlock } from "../../../src/features/pipelines/domain/types";
import { toBlockId } from "../../../src/features/pipelines/domain/types";
import {
  ICON_APPROVAL,
  ICON_CONDITION,
  ICON_EVALUATOR,
  ICON_FILE,
  ICON_HTTP,
  ICON_LLM,
  ICON_LOOP,
  ICON_MAP,
  ICON_PARALLEL,
  ICON_REDUCE,
  ICON_SCRIPT,
  ICON_WAIT,
  ICON_WORKER,
} from "./pipelineIcons.js";

export interface BlockNodeMeta {
  readonly icon: string;
  readonly cssKind: string;
  readonly kindLabel: string;
  readonly sublabel: string;
}

export const blockNodeMeta = (block: Block): BlockNodeMeta => {
  switch (block.kind) {
    case "worker":
      return { icon: ICON_WORKER, cssKind: "worker", kindLabel: "Worker", sublabel: "Worker" };
    case "parallel":
      return {
        icon: ICON_PARALLEL,
        cssKind: "parallel",
        kindLabel: "Parallel",
        sublabel: `Parallel · ${block.workers.length} worker${block.workers.length === 1 ? "" : "s"}`,
      };
    case "loop":
      return {
        icon: ICON_LOOP,
        cssKind: "loop",
        kindLabel: "Loop",
        sublabel: `Loop · max ${block.maxIterations}`,
      };
    case "script":
      return {
        icon: ICON_SCRIPT,
        cssKind: "script",
        kindLabel: "Script",
        sublabel: `Script · ${block.interpreter}`,
      };
    case "http":
      return {
        icon: ICON_HTTP,
        cssKind: "http",
        kindLabel: "HTTP",
        sublabel: `HTTP · ${block.method}`,
      };
    case "file":
      return {
        icon: ICON_FILE,
        cssKind: "file",
        kindLabel: "File",
        sublabel: `File · ${block.operation}`,
      };
    case "condition":
      return { icon: ICON_CONDITION, cssKind: "condition", kindLabel: "Condition", sublabel: "Condition · branch" };
    case "wait":
      return { icon: ICON_WAIT, cssKind: "wait", kindLabel: "Wait", sublabel: `Wait · ${block.durationMs}ms` };
    case "reduce":
      return { icon: ICON_REDUCE, cssKind: "reduce", kindLabel: "Reduce", sublabel: `Reduce · ${block.mode}` };
    case "llm":
      return { icon: ICON_LLM, cssKind: "llm", kindLabel: "LLM", sublabel: "LLM call" };
    case "evaluator":
      return { icon: ICON_EVALUATOR, cssKind: "evaluator", kindLabel: "Evaluator", sublabel: "Evaluator · gate" };
    case "map":
      return { icon: ICON_MAP, cssKind: "map", kindLabel: "Map", sublabel: `Map · \${vars.${block.listVar}}` };
    case "approval":
      return { icon: ICON_APPROVAL, cssKind: "approval", kindLabel: "Approval", sublabel: "Approval · human gate" };
    default:
      return assertNever(block);
  }
};

export const makeId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 100000).toString(36)}`;

export const defaultWorker = (name: string): WorkerBlock => ({
  id: toBlockId(makeId("worker")),
  kind: "worker",
  name,
  prompt: "",
  model: DEFAULT_MODEL_CHOICE,
  effort: "medium",
});

export const createBlock = (kind: BlockKind): Block => {
  switch (kind) {
    case "worker":
      return defaultWorker("New worker");
    case "parallel":
      return {
        id: toBlockId(makeId("parallel")),
        kind: "parallel",
        name: "Parallel split",
        mergerGoal: "Combine the parallel outputs into a single coherent summary.",
        mergerModel: DEFAULT_MODEL_CHOICE,
        workers: [defaultWorker("Worker 1"), defaultWorker("Worker 2")],
      };
    case "loop":
      return {
        id: toBlockId(makeId("loop")),
        kind: "loop",
        name: "Loop",
        loopBackToBlockId: null,
        goal: "",
        maxIterations: 5,
        evaluatorModel: DEFAULT_MODEL_CHOICE,
      };
    case "script":
      return {
        id: toBlockId(makeId("script")),
        kind: "script",
        name: "Script",
        interpreter: "bash",
        code: "",
        outputVar: null,
      };
    case "http":
      return {
        id: toBlockId(makeId("http")),
        kind: "http",
        name: "HTTP request",
        method: "GET",
        url: "",
        headers: [],
        body: null,
        outputVar: null,
      };
    case "file":
      return {
        id: toBlockId(makeId("file")),
        kind: "file",
        name: "File",
        operation: "write",
        path: "",
        content: "",
        outputVar: null,
      };
    case "condition":
      return {
        id: toBlockId(makeId("condition")),
        kind: "condition",
        name: "Condition",
        expression: "",
        skipToBlockId: null,
      };
    case "wait":
      return {
        id: toBlockId(makeId("wait")),
        kind: "wait",
        name: "Wait",
        durationMs: 1000,
      };
    case "reduce":
      return {
        id: toBlockId(makeId("reduce")),
        kind: "reduce",
        name: "Reduce",
        inputVar: "",
        mode: "concat",
        separator: "\n",
        mergerGoal: "Combine the inputs into one coherent result.",
        mergerModel: DEFAULT_MODEL_CHOICE,
        outputVar: null,
      };
    case "llm":
      return {
        id: toBlockId(makeId("llm")),
        kind: "llm",
        name: "LLM call",
        prompt: "",
        model: DEFAULT_MODEL_CHOICE,
        effort: "medium",
        outputVar: null,
      };
    case "evaluator":
      return {
        id: toBlockId(makeId("evaluator")),
        kind: "evaluator",
        name: "Evaluator",
        goal: "",
        evaluatorModel: DEFAULT_MODEL_CHOICE,
      };
    case "map":
      return {
        id: toBlockId(makeId("map")),
        kind: "map",
        name: "Map",
        listVar: "",
        itemVar: "item",
        prompt: "Process this item: ${vars.item}",
        model: DEFAULT_MODEL_CHOICE,
        effort: "medium",
        outputVar: null,
      };
    case "approval":
      return {
        id: toBlockId(makeId("approval")),
        kind: "approval",
        name: "Approval",
        message: "Review the results so far, then continue.",
      };
    default:
      return assertNever(kind);
  }
};

export const orchStatusFor = (blockStatus: string): string | undefined => {
  switch (blockStatus) {
    case "judging":
    case "done":
    case "stuck":
    case "failed":
      return blockStatus;
    default:
      return undefined;
  }
};
