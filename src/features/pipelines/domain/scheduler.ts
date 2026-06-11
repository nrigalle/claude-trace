import type {
  Block,
  BlockId,
  BlockRun,
  BlockSessionRecord,
  BlockStatus,
  OrchestratorDecision,
  ParallelBlock,
  ParallelRunState,
  Pipeline,
  RunId,
  RunState,
  SessionVerdict,
} from "./types";
import { blockRunOutput, fromBlockId } from "./types";
import { assertNever } from "../../../shared/assertNever";

export const initialRunState = (
  pipeline: Pipeline,
  runId: RunId,
  nowMs: number,
): RunState => ({
  runId,
  pipelineId: pipeline.id,
  name: "",
  pipelineSnapshot: pipeline,
  startedAtMs: nowMs,
  endedAtMs: null,
  status: "running",
  blocks: pipeline.blocks.map(initialBlockRun),
  variables: {},
});

const initialBlockRun = (b: Block): BlockRun => ({
  blockId: b.id,
  status: "pending",
  sessions: [],
  parallel: b.kind === "parallel" ? initialParallelState(b) : null,
  output: null,
  stuckReason: null,
  failureReason: null,
  startedAtMs: null,
  endedAtMs: null,
});

const initialParallelState = (b: ParallelBlock): ParallelRunState => ({
  workerRuns: b.workers.map((w) => ({
    workerBlockId: w.id,
    status: "pending",
    sessions: [],
    stuckReason: null,
    failureReason: null,
    startedAtMs: null,
    endedAtMs: null,
  })),
  mergerSessions: [],
  mergerStatus: "pending",
  mergerStuckReason: null,
});

export const nextPendingBlock = (state: RunState): BlockId | null => {
  for (const b of state.blocks) {
    if (b.status === "pending") return b.blockId;
  }
  return null;
};

export const stuckBlock = (state: RunState): BlockId | null => {
  for (const b of state.blocks) {
    if (b.status === "stuck") return b.blockId;
  }
  return null;
};

export const applyBlockSpawned = (
  state: RunState,
  blockId: BlockId,
  sessionId: string,
  promptSent: string,
  nowMs: number,
): RunState =>
  mapBlock(state, blockId, (b) => {
    const session: BlockSessionRecord = {
      sessionId,
      iteration: b.sessions.length,
      promptSent,
      summary: null,
      workerOutput: null,
      startedAtMs: nowMs,
      endedAtMs: null,
    };
    return {
      ...b,
      status: "running",
      sessions: [...b.sessions, session],
      startedAtMs: b.startedAtMs ?? nowMs,
    };
  });

export const applyBlockResumed = (
  state: RunState,
  blockId: BlockId,
  promptSent: string,
  nowMs: number,
): RunState => {
  const next = mapBlock(state, blockId, (b) => {
    const lastIdx = b.sessions.length - 1;
    if (lastIdx < 0) return b;
    const last = b.sessions[lastIdx]!;
    const sessions = [
      ...b.sessions.slice(0, lastIdx),
      { ...last, promptSent, endedAtMs: null },
    ];
    return {
      ...b,
      status: "running",
      sessions,
      stuckReason: null,
      startedAtMs: b.startedAtMs ?? nowMs,
    };
  });
  return {
    ...next,
    status: state.status === "paused-needs-input" ? "running" : state.status,
  };
};

export const applyWorkerOutput = (
  state: RunState,
  blockId: BlockId,
  workerOutput: string,
): RunState =>
  mapBlock(state, blockId, (b) => {
    const lastIdx = b.sessions.length - 1;
    if (lastIdx < 0) return b;
    const last = b.sessions[lastIdx]!;
    return {
      ...b,
      sessions: [...b.sessions.slice(0, lastIdx), { ...last, workerOutput }],
    };
  });

