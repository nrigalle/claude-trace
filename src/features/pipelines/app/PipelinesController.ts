import type { AutomationRunner } from "./AutomationRunner";
import type { DeterministicRunner } from "./DeterministicRunner";
import { RunEngine } from "./RunEngine";
import type { PipelineStore } from "../infra/PipelineStore";
import type { RunStore } from "../infra/RunStore";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
} from "../protocol";
import { assertNeverPipelines, type SessionTarget } from "../protocol";
import {
  applyApprovalApproved,
  firstApprovalAwaitingInput,
  initialRunState,
} from "../domain/scheduler";
import {
  fromPipelineId,
  toRunId,
  type BlockId,
  type Pipeline,
  type PipelineId,
  type RunId,
} from "../domain/types";
import { validatePipeline } from "../domain/validate";
import type { PipelineAssistant } from "../infra/PipelineAssistant";
import type { AssistantSessionStore } from "../infra/AssistantSessionStore";
import type { EffortChoice, ModelChoice } from "../../../shared/models";

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
  readonly assistant?: PipelineAssistant;
  readonly assistantSessions?: AssistantSessionStore;
  readonly workspaceCwd?: () => string | null;
}


export class PipelinesController {
  private readonly disposables: { dispose(): void }[] = [];
  private readonly engine: RunEngine;
  private disposed = false;

  constructor(private readonly deps: PipelinesControllerDeps) {
    this.engine = new RunEngine(deps, () => this.broadcastList());
    this.disposables.push(deps.host.onMessage((m) => this.onMessage(m)));
    this.disposables.push(deps.host.onDispose(() => this.dispose()));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.disposeActive();
    this.deps.assistant?.dispose();
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
      case "pipelineAssistantAsk": void this.handleAssistantAsk(msg.pipeline, msg.conversationId, msg.message, msg.model, msg.effort); return;
      case "pipelineAssistantListConversations": this.handleAssistantListConversations(msg.pipelineId); return;
      case "pipelineAssistantLoadHistory": this.handleAssistantHistory(msg.pipelineId, msg.conversationId); return;
      case "pipelineAssistantCancel": this.deps.assistant?.cancel(msg.conversationId); return;
      case "pipelineAssistantRenameConversation":
        this.deps.assistantSessions?.rename(msg.pipelineId, msg.conversationId, conversationTitle(msg.title));
        this.handleAssistantListConversations(msg.pipelineId);
        return;
      case "pipelineAssistantDeleteConversation":
        this.deps.assistant?.reset(msg.conversationId);
        this.deps.assistantSessions?.delete(msg.pipelineId, msg.conversationId);
        this.handleAssistantListConversations(msg.pipelineId);
        return;
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
    if (this.engine.isRunning()) {
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
    await this.engine.run(initialRunState(pipeline, runId, this.deps.clock()));
  }

  private async handleDeleteRun(runId: RunId): Promise<void> {
    if (this.engine.activeRunId() === runId) {
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
    this.engine.kill(runId);
  }

  private handleReveal(runId: RunId, blockId: BlockId, target: SessionTarget, sessionId: string | null): void {
    this.engine.reveal(runId, blockId, target, sessionId);
  }

  private handleLoadRun(runId: RunId): void {
    const state = this.deps.runStore.get(runId);
    if (!state) { this.notice("error", "Run not found."); return; }
    this.deps.host.postMessage({ type: "runUpdate", run: state });
  }

  private async handleResumeRun(runId: RunId): Promise<void> {
    if (this.engine.isRunning()) {
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
    await this.engine.run(applyApprovalApproved(state, approvalId, this.deps.clock()));
  }

  private adoptIfSaved(pipelineId: PipelineId, conversationId: string): void {
    const assistant = this.deps.assistant;
    if (!assistant || assistant.sessionInfo(conversationId)) return;
    const saved = this.deps.assistantSessions?.get(pipelineId, conversationId);
    if (saved) assistant.adopt(conversationId, saved.sessionId, saved.cwd);
  }

  private handleAssistantListConversations(pipelineId: PipelineId): void {
    const conversations = (this.deps.assistantSessions?.list(pipelineId) ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      createdAtMs: c.createdAtMs,
      updatedAtMs: c.updatedAtMs,
    }));
    this.deps.host.postMessage({ type: "pipelineAssistantConversations", pipelineId, conversations });
  }

  private async handleAssistantAsk(
    pipeline: Pipeline,
    conversationId: string,
    message: string,
    model: ModelChoice,
    effort: EffortChoice,
  ): Promise<void> {
    const assistant = this.deps.assistant;
    if (!assistant) {
      this.notice("error", "The workflow assistant is not available.");
      return;
    }
    const pipelineId = pipeline.id;
    this.adoptIfSaved(pipelineId, conversationId);
    this.deps.host.postMessage({ type: "pipelineAssistantBusy", pipelineId, conversationId, busy: true });
    try {
      const result = await assistant.ask(
        conversationId,
        {
          pipeline,
          workspaceCwd: this.deps.workspaceCwd?.() ?? null,
          otherPipelines: this.deps.pipelineStore.list().filter((p) => p.id !== pipelineId),
        },
        message,
        {
          model,
          effort,
          onProgress: (events) =>
            this.deps.host.postMessage({ type: "pipelineAssistantProgress", pipelineId, conversationId, events }),
        },
      );
      this.persistConversation(pipelineId, conversationId, message);
      this.deps.host.postMessage({
        type: "pipelineAssistantReply",
        pipelineId,
        conversationId,
        events: result.events,
        text: result.text,
        proposedPipeline: result.proposal.pipeline,
        proposalErrors: result.proposal.errors,
      });
      this.handleAssistantListConversations(pipelineId);
    } catch (err) {
      this.deps.host.postMessage({
        type: "pipelineAssistantError",
        pipelineId,
        conversationId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.deps.host.postMessage({ type: "pipelineAssistantBusy", pipelineId, conversationId, busy: false });
    }
  }

  private persistConversation(pipelineId: PipelineId, conversationId: string, latestMessage: string): void {
    const assistant = this.deps.assistant;
    const store = this.deps.assistantSessions;
    if (!assistant || !store) return;
    const info = assistant.sessionInfo(conversationId);
    if (!info) return;
    const now = this.deps.clock();
    const existing = store.get(pipelineId, conversationId);
    store.upsert(pipelineId, {
      id: conversationId,
      sessionId: info.sessionId,
      cwd: info.cwd,
      title: existing?.title ?? conversationTitle(latestMessage),
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    });
  }

  private handleAssistantHistory(pipelineId: PipelineId, conversationId: string): void {
    const assistant = this.deps.assistant;
    if (!assistant) return;
    this.adoptIfSaved(pipelineId, conversationId);
    this.deps.host.postMessage({
      type: "pipelineAssistantHistory",
      pipelineId,
      conversationId,
      events: assistant.history(conversationId),
    });
  }

  private notice(level: "info" | "warning" | "error", message: string): void {
    this.deps.host.postMessage({ type: "notice", level, message });
  }

}


const conversationTitle = (firstMessage: string): string => {
  const oneLine = firstMessage.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "New chat";
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
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
