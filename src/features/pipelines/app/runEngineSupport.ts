import type { SessionTarget } from "../protocol";
import type {
  Block,
  BlockId,
  EffortLevel,
  LoopBlock,
  OrchestratorDecision,
  ParallelBlock,
  RunState,
  WorkerBlock,
} from "../domain/types";
import type { ModelChoice } from "../../../shared/models";
import { assertNever } from "../../../shared/assertNever";

export const SELF_KEY = "_self";
export const MERGER_KEY = "_merger";
export const POOL_KEY = "_pool";
export const MAX_PARALLEL_WORKER_TURNS = 12;
export const RUN_POST_MIN_INTERVAL_MS = 150;
export const MAX_MAP_ITEMS = 500;

export const runShapeSignature = (state: RunState): string => {
  const parts: string[] = [state.status];
  for (const b of state.blocks) {
    parts.push(b.blockId, b.status, String(b.sessions.length), String(b.sessions.filter((s) => s.endedAtMs !== null).length));
    if (b.parallel) {
      parts.push(b.parallel.mergerStatus, String(b.parallel.mergerSessions.length));
      for (const w of b.parallel.workerRuns) parts.push(w.status, String(w.sessions.length));
    }
  }
  return parts.join("|");
};

export type HandleKey = string;

export const handleKey = (blockId: BlockId, sub: string = SELF_KEY): HandleKey =>
  `${blockId}::${sub}`;

export const sessionTargetToHandleSub = (target: SessionTarget): string => {
  switch (target.kind) {
    case "self": return SELF_KEY;
    case "merger": return MERGER_KEY;
    case "parallel-worker": return target.workerBlockId;
    default: return assertNever(target);
  }
};

export class InterruptedError extends Error {
  constructor() { super("Run interrupted."); this.name = "InterruptedError"; }
}

export class BlockFailedError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "BlockFailedError"; }
}

export class PausedError extends Error {
  constructor() { super("Run paused for approval."); this.name = "PausedError"; }
}

export interface SessionMutators {
  readonly applySpawned: (state: RunState, sessionId: string, prompt: string, now: number) => RunState;
  readonly applyStopped: (state: RunState, now: number) => RunState;
  readonly applyDecision: (state: RunState, decision: OrchestratorDecision, now: number) => RunState;
  readonly applyCrashed: (state: RunState, reason: string, now: number) => RunState;
  readonly applyWorkerOutput: (state: RunState, output: string) => RunState;
}

export interface SpawnRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
  readonly resumeSessionId: string | null;
}

export const composePromptWithUpstream = (
  state: RunState,
  currentBlockId: BlockId,
  prompt: string,
): string => {
  const upstream: { name: string; summary: string }[] = [];
  for (const blockDef of state.pipelineSnapshot.blocks) {
    if (blockDef.id === currentBlockId) break;
    const blockRun = state.blocks.find((b) => b.blockId === blockDef.id);
    if (!blockRun) continue;
    const summary = collectBlockSummary(blockDef, blockRun);
    if (summary !== null) upstream.push({ name: blockDef.name, summary });
  }
  if (upstream.length === 0) return prompt;
  const upstreamLines = upstream.map((u) => `- ${u.name}: ${u.summary}`).join("\n");
  return `<previous_steps>\n${upstreamLines}\n</previous_steps>\n\n<your_task>\n${prompt}\n</your_task>`;
};

const collectBlockSummary = (block: Block, blockRun: RunState["blocks"][number]): string | null => {
  if (blockRun.output !== null) return blockRun.output;
  const fromSession = (s: { workerOutput: string | null; summary: string | null }): string | null =>
    s.workerOutput ?? s.summary ?? null;
  if (block.kind === "parallel" && blockRun.parallel) {
    const merger = blockRun.parallel.mergerSessions.at(-1);
    if (merger) {
      const mergerText = fromSession(merger);
      if (mergerText !== null) return mergerText;
    }
    const workerTexts = blockRun.parallel.workerRuns
      .map((w) => {
        const last = w.sessions.at(-1);
        return last ? fromSession(last) : null;
      })
      .filter((s): s is string => typeof s === "string");
    return workerTexts.length > 0 ? workerTexts.join(" | ") : null;
  }
  const last = blockRun.sessions.at(-1);
  return last ? fromSession(last) : null;
};

export const latestSessionIdForParallelWorker = (
  state: RunState,
  blockId: BlockId,
  workerBlockId: BlockId,
): string | null => {
  const blockRun = state.blocks.find((b) => b.blockId === blockId);
  if (!blockRun || !blockRun.parallel) return null;
  const wr = blockRun.parallel.workerRuns.find((w) => w.workerBlockId === workerBlockId);
  return wr?.sessions.at(-1)?.sessionId ?? null;
};

export const buildMergerPrompt = (
  block: ParallelBlock,
  summaries: ReadonlyMap<BlockId, string>,
): string => {
  const lines = [
    `Merge the results of ${block.workers.length} parallel worker(s).`,
    "",
    "Worker outputs:",
    ...block.workers.map((w) => `- ${w.name}: ${summaries.get(w.id) ?? "(no summary)"}`),
    "",
    `Merger goal: ${block.mergerGoal}`,
  ];
  return lines.join("\n");
};

export const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const anySignal = (signals: readonly AbortSignal[]): AbortSignal => {
  const factory = (AbortSignal as unknown as { any?: (s: readonly AbortSignal[]) => AbortSignal }).any;
  if (typeof factory === "function") return factory(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); return ctrl.signal; }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
};

export const blocksInLoopRange = (
  blocks: readonly Block[],
  loopBlock: LoopBlock,
): readonly BlockId[] => {
  const targetIdx = blocks.findIndex((b) => b.id === loopBlock.loopBackToBlockId);
  const loopIdx = blocks.findIndex((b) => b.id === loopBlock.id);
  if (targetIdx < 0 || loopIdx <= targetIdx) return [];
  return blocks.slice(targetIdx, loopIdx + 1).map((b) => b.id);
};

export interface BlockDispatch {
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
}

export const blockDispatch = (block: WorkerBlock | LoopBlock): BlockDispatch => {
  switch (block.kind) {
    case "worker":
      return { prompt: block.prompt, model: block.model, effort: block.effort };
    case "loop":
      return {
        prompt: `Loop evaluator (max ${block.maxIterations} iterations).\n\nGoal: ${block.goal}\n\nReport SUCCESS if a new iteration is needed, or LOOP_DONE if the goal is met.`,
        model: block.evaluatorModel,
        effort: "medium",
      };
    default:
      return assertNever(block);
  }
};