export const applyBlockSessionFinished = (
  state: RunState,
  blockId: BlockId,
  sessionId: string,
  output: string,
  nowMs: number,
): RunState =>
  mapBlock(state, blockId, (b) => ({
    ...b,
    sessions: b.sessions.map((s) =>
      s.sessionId === sessionId
        ? { ...s, workerOutput: output, summary: output, endedAtMs: nowMs }
        : s,
    ),
  }));

export const applyBlockStopped = (
  state: RunState,
  blockId: BlockId,
  nowMs: number,
): RunState =>
  mapBlock(state, blockId, (b) => {
    const lastIdx = b.sessions.length - 1;
    if (lastIdx < 0) return { ...b, status: "judging" };
    const last = b.sessions[lastIdx]!;
    const sessions = [
      ...b.sessions.slice(0, lastIdx),
      { ...last, endedAtMs: nowMs },
    ];
    return { ...b, status: "judging", sessions };
  });

export const applyDecision = (
  state: RunState,
  blockId: BlockId,
  decision: OrchestratorDecision,
  nowMs: number,
): RunState => {
  switch (decision.kind) {
    case "success":
    case "loop-done":
      return finalizeSuccess(state, blockId, decision.summary, nowMs);
    case "failed":
      return applyBlockCrashed(state, blockId, decision.reason, nowMs);
    case "needs-input":
      return finalizeNeedsInput(state, blockId, decision.reason);
    default:
      return assertNever(decision);
  }
};

export const applyBlockSessionVerdict = (
  state: RunState,
  blockId: BlockId,
  sessionId: string,
  verdict: SessionVerdict,
): RunState =>
  mapBlock(state, blockId, (b) => ({
    ...b,
    sessions: b.sessions.map((s) => (s.sessionId === sessionId ? { ...s, verdict } : s)),
  }));

export const applyPoolOrchestrator = (
  state: RunState,
  blockId: BlockId,
  sessionId: string,
): RunState =>
  mapBlock(state, blockId, (b) =>
    b.orchestratorSessionId === sessionId ? b : { ...b, orchestratorSessionId: sessionId },
  );

export const applyBlockCrashed = (
  state: RunState,
  blockId: BlockId,
  reason: string,
  nowMs: number,
): RunState => {
  const next = mapBlock(state, blockId, (b) => {
    return {
      ...b,
      status: "failed",
      sessions: closeOpenSessions(b.sessions, nowMs),
      failureReason: reason,
      endedAtMs: nowMs,
    };
  });
  return { ...next, status: "failed", endedAtMs: nowMs };
};

export const TERMINAL_BLOCK_STATUS: ReadonlySet<BlockStatus> = new Set(["done", "skipped", "failed", "interrupted"]);
export const isTerminalBlockStatus = (s: BlockStatus): boolean => TERMINAL_BLOCK_STATUS.has(s);

export const closeOpenSessions = (
  sessions: readonly BlockSessionRecord[],
  nowMs: number,
): BlockSessionRecord[] =>
  sessions.map((s) => (s.endedAtMs === null ? { ...s, endedAtMs: nowMs } : s));

const interruptParallel = (parallel: ParallelRunState, nowMs: number): ParallelRunState => ({
  ...parallel,
  workerRuns: parallel.workerRuns.map((w) =>
    isTerminalBlockStatus(w.status)
      ? { ...w, sessions: closeOpenSessions(w.sessions, nowMs) }
      : { ...w, status: "interrupted", endedAtMs: w.startedAtMs !== null ? (w.endedAtMs ?? nowMs) : w.endedAtMs, sessions: closeOpenSessions(w.sessions, nowMs) },
  ),
  mergerSessions: closeOpenSessions(parallel.mergerSessions, nowMs),
  mergerStatus: isTerminalBlockStatus(parallel.mergerStatus) ? parallel.mergerStatus : "interrupted",
});

const FRESH_SESSION_KINDS: ReadonlySet<string> = new Set(["pool", "map", "llm", "reduce", "evaluator"]);
const RERUNNABLE_BLOCK_STATUSES: ReadonlySet<BlockStatus> = new Set(["interrupted", "failed"]);

