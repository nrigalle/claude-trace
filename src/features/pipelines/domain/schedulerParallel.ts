import type {
  BlockId,
  BlockRun,
  BlockSessionRecord,
  BlockStatus,
  OrchestratorDecision,
  RunState,
} from "./types";
import { assertNever } from "../../../shared/assertNever";
import {
  finalizeRunIfComplete,
  mapParallel,
  rebuildParallelBlockStatus,
} from "./scheduler";

export const applyParallelWorkerOutput = (
  state: RunState,
  blockId: BlockId,
  workerBlockId: BlockId,
  workerOutput: string,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => {
    const workerRuns = parallel.workerRuns.map((w) => {
      if (w.workerBlockId !== workerBlockId) return w;
      const lastIdx = w.sessions.length - 1;
      if (lastIdx < 0) return w;
      const last = w.sessions[lastIdx]!;
      return {
        ...w,
        sessions: [...w.sessions.slice(0, lastIdx), { ...last, workerOutput }],
      };
    });
    return { ...blockRun, parallel: { ...parallel, workerRuns } };
  });

export const applyMergerOutput = (
  state: RunState,
  blockId: BlockId,
  workerOutput: string,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => {
    const lastIdx = parallel.mergerSessions.length - 1;
    if (lastIdx < 0) return blockRun;
    const last = parallel.mergerSessions[lastIdx]!;
    const mergerSessions = [...parallel.mergerSessions.slice(0, lastIdx), { ...last, workerOutput }];
    return { ...blockRun, parallel: { ...parallel, mergerSessions } };
  });

export const applyParallelWorkerSpawned = (
  state: RunState,
  blockId: BlockId,
  workerBlockId: BlockId,
  sessionId: string,
  promptSent: string,
  nowMs: number,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => {
    const workerRuns = parallel.workerRuns.map((w) => {
      if (w.workerBlockId !== workerBlockId) return w;
      const session: BlockSessionRecord = {
        sessionId,
        iteration: w.sessions.length,
        promptSent,
        summary: null,
        workerOutput: null,
        startedAtMs: nowMs,
        endedAtMs: null,
      };
      return {
        ...w,
        status: "running" as BlockStatus,
        sessions: [...w.sessions, session],
        startedAtMs: w.startedAtMs ?? nowMs,
      };
    });
    return {
      ...blockRun,
      status: "running",
      startedAtMs: blockRun.startedAtMs ?? nowMs,
      parallel: { ...parallel, workerRuns },
    };
  });

export const applyParallelWorkerStopped = (
  state: RunState,
  blockId: BlockId,
  workerBlockId: BlockId,
  nowMs: number,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => {
    const workerRuns = parallel.workerRuns.map((w) => {
      if (w.workerBlockId !== workerBlockId) return w;
      const lastIdx = w.sessions.length - 1;
      const sessions =
        lastIdx >= 0
          ? [...w.sessions.slice(0, lastIdx), { ...w.sessions[lastIdx]!, endedAtMs: nowMs }]
          : w.sessions;
      return { ...w, status: "judging" as BlockStatus, sessions };
    });
    return { ...blockRun, parallel: { ...parallel, workerRuns } };
  });

export const applyParallelWorkerDecision = (
  state: RunState,
  blockId: BlockId,
  workerBlockId: BlockId,
  decision: OrchestratorDecision,
  nowMs: number,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => {
    const workerRuns = parallel.workerRuns.map((w) => {
      if (w.workerBlockId !== workerBlockId) return w;
      switch (decision.kind) {
        case "success":
        case "loop-done": {
          const lastIdx = w.sessions.length - 1;
          const sessions =
            lastIdx >= 0
              ? [
                  ...w.sessions.slice(0, lastIdx),
                  { ...w.sessions[lastIdx]!, summary: decision.summary },
                ]
              : w.sessions;
          return {
            ...w,
            status: "done" as BlockStatus,
            sessions,
            endedAtMs: nowMs,
            stuckReason: null,
          };
        }
        case "failed":
          return {
            ...w,
            status: "failed" as BlockStatus,
            failureReason: decision.reason,
            endedAtMs: nowMs,
          };
        case "needs-input":
          return {
            ...w,
            status: "stuck" as BlockStatus,
            stuckReason: decision.reason,
          };
        default:
          return assertNever(decision);
      }
    });
    return rebuildParallelBlockStatus({ ...blockRun, parallel: { ...parallel, workerRuns } });
  });

