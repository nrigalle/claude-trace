import type { SpawnHandle } from "./AutomationRunner";
import { type SessionTarget } from "../protocol";
import {
  applyBlockCrashed,
  applyInterrupted,
  applyDeterministicStarted,
  applyDeterministicDone,
  applyDeterministicFailed,
  applyDeterministicLog,
  applyBlocksSkipped,
  applyApprovalPaused,
  applyInputPaused,
  conditionSkipRange,
  setVariable,
  blockOutputsOf,
  nextPendingBlock,
  resetBlocksForLoopIteration,
} from "../domain/scheduler";
import {
  isDeterministicBlock,
  latestSessionId,
  type ApprovalBlock,
  type Block,
  type InputBlock,
  type BlockId,
  type ConditionBlock,
  type EvaluatorBlock,
  type FileBlock,
  type HttpBlock,
  type LlmBlock,
  type LoopBlock,
  type MapBlock,
  type ParallelBlock,
  type PoolBlock,
  type ReduceBlock,
  type RunId,
  type RunState,
  type ScriptBlock,
  type WaitBlock,
  type WorkerBlock,
} from "../domain/types";
import { interpolate, evaluateCondition, type InterpolationContext } from "../domain/interpolate";
import { assertNever } from "../../../shared/assertNever";
import type { PipelinesControllerDeps } from "./PipelinesController";
import { runMapBlockIn, runPoolBlockIn, type PoolHost } from "./poolRunner";

import {
  SELF_KEY,
  MERGER_KEY,
  POOL_KEY,
  MAX_PARALLEL_WORKER_TURNS,
  RUN_POST_MIN_INTERVAL_MS,
  runShapeSignature,
  handleKey,
  sessionTargetToHandleSub,
  InterruptedError,
  linearMutators,
  parallelWorkerMutators,
  mergerMutators,
  BlockFailedError,
  PausedError,
  composePromptWithUpstream,
  latestSessionIdForParallelWorker,
  buildMergerPrompt,
  delay,
  anySignal,
  blocksInLoopRange,
  blockDispatch,
  executeDeterministicBlock,
  crashReasonForTurnEnd,
  type HandleKey,
  type SessionMutators,
  type SpawnRequest,
} from "./runEngineSupport";

interface ActiveRun {
  readonly runId: RunId;
  state: RunState;
  readonly handles: Map<HandleKey, SpawnHandle>;
  readonly abort: AbortController;
}

export class RunEngine {
  private active: ActiveRun | null = null;
  private runPostTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRunPostMs = 0;
  private lastPostedShape = "";

  constructor(
    private readonly deps: PipelinesControllerDeps,
    private readonly onRunListChanged: () => void,
  ) {}

  isRunning(): boolean {
    return this.active !== null;
  }

  activeRunId(): RunId | null {
    return this.active?.runId ?? null;
  }

  renameActiveRun(name: string): RunState | null {
    if (!this.active) return null;
    this.active.state = { ...this.active.state, name };
    return this.active.state;
  }

  async run(state: RunState): Promise<void> {
    const runId = state.runId;
    this.active = {
      runId,
      state,
      handles: new Map<HandleKey, SpawnHandle>(),
      abort: new AbortController(),
    };
    this.persistAndBroadcastRun();
    this.onRunListChanged();
    try {
      await this.dispatchLoop();
    } finally {
      this.deps.runner.killRun(runId);
      this.active = null;
      if (this.runPostTimer !== null) { clearTimeout(this.runPostTimer); this.runPostTimer = null; }
      this.onRunListChanged();
    }
  }

  private appendBlockLog(blockId: BlockId, chunk: string): void {
    const active = this.active;
    if (!active) return;
    active.state = applyDeterministicLog(active.state, blockId, chunk);
    this.postRunUpdate();
  }

  private crashSession(mutators: SessionMutators, reason: string): BlockFailedError {
    const active = this.active!;
    active.state = mutators.applyCrashed(active.state, reason, this.deps.clock());
    this.persistAndBroadcastRun();
    return new BlockFailedError(reason);
  }

