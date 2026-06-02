import type {
  Block,
  BlockId,
  BlockStatus,
  RunId,
  RunState,
} from "../../../src/features/pipelines/domain/types";
import {
  latestPromptSent,
  latestSessionId,
  latestSummary,
} from "../../../src/features/pipelines/domain/types";

export interface RunBlockState {
  readonly runId?: RunId;
  readonly status: string;
  readonly summary: string | null;
  readonly stuckReason: string | null;
  readonly failureReason: string | null;
  readonly sessionId: string | null;
  readonly lastPromptSent: string | null;
  readonly iterations: number;
  readonly parallelWorkerStatuses?: ReadonlyMap<BlockId, BlockStatus>;
  readonly parallelWorkerSessionIds?: ReadonlyMap<BlockId, string | null>;
  readonly mergerStatus?: string;
  readonly mergerSessionId?: string | null;
  readonly loopMaxIterations?: number;
  readonly parallelDoneCount?: number;
  readonly parallelTotalCount?: number;
}

export const blockCountLabel = (n: number): string => `${n} block${n === 1 ? "" : "s"}`;
export const runCountLabel = (n: number): string => `${n} run${n === 1 ? "" : "s"}`;

export const staticSublabel = (
  kind: "start" | "end",
  runState: "active" | "completed" | "failed" | "interrupted" | undefined,
  fallback: string,
): string => {
  if (kind !== "end") return fallback;
  if (runState === "completed") return "Pipeline complete";
  if (runState === "failed") return "Pipeline failed";
  if (runState === "interrupted") return "Pipeline interrupted";
  return fallback;
};

export const startEndState = (
  status: RunState["status"],
  pos: "start" | "end",
): "active" | "completed" | "failed" | "interrupted" | undefined => {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return pos === "start" ? "active" : undefined;
};

export const buildRunBlockState = (
  runId: RunId,
  blockRun: RunState["blocks"][number],
  definition: Block,
): RunBlockState => {
  const parallelWorkerStatuses = blockRun.parallel
    ? new Map<BlockId, BlockStatus>(blockRun.parallel.workerRuns.map((w) => [w.workerBlockId, w.status]))
    : undefined;
  const parallelWorkerSessionIds = blockRun.parallel
    ? new Map<BlockId, string | null>(
        blockRun.parallel.workerRuns.map((w) => [w.workerBlockId, w.sessions.at(-1)?.sessionId ?? null]),
      )
    : undefined;
  const parallelTotalCount = blockRun.parallel ? blockRun.parallel.workerRuns.length : undefined;
  const parallelDoneCount = blockRun.parallel
    ? blockRun.parallel.workerRuns.filter((w) => w.status === "done").length
    : undefined;
  return {
    runId,
    status: blockRun.status,
    summary: latestSummary(blockRun),
    stuckReason: blockRun.stuckReason,
    failureReason: blockRun.failureReason,
    sessionId: latestSessionId(blockRun),
    lastPromptSent: latestPromptSent(blockRun),
    iterations: blockRun.sessions.length,
    parallelWorkerStatuses,
    parallelWorkerSessionIds,
    mergerStatus: blockRun.parallel?.mergerStatus,
    mergerSessionId: blockRun.parallel?.mergerSessions.at(-1)?.sessionId ?? null,
    loopMaxIterations: definition.kind === "loop" ? definition.maxIterations : undefined,
    parallelDoneCount,
    parallelTotalCount,
  };
};

export const computeRunSignature = (run: RunState): string => {
  const parts = run.pipelineSnapshot.blocks.map((b) => {
    if (b.kind === "parallel") return `${b.id}:parallel:${b.workers.map((w) => w.id).join(",")}`;
    return `${b.id}:${b.kind}`;
  });
  return `${run.runId}::${parts.join("|")}`;
};
