import type {
  PipelinesWebviewToHost,
  PipelinesHostToWebview,
  TimelineEvent,
  AssistantConversationMeta,
} from "../../../src/features/pipelines/protocol";
import type { Pipeline } from "../../../src/features/pipelines/domain/types";
import { clear, h } from "../ui/h.js";
import { decorateTextarea } from "../ui/textarea.js";
import {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  modelEffortLevels,
  type ModelChoice,
  type EffortChoice,
} from "../../../src/shared/models";

// The assistant interviews and emits JSON; Sonnet is fast and more than capable.
// Opus stays one click away in the model dropdown.
const ASSISTANT_DEFAULT_MODEL: ModelChoice = "claude-sonnet-4-6";

export interface WorkflowAssistantPanelDeps {
  readonly send: (msg: PipelinesWebviewToHost) => void;
  readonly getPipeline: () => Pipeline | null;
  readonly onApply: (pipeline: Pipeline) => Pipeline | null;
}

type AssistantHostMessage = Extract<
  PipelinesHostToWebview,
  { readonly type: "pipelineAssistantReply" | "pipelineAssistantProgress" | "pipelineAssistantHistory" | "pipelineAssistantError" | "pipelineAssistantBusy" | "pipelineAssistantConversations" }
>;

interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly events?: readonly TimelineEvent[];
  readonly proposed?: Pipeline | null;
  readonly proposalErrors?: readonly string[];
  applied?: boolean;
  undoSnapshot?: Pipeline | null;
}

interface Conversation {
  readonly turns: Turn[];
  busy: boolean;
  error: string | null;
  pendingEvents: readonly TimelineEvent[];
  historyLoaded: boolean;
  model: ModelChoice;
  effort: EffortChoice;
}

// Per-workflow chat bookkeeping: the list of saved conversations (from disk),
// which one is open, and whether we've fetched the list yet this session.
interface PipelineChats {
  metas: AssistantConversationMeta[];
  activeId: string | null;
  listLoaded: boolean;
}

export class WorkflowAssistantPanel {
  private readonly root: HTMLElement;
  private readonly head: HTMLElement;
  private readonly historyEl: HTMLElement;
  private readonly inputContainer: HTMLElement;
  private readonly conversations = new Map<string, Conversation>(); // keyed by conversationId
  private readonly pipelineChats = new Map<string, PipelineChats>(); // keyed by pipelineId
  private inputTextarea: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private open = false;
  private renderScheduled = false;
  private renamingChat = false;

  constructor(private readonly deps: WorkflowAssistantPanelDeps) {
    this.head = h("div", { className: "lib-asst-head" });
    this.historyEl = h("div", { className: "lib-asst-history" });
    this.inputContainer = h("div", { className: "lib-asst-input-row" });
    const footer = h("div", { className: "lib-asst-footer" }, this.inputContainer);
    const resizeHandle = h("div", {
      className: "lib-asst-resize",
      attrs: { "aria-hidden": "true", title: "Drag to resize the assistant panel" },
    });
    this.wireResize(resizeHandle);
    this.root = h("aside", {
      className: "lib-asst hidden",
      attrs: { "aria-label": "Workflow assistant" },
    }, resizeHandle, this.head, this.historyEl, footer);
  }

  element(): HTMLElement {
    return this.root;
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.root.classList.toggle("hidden", !open);
    if (open) {
      this.ensureChatListLoaded();
      this.rebuildAll();
      window.setTimeout(() => this.inputTextarea?.focus(), 30);
    }
  }

  switchPipeline(): void {
    if (!this.open) return;
    this.renamingChat = false;
    this.ensureChatListLoaded();
    this.rebuildAll();
  }

  private rebuildAll(): void {
    this.rebuildHead();
    this.rebuildHistory();
    this.rebuildInput();
  }

  private currentPipelineId(): string | null {
    const p = this.deps.getPipeline();
    return p ? (p.id as string) : null;
  }

  // The key the engine/render path use is the *conversation* id, not the pipeline id.
  private currentKey(): string | null {
    const pid = this.currentPipelineId();
    return pid ? this.chatsFor(pid).activeId : null;
  }