  kill(runId: RunId): void {
    if (!this.active || this.active.runId !== runId) return;
    this.active.abort.abort();
    this.deps.runner.killRun(runId);
    this.active.state = applyInterrupted(this.active.state, this.deps.clock());
    this.persistAndBroadcastRun();
  }

  reveal(runId: RunId, blockId: BlockId, target: SessionTarget, sessionId: string | null): void {
    if (this.active && this.active.runId === runId) {
      const sub = sessionTargetToHandleSub(target);
      const handle = this.active.handles.get(handleKey(blockId, sub));
      if (handle) {
        handle.reveal();
        return;
      }
    }
    if (sessionId) {
      this.deps.actions.openSessionInTerminal(sessionId);
    }
  }

  disposeActive(): void {
    if (!this.active) return;
    this.active.abort.abort();
    this.deps.runner.killRun(this.active.runId);
    const interrupted = applyInterrupted(this.active.state, this.deps.clock());
    this.deps.runStore.save(interrupted);
    this.active = null;
  }

  private async dispatchLoop(): Promise<void> {
    const active = this.active;
    if (!active) return;

    while (!active.abort.signal.aborted) {
      const target = nextPendingBlock(active.state);
      if (target === null) return;
      const block = active.state.pipelineSnapshot.blocks.find((b) => b.id === target);
      if (!block) return;

      let decisionKind: "success" | "loop-done";
      try {
        if (block.kind === "parallel") {
          decisionKind = await this.runParallelBlock(block);
        } else if (block.kind === "worker" || block.kind === "loop") {
          decisionKind = await this.runLinearBlock(block);
        } else if (block.kind === "condition") {
          decisionKind = await this.runConditionBlock(block);
        } else if (block.kind === "wait") {
          decisionKind = await this.runWaitBlock(block);
        } else if (block.kind === "reduce") {
          decisionKind = await this.runReduceBlock(block);
        } else if (block.kind === "llm") {
          decisionKind = await this.runLlmBlock(block);
        } else if (block.kind === "evaluator") {
          decisionKind = await this.runEvaluatorBlock(block);
        } else if (block.kind === "map") {
          decisionKind = await this.runMapBlock(block);
        } else if (block.kind === "pool") {
          decisionKind = await this.runPoolBlock(block);
        } else if (block.kind === "approval") {
          decisionKind = await this.runApprovalBlock(block);
        } else if (block.kind === "input") {
          decisionKind = await this.runInputBlock(block);
        } else if (isDeterministicBlock(block)) {
          decisionKind = await this.runDeterministicBlock(block);
        } else {
          return assertNever(block);
        }
      } catch (err) {
        if (err instanceof PausedError) {
          this.persistAndBroadcastRun();
          return;
        }
        if (err instanceof InterruptedError || active.abort.signal.aborted) {
          active.state = applyInterrupted(active.state, this.deps.clock());
          this.persistAndBroadcastRun();
          return;
        }
        if (err instanceof BlockFailedError) {
          active.state = { ...active.state, status: "failed", endedAtMs: this.deps.clock() };
          this.persistAndBroadcastRun();
          return;
        }
        const reason = err instanceof Error ? err.message : String(err);
        active.state = applyBlockCrashed(active.state, block.id, reason, this.deps.clock());
        this.persistAndBroadcastRun();
        return;
      }

      this.maybeIterateLoop(block, decisionKind);
    }
  }

  private maybeIterateLoop(block: Block, decisionKind: "success" | "loop-done"): void {
    if (block.kind !== "loop" || block.loopBackToBlockId === null) return;
    if (decisionKind === "loop-done") return;
    const active = this.active!;
    const blockRunAfter = active.state.blocks.find((b) => b.blockId === block.id);
    if (!blockRunAfter || blockRunAfter.status !== "done") return;
    if (blockRunAfter.sessions.length >= block.maxIterations) return;
    const idsInRange = blocksInLoopRange(active.state.pipelineSnapshot.blocks, block);
    if (idsInRange.length === 0) return;
    for (const id of idsInRange) {
      active.handles.delete(handleKey(id));
      const def = active.state.pipelineSnapshot.blocks.find((b) => b.id === id);
      if (def?.kind === "parallel") {
        for (const w of def.workers) active.handles.delete(handleKey(id, w.id));
        active.handles.delete(handleKey(id, MERGER_KEY));
      }
    }
    active.state = resetBlocksForLoopIteration(active.state, idsInRange);
    this.persistAndBroadcastRun();
  }

