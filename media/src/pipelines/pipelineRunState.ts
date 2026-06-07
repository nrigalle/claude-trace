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
  readonly poolDoneCount?: number;
  readonly poolActiveCount?: number;
}

export const blockCountLabel = (n: number): string => `${n} block${n === 1 ? "" : "s"}`;
export const runCountLabel = (n: number): string => `${n} run${n === 1 ? "" : "s"}`;

export const runDisplayName = (name: string, pipelineName: string, startedAtMs: number): string => {
  if (name.trim().length > 0) return name;
  const d = new Date(startedAtMs);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${pipelineName} · ${date} · ${time}`;
};

export const formatRelativeTime = (ms: number, nowMs: number): string => {
  const diff = Math.max(0, nowMs - ms);
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export type RunDateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Earlier";

export const runDateGroup = (ms: number, nowMs: number): RunDateGroup => {
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  if (ms >= startMs) return "Today";
  if (ms >= startMs - 86400000) return "Yesterday";
  if (ms >= startMs - 7 * 86400000) return "Previous 7 days";
  return "Earlier";
};

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
  const isPool = definition.kind === "pool";
  const poolDoneCount = isPool ? blockRun.sessions.filter((s) => s.endedAtMs !== null).length : undefined;
  const poolActiveCount = isPool ? blockRun.sessions.filter((s) => s.endedAtMs === null).length : undefined;
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
    poolDoneCount,
    poolActiveCount,
  };
};

export const computeRunSignature = (run: RunState): string => {
  const parts = run.pipelineSnapshot.blocks.map((b) => {
    if (b.kind === "parallel") return `${b.id}:parallel:${b.workers.map((w) => w.id).join(",")}`;
    return `${b.id}:${b.kind}`;
  });
  return `${run.runId}::${parts.join("|")}`;
};
