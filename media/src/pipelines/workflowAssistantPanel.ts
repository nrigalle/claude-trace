import type {
  PipelinesWebviewToHost,
  PipelinesHostToWebview,
  TimelineEvent,
  WorkflowReplayTurn,
} from "../../../src/features/pipelines/protocol";
import type { ReplayTurn } from "../../../src/shared/assistant/timeline";
import type { Pipeline } from "../../../src/features/pipelines/domain/types";
import { h } from "../ui/h.js";
import {
  ChatPanelBase,
  type BaseTurn,
  type ChatConversation,
} from "../ui/chatPanelBase.js";

export interface WorkflowAssistantPanelDeps {
  readonly send: (msg: PipelinesWebviewToHost) => void;
  readonly getPipeline: () => Pipeline | null;
  readonly onApply: (pipeline: Pipeline) => Pipeline | null;
}

interface WorkflowTurn extends BaseTurn {
  readonly proposed?: Pipeline | null;
  readonly proposalErrors?: readonly string[];
  applied?: boolean;
  undoSnapshot?: Pipeline | null;
}

type AssistantHostMessage = Extract<
  PipelinesHostToWebview,
  { readonly type: "pipelineAssistantReply" | "pipelineAssistantProgress" | "pipelineAssistantHistory" | "pipelineAssistantError" | "pipelineAssistantBusy" | "pipelineAssistantConversations" }
>;

export class WorkflowAssistantPanel extends ChatPanelBase<WorkflowTurn> {
  constructor(private readonly deps: WorkflowAssistantPanelDeps) {
    super();
  }

  switchPipeline(): void {
    this.switchGroup();
  }

  receive(msg: AssistantHostMessage): void {
    switch (msg.type) {
      case "pipelineAssistantConversations":
        this.setConversations(msg.pipelineId as string, msg.conversations);
        return;
      case "pipelineAssistantReply":
        this.appendAssistantTurn(msg.conversationId, {
          role: "assistant",
          text: msg.text,
          events: msg.events,
          proposed: msg.proposedPipeline,
          proposalErrors: msg.proposalErrors,
        });
        return;
      case "pipelineAssistantProgress":
        this.setProgress(msg.conversationId, msg.events);
        return;
      case "pipelineAssistantHistory":
        this.loadHistoryTurns(msg.conversationId, msg.turns);
        return;
      case "pipelineAssistantError":
        this.setError(msg.conversationId, msg.message);
        return;
      case "pipelineAssistantBusy":
        this.setBusy(msg.conversationId, msg.busy);
        return;
    }
  }

  protected panelTitle(): string {
    return "Workflow assistant";
  }

  protected subtitle(): string {
    const p = this.deps.getPipeline();
    return p ? `Building "${p.name}"` : "Open a workflow to start";
  }

  protected emptyState(): { readonly title: string; readonly body: string } {
    if (!this.deps.getPipeline()) {
      return { title: "Open a workflow first", body: "Pick a workflow on the left, then chat with me to build it." };
    }
    return {
      title: "Let's build this workflow.",
      body: "Describe what it should do, or point me at scripts in your repo. I'll ask questions, then propose a workflow you can apply to the canvas.",
    };
  }

  protected currentGroupKey(): string | null {
    const p = this.deps.getPipeline();
    return p ? (p.id as string) : null;
  }

  protected makeUserTurn(text: string): WorkflowTurn {
    return { role: "user", text };
  }

  protected override makeReplayTurn(turn: ReplayTurn): WorkflowTurn {
    if (turn.role === "user") return this.makeUserTurn(turn.text);
    const w = turn as WorkflowReplayTurn;
    return {
      role: "assistant",
      text: turn.text,
      events: turn.events,
      proposed: w.proposedPipeline ?? null,
      proposalErrors: w.proposalErrors,
    };
  }

  protected sendAsk(_groupKey: string, conversationId: string, conv: ChatConversation<WorkflowTurn>, message: string): void {
    const p = this.deps.getPipeline();
    if (!p) return;
    this.deps.send({
      type: "pipelineAssistantAsk",
      pipeline: p,
      conversationId,
      message,
      model: conv.model,
      effort: conv.effort,
    });
  }

  protected sendListConversations(groupKey: string): void {
    this.deps.send({ type: "pipelineAssistantListConversations", pipelineId: groupKey as Pipeline["id"] });
  }

  protected sendLoadHistory(groupKey: string, conversationId: string): void {
    this.deps.send({ type: "pipelineAssistantLoadHistory", pipelineId: groupKey as Pipeline["id"], conversationId });
  }

  protected sendCancel(groupKey: string, conversationId: string): void {
    this.deps.send({ type: "pipelineAssistantCancel", pipelineId: groupKey as Pipeline["id"], conversationId });
  }

  protected sendRename(groupKey: string, conversationId: string, title: string): void {
    this.deps.send({ type: "pipelineAssistantRenameConversation", pipelineId: groupKey as Pipeline["id"], conversationId, title });
  }

  protected sendDelete(groupKey: string, conversationId: string): void {
    this.deps.send({ type: "pipelineAssistantDeleteConversation", pipelineId: groupKey as Pipeline["id"], conversationId });
  }

  protected override renderReplyExtras(turn: WorkflowTurn): HTMLElement | null {
    if (turn.role !== "assistant") return null;
    const frag = h("div", { className: "lib-asst-reply-extras" });
    let hasExtras = false;
    if (turn.proposalErrors && turn.proposalErrors.length > 0) {
      frag.appendChild(h("div", { className: "lib-asst-error", textContent: `Proposed workflow was invalid: ${turn.proposalErrors.join("; ")}` }));
      hasExtras = true;
    }
    if (turn.proposed) {
      frag.appendChild(this.renderApplyCard(turn));
      hasExtras = true;
    }
    return hasExtras ? frag : null;
  }

  private renderApplyCard(turn: WorkflowTurn): HTMLElement {
    const proposed = turn.proposed!;
    const count = proposed.blocks.length;
    const triggers = proposed.triggers.length;
    const summary = `${count} block${count === 1 ? "" : "s"}${triggers > 0 ? `, ${triggers} trigger${triggers === 1 ? "" : "s"}` : ""}`;
    const card = h("div", { className: "lib-asst-applied", style: { justifyContent: "space-between", gap: "10px" } });
    if (turn.applied) {
      card.appendChild(h("span", { className: "lib-asst-applied-done", textContent: `✓ Applied to canvas · ${summary}` }));
      card.appendChild(h("button", {
        className: "pl-btn",
        attrs: { type: "button", title: "Revert the canvas to its state before this was applied" },
        textContent: "Undo",
        on: { click: () => this.undoApply(turn) },
      }));
      return card;
    }
    card.appendChild(h("span", { textContent: `Proposed: ${summary}` }));
    card.appendChild(h("button", {
      className: "pl-btn primary",
      attrs: { type: "button" },
      textContent: "Apply to workflow",
      on: { click: () => this.applyTurn(turn) },
    }));
    return card;
  }

  private applyTurn(turn: WorkflowTurn): void {
    if (!turn.proposed) return;
    turn.undoSnapshot = this.deps.onApply(turn.proposed);
    turn.applied = true;
    this.refreshView();
  }

  private undoApply(turn: WorkflowTurn): void {
    if (turn.undoSnapshot) this.deps.onApply(turn.undoSnapshot);
    turn.applied = false;
    turn.undoSnapshot = undefined;
    this.refreshView();
  }
}

export type { TimelineEvent };