  private async runLinearBlock(block: WorkerBlock | LoopBlock): Promise<"success" | "loop-done"> {
    const active = this.active!;
    const blockRunBefore = active.state.blocks.find((b) => b.blockId === block.id)!;
    const dispatch = blockDispatch(block);
    const interpolatedPrompt = interpolate(dispatch.prompt, this.interpolationCtx(), { bareVars: true });
    const chainedPrompt = composePromptWithUpstream(active.state, block.id, interpolatedPrompt);
    const mutators = linearMutators(block.id);
    const turnStartMs = this.deps.clock();
    const restartEach = block.kind === "worker" && block.restartEachIteration === true;
    const handle = await this.spawnTracked(block.id, SELF_KEY, {
      cwd: this.runCwd(),
      prompt: chainedPrompt,
      model: dispatch.model,
      effort: dispatch.effort,
      resumeSessionId: restartEach ? null : latestSessionId(blockRunBefore),
    }, mutators);

    const result = await this.runPatientSession(handle, block.id, chainedPrompt, active.abort.signal, mutators, turnStartMs);
    this.releaseHandle(block.id, SELF_KEY);
    return result.decisionKind;
  }

  private interpolationCtx(): InterpolationContext {
    const active = this.active!;
    return {
      workspace: this.runCwd(),
      vars: active.state.variables,
      blockOutputs: blockOutputsOf(active.state),
    };
  }

  private async runDeterministicBlock(
    block: ScriptBlock | HttpBlock | FileBlock,
  ): Promise<"success"> {
    const active = this.active!;
    active.state = applyDeterministicStarted(active.state, block.id, this.deps.clock());
    this.persistAndBroadcastRun();

    let output: string;
    try {
      output = await executeDeterministicBlock(
        this.deps.deterministic,
        block,
        this.interpolationCtx(),
        active.abort.signal,
        (chunk) => this.appendBlockLog(block.id, chunk),
      );
    } catch (err) {
      if (err instanceof InterruptedError || active.abort.signal.aborted) throw new InterruptedError();
      const reason = err instanceof Error ? err.message : String(err);
      active.state = applyDeterministicFailed(active.state, block.id, reason, this.deps.clock());
      this.persistAndBroadcastRun();
      throw new BlockFailedError(reason);
    }

    active.state = applyDeterministicDone(active.state, block.id, output, this.deps.clock());
    if (block.outputVar !== null) {
      active.state = setVariable(active.state, block.outputVar, output);
    }
    this.persistAndBroadcastRun();
    return "success";
  }

  private async runSingleTurn(
    blockId: BlockId,
    sub: string,
    req: SpawnRequest,
    mutators: SessionMutators,
  ): Promise<{ text: string; jsonlPath: string }> {
    const active = this.active!;
    const turnStartMs = this.deps.clock();
    const handle = await this.spawnTracked(blockId, sub, req, mutators);
    const turnEnd = await handle.waitForTurnEnd(turnStartMs, active.abort.signal);
    if (turnEnd === "aborted") throw new InterruptedError();
    if (turnEnd === "terminal-closed" || turnEnd === "process-exited") {
      throw this.crashSession(mutators, crashReasonForTurnEnd(turnEnd));
    }
    if (turnEnd === "notified") {
      throw this.crashSession(mutators, "Claude hit a permission prompt this unattended step cannot answer.");
    }
    active.state = mutators.applyStopped(active.state, this.deps.clock());
    const text = handle.readLastAssistantText();
    if (text.length > 0) {
      active.state = mutators.applyWorkerOutput(active.state, text);
    }
    this.persistAndBroadcastRun();
    return { text, jsonlPath: handle.jsonlPath };
  }

