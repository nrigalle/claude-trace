import type { ModelChoice } from "../../../shared/models";

export type PipelineId = string & { readonly __brand: "PipelineId" };
export type BlockId = string & { readonly __brand: "BlockId" };
export type RunId = string & { readonly __brand: "RunId" };

export const toPipelineId = (s: string): PipelineId => s as PipelineId;
export const fromPipelineId = (id: PipelineId): string => id;
export const toBlockId = (s: string): BlockId => s as BlockId;
export const fromBlockId = (id: BlockId): string => id;
export const toRunId = (s: string): RunId => s as RunId;
export const fromRunId = (id: RunId): string => id;

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface WorkerBlock {
  readonly id: BlockId;
  readonly kind: "worker";
  readonly name: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
  readonly restartEachIteration?: boolean;
}

export interface ParallelBlock {
  readonly id: BlockId;
  readonly kind: "parallel";
  readonly name: string;
  readonly workers: readonly WorkerBlock[];
  readonly mergerGoal: string;
  readonly mergerModel: ModelChoice;
}

export interface LoopBlock {
  readonly id: BlockId;
  readonly kind: "loop";
  readonly name: string;
  readonly loopBackToBlockId: BlockId | null;
  readonly goal: string;
  readonly maxIterations: number;
  readonly evaluatorModel: ModelChoice;
}

export type Interpreter = "bash" | "sh" | "python" | "node";