  private chatsFor(pid: string): PipelineChats {
    let m = this.pipelineChats.get(pid);
    if (!m) {
      m = { metas: [], activeId: null, listLoaded: false };
      this.pipelineChats.set(pid, m);
    }
    return m;
  }

  private newConversationId(): string {
    const rand = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "");
    return `c-${Date.now().toString(36)}-${rand.slice(0, 8)}`;
  }

  // Ensure the current pipeline has an active conversation to type into.
  private ensureActiveConversation(pid: string): string {
    const m = this.chatsFor(pid);
    if (!m.activeId) m.activeId = this.newConversationId();
    return m.activeId;
  }

  private ensureChatListLoaded(): void {
    const p = this.deps.getPipeline();
    if (!p) return;
    const m = this.chatsFor(p.id as string);
    if (m.listLoaded) return;
    m.listLoaded = true;
    this.deps.send({ type: "pipelineAssistantListConversations", pipelineId: p.id });
  }

  private loadConversationHistory(conversationId: string): void {
    const p = this.deps.getPipeline();
    if (!p) return;
    const conv = this.ensureConversation(conversationId);
    if (conv.historyLoaded) return;
    conv.historyLoaded = true;
    this.deps.send({ type: "pipelineAssistantLoadHistory", pipelineId: p.id, conversationId });
  }

  private openConversation(conversationId: string): void {
    const pid = this.currentPipelineId();
    if (!pid) return;
    this.renamingChat = false;
    this.chatsFor(pid).activeId = conversationId;
    this.loadConversationHistory(conversationId);
    this.rebuildAll();
  }

  private startNewChat(): void {
    const pid = this.currentPipelineId();
    if (!pid) return;
    this.renamingChat = false;
    const m = this.chatsFor(pid);
    m.activeId = this.newConversationId();
    this.ensureConversation(m.activeId);
    this.rebuildAll();
    window.setTimeout(() => this.inputTextarea?.focus(), 30);
  }

  private deleteConversation(conversationId: string): void {
    const p = this.deps.getPipeline();
    if (!p) return;
    this.conversations.delete(conversationId);
    const m = this.chatsFor(p.id as string);
    if (m.activeId === conversationId) m.activeId = null;
    this.deps.send({ type: "pipelineAssistantDeleteConversation", pipelineId: p.id, conversationId });
    this.rebuildAll();
  }

  receive(msg: AssistantHostMessage): void {
    if (msg.type === "pipelineAssistantConversations") {
      const m = this.chatsFor(msg.pipelineId as string);
      m.metas = [...msg.conversations];
      m.listLoaded = true;
      if (m.metas.length > 0) {
        // If the open chat is a fresh, empty, unsaved one, land on the most recent
        // saved conversation instead — but never yank the user out of a chat in progress.
        const active = m.activeId ? this.conversations.get(m.activeId) : null;
        const activeSaved = !!m.activeId && m.metas.some((x) => x.id === m.activeId);
        if (!activeSaved && (!active || active.turns.length === 0)) {
          m.activeId = m.metas[0]!.id;
          this.loadConversationHistory(m.activeId);
        }
      } else if (!m.activeId) {
        m.activeId = this.newConversationId();
      }
      if (this.open && (msg.pipelineId as string) === this.currentPipelineId()) this.rebuildAll();
      return;
    }
    const key = msg.conversationId;
    switch (msg.type) {
      case "pipelineAssistantReply": {
        const conv = this.ensureConversation(key);
        conv.turns.push({
          role: "assistant",
          text: msg.text,
          events: msg.events,
          proposed: msg.proposedPipeline,
          proposalErrors: msg.proposalErrors,
        });
        conv.busy = false;
        conv.pendingEvents = [];
        conv.error = null;
        this.scheduleRender(key);
        return;
      }
      case "pipelineAssistantProgress": {
        const conv = this.ensureConversation(key);
        conv.pendingEvents = msg.events;
        this.scheduleRender(key);
        return;
      }
      case "pipelineAssistantHistory": {
        const conv = this.ensureConversation(key);
        if (msg.events.length > 0 && conv.turns.length === 0) {
          conv.turns.push({ role: "assistant", text: "", events: msg.events });
        }
        this.scheduleRender(key);
        return;
      }
      case "pipelineAssistantError": {
        const conv = this.ensureConversation(key);
        conv.busy = false;
        conv.error = msg.message;
        conv.pendingEvents = [];
        this.scheduleRender(key);
        return;
      }
      case "pipelineAssistantBusy": {
        const conv = this.ensureConversation(key);
        conv.busy = msg.busy;
        if (!msg.busy) conv.pendingEvents = [];
        this.scheduleRender(key);
        return;
      }
      default:
        return;
    }
  }

  private scheduleRender(key: string): void {
    if (!this.open || key !== this.currentKey()) return;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.rebuildHistory();
      this.updateSendBtn();
    });
  }

  private ensureConversation(key: string): Conversation {
    let conv = this.conversations.get(key);
    if (!conv) {
      conv = { turns: [], busy: false, error: null, pendingEvents: [], historyLoaded: false, model: ASSISTANT_DEFAULT_MODEL, effort: "default" };
      this.conversations.set(key, conv);
    }
    return conv;
  }

  private rebuildHead(): void {
    clear(this.head);
    const p = this.deps.getPipeline();
    const title = h("div", { className: "lib-asst-title", textContent: "Workflow assistant" });
    const sub = h("div", { className: "lib-asst-sub", textContent: p ? `Building “${p.name}”` : "Open a workflow to start" });
    const newBtn = h("button", {
      className: "lib-asst-newchat",
      attrs: { type: "button", title: "Start a new chat about this workflow" },
      innerHTML: `<span aria-hidden="true">+</span><span>New chat</span>`,
      on: { click: () => this.startNewChat() },
    });
    const closeBtn = h("button", {
      className: "lib-asst-icon-btn",
      attrs: { type: "button", title: "Close assistant", "aria-label": "Close assistant" },
      innerHTML: "&times;",
      on: { click: () => this.setOpen(false) },
    });
    this.head.appendChild(h("div", { className: "lib-asst-head-top" },
      h("div", { className: "lib-asst-head-text" }, title, sub),
      h("div", { className: "lib-asst-head-actions" }, ...(p ? [newBtn] : []), closeBtn),
    ));
    if (p) {
      this.head.appendChild(this.renderConversationBar(p.id as string));
      this.head.appendChild(this.renderPickers(this.ensureConversation(this.ensureActiveConversation(p.id as string))));
    }
  }

  private renderConversationBar(pid: string): HTMLElement {
    const m = this.chatsFor(pid);
    const activeId = this.ensureActiveConversation(pid);
    const activeMeta = m.metas.find((meta) => meta.id === activeId);
    const activeSaved = !!activeMeta;

    if (this.renamingChat && activeSaved) {
      const input = h("input", {
        className: "lib-asst-pick lib-asst-chat-select",
        attrs: { type: "text", value: activeMeta!.title, "aria-label": "Rename this chat" },
      }) as HTMLInputElement;
      let done = false;
      const commit = (save: boolean): void => {
        if (done) return;
        done = true;
        this.renamingChat = false;
        if (save) this.commitRename(activeId, input.value);
        else this.rebuildAll();
      };
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); commit(true); }
        else if (e.key === "Escape") { e.preventDefault(); commit(false); }
      });
      input.addEventListener("blur", () => commit(true));
      window.setTimeout(() => { input.focus(); input.select(); }, 0);
      return h("div", { className: "lib-asst-chat-bar" },
        h("div", { className: "lib-asst-pick-group" },
          h("span", { className: "lib-asst-pick-label", textContent: "Name" }),
          input,
        ),
      );
    }

    const select = h("select", {
      className: "lib-asst-pick lib-asst-chat-select",
      attrs: { "aria-label": "Chat history for this workflow" },
      on: { change: (e: Event) => this.openConversation((e.target as HTMLSelectElement).value) },
    }) as HTMLSelectElement;
    if (!activeSaved) {
      select.appendChild(h("option", { attrs: { value: activeId, selected: "selected" }, textContent: "New chat (unsaved)" }));
    }
    for (const meta of m.metas) {
      select.appendChild(h("option", {
        attrs: { value: meta.id, ...(meta.id === activeId ? { selected: "selected" } : {}) },
        textContent: `${meta.title} · ${relativeTime(meta.updatedAtMs)}`,
      }));
    }
    const count = m.metas.length + (activeSaved ? 0 : 1);
    const label = h("span", { className: "lib-asst-pick-label", textContent: count > 1 ? `Chats (${count})` : "Chat" });
    const children: HTMLElement[] = [h("div", { className: "lib-asst-pick-group" }, label, select)];
    if (activeSaved) {
      children.push(h("button", {
        className: "lib-asst-icon-btn",
        attrs: { type: "button", title: "Rename this chat", "aria-label": "Rename this chat" },
        textContent: "✎",
        on: { click: () => { this.renamingChat = true; this.rebuildAll(); } },
      }));
      children.push(h("button", {
        className: "lib-asst-icon-btn",
        attrs: { type: "button", title: "Delete this chat", "aria-label": "Delete this chat" },
        innerHTML: "&#128465;",
        on: { click: () => this.deleteConversation(activeId) },
      }));
    }
    return h("div", { className: "lib-asst-chat-bar" }, ...children);
  }

  private commitRename(conversationId: string, title: string): void {
    const p = this.deps.getPipeline();
    const trimmed = title.trim();
    if (p && trimmed.length > 0) {
      const m = this.chatsFor(p.id as string);
      m.metas = m.metas.map((meta) => (meta.id === conversationId ? { ...meta, title: trimmed } : meta));
      this.deps.send({ type: "pipelineAssistantRenameConversation", pipelineId: p.id, conversationId, title: trimmed });
    }
    this.rebuildAll();
  }

  private renderPickers(conv: Conversation): HTMLElement {
    const modelSelect = h("select", {
      className: "lib-asst-pick",
      attrs: { "aria-label": "Assistant model" },
      on: { change: (e: Event) => {
        conv.model = (e.target as HTMLSelectElement).value as ModelChoice;
        if (!modelEffortLevels(conv.model).includes(conv.effort)) conv.effort = "default";
        this.rebuildHead();
      } },
    }, ...MODEL_OPTIONS.map((o) => h("option", {
      attrs: { value: o.id, ...(o.id === conv.model ? { selected: "selected" } : {}) },
      textContent: o.label,
    })));
    const levels = modelEffortLevels(conv.model);
    const effortSelect = h("select", {
      className: "lib-asst-pick",
      attrs: { "aria-label": "Assistant effort" },
      on: { change: (e: Event) => { conv.effort = (e.target as HTMLSelectElement).value as EffortChoice; } },
    }, ...EFFORT_OPTIONS.filter((o) => levels.includes(o.id)).map((o) => h("option", {
      attrs: { value: o.id, ...(o.id === conv.effort ? { selected: "selected" } : {}) },
      textContent: o.label,
    })));
    return h("div", { className: "lib-asst-pick-row" },
      h("div", { className: "lib-asst-pick-group" }, h("span", { className: "lib-asst-pick-label", textContent: "Model" }), modelSelect),
      h("div", { className: "lib-asst-pick-group" }, h("span", { className: "lib-asst-pick-label", textContent: "Effort" }), effortSelect),
    );
  }

  private rebuildHistory(): void {
    clear(this.historyEl);
    const p = this.deps.getPipeline();
    if (!p) {
      this.historyEl.appendChild(this.renderEmpty("Open a workflow first", "Pick a workflow on the left, then chat with me to build it."));
      return;
    }
    const conv = this.conversations.get(this.ensureActiveConversation(p.id as string));
    if (!conv || (conv.turns.length === 0 && conv.pendingEvents.length === 0 && !conv.busy)) {
      this.historyEl.appendChild(this.renderEmpty(
        "Let's build this workflow.",
        "Describe what it should do, or point me at scripts in your repo. I'll ask questions, then propose a workflow you can apply to the canvas.",
      ));
    } else {
      for (const turn of conv.turns) this.historyEl.appendChild(this.renderTurn(turn));
      if (conv.busy) this.historyEl.appendChild(this.renderInflight(conv));
    }
    if (conv?.error) this.historyEl.appendChild(h("div", { className: "lib-asst-error", textContent: conv.error }));
    this.historyEl.scrollTop = this.historyEl.scrollHeight;
  }

  private renderEmpty(title: string, body: string): HTMLElement {
    return h("div", { className: "lib-asst-empty" },
      h("div", { className: "lib-asst-empty-title", textContent: title }),
      h("div", { className: "lib-asst-empty-body", textContent: body }),
    );
  }

  private renderTurn(turn: Turn): HTMLElement {
    const wrap = h("div", { className: turn.role === "user" ? "lib-asst-turn user" : "lib-asst-turn assistant" });
    if (turn.role === "user") {
      wrap.appendChild(h("div", { className: "lib-asst-turn-text" }, ...renderTextLines(turn.text)));
      return wrap;
    }
    if (turn.events && turn.events.length > 0) {
      wrap.appendChild(this.renderTimeline(turn.events));
    } else if (turn.text.length > 0) {
      wrap.appendChild(h("div", { className: "lib-asst-turn-text" }, ...renderTextLines(turn.text)));
    }
    if (turn.proposalErrors && turn.proposalErrors.length > 0) {
      wrap.appendChild(h("div", { className: "lib-asst-error", textContent: `Proposed workflow was invalid: ${turn.proposalErrors.join("; ")}` }));
    }
    if (turn.proposed) wrap.appendChild(this.renderApplyCard(turn));
    return wrap;
  }

  private renderApplyCard(turn: Turn): HTMLElement {
    const proposed = turn.proposed!;
    const count = proposed.blocks.length;
    const triggers = proposed.triggers.length;
    const summary = `Proposed: ${count} block${count === 1 ? "" : "s"}${triggers > 0 ? `, ${triggers} trigger${triggers === 1 ? "" : "s"}` : ""}`;
    const card = h("div", { className: "lib-asst-applied", style: { justifyContent: "space-between", gap: "10px" } });
    if (turn.applied) {
      card.appendChild(h("span", { className: "lib-asst-applied-done", textContent: `✓ Applied to canvas · ${summary.replace(/^Proposed: /, "")}` }));
      card.appendChild(h("button", {
        className: "pl-btn",
        attrs: { type: "button", title: "Revert the canvas to its state before this was applied" },
        textContent: "Undo",
        on: { click: () => this.undoApply(turn) },
      }));
      return card;
    }
    card.appendChild(h("span", { textContent: summary }));
    card.appendChild(h("button", {
      className: "pl-btn primary",
      attrs: { type: "button" },
      textContent: "Apply to workflow",
      on: { click: () => this.applyTurn(turn) },
    }));
    return card;
  }

  private applyTurn(turn: Turn): void {
    if (!turn.proposed) return;
    turn.undoSnapshot = this.deps.onApply(turn.proposed);
    turn.applied = true;
    this.rebuildHistory();
  }

  private undoApply(turn: Turn): void {
    if (turn.undoSnapshot) this.deps.onApply(turn.undoSnapshot);
    turn.applied = false;
    turn.undoSnapshot = undefined;
    this.rebuildHistory();
  }

  private renderInflight(conv: Conversation): HTMLElement {
    const wrap = h("div", { className: "lib-asst-turn assistant inflight" });
    if (conv.pendingEvents.length > 0) wrap.appendChild(this.renderTimeline(conv.pendingEvents));
    wrap.appendChild(h("div", { className: "lib-asst-typing" },
      h("span", { className: "lib-asst-dot" }), h("span", { className: "lib-asst-dot" }), h("span", { className: "lib-asst-dot" }),
    ));
    return wrap;
  }

  private renderTimeline(events: readonly TimelineEvent[]): HTMLElement {
    const wrap = h("div", { className: "lib-asst-timeline" });
    const resultsByToolUseId = new Map<string, TimelineEvent>();
    for (const e of events) if (e.kind === "tool_result") resultsByToolUseId.set(e.toolUseId, e);
    for (const e of events) {
      if (e.kind === "text") {
        wrap.appendChild(h("div", { className: "lib-asst-tl-text" }, ...renderTextLines(e.text)));
      } else if (e.kind === "tool_use") {
        wrap.appendChild(this.renderToolUseRow(e, resultsByToolUseId.get(e.id)));
      }
    }
    return wrap;
  }

  private renderToolUseRow(use: TimelineEvent & { kind: "tool_use" }, result: TimelineEvent | undefined): HTMLElement {
    const row = h("div", { className: `lib-asst-tl-tool${result?.kind === "tool_result" && result.isError ? " error" : ""}` });
    const head = h("div", { className: "lib-asst-tl-tool-head" },
      h("span", { className: "lib-asst-tl-tool-icon", textContent: iconFor(use.name) }),
      h("span", { className: "lib-asst-tl-tool-name", textContent: use.name }),
    );
    if (use.input.length > 0) head.appendChild(h("span", { className: "lib-asst-tl-tool-input", textContent: use.input, attrs: { title: use.input } }));
    if (!result || result.kind !== "tool_result") head.appendChild(h("span", { className: "lib-asst-tl-tool-running", textContent: "running…" }));
    row.appendChild(head);
    if (result?.kind === "tool_result" && result.preview.length > 0) {
      row.appendChild(h("div", { className: "lib-asst-tl-tool-preview", textContent: result.preview, attrs: { title: result.preview } }));
    }
    return row;
  }

  private rebuildInput(): void {
    clear(this.inputContainer);
    const { element, textarea } = decorateTextarea({
      className: "lib-asst-input",
      rows: 3,
      placeholder: "Describe the workflow, or ask a question…",
      ariaLabel: "Message to the workflow assistant",
      expandTitle: "Compose your message",
    });
    this.inputTextarea = textarea;
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.sendCurrent();
      }
    });
    const sendBtn = h("button", { className: "lib-asst-send", attrs: { type: "button" }, textContent: "Send", on: { click: () => this.sendCurrent() } });
    const cancelBtn = h("button", { className: "lib-asst-cancel hidden", attrs: { type: "button", title: "Stop the current turn" }, textContent: "Stop", on: { click: () => this.cancelCurrent() } });
    this.sendBtn = sendBtn;
    this.cancelBtn = cancelBtn;
    this.inputContainer.appendChild(element);
    this.inputContainer.appendChild(h("div", { className: "lib-asst-input-foot" }, cancelBtn, sendBtn));
    this.updateSendBtn();
  }

  private updateSendBtn(): void {
    if (!this.sendBtn || !this.cancelBtn) return;
    const p = this.deps.getPipeline();
    const convId = p ? this.chatsFor(p.id as string).activeId : null;
    const conv = convId ? this.conversations.get(convId) : null;
    const busy = conv?.busy ?? false;
    this.sendBtn.disabled = busy || !p;
    this.sendBtn.classList.toggle("busy", busy);
    this.cancelBtn.classList.toggle("hidden", !busy);
  }

  private sendCurrent(): void {
    const p = this.deps.getPipeline();
    if (!p || !this.inputTextarea) return;
    const text = this.inputTextarea.value.trim();
    if (text === "") return;
    const conversationId = this.ensureActiveConversation(p.id as string);
    const conv = this.ensureConversation(conversationId);
    if (conv.busy) return;
    conv.error = null;
    conv.turns.push({ role: "user", text });
    this.inputTextarea.value = "";
    this.deps.send({ type: "pipelineAssistantAsk", pipeline: p, conversationId, message: text, model: conv.model, effort: conv.effort });
    this.rebuildHistory();
    this.updateSendBtn();
  }

  private cancelCurrent(): void {
    const p = this.deps.getPipeline();
    if (!p) return;
    const conversationId = this.chatsFor(p.id as string).activeId;
    if (conversationId) this.deps.send({ type: "pipelineAssistantCancel", pipelineId: p.id, conversationId });
  }

  private wireResize(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidth = this.root.getBoundingClientRect().width;
      const move = (ev: PointerEvent): void => {
        const next = Math.max(300, Math.min(900, startWidth + (startX - ev.clientX)));
        this.root.style.width = `${next}px`;
      };
      const up = (ev: PointerEvent): void => {
        handle.releasePointerCapture(ev.pointerId);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
}

const renderTextLines = (text: string): readonly Node[] => {
  const lines = text.split(/\r?\n/);
  const out: Node[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) out.push(document.createElement("br"));
    out.push(document.createTextNode(lines[i] ?? ""));
  }
  return out;
};

const ICONS: Readonly<Record<string, string>> = {
  WebSearch: "🔎", WebFetch: "🌐", Read: "📄", Grep: "🔍", Glob: "🗂", TodoWrite: "✓",
};
const iconFor = (name: string): string => ICONS[name] ?? "⚙";

const relativeTime = (ms: number): string => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(ms).toLocaleDateString();
};
