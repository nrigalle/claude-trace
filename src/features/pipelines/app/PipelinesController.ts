import type { AutomationRunner, SpawnHandle } from "./AutomationRunner";
import type { DeterministicRunner } from "./DeterministicRunner";
import type { PipelineStore } from "../infra/PipelineStore";
import type { RunStore } from "../infra/RunStore";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
} from "../protocol";
import { assertNeverPipelines, type SessionTarget } from "../protocol";
import {
  applyBlockCrashed,
  applyBlockSpawned,
  applyBlockStopped,
  applyDecision,
  applyInterrupted,
  applyMergerCrashed,
  applyMergerDecision,
  applyMergerOutput,
  applyMergerSpawned,
  applyMergerStopped,
  applyParallelWorkerCrashed,
  applyParallelWorkerDecision,
  applyParallelWorkerOutput,
  applyParallelWorkerSpawned,
  applyParallelWorkerStopped,
  applyWorkerOutput,
  applyDeterministicStarted,
  applyDeterministicDone,
  applyDeterministicFailed,
  applyBlocksSkipped,
  applyApprovalPaused,
  applyApprovalApproved,
  firstApprovalAwaitingInput,
  conditionSkipRange,
  setVariable,
  blockOutputsOf,
  initialRunState,
  nextPendingBlock,
  resetBlocksForLoopIteration,
} from "../domain/scheduler";
import {
  fromPipelineId,
  isDeterministicBlock,
  latestSessionId,
  toRunId,
  type ApprovalBlock,
  type Block,
  type BlockId,
  type ConditionBlock,
  type EvaluatorBlock,
  type FileBlock,
  type HttpBlock,
  type LlmBlock,
  type LoopBlock,
  type MapBlock,
  type OrchestratorDecision,
  type ParallelBlock,
  type Pipeline,
  type PipelineId,
  type ReduceBlock,
  type RunId,
  type RunState,
  type ScriptBlock,
  type WaitBlock,
  type WorkerBlock,
} from "../domain/types";
import type { ModelChoice } from "../../../shared/models";
import type { EffortLevel } from "../domain/types";
import { validatePipeline } from "../domain/validate";
import { interpolate, evaluateCondition, type InterpolationContext } from "../domain/interpolate";
import { assertNever } from "../../../shared/assertNever";

export interface PipelinesHost {
  postMessage(msg: PipelinesHostToWebview): void;
  onMessage(listener: (msg: PipelinesWebviewToHost) => void): { dispose(): void };
  onDispose(listener: () => void): { dispose(): void };
}

export interface PipelinesActions {
  askPipelineName(initial: string): Promise<string | null>;
  confirmDeletePipeline(name: string): Promise<boolean>;
  confirmDeleteRun(): Promise<boolean>;
  openSessionInTerminal(sessionId: string): void;
}

export interface PipelinesControllerDeps {
  readonly host: PipelinesHost;
  readonly pipelineStore: PipelineStore;
  readonly runStore: RunStore;
  readonly runner: AutomationRunner;
  readonly deterministic: DeterministicRunner;
  readonly actions: PipelinesActions;
  readonly clock: () => number;
  readonly newRunId: () => RunId;
  readonly onPipelinesChanged?: () => void;
}

const SELF_KEY = "_self";
const MERGER_KEY = "_merger";

type HandleKey = string;

const handleKey = (blockId: BlockId, sub: string = SELF_KEY): HandleKey =>
  `${blockId}::${sub}`;

const sessionTargetToHandleSub = (target: SessionTarget): string => {
  switch (target.kind) {
    case "self": return SELF_KEY;
    case "merger": return MERGER_KEY;
    case "parallel-worker": return target.workerBlockId;
    default: return assertNever(target);
  }
};

interface ActiveRun {
  readonly runId: RunId;
  state: RunState;
  readonly handles: Map<HandleKey, SpawnHandle>;
  readonly abort: AbortController;
}

class InterruptedError extends Error {
  constructor() { super("Run interrupted."); this.name = "InterruptedError"; }
}

class BlockFailedError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "BlockFailedError"; }
}

class PausedError extends Error {
  constructor() { super("Run paused for approval."); this.name = "PausedError"; }
}

interface SessionMutators {
  readonly applySpawned: (state: RunState, sessionId: string, prompt: string, now: number) => RunState;
  readonly applyStopped: (state: RunState, now: number) => RunState;
  readonly applyDecision: (state: RunState, decision: OrchestratorDecision, now: number) => RunState;
  readonly applyCrashed: (state: RunState, reason: string, now: number) => RunState;
  readonly applyWorkerOutput: (state: RunState, output: string) => RunState;
}