export const applyRerunAll = (state: RunState, nowMs: number): RunState => {
  const fresh = initialRunState(state.pipelineSnapshot, state.runId, nowMs);
  const variables: Record<string, string> = {};
  const blocks = fresh.blocks.map((b) => {
    const def = state.pipelineSnapshot.blocks.find((d) => d.id === b.blockId);
    if (def?.kind !== "input") return b;
    const prev = state.blocks.find((p) => p.blockId === b.blockId);
    if (!prev || prev.status !== "done" || prev.output === null) return b;
    if (def.outputVar !== null) variables[def.outputVar] = prev.output;
    return prev;
  });
  return { ...fresh, name: state.name, blocks, variables };
};

export const applyResumeInterrupted = (state: RunState): RunState => ({
  ...state,
  status: "running",
  endedAtMs: null,
  blocks: state.blocks.map((b) => {
    if (!RERUNNABLE_BLOCK_STATUSES.has(b.status)) return b;
    const kind = state.pipelineSnapshot.blocks.find((d) => d.id === b.blockId)?.kind;
    const startsFresh = kind !== undefined && FRESH_SESSION_KINDS.has(kind);
    return {
      ...b,
      status: "pending",
      startedAtMs: null,
      endedAtMs: null,
      stuckReason: null,
      failureReason: null,
      ...(startsFresh ? { sessions: [], orchestratorSessionId: null } : {}),
    };
  }),
});

export const applyInterrupted = (state: RunState, nowMs: number): RunState => ({
  ...state,
  status: "interrupted",
  endedAtMs: nowMs,
  blocks: state.blocks.map((b) =>
    isTerminalBlockStatus(b.status)
      ? { ...b, sessions: closeOpenSessions(b.sessions, nowMs), parallel: b.parallel === null ? null : interruptParallel(b.parallel, nowMs) }
      : {
          ...b,
          status: "interrupted",
          endedAtMs: b.startedAtMs !== null ? (b.endedAtMs ?? nowMs) : b.endedAtMs,
          sessions: closeOpenSessions(b.sessions, nowMs),
          parallel: b.parallel === null ? null : interruptParallel(b.parallel, nowMs),
        },
  ),
});

export const resetBlocksForLoopIteration = (
  state: RunState,
  blockIdsInRange: readonly BlockId[],
): RunState => ({
  ...state,
  status: state.status === "completed" ? "running" : state.status,
  endedAtMs: state.status === "completed" ? null : state.endedAtMs,
  blocks: state.blocks.map((b) =>
    blockIdsInRange.includes(b.blockId)
      ? { ...b, status: "pending", endedAtMs: null }
      : b,
  ),
});

const finalizeSuccess = (
  state: RunState,
  blockId: BlockId,
  summary: string,
  nowMs: number,
): RunState => {
  const after = mapBlock(state, blockId, (b) => {
    const lastIdx = b.sessions.length - 1;
    const sessions =
      lastIdx >= 0
        ? [...b.sessions.slice(0, lastIdx), { ...b.sessions[lastIdx]!, summary }]
        : b.sessions;
    return {
      ...b,
      status: "done",
      sessions,
      endedAtMs: nowMs,
    };
  });
  return finalizeRunIfComplete(after, nowMs);
};

export const finalizeNeedsInput = (
  state: RunState,
  blockId: BlockId,
  reason: string,
): RunState => {
  const after = mapBlock(state, blockId, (b) => ({
    ...b,
    status: "stuck",
    stuckReason: reason,
  }));
  return { ...after, status: "paused-needs-input" };
};

export const finalizeRunIfComplete = (state: RunState, nowMs: number): RunState => {
  const more = state.blocks.some((b) => b.status === "pending" || b.status === "stuck");
  if (more) return state;
  const anyFailed = state.blocks.some((b) => b.status === "failed");
  if (anyFailed) return { ...state, status: "failed", endedAtMs: nowMs };
  return { ...state, status: "completed", endedAtMs: nowMs };
};