  private async runLlmBlock(block: LlmBlock): Promise<"success"> {
    const active = this.active!;
    const prompt = interpolate(block.prompt, this.interpolationCtx(), { bareVars: true });
    const mutators = linearMutators(block.id);
    const { text } = await this.runSingleTurn(block.id, SELF_KEY, {
      cwd: this.runCwd(),
      prompt,
      model: block.model,
      effort: block.effort,
      resumeSessionId: null,
    }, mutators);
    this.releaseHandle(block.id, SELF_KEY);
    active.state = applyDeterministicDone(active.state, block.id, text, this.deps.clock());
    if (block.outputVar !== null) {
      active.state = setVariable(active.state, block.outputVar, text);
    }
    this.persistAndBroadcastRun();
    return "success";
  }

  private async runEvaluatorBlock(block: EvaluatorBlock): Promise<"success"> {
    const active = this.active!;
    const goal = interpolate(block.goal, this.interpolationCtx(), { bareVars: true });
    const mutators = linearMutators(block.id);
    const { jsonlPath } = await this.runSingleTurn(block.id, SELF_KEY, {
      cwd: this.runCwd(),
      prompt: goal,
      model: block.evaluatorModel,
      effort: "medium",
      resumeSessionId: null,
    }, mutators);

    const { decision } = await this.deps.runner.judge({
      runId: active.runId,
      blockId: block.id,
      cwd: this.runCwd(),
      taskGoal: goal,
      workerJsonlPath: jsonlPath,
      signal: active.abort.signal,
    });
    if (active.abort.signal.aborted) throw new InterruptedError();
    this.releaseHandle(block.id, SELF_KEY);

    if (decision.kind === "success" || decision.kind === "loop-done") {
      active.state = applyDeterministicDone(active.state, block.id, decision.summary, this.deps.clock());
      this.persistAndBroadcastRun();
      return "success";
    }
    active.state = applyDeterministicFailed(active.state, block.id, `Evaluation failed: ${decision.reason}`, this.deps.clock());
    this.persistAndBroadcastRun();
    throw new BlockFailedError(`Evaluation failed: ${decision.reason}`);
  }

  private poolHost(): PoolHost {
    const active = this.active!;
    return {
      runner: this.deps.runner,
      deterministic: this.deps.deterministic,
      clock: () => this.deps.clock(),
      runId: () => active.runId,
      runCwd: () => this.runCwd(),
      interpolationCtx: () => this.interpolationCtx(),
      signal: () => active.abort.signal,
      getState: () => active.state,
      setState: (state) => { active.state = state; },
      persist: () => this.persistAndBroadcastRun(),
      trackHandle: (key, handle) => active.handles.set(key, handle),
      releaseHandle: (blockId, sub) => this.releaseHandle(blockId, sub),
      releasePoolHandles: (blockId) => this.releasePoolHandles(blockId),
      runSingleTurn: (blockId, sub, req, mutators) => this.runSingleTurn(blockId, sub, req, mutators),
    };
  }

  private async runMapBlock(block: MapBlock): Promise<"success"> {
    return runMapBlockIn(this.poolHost(), block);
  }

  private async runPoolBlock(block: PoolBlock): Promise<"success"> {
    return runPoolBlockIn(this.poolHost(), block);
  }

  private async runApprovalBlock(block: ApprovalBlock): Promise<never> {
    const active = this.active!;
    const message = interpolate(block.message, this.interpolationCtx(), { bareVars: true });
    active.state = applyApprovalPaused(active.state, block.id, message || "Waiting for approval to continue.", this.deps.clock());
    this.persistAndBroadcastRun();
    throw new PausedError();
  }

  private async runInputBlock(block: InputBlock): Promise<never> {
    const active = this.active!;
    const message = interpolate(block.message, this.interpolationCtx(), { bareVars: true });
    active.state = applyInputPaused(active.state, block.id, message || "Fill in the table to continue.", this.deps.clock());
    this.persistAndBroadcastRun();
    throw new PausedError();
  }

  private async runConditionBlock(block: ConditionBlock): Promise<"success"> {
    const active = this.active!;
    active.state = applyDeterministicStarted(active.state, block.id, this.deps.clock());
    this.persistAndBroadcastRun();
    const truthy = evaluateCondition(block.expression, this.interpolationCtx());
    active.state = applyDeterministicDone(active.state, block.id, truthy ? "true" : "false", this.deps.clock());
    if (!truthy) {
      const range = conditionSkipRange(active.state.pipelineSnapshot.blocks, block.id, block.skipToBlockId);
      active.state = applyBlocksSkipped(active.state, range, this.deps.clock());
    }
    this.persistAndBroadcastRun();
    return "success";
  }