export interface ScriptBlock {
  readonly id: BlockId;
  readonly kind: "script";
  readonly name: string;
  readonly interpreter: Interpreter;
  readonly code: string;
  readonly outputVar: string | null;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpHeader {
  readonly name: string;
  readonly value: string;
}

export interface HttpBlock {
  readonly id: BlockId;
  readonly kind: "http";
  readonly name: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: readonly HttpHeader[];
  readonly body: string | null;
  readonly outputVar: string | null;
}

export type FileOperation = "write" | "read";

export interface FileBlock {
  readonly id: BlockId;
  readonly kind: "file";
  readonly name: string;
  readonly operation: FileOperation;
  readonly path: string;
  readonly content: string;
  readonly outputVar: string | null;
}

export interface ConditionBlock {
  readonly id: BlockId;
  readonly kind: "condition";
  readonly name: string;
  readonly expression: string;
  readonly skipToBlockId: BlockId | null;
}

export interface WaitBlock {
  readonly id: BlockId;
  readonly kind: "wait";
  readonly name: string;
  readonly durationMs: number;
}

export type ReduceMode = "concat" | "llm";

export interface ReduceBlock {
  readonly id: BlockId;
  readonly kind: "reduce";
  readonly name: string;
  readonly inputVar: string;
  readonly mode: ReduceMode;
  readonly separator: string;
  readonly mergerGoal: string;
  readonly mergerModel: ModelChoice;
  readonly outputVar: string | null;
}

export interface LlmBlock {
  readonly id: BlockId;
  readonly kind: "llm";
  readonly name: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
  readonly outputVar: string | null;
}

export interface EvaluatorBlock {
  readonly id: BlockId;
  readonly kind: "evaluator";
  readonly name: string;
  readonly goal: string;
  readonly evaluatorModel: ModelChoice;
}

export interface MapBlock {
  readonly id: BlockId;
  readonly kind: "map";
  readonly name: string;
  readonly listVar: string;
  readonly itemVar: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
  readonly outputVar: string | null;
}

export interface PoolBlock {
  readonly id: BlockId;
  readonly kind: "pool";
  readonly name: string;
  readonly listVar: string;
  readonly itemVar: string;
  readonly concurrency: number;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
  readonly outputVar: string | null;
}

export const POOL_MIN_CONCURRENCY = 1;
export const POOL_MAX_CONCURRENCY = 20;

export const clampConcurrency = (n: number): number => {
  const rounded = Math.round(n);
  if (!Number.isFinite(rounded)) return POOL_MIN_CONCURRENCY;
  return Math.max(POOL_MIN_CONCURRENCY, Math.min(POOL_MAX_CONCURRENCY, rounded));
};

export interface ApprovalBlock {
  readonly id: BlockId;
  readonly kind: "approval";
  readonly name: string;
  readonly message: string;
}

export type InputColumnType = "text" | "url" | "enum";

export interface InputColumn {
  readonly key: string;
  readonly label: string;
  readonly type: InputColumnType;
  readonly options: readonly string[];
  readonly required: boolean;
  readonly help: string | null;
}

export interface InputBlock {
  readonly id: BlockId;
  readonly kind: "input";
  readonly name: string;
  readonly message: string;
  readonly columns: readonly InputColumn[];
  readonly outputVar: string | null;
}

export type Block =
  | WorkerBlock
  | ParallelBlock
  | LoopBlock
  | ScriptBlock
  | HttpBlock
  | FileBlock
  | ConditionBlock
  | WaitBlock
  | ReduceBlock
  | LlmBlock
  | EvaluatorBlock
  | MapBlock
  | PoolBlock
  | ApprovalBlock
  | InputBlock;
export type BlockKind = Block["kind"];

export const isDeterministicBlock = (
  b: Block,
): b is ScriptBlock | HttpBlock | FileBlock | ConditionBlock | WaitBlock | ReduceBlock =>
  b.kind === "script" ||
  b.kind === "http" ||
  b.kind === "file" ||
  b.kind === "condition" ||
  b.kind === "wait" ||
  b.kind === "reduce";

export type ScheduleRecurrence =
  | { readonly type: "interval"; readonly everyMs: number }
  | { readonly type: "daily"; readonly atMinute: number }
  | { readonly type: "weekly"; readonly weekdays: readonly number[]; readonly atMinute: number }
  | { readonly type: "monthly"; readonly day: number; readonly atMinute: number };

export interface ScheduleTrigger {
  readonly kind: "schedule";
  readonly enabled: boolean;
  readonly recurrence: ScheduleRecurrence;
}

export interface WebhookTrigger {
  readonly kind: "webhook";
  readonly token: string;
  readonly enabled: boolean;
}

export type Trigger = ScheduleTrigger | WebhookTrigger;
export type TriggerKind = Trigger["kind"];

export interface Pipeline {
  readonly id: PipelineId;
  readonly name: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly blocks: readonly Block[];
  readonly triggers: readonly Trigger[];
}

export type BlockStatus =
  | "pending"
  | "running"
  | "judging"
  | "done"
  | "skipped"
  | "stuck"
  | "failed"
  | "interrupted";

export interface BlockSessionRecord {
  readonly sessionId: string;
  readonly iteration: number;
  readonly promptSent: string;
  readonly summary: string | null;
  readonly workerOutput: string | null;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

export interface ParallelWorkerRun {
  readonly workerBlockId: BlockId;
  readonly status: BlockStatus;
  readonly sessions: readonly BlockSessionRecord[];
  readonly stuckReason: string | null;
  readonly failureReason: string | null;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
}

export interface ParallelRunState {
  readonly workerRuns: readonly ParallelWorkerRun[];
  readonly mergerSessions: readonly BlockSessionRecord[];
  readonly mergerStatus: BlockStatus;
  readonly mergerStuckReason: string | null;
}

export interface BlockRun {
  readonly blockId: BlockId;
  readonly status: BlockStatus;
  readonly sessions: readonly BlockSessionRecord[];
  readonly parallel: ParallelRunState | null;
  readonly output: string | null;
  readonly logTail?: string | null;
  readonly stuckReason: string | null;
  readonly failureReason: string | null;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
}

export const blockRunOutput = (br: BlockRun): string | null => {
  if (br.output !== null) return br.output;
  if (br.parallel) {
    const merger = br.parallel.mergerSessions.at(-1);
    const mergerText = merger ? merger.workerOutput ?? merger.summary : null;
    if (mergerText !== null && mergerText !== undefined) return mergerText;
  }
  const last = br.sessions.at(-1);
  if (!last) return null;
  return last.workerOutput ?? last.summary ?? null;
};

export const latestSession = (br: BlockRun): BlockSessionRecord | null =>
  br.sessions[br.sessions.length - 1] ?? null;
export const latestSummary = (br: BlockRun): string | null =>
  latestSession(br)?.summary ?? null;
export const latestSessionId = (br: BlockRun): string | null =>
  latestSession(br)?.sessionId ?? null;
export const latestPromptSent = (br: BlockRun): string | null =>
  latestSession(br)?.promptSent ?? null;

export type RunStatus =
  | "running"
  | "paused-needs-input"
  | "completed"
  | "failed"
  | "interrupted";

export interface RunState {
  readonly runId: RunId;
  readonly pipelineId: PipelineId;
  readonly name: string;
  readonly pipelineSnapshot: Pipeline;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly status: RunStatus;
  readonly blocks: readonly BlockRun[];
  readonly variables: Readonly<Record<string, string>>;
}

export type OrchestratorDecision =
  | { readonly kind: "success"; readonly summary: string }
  | { readonly kind: "needs-input"; readonly reason: string }
  | { readonly kind: "loop-done"; readonly summary: string };