export const rebuildParallelBlockStatus = (blockRun: BlockRun): BlockRun => {
  const p = blockRun.parallel;
  if (!p) return blockRun;
  const anyStuck = p.workerRuns.some((w) => w.status === "stuck") || p.mergerStatus === "stuck";
  const anyFailed = p.workerRuns.some((w) => w.status === "failed") || p.mergerStatus === "failed";
  if (anyFailed) return { ...blockRun, status: "failed" };
  if (anyStuck) return { ...blockRun, status: "stuck", stuckReason: collectStuckReasons(p) };
  return { ...blockRun, status: blockRun.status === "stuck" ? "running" : blockRun.status, stuckReason: null };
};

export const collectStuckReasons = (p: ParallelRunState): string => {
  const stuck: string[] = [];
  for (const w of p.workerRuns) {
    if (w.status === "stuck" && w.stuckReason) stuck.push(`${w.workerBlockId}: ${w.stuckReason}`);
  }
  if (p.mergerStatus === "stuck" && p.mergerStuckReason) stuck.push(`merger: ${p.mergerStuckReason}`);
  return stuck.join(" | ");
};

const mapBlock = (
  state: RunState,
  blockId: BlockId,
  fn: (b: BlockRun) => BlockRun,
): RunState => ({
  ...state,
  blocks: state.blocks.map((b) => (b.blockId === blockId ? fn(b) : b)),
});

export const mapParallel = (
  state: RunState,
  blockId: BlockId,
  fn: (parallel: ParallelRunState, blockRun: BlockRun) => BlockRun,
): RunState =>
  mapBlock(state, blockId, (b) => {
    if (!b.parallel) return b;
    return fn(b.parallel, b);
  });

export const stuckParallelWorkers = (
  blockRun: BlockRun,
): readonly { workerBlockId: BlockId; reason: string }[] => {
  if (!blockRun.parallel) return [];
  const out: { workerBlockId: BlockId; reason: string }[] = [];
  for (const w of blockRun.parallel.workerRuns) {
    if (w.status === "stuck") out.push({ workerBlockId: w.workerBlockId, reason: w.stuckReason ?? "" });
  }
  return out;
};

const LOG_TAIL_CAP = 16384;

export const applyDeterministicStarted = (
  state: RunState,
  blockId: BlockId,
  nowMs: number,
): RunState =>
  mapBlock(state, blockId, (b) => ({
    ...b,
    status: "running",
    logTail: "",
    startedAtMs: b.startedAtMs ?? nowMs,
  }));

export const applyDeterministicLog = (
  state: RunState,
  blockId: BlockId,
  chunk: string,
): RunState =>
  mapBlock(state, blockId, (b) => {
    const combined = (b.logTail ?? "") + chunk;
    return { ...b, logTail: combined.length > LOG_TAIL_CAP ? combined.slice(combined.length - LOG_TAIL_CAP) : combined };
  });

export const applyDeterministicDone = (
  state: RunState,
  blockId: BlockId,
  output: string,
  nowMs: number,
): RunState => {
  const after = mapBlock(state, blockId, (b) => ({
    ...b,
    status: "done",
    output,
    endedAtMs: nowMs,
  }));
  return finalizeRunIfComplete(after, nowMs);
};

export const applyDeterministicFailed = (
  state: RunState,
  blockId: BlockId,
  reason: string,
  nowMs: number,
): RunState => {
  const after = mapBlock(state, blockId, (b) => ({
    ...b,
    status: "failed",
    failureReason: reason,
    endedAtMs: nowMs,
  }));
  return { ...after, status: "failed", endedAtMs: nowMs };
};

export const setVariable = (
  state: RunState,
  name: string,
  value: string,
): RunState => ({
  ...state,
  variables: { ...state.variables, [name]: value },
});

export const blockOutputsOf = (state: RunState): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const br of state.blocks) {
    const value = blockRunOutput(br);
    if (value !== null) out[fromBlockId(br.blockId)] = value;
  }
  return out;
};

