import type {
  AssistantContext,
  AssistantMode,
  LibraryHostToWebview,
  LibraryWebviewToHost,
} from "../../../src/features/library/protocol";
import { h } from "../ui/h.js";
import {
  ChatPanelBase,
  type BaseTurn,
  type ChatConversation,
} from "../ui/chatPanelBase.js";

export interface AssistantPanelDeps {
  readonly send: (msg: LibraryWebviewToHost) => void;
  readonly onApplyBody: (text: string) => void;
  readonly onApplyDescription: (text: string) => void;
  readonly getContext: () => AssistantContext | null;
}

interface LibraryTurn extends BaseTurn {}

type AssistantHostMessage = Extract<
  LibraryHostToWebview,
  { readonly type: "assistantReply" | "assistantProgress" | "assistantHistory" | "assistantError" | "assistantBusy" | "assistantConversations" }
>;

export class AssistantPanel extends ChatPanelBase<LibraryTurn> {
  private readonly modes = new Map<string, AssistantMode>();

  constructor(private readonly deps: AssistantPanelDeps) {
    super();
  }

  switchItem(): void {
    this.switchGroup();
  }

  receive(msg: AssistantHostMessage): void {
    switch (msg.type) {
      case "assistantConversations":
        for (const c of msg.conversations) {
          if (c.mode) this.modes.set(c.id, c.mode);
        }
        this.setConversations(msg.itemKey, msg.conversations);
        return;
      case "assistantReply": {
        const mode = this.modeFor(msg.conversationId);
        const hasTools = msg.events.some((e) => e.kind === "tool_use");
        const error = mode === "writeBody" && msg.text.length === 0 && hasTools
          ? "Claude finished with tool calls but did not write a closing body. Send 'now write the body' as a follow-up."
          : null;
        this.appendAssistantTurn(msg.conversationId, { role: "assistant", text: msg.text, events: msg.events }, error);
        const isActive = msg.itemKey === this.currentGroupKey() && msg.conversationId === this.currentKey();
        if (isActive && mode === "writeBody" && msg.text.length > 0) this.deps.onApplyBody(msg.text);
        if (isActive && msg.suggestedDescription && msg.suggestedDescription.length > 0) this.deps.onApplyDescription(msg.suggestedDescription);
        return;
      }
      case "assistantProgress":
        this.setProgress(msg.conversationId, msg.events);
        return;
      case "assistantHistory":
        this.loadHistoryTurns(msg.conversationId, msg.turns);
        return;
      case "assistantError":
        this.setError(msg.conversationId, msg.message);
        return;
      case "assistantBusy":
        this.setBusy(msg.conversationId, msg.busy);
        return;
    }
  }

  protected panelTitle(): string {
    return "Assistant";
  }

  protected subtitle(): string {
    const ctx = this.deps.getContext();
    if (!ctx) return "Pick a skill or agent to start";
    return `Helping with ${ctx.kind === "skill" ? "skill" : "agent"} “${ctx.name}”`;
  }

  protected emptyState(): { readonly title: string; readonly body: string } {
    const ctx = this.deps.getContext();
    if (!ctx) {
      return {
        title: "Select a skill or agent first",
        body: "Pick a row on the left to open it, then come back here. I'll help you draft the body.",
      };
    }
    return {
      title: `Let's draft this ${ctx.kind}.`,
      body: this.modeForCurrent() === "discuss"
        ? "Discuss the design with me. I won't touch the body field in this mode."
        : `Tell me what this ${ctx.kind} should do. My reply will land directly in the body field.`,
    };
  }

  protected currentGroupKey(): string | null {
    return this.deps.getContext()?.itemKey ?? null;
  }

  protected makeUserTurn(text: string): LibraryTurn {
    return { role: "user", text };
  }

  protected sendAsk(_groupKey: string, conversationId: string, conv: ChatConversation<LibraryTurn>, message: string): void {
    const ctx = this.deps.getContext();
    if (!ctx) return;
    this.deps.send({
      type: "assistantAsk",
      context: ctx,
      conversationId,
      message,
      mode: this.modeFor(conversationId),
      model: conv.model,
      effort: conv.effort,
    });
  }

  protected sendListConversations(groupKey: string): void {
    this.deps.send({ type: "assistantListConversations", itemKey: groupKey });
  }

  protected sendLoadHistory(groupKey: string, conversationId: string): void {
    this.deps.send({ type: "assistantLoadHistory", itemKey: groupKey, conversationId });
  }

  protected sendCancel(_groupKey: string, conversationId: string): void {
    this.deps.send({ type: "assistantCancel", conversationId });
  }

  protected sendRename(groupKey: string, conversationId: string, title: string): void {
    this.deps.send({ type: "assistantRenameConversation", itemKey: groupKey, conversationId, title });
  }

  protected sendDelete(groupKey: string, conversationId: string): void {
    this.deps.send({ type: "assistantDeleteConversation", itemKey: groupKey, conversationId });
  }

  protected override renderHeadExtras(): HTMLElement | null {
    return this.renderModeToggle();
  }

  protected override renderReplyExtras(turn: LibraryTurn, conv: ChatConversation<LibraryTurn>): HTMLElement | null {
    if (turn.role !== "assistant" || turn.text.length === 0 || this.modeForCurrent() !== "writeBody") return null;
    const lastTurn = conv.turns[conv.turns.length - 1] === turn;
    return h("div", { className: "lib-asst-applied" },
      h("span", { className: "lib-asst-applied-dot" }),
      h("span", { textContent: lastTurn ? "Written to body field" : "Was written to body field" }),
    );
  }

  private modeFor(conversationId: string): AssistantMode {
    return this.modes.get(conversationId) ?? "writeBody";
  }

  private modeForCurrent(): AssistantMode {
    const key = this.currentKey();
    return key ? this.modeFor(key) : "writeBody";
  }

  private renderModeToggle(): HTMLElement {
    const current = this.modeForCurrent();
    const make = (mode: AssistantMode, label: string, desc: string): HTMLElement =>
      h("button", {
        className: `lib-asst-mode${current === mode ? " active" : ""}`,
        attrs: { type: "button", title: desc, "data-mode": mode },
        on: { click: () => {
          const key = this.currentKey();
          if (!key || current === mode) return;
          this.modes.set(key, mode);
          this.refreshView();
        } },
      }, h("span", { className: "lib-asst-mode-label", textContent: label }));
    return h("div", { className: "lib-asst-mode-row", attrs: { role: "tablist" } },
      make("writeBody", "Write to body", "Claude's reply replaces the body field automatically when the turn ends."),
      make("discuss", "Discuss", "Reply stays in chat. The body field is not touched."),
    );
  }
}
