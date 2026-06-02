import type {
  BlockKind,
  FileOperation,
  HttpMethod,
  Interpreter,
  ReduceMode,
} from "../../../src/features/pipelines/domain/types";
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

export const REDUCE_MODE_OPTIONS: readonly { readonly id: ReduceMode; readonly label: string }[] = [
  { id: "concat", label: "Concatenate lines" },
  { id: "llm", label: "Synthesize with an LLM" },
];

export const INTERPRETER_OPTIONS: readonly { readonly id: Interpreter; readonly label: string }[] = [
  { id: "bash", label: "Bash" },
  { id: "sh", label: "sh" },
  { id: "python", label: "Python" },
  { id: "node", label: "Node.js" },
];

export const HTTP_METHOD_OPTIONS: readonly { readonly id: HttpMethod; readonly label: string }[] = [
  { id: "GET", label: "GET" },
  { id: "POST", label: "POST" },
  { id: "PUT", label: "PUT" },
  { id: "PATCH", label: "PATCH" },
  { id: "DELETE", label: "DELETE" },
];

export const FILE_OP_OPTIONS: readonly { readonly id: FileOperation; readonly label: string }[] = [
  { id: "write", label: "Write file" },
  { id: "read", label: "Read file" },
];

export interface LibraryEntry {
  readonly kind: BlockKind;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
}

export const LIBRARY: readonly LibraryEntry[] = [
  {
    kind: "worker",
    label: "Worker",
    description: "An interactive Claude Code session with a prompt. Runs in bypassPermissions mode.",
    icon: ICON_WORKER,
  },
  {
    kind: "parallel",
    label: "Parallel",
    description: "Fan out into branches that run side by side, then a Merger combines results before the pipeline continues.",
    icon: ICON_PARALLEL,
  },
  {
    kind: "loop",
    label: "Loop",
    description: "Repeat a sequence of workers up to N times. Each iteration resumes the same Claude sessions.",
    icon: ICON_LOOP,
  },
  {
    kind: "script",
    label: "Script",
    description: "Run a shell, Python, or Node script in the run workspace. Stdout becomes the block output.",
    icon: ICON_SCRIPT,
  },
  {
    kind: "http",
    label: "HTTP request",
    description: "Call an external API or webhook. The response body becomes the block output.",
    icon: ICON_HTTP,
  },
  {
    kind: "file",
    label: "File",
    description: "Write or read a file in the shared run workspace so later blocks can use it.",
    icon: ICON_FILE,
  },
  {
    kind: "condition",
    label: "Condition",
    description: "Branch the workflow: when the expression is false, skip the blocks up to a chosen rejoin point.",
    icon: ICON_CONDITION,
  },
  {
    kind: "wait",
    label: "Wait",
    description: "Pause the pipeline for a fixed delay before continuing.",
    icon: ICON_WAIT,
  },
  {
    kind: "reduce",
    label: "Reduce",
    description: "Combine a list variable into one value. Concatenate lines or synthesize with an LLM.",
    icon: ICON_REDUCE,
  },
  {
    kind: "llm",
    label: "LLM call",
    description: "A single, one-shot Claude prompt (no tool loop). The reply becomes the block output.",
    icon: ICON_LLM,
  },
  {
    kind: "evaluator",
    label: "Evaluator",
    description: "An LLM gate: judges a goal and passes or fails the run. Use it to block progress until criteria are met.",
    icon: ICON_EVALUATOR,
  },
  {
    kind: "map",
    label: "Map",
    description: "Run a prompt once per line of a list variable, collecting every result into one output.",
    icon: ICON_MAP,
  },
  {
    kind: "approval",
    label: "Approval",
    description: "Pause the run for a human to review. The pipeline continues only after you click Continue.",
    icon: ICON_APPROVAL,
  },
];