export const applyApprovalPaused = (
  state: RunState,
  blockId: BlockId,
  message: string,
  nowMs: number,
): RunState => {
  const after = mapBlock(state, blockId, (b) => ({
    ...b,
    status: "stuck",
    stuckReason: message,
    startedAtMs: b.startedAtMs ?? nowMs,
  }));
  return { ...after, status: "paused-needs-input" };
};

export const applyApprovalApproved = (
  state: RunState,
  blockId: BlockId,
  nowMs: number,
): RunState => {
  const after = mapBlock(state, blockId, (b) => ({
    ...b,
    status: "done",
    stuckReason: null,
    output: "approved",
    endedAtMs: nowMs,
  }));
  return finalizeRunIfComplete({ ...after, status: "running" }, nowMs);
};

export const firstApprovalAwaitingInput = (
  state: RunState,
): BlockId | null => {
  for (const b of state.blocks) {
    if (b.status !== "stuck") continue;
    const def = state.pipelineSnapshot.blocks.find((d) => d.id === b.blockId);
    if (def && def.kind === "approval") return b.blockId;
  }
  return null;
};

export const applyInputPaused = (
  state: RunState,
  blockId: BlockId,
  message: string,
  nowMs: number,
): RunState => {
  const after = mapBlock(state, blockId, (b) => ({
    ...b,
    status: "stuck",
    stuckReason: message,
    startedAtMs: b.startedAtMs ?? nowMs,
  }));
  return { ...after, status: "paused-needs-input" };
};

export const firstInputAwaitingInput = (
  state: RunState,
): BlockId | null => {
  for (const b of state.blocks) {
    if (b.status !== "stuck") continue;
    const def = state.pipelineSnapshot.blocks.find((d) => d.id === b.blockId);
    if (def && def.kind === "input") return b.blockId;
  }
  return null;
};

export const applyInputSubmitted = (
  state: RunState,
  blockId: BlockId,
  rows: readonly Record<string, string>[],
  nowMs: number,
): RunState => {
  const value = rows.map((r) => JSON.stringify(r)).join("\n");
  const after = mapBlock(state, blockId, (b) => ({
    ...b,
    status: "done",
    stuckReason: null,
    output: value,
    endedAtMs: nowMs,
  }));
  const def = state.pipelineSnapshot.blocks.find((d) => d.id === blockId);
  const outputVar = def && def.kind === "input" ? def.outputVar : null;
  const withVar = outputVar !== null ? setVariable(after, outputVar, value) : after;
  return finalizeRunIfComplete({ ...withVar, status: "running" }, nowMs);
};

export const applyBlocksSkipped = (
  state: RunState,
  blockIds: readonly BlockId[],
  nowMs: number,
): RunState => {
  const skip = new Set<BlockId>(blockIds);
  const after: RunState = {
    ...state,
    blocks: state.blocks.map((b) =>
      skip.has(b.blockId) && b.status === "pending"
        ? { ...b, status: "skipped", startedAtMs: b.startedAtMs ?? nowMs, endedAtMs: nowMs }
        : b,
    ),
  };
  return finalizeRunIfComplete(after, nowMs);
};

export const conditionSkipRange = (
  blocks: readonly Block[],
  conditionId: BlockId,
  skipToBlockId: BlockId | null,
): readonly BlockId[] => {
  const startIdx = blocks.findIndex((b) => b.id === conditionId);
  if (startIdx < 0) return [];
  const endIdx =
    skipToBlockId === null
      ? blocks.length
      : blocks.findIndex((b) => b.id === skipToBlockId);
  const stop = endIdx < 0 ? blocks.length : endIdx;
  if (stop <= startIdx + 1) return [];
  return blocks.slice(startIdx + 1, stop).map((b) => b.id);
};

export const allParallelWorkersDone = (blockRun: BlockRun): boolean => {
  if (!blockRun.parallel) return false;
  return blockRun.parallel.workerRuns.every((w) => w.status === "done");
};