export const applyParallelWorkerCrashed = (
  state: RunState,
  blockId: BlockId,
  workerBlockId: BlockId,
  reason: string,
  nowMs: number,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => {
    const workerRuns = parallel.workerRuns.map((w) =>
      w.workerBlockId === workerBlockId
        ? { ...w, status: "failed" as BlockStatus, failureReason: reason, endedAtMs: nowMs }
        : w,
    );
    const failed: BlockRun = {
      ...blockRun,
      status: "failed",
      failureReason: reason,
      endedAtMs: nowMs,
      parallel: { ...parallel, workerRuns },
    };
    return { ...failed };
  });

export const applyMergerSpawned = (
  state: RunState,
  blockId: BlockId,
  sessionId: string,
  promptSent: string,
  nowMs: number,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => {
    const session: BlockSessionRecord = {
      sessionId,
      iteration: parallel.mergerSessions.length,
      promptSent,
      summary: null,
      workerOutput: null,
      startedAtMs: nowMs,
      endedAtMs: null,
    };
    return {
      ...blockRun,
      status: "running",
      parallel: {
        ...parallel,
        mergerSessions: [...parallel.mergerSessions, session],
        mergerStatus: "running",
        mergerStuckReason: null,
      },
    };
  });

export const applyMergerStopped = (
  state: RunState,
  blockId: BlockId,
  nowMs: number,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => {
    const lastIdx = parallel.mergerSessions.length - 1;
    const mergerSessions =
      lastIdx >= 0
        ? [
            ...parallel.mergerSessions.slice(0, lastIdx),
            { ...parallel.mergerSessions[lastIdx]!, endedAtMs: nowMs },
          ]
        : parallel.mergerSessions;
    return {
      ...blockRun,
      parallel: { ...parallel, mergerSessions, mergerStatus: "judging" },
    };
  });

export const applyMergerDecision = (
  state: RunState,
  blockId: BlockId,
  decision: OrchestratorDecision,
  nowMs: number,
): RunState => {
  const next = mapParallel(state, blockId, (parallel, blockRun) => {
    switch (decision.kind) {
      case "success":
      case "loop-done": {
        const lastIdx = parallel.mergerSessions.length - 1;
        const mergerSessions =
          lastIdx >= 0
            ? [
                ...parallel.mergerSessions.slice(0, lastIdx),
                { ...parallel.mergerSessions[lastIdx]!, summary: decision.summary },
              ]
            : parallel.mergerSessions;
        return {
          ...blockRun,
          status: "done",
          endedAtMs: nowMs,
          stuckReason: null,
          parallel: {
            ...parallel,
            mergerSessions,
            mergerStatus: "done",
            mergerStuckReason: null,
          },
        };
      }
      case "failed":
        return {
          ...blockRun,
          status: "failed",
          failureReason: decision.reason,
          endedAtMs: nowMs,
          parallel: { ...parallel, mergerStatus: "failed" },
        };
      case "needs-input":
        return {
          ...blockRun,
          status: "stuck",
          stuckReason: decision.reason,
          parallel: {
            ...parallel,
            mergerStatus: "stuck",
            mergerStuckReason: decision.reason,
          },
        };
      default:
        return assertNever(decision);
    }
  });
  if (decision.kind === "needs-input") {
    return { ...next, status: "paused-needs-input" };
  }
  if (decision.kind === "failed") {
    return { ...next, status: "failed", endedAtMs: nowMs };
  }
  return finalizeRunIfComplete(next, nowMs);
};

export const applyMergerCrashed = (
  state: RunState,
  blockId: BlockId,
  reason: string,
  nowMs: number,
): RunState =>
  mapParallel(state, blockId, (parallel, blockRun) => ({
    ...blockRun,
    status: "failed",
    failureReason: reason,
    endedAtMs: nowMs,
    parallel: { ...parallel, mergerStatus: "failed" },
  }));