  private async runWaitBlock(block: WaitBlock): Promise<"success"> {
    const active = this.active!;
    active.state = applyDeterministicStarted(active.state, block.id, this.deps.clock());
    this.persistAndBroadcastRun();
    await delay(block.durationMs, active.abort.signal);
    if (active.abort.signal.aborted) throw new InterruptedError();
    active.state = applyDeterministicDone(active.state, block.id, `Waited ${block.durationMs}ms`, this.deps.clock());
    this.persistAndBroadcastRun();
    return "success";
  }

  private async runReduceBlock(block: ReduceBlock): Promise<"success"> {
    const active = this.active!;
    active.state = applyDeterministicStarted(active.state, block.id, this.deps.clock());
    this.persistAndBroadcastRun();
    const input = active.state.variables[block.inputVar] ?? "";

    let output: string;
    if (block.mode === "concat") {
      output = input
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join(block.separator);
    } else {
      const prompt = `${interpolate(block.mergerGoal, this.interpolationCtx(), { bareVars: true })}\n\n<input>\n${input}\n</input>`;
      const mutators = linearMutators(block.id);
      const turnStartMs = this.deps.clock();
      const handle = await this.spawnTracked(block.id, SELF_KEY, {
        cwd: this.runCwd(),
        prompt,
        model: block.mergerModel,
        effort: "medium",
        resumeSessionId: null,
      }, mutators);
      const result = await this.runPatientSession(handle, block.id, prompt, active.abort.signal, mutators, turnStartMs);
      this.releaseHandle(block.id, SELF_KEY);
      output = result.summary;
    }

    active.state = applyDeterministicDone(active.state, block.id, output, this.deps.clock());
    if (block.outputVar !== null) {
      active.state = setVariable(active.state, block.outputVar, output);
    }
    this.persistAndBroadcastRun();
    return "success";
  }

  private async runParallelBlock(block: ParallelBlock): Promise<"success" | "loop-done"> {
    const active = this.active!;
    const globalSignal = active.abort.signal;
    const siblingsAbort = new AbortController();
    const combined = anySignal([globalSignal, siblingsAbort.signal]);
    const handles: SpawnHandle[] = [];

    const workerStartTimes = new Map<BlockId, number>();
    for (const worker of block.workers) {
      if (globalSignal.aborted) throw new InterruptedError();
      const restartEach = worker.restartEachIteration === true;
      const resumeId = restartEach ? null : latestSessionIdForParallelWorker(active.state, block.id, worker.id);
      const interpolatedPrompt = interpolate(worker.prompt, this.interpolationCtx(), { bareVars: true });
      const chainedPrompt = composePromptWithUpstream(active.state, block.id, interpolatedPrompt);
      const mutators = parallelWorkerMutators(block.id, worker.id);
      const turnStartMs = this.deps.clock();
      workerStartTimes.set(worker.id, turnStartMs);
      const handle = await this.spawnTracked(block.id, worker.id, {
        cwd: this.runCwd(),
        prompt: chainedPrompt,
        model: worker.model,
        effort: worker.effort,
        resumeSessionId: resumeId,
      }, mutators);
      handles.push(handle);
    }

    const summaries = new Map<BlockId, string>();
    const workerPromises = block.workers.map((worker, i) =>
      this.runParallelWorkerLoop(block, worker, handles[i]!, combined, siblingsAbort, summaries, workerStartTimes.get(worker.id)!),
    );
    const settled = await Promise.allSettled(workerPromises);
    if (globalSignal.aborted) throw new InterruptedError();
    const rejected = settled.find((s) => s.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      siblingsAbort.abort();
      for (const h of handles) h.dispose();
      const reason = rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason);
      throw new BlockFailedError(reason);
    }