interface SpawnRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
  readonly resumeSessionId: string | null;
}

export class PipelinesController {
  private readonly disposables: { dispose(): void }[] = [];
  private active: ActiveRun | null = null;
  private disposed = false;

  constructor(private readonly deps: PipelinesControllerDeps) {
    this.disposables.push(deps.host.onMessage((m) => this.onMessage(m)));
    this.disposables.push(deps.host.onDispose(() => this.dispose()));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) {
      this.active.abort.abort();
      this.deps.runner.killRun(this.active.runId);
      const interrupted = applyInterrupted(this.active.state, this.deps.clock());
      this.deps.runStore.save(interrupted);
      this.active = null;
    }
    this.deps.runner.dispose();
    for (const d of this.disposables) {
      try { d.dispose(); } catch {}
    }
    this.disposables.length = 0;
  }

  private onMessage(msg: PipelinesWebviewToHost): void {
    switch (msg.type) {
      case "ready": this.broadcastList(); return;
      case "createPipeline": void this.handleCreate(); return;
      case "loadPipeline": this.handleLoadPipeline(msg.pipelineId); return;
      case "savePipeline": this.handleSave(msg.pipeline); return;
      case "deletePipeline": void this.handleDelete(msg.pipelineId); return;
      case "runPipeline": void this.handleRun(msg.pipelineId); return;
      case "killRun": this.handleKill(msg.runId); return;
      case "deleteRun": void this.handleDeleteRun(msg.runId); return;
      case "revealSession": this.handleReveal(msg.runId, msg.blockId, msg.target, msg.sessionId); return;
      case "loadRun": this.handleLoadRun(msg.runId); return;
      case "resumeRun": void this.handleResumeRun(msg.runId); return;
      default: return assertNeverPipelines(msg);
    }
  }

  private broadcastList(): void {
    this.deps.host.postMessage({
      type: "pipelinesList",
      payload: {
        pipelines: this.deps.pipelineStore.list(),
        runs: this.deps.runStore.list(),
      },
    });
    this.deps.onPipelinesChanged?.();
  }

  private async handleCreate(): Promise<void> {
    const name = await this.deps.actions.askPipelineName("");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      this.notice("warning", "Pipeline name is required.");
      return;
    }
    const now = this.deps.clock();
    const pipeline: Pipeline = {
      id: newPipelineId(trimmed, now),
      name: trimmed,
      createdAtMs: now,
      updatedAtMs: now,
      blocks: [],
      triggers: [],
    };
    this.deps.pipelineStore.save(pipeline);
    this.broadcastList();
    this.deps.host.postMessage({ type: "pipelineDetail", pipeline });
  }

  private handleLoadPipeline(id: PipelineId): void {
    const pipeline = this.deps.pipelineStore.get(id);
    if (!pipeline) {
      this.notice("error", `Pipeline ${fromPipelineId(id)} was not found.`);
      return;
    }
    this.deps.host.postMessage({ type: "pipelineDetail", pipeline });
  }

  private handleSave(pipeline: Pipeline): void {
    const errors = validatePipeline(pipeline);
    if (errors.length > 0) {
      this.deps.host.postMessage({ type: "validationFailed", errors });
      return;
    }
    const stamped: Pipeline = { ...pipeline, updatedAtMs: this.deps.clock() };
    this.deps.pipelineStore.save(stamped);
    this.broadcastList();
    this.deps.host.postMessage({ type: "pipelineDetail", pipeline: stamped });
  }

  private async handleDelete(id: PipelineId): Promise<void> {
    const existing = this.deps.pipelineStore.get(id);
    if (!existing) { this.broadcastList(); return; }
    const confirmed = await this.deps.actions.confirmDeletePipeline(existing.name);
    if (!confirmed) return;
    this.deps.pipelineStore.delete(id);
    this.broadcastList();
  }

  triggerRun(id: PipelineId): void {
    if (this.disposed) return;
    void this.handleRun(id);
  }

  private async handleRun(id: PipelineId): Promise<void> {
    if (this.active) {
      this.notice("warning", "Another pipeline is already running. Wait for it to finish or stop it first.");
      return;
    }
    const pipeline = this.deps.pipelineStore.get(id);
    if (!pipeline) {
      this.notice("error", `Pipeline ${fromPipelineId(id)} was not found.`);
      return;
    }
    const errors = validatePipeline(pipeline);
    if (errors.length > 0) {
      this.deps.host.postMessage({ type: "validationFailed", errors });
      return;
    }

    const runId = this.deps.newRunId();
    this.active = {
      runId,
      state: initialRunState(pipeline, runId, this.deps.clock()),
      handles: new Map<HandleKey, SpawnHandle>(),
      abort: new AbortController(),
    };
    this.persistAndBroadcastRun();
    this.broadcastList();

    try {
      await this.dispatchLoop();
    } finally {
      this.deps.runner.killRun(runId);
      this.active = null;
      this.broadcastList();
    }
  }

  private async handleDeleteRun(runId: RunId): Promise<void> {
    if (this.active && this.active.runId === runId) {
      this.notice("warning", "Cannot delete a run that is currently active. Cancel it first.");
      return;
    }
    const existing = this.deps.runStore.get(runId);
    if (!existing) {
      this.broadcastList();
      return;
    }
    const confirmed = await this.deps.actions.confirmDeleteRun();
    if (!confirmed) return;
    this.deps.runStore.delete(runId);
    this.broadcastList();
  }

  private handleKill(runId: RunId): void {
    if (!this.active || this.active.runId !== runId) return;
    this.active.abort.abort();
    this.deps.runner.killRun(runId);
  }

  private handleReveal(runId: RunId, blockId: BlockId, target: SessionTarget, sessionId: string | null): void {
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

  private handleLoadRun(runId: RunId): void {
    const state = this.deps.runStore.get(runId);
    if (!state) { this.notice("error", "Run not found."); return; }
    this.deps.host.postMessage({ type: "runUpdate", run: state });
  }

  private async handleResumeRun(runId: RunId): Promise<void> {
    if (this.active) {
      this.notice("warning", "A pipeline is already running. Wait for it to finish first.");
      return;
    }
    const state = this.deps.runStore.get(runId);
    if (!state || state.status !== "paused-needs-input") return;
    const approvalId = firstApprovalAwaitingInput(state);
    if (approvalId === null) {
      this.notice("warning", "This run is not waiting on an approval step.");
      return;
    }
    this.active = {
      runId,
      state: applyApprovalApproved(state, approvalId, this.deps.clock()),
      handles: new Map<HandleKey, SpawnHandle>(),
      abort: new AbortController(),
    };
    this.persistAndBroadcastRun();
    this.broadcastList();
    try {
      await this.dispatchLoop();
    } finally {
      this.deps.runner.killRun(runId);
      this.active = null;
      this.broadcastList();
    }
  }

  private notice(level: "info" | "warning" | "error", message: string): void {
    this.deps.host.postMessage({ type: "notice", level, message });
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
        } else if (block.kind === "approval") {
          decisionKind = await this.runApprovalBlock(block);
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
    const interpolatedPrompt = interpolate(dispatch.prompt, this.interpolationCtx());
    const chainedPrompt = composePromptWithUpstream(active.state, block.id, interpolatedPrompt);
    const mutators = this.linearMutators(block.id);
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
      output = await this.executeDeterministic(block, this.interpolationCtx(), active.abort.signal);
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
    if (turnEnd === "terminal-closed") {
      const reason = "Terminal was closed before Claude finished responding.";
      active.state = mutators.applyCrashed(active.state, reason, this.deps.clock());
      this.persistAndBroadcastRun();
      throw new BlockFailedError(reason);
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
    const prompt = interpolate(block.prompt, this.interpolationCtx());
    const mutators = this.linearMutators(block.id);
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
    const goal = interpolate(block.goal, this.interpolationCtx());
    const mutators = this.linearMutators(block.id);
    const { jsonlPath } = await this.runSingleTurn(block.id, SELF_KEY, {
      cwd: this.runCwd(),
      prompt: goal,
      model: block.evaluatorModel,
      effort: "medium",
      resumeSessionId: null,
    }, mutators);

    const decision = await this.deps.runner.judge({
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

  private async runMapBlock(block: MapBlock): Promise<"success"> {
    const active = this.active!;
    active.state = applyDeterministicStarted(active.state, block.id, this.deps.clock());
    this.persistAndBroadcastRun();

    const list = active.state.variables[block.listVar] ?? "";
    const items = list.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const mutators = this.linearMutators(block.id);
    const outputs: string[] = [];

    for (const item of items) {
      if (active.abort.signal.aborted) throw new InterruptedError();
      const base = this.interpolationCtx();
      const ctx: InterpolationContext = { ...base, vars: { ...base.vars, [block.itemVar]: item } };
      const prompt = interpolate(block.prompt, ctx);
      const { text } = await this.runSingleTurn(block.id, SELF_KEY, {
        cwd: this.runCwd(),
        prompt,
        model: block.model,
        effort: block.effort,
        resumeSessionId: null,
      }, mutators);
      this.releaseHandle(block.id, SELF_KEY);
      outputs.push(text);
    }

    const combined = outputs.join("\n");
    active.state = applyDeterministicDone(active.state, block.id, combined, this.deps.clock());
    if (block.outputVar !== null) {
      active.state = setVariable(active.state, block.outputVar, combined);
    }
    this.persistAndBroadcastRun();
    return "success";
  }

  private async runApprovalBlock(block: ApprovalBlock): Promise<never> {
    const active = this.active!;
    const message = interpolate(block.message, this.interpolationCtx());
    active.state = applyApprovalPaused(active.state, block.id, message || "Waiting for approval to continue.", this.deps.clock());
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
      const prompt = `${interpolate(block.mergerGoal, this.interpolationCtx())}\n\n<input>\n${input}\n</input>`;
      const mutators = this.linearMutators(block.id);
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

  private async executeDeterministic(
    block: ScriptBlock | HttpBlock | FileBlock,
    ctx: InterpolationContext,
    signal: AbortSignal,
  ): Promise<string> {
    switch (block.kind) {
      case "script": {
        const result = await this.deps.deterministic.runScript({
          interpreter: block.interpreter,
          code: interpolate(block.code, ctx),
          cwd: ctx.workspace,
          env: ctx.vars,
          signal,
        });
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim();
          throw new Error(`Script exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`);
        }
        return result.stdout.trim();
      }
      case "http": {
        const url = interpolate(block.url, ctx);
        const result = await this.deps.deterministic.runHttp({
          method: block.method,
          url,
          headers: block.headers.map((h) => ({
            name: interpolate(h.name, ctx),
            value: interpolate(h.value, ctx),
          })),
          body: block.body === null ? null : interpolate(block.body, ctx),
          signal,
        });
        if (result.status >= 400) {
          throw new Error(`HTTP ${block.method} ${url} returned ${result.status}`);
        }
        return result.body;
      }
      case "file": {
        const path = interpolate(block.path, ctx);
        if (block.operation === "write") {
          await this.deps.deterministic.writeFile({ cwd: ctx.workspace, path, content: interpolate(block.content, ctx) });
          return path;
        }
        return this.deps.deterministic.readFile({ cwd: ctx.workspace, path });
      }
      default:
        return assertNever(block);
    }
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
      const interpolatedPrompt = interpolate(worker.prompt, this.interpolationCtx());
      const chainedPrompt = composePromptWithUpstream(active.state, block.id, interpolatedPrompt);
      const mutators = this.parallelWorkerMutators(block.id, worker.id);
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
    const mergerMutators = this.mergerMutators(block.id);
    const mergerTurnStartMs = this.deps.clock();
    const mergerHandle = await this.spawnTracked(block.id, MERGER_KEY, {
      cwd: this.runCwd(),
      prompt: mergerPrompt,
      model: block.mergerModel,
      effort: "medium",
      resumeSessionId: null,
    }, mergerMutators);

    const mergerResult = await this.runPatientSession(mergerHandle, block.id, mergerPrompt, globalSignal, mergerMutators, mergerTurnStartMs);
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
    const mutators = this.parallelWorkerMutators(parallelBlock.id, worker.id);
    let handle = initialHandle;
    let sinceMs = initialSinceMs;

    try {
      while (true) {
        const turnEnd = await handle.waitForTurnEnd(sinceMs, signal);
        if (turnEnd === "aborted") throw new InterruptedError();
        if (turnEnd === "terminal-closed") {
          const reason = "Terminal was closed before Claude finished responding.";
          active.state = mutators.applyCrashed(active.state, reason, this.deps.clock());
          this.persistAndBroadcastRun();
          throw new BlockFailedError(reason);
        }

        active.state = mutators.applyStopped(active.state, this.deps.clock());
        const workerText = handle.readLastAssistantText();
        if (workerText.length > 0) {
          active.state = mutators.applyWorkerOutput(active.state, workerText);
        }
        this.persistAndBroadcastRun();

        const priorSessionId = handle.sessionId;
        const priorJsonlPath = handle.jsonlPath;

        this.releaseHandle(parallelBlock.id, worker.id);

        const decision = await this.deps.runner.judge({
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
        handle.reveal();
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
      if (turnEnd === "terminal-closed") {
        const reason = "Terminal was closed before Claude finished responding.";
        active.state = mutators.applyCrashed(active.state, reason, this.deps.clock());
        this.persistAndBroadcastRun();
        throw new BlockFailedError(reason);
      }

      active.state = mutators.applyStopped(active.state, this.deps.clock());
      const workerText = handle.readLastAssistantText();
      if (workerText.length > 0) {
        active.state = mutators.applyWorkerOutput(active.state, workerText);
      }
      this.persistAndBroadcastRun();

      const decision = await this.deps.runner.judge({
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

      handle.reveal();
      sinceMs = this.deps.clock();
    }
  }

  private linearMutators(blockId: BlockId): SessionMutators {
    return {
      applySpawned: (s, sid, p, n) => applyBlockSpawned(s, blockId, sid, p, n),
      applyStopped: (s, n) => applyBlockStopped(s, blockId, n),
      applyDecision: (s, d, n) => applyDecision(s, blockId, d, n),
      applyCrashed: (s, r, n) => applyBlockCrashed(s, blockId, r, n),
      applyWorkerOutput: (s, o) => applyWorkerOutput(s, blockId, o),
    };
  }

  private parallelWorkerMutators(blockId: BlockId, workerBlockId: BlockId): SessionMutators {
    return {
      applySpawned: (s, sid, p, n) => applyParallelWorkerSpawned(s, blockId, workerBlockId, sid, p, n),
      applyStopped: (s, n) => applyParallelWorkerStopped(s, blockId, workerBlockId, n),
      applyDecision: (s, d, n) => applyParallelWorkerDecision(s, blockId, workerBlockId, d, n),
      applyCrashed: (s, r, n) => applyParallelWorkerCrashed(s, blockId, workerBlockId, r, n),
      applyWorkerOutput: (s, o) => applyParallelWorkerOutput(s, blockId, workerBlockId, o),
    };
  }

  private mergerMutators(blockId: BlockId): SessionMutators {
    return {
      applySpawned: (s, sid, p, n) => applyMergerSpawned(s, blockId, sid, p, n),
      applyStopped: (s, n) => applyMergerStopped(s, blockId, n),
      applyDecision: (s, d, n) => applyMergerDecision(s, blockId, d, n),
      applyCrashed: (s, r, n) => applyMergerCrashed(s, blockId, r, n),
      applyWorkerOutput: (s, o) => applyMergerOutput(s, blockId, o),
    };
  }

  private releaseHandle(blockId: BlockId, sub: string): void {
    if (!this.active) return;
    const key = handleKey(blockId, sub);
    const handle = this.active.handles.get(key);
    if (!handle) return;
    handle.dispose();
    this.active.handles.delete(key);
  }

  private runCwd(): string {
    const active = this.active!;
    return this.deps.runStore.pipelineCwdFor(active.runId, active.state.pipelineId);
  }

  private persistAndBroadcastRun(): void {
    if (!this.active) return;
    this.deps.runStore.save(this.active.state);
    this.deps.host.postMessage({ type: "runUpdate", run: this.active.state });
  }
}

const composePromptWithUpstream = (
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

const latestSessionIdForParallelWorker = (
  state: RunState,
  blockId: BlockId,
  workerBlockId: BlockId,
): string | null => {
  const blockRun = state.blocks.find((b) => b.blockId === blockId);
  if (!blockRun || !blockRun.parallel) return null;
  const wr = blockRun.parallel.workerRuns.find((w) => w.workerBlockId === workerBlockId);
  return wr?.sessions.at(-1)?.sessionId ?? null;
};

const buildMergerPrompt = (
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

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

const anySignal = (signals: readonly AbortSignal[]): AbortSignal => {
  const factory = (AbortSignal as unknown as { any?: (s: readonly AbortSignal[]) => AbortSignal }).any;
  if (typeof factory === "function") return factory(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); return ctrl.signal; }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
};

const blocksInLoopRange = (
  blocks: readonly Block[],
  loopBlock: LoopBlock,
): readonly BlockId[] => {
  const targetIdx = blocks.findIndex((b) => b.id === loopBlock.loopBackToBlockId);
  const loopIdx = blocks.findIndex((b) => b.id === loopBlock.id);
  if (targetIdx < 0 || loopIdx <= targetIdx) return [];
  return blocks.slice(targetIdx, loopIdx + 1).map((b) => b.id);
};

interface BlockDispatch {
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
}

const blockDispatch = (block: WorkerBlock | LoopBlock): BlockDispatch => {
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

const newPipelineId = (name: string, nowMs: number): PipelineId => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "pipeline";
  return `${slug}-${nowMs.toString(36)}` as PipelineId;
};

export const newRunIdFromClock = (nowMs: number): RunId => {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return toRunId(`${iso}_${Math.floor(Math.random() * 1_000_000).toString(36)}`);
};