    const mergerPrompt = buildMergerPrompt(block, summaries);
    const mutatorsForMerger = mergerMutators(block.id);
    const mergerTurnStartMs = this.deps.clock();
    const mergerHandle = await this.spawnTracked(block.id, MERGER_KEY, {
      cwd: this.runCwd(),
      prompt: mergerPrompt,
      model: block.mergerModel,
      effort: "medium",
      resumeSessionId: null,
    }, mutatorsForMerger);

    const mergerResult = await this.runPatientSession(mergerHandle, block.id, mergerPrompt, globalSignal, mutatorsForMerger, mergerTurnStartMs);
    this.releaseHandle(block.id, MERGER_KEY);
    return mergerResult.decisionKind;
  }

  private async runParallelWorkerLoop(
    parallelBlock: ParallelBlock,
    worker: WorkerBlock,
    initialHandle: SpawnHandle,
    signal: AbortSignal,
    siblingsAbort: AbortController,
    summaries: Map<BlockId, string>,
    initialSinceMs: number,
  ): Promise<void> {
    const active = this.active!;
    const mutators = parallelWorkerMutators(parallelBlock.id, worker.id);
    let handle = initialHandle;
    let sinceMs = initialSinceMs;
    let turns = 0;
    let lastWorkerText = "";

    try {
      while (true) {
        turns += 1;
        const turnEnd = await handle.waitForTurnEnd(sinceMs, signal);
        if (turnEnd === "aborted") throw new InterruptedError();
        if (turnEnd === "terminal-closed" || turnEnd === "process-exited") {
          throw this.crashSession(mutators, crashReasonForTurnEnd(turnEnd));
        }

        active.state = mutators.applyStopped(active.state, this.deps.clock());
        const workerText = handle.readLastAssistantText();
        if (workerText.length > 0) {
          lastWorkerText = workerText;
          active.state = mutators.applyWorkerOutput(active.state, workerText);
        }
        this.persistAndBroadcastRun();

        const priorSessionId = handle.sessionId;
        const priorJsonlPath = handle.jsonlPath;

        this.releaseHandle(parallelBlock.id, worker.id);

        const { decision } = await this.deps.runner.judge({
          runId: active.runId,
          blockId: parallelBlock.id,
          cwd: this.runCwd(),
          taskGoal: worker.prompt,
          workerJsonlPath: priorJsonlPath,
          signal,
        });
        if (signal.aborted) throw new InterruptedError();

        active.state = mutators.applyDecision(active.state, decision, this.deps.clock());
        this.persistAndBroadcastRun();

        if (decision.kind === "success" || decision.kind === "loop-done") {
          summaries.set(worker.id, decision.summary);
          return;
        }
        if (decision.kind === "failed") {
          throw new BlockFailedError(decision.reason);
        }

        if (turns >= MAX_PARALLEL_WORKER_TURNS) {
          summaries.set(worker.id, lastWorkerText.length > 0
            ? `(stopped after ${MAX_PARALLEL_WORKER_TURNS} turns without converging)\n${lastWorkerText}`
            : `(stopped after ${MAX_PARALLEL_WORKER_TURNS} turns without converging)`);
          return;
        }

        try {
          handle = await this.deps.runner.spawn({
            runId: active.runId,
            blockId: parallelBlock.id,
            cwd: this.runCwd(),
            prompt: "",
            model: worker.model,
            effort: worker.effort,
            resumeSessionId: priorSessionId,
            signal,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          active.state = mutators.applyCrashed(active.state, reason, this.deps.clock());
          this.persistAndBroadcastRun();
          throw new BlockFailedError(reason);
        }
        active.handles.set(handleKey(parallelBlock.id, worker.id), handle);
        sinceMs = this.deps.clock();
      }
    } catch (err) {
      if (err instanceof BlockFailedError) siblingsAbort.abort();
      throw err;
    }
  }

  private async spawnTracked(
    blockId: BlockId,
    sub: string,
    req: SpawnRequest,
    mutators: SessionMutators,
  ): Promise<SpawnHandle> {
    const active = this.active!;
    let handle: SpawnHandle;
    try {
      handle = await this.deps.runner.spawn({
        runId: active.runId,
        blockId,
        cwd: req.cwd,
        prompt: req.prompt,
        model: req.model,
        effort: req.effort,
        resumeSessionId: req.resumeSessionId,
        signal: active.abort.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      active.state = mutators.applyCrashed(active.state, reason, this.deps.clock());
      this.persistAndBroadcastRun();
      throw new BlockFailedError(reason);
    }
    active.handles.set(handleKey(blockId, sub), handle);
    active.state = mutators.applySpawned(active.state, handle.sessionId, req.prompt, this.deps.clock());
    this.persistAndBroadcastRun();
    return handle;
  }

  private async runPatientSession(
    handle: SpawnHandle,
    blockId: BlockId,
    judgePrompt: string,
    signal: AbortSignal,
    mutators: SessionMutators,
    initialSinceMs?: number,
  ): Promise<{ summary: string; decisionKind: "success" | "loop-done" }> {
    const active = this.active!;
    let sinceMs = initialSinceMs ?? this.deps.clock();

    while (true) {
      const turnEnd = await handle.waitForTurnEnd(sinceMs, signal);
      if (turnEnd === "aborted") throw new InterruptedError();
      if (turnEnd === "terminal-closed" || turnEnd === "process-exited") {
        throw this.crashSession(mutators, crashReasonForTurnEnd(turnEnd));
      }

      active.state = mutators.applyStopped(active.state, this.deps.clock());
      const workerText = handle.readLastAssistantText();
      if (workerText.length > 0) {
        active.state = mutators.applyWorkerOutput(active.state, workerText);
      }
      this.persistAndBroadcastRun();

      const { decision } = await this.deps.runner.judge({
        runId: active.runId,
        blockId,
        cwd: this.runCwd(),
        taskGoal: judgePrompt,
        workerJsonlPath: handle.jsonlPath,
        signal,
      });
      if (signal.aborted) throw new InterruptedError();

      active.state = mutators.applyDecision(active.state, decision, this.deps.clock());
      this.persistAndBroadcastRun();

      if (decision.kind === "success" || decision.kind === "loop-done") {
        return { summary: decision.summary, decisionKind: decision.kind };
      }
      if (decision.kind === "failed") {
        throw new BlockFailedError(decision.reason);
      }

      sinceMs = this.deps.clock();
    }
  }

  private releaseHandle(blockId: BlockId, sub: string): void {
    if (!this.active) return;
    const key = handleKey(blockId, sub);
    const handle = this.active.handles.get(key);
    if (!handle) return;
    handle.dispose();
    this.active.handles.delete(key);
  }

  private releasePoolHandles(blockId: BlockId): void {
    if (!this.active) return;
    const prefix = handleKey(blockId, `${POOL_KEY}#`);
    for (const key of Array.from(this.active.handles.keys())) {
      if (!key.startsWith(prefix)) continue;
      const handle = this.active.handles.get(key);
      handle?.dispose();
      this.active.handles.delete(key);
    }
  }

  private runCwd(): string {
    const active = this.active!;
    const workspace = this.deps.workspaceCwd?.();
    if (workspace) return workspace;
    return this.deps.runStore.pipelineCwdFor(active.runId, active.state.pipelineId);
  }

  private persistAndBroadcastRun(): void {
    if (!this.active) return;
    this.deps.runStore.save(this.active.state);
    this.postRunUpdate();
  }

  private postRunUpdate(): void {
    const active = this.active;
    if (!active) return;
    const shape = runShapeSignature(active.state);
    const now = Date.now();
    if (shape !== this.lastPostedShape || now - this.lastRunPostMs >= RUN_POST_MIN_INTERVAL_MS) {
      this.flushRunPost();
      return;
    }
    if (this.runPostTimer !== null) return;
    this.runPostTimer = setTimeout(() => {
      this.runPostTimer = null;
      this.flushRunPost();
    }, RUN_POST_MIN_INTERVAL_MS - (now - this.lastRunPostMs));
  }

  private flushRunPost(): void {
    if (!this.active) return;
    if (this.runPostTimer !== null) {
      clearTimeout(this.runPostTimer);
      this.runPostTimer = null;
    }
    this.lastRunPostMs = Date.now();
    this.lastPostedShape = runShapeSignature(this.active.state);
    this.deps.host.postMessage({ type: "runUpdate", run: this.active.state });
  }
}
