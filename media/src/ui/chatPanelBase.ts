import type { TimelineEvent, ReplayTurn } from "../../../src/shared/assistant/timeline";
import { clear, h } from "./h.js";
import { buildDropdown } from "./dropdown.js";
import { decorateTextarea } from "./textarea.js";
import {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  DEFAULT_MODEL_CHOICE,
  modelEffortLevels,
  type ModelChoice,
  type EffortChoice,
} from "../../../src/shared/models";

export const ASSISTANT_DEFAULT_MODEL: ModelChoice = DEFAULT_MODEL_CHOICE;

export interface BaseTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly events?: readonly TimelineEvent[];
}

export interface ChatConversation<TTurn extends BaseTurn> {
  turns: TTurn[];
  busy: boolean;
  error: string | null;
  pendingEvents: readonly TimelineEvent[];
  historyLoaded: boolean;
  historyApplied: boolean;
  model: ModelChoice;
  effort: EffortChoice;
  stopped: boolean;
}

export interface ConversationMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

interface GroupChats {
  metas: ConversationMeta[];
  activeId: string | null;
  listLoaded: boolean;
}

export abstract class ChatPanelBase<TTurn extends BaseTurn> {
  private readonly root: HTMLElement;
  private readonly head: HTMLElement;
  private readonly historyEl: HTMLElement;
  private readonly inputContainer: HTMLElement;
  protected readonly conversations = new Map<string, ChatConversation<TTurn>>();
  private readonly groups = new Map<string, GroupChats>();
  private inputTextarea: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private open = false;
  private renderScheduled = false;
  private renamingChat = false;

  constructor() {
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
      attrs: { "aria-label": "Assistant" },
    }, resizeHandle, this.head, this.historyEl, footer);
  }

  protected abstract panelTitle(): string;
  protected abstract subtitle(): string;
  protected abstract emptyState(): { readonly title: string; readonly body: string };
  protected abstract currentGroupKey(): string | null;
  protected abstract makeUserTurn(text: string): TTurn;
  protected abstract sendAsk(groupKey: string, conversationId: string, conv: ChatConversation<TTurn>, message: string): void;
  protected abstract sendListConversations(groupKey: string): void;
  protected abstract sendLoadHistory(groupKey: string, conversationId: string): void;
  protected abstract sendCancel(groupKey: string, conversationId: string): void;
  protected abstract sendRename(groupKey: string, conversationId: string, title: string): void;
  protected abstract sendDelete(groupKey: string, conversationId: string): void;
  protected renderHeadExtras(_conv: ChatConversation<TTurn>): HTMLElement | null { return null; }
  protected renderReplyExtras(_turn: TTurn, _conv: ChatConversation<TTurn>): HTMLElement | null { return null; }

  element(): HTMLElement { return this.root; }
  isOpen(): boolean { return this.open; }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.root.classList.toggle("hidden", !open);
    if (open) {
      this.ensureChatListLoaded();
      this.rebuildAll();
      this.focusInput();
    }
  }

  switchGroup(): void {
    if (!this.open) return;
    this.renamingChat = false;
    this.ensureChatListLoaded();
    this.rebuildAll();
  }

  protected setConversations(groupKey: string, metas: readonly ConversationMeta[]): void {
    const m = this.chatsFor(groupKey);
    m.metas = [...metas];
    m.listLoaded = true;
    if (m.metas.length > 0) {
      const active = m.activeId ? this.conversations.get(m.activeId) : null;
      const activeSaved = !!m.activeId && m.metas.some((x) => x.id === m.activeId);
      if (!activeSaved && (!active || active.turns.length === 0)) {
        m.activeId = m.metas[0]!.id;
        this.loadConversationHistory(groupKey, m.activeId);
      }
    } else if (!m.activeId) {
      m.activeId = this.newConversationId();
    }
    if (this.open && groupKey === this.currentGroupKey()) this.rebuildAll();
  }

  protected appendAssistantTurn(conversationId: string, turn: TTurn, error: string | null = null): void {
    const conv = this.ensureConversation(conversationId);
    conv.turns.push(turn);
    conv.busy = false;
    conv.pendingEvents = [];
    conv.error = error;
    conv.stopped = false;
    this.scheduleRender(conversationId);
  }

  protected setProgress(conversationId: string, events: readonly TimelineEvent[]): void {
    this.ensureConversation(conversationId).pendingEvents = events;
    this.scheduleRender(conversationId);
  }

  protected loadHistoryTurns(conversationId: string, turns: readonly ReplayTurn[]): void {
    const conv = this.ensureConversation(conversationId);
    if (conv.historyApplied) return;
    conv.historyApplied = true;
    if (turns.length === 0) return;
    const replayed = turns.map((turn) => this.makeReplayTurn(turn));
    conv.turns = [...replayed, ...conv.turns];
    this.scheduleRender(conversationId);
  }

  protected makeReplayTurn(turn: ReplayTurn): TTurn {
    return turn.role === "user"
      ? this.makeUserTurn(turn.text)
      : ({ role: "assistant", text: turn.text, events: turn.events } as TTurn);
  }

  protected setError(conversationId: string, message: string): void {
    const conv = this.ensureConversation(conversationId);
    conv.busy = false;
    conv.error = message;
    conv.pendingEvents = [];
    conv.stopped = false;
    this.scheduleRender(conversationId);
  }

  protected setBusy(conversationId: string, busy: boolean): void {
    const conv = this.ensureConversation(conversationId);
    conv.busy = busy;
    if (!busy) conv.pendingEvents = [];
    this.scheduleRender(conversationId);
  }

  protected currentKey(): string | null {
    const g = this.currentGroupKey();
    return g ? this.chatsFor(g).activeId : null;
  }

  private chatsFor(groupKey: string): GroupChats {
    let m = this.groups.get(groupKey);
    if (!m) {
      m = { metas: [], activeId: null, listLoaded: false };
      this.groups.set(groupKey, m);
    }
    return m;
  }

  private newConversationId(): string {
    const rand = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "");
    return `c-${Date.now().toString(36)}-${rand.slice(0, 8)}`;
  }

  private ensureActiveConversation(groupKey: string): string {
    const m = this.chatsFor(groupKey);
    if (!m.activeId) m.activeId = this.newConversationId();
    return m.activeId;
  }

  private ensureChatListLoaded(): void {
    const g = this.currentGroupKey();
    if (!g) return;
    const m = this.chatsFor(g);
    if (m.listLoaded) return;
    m.listLoaded = true;
    this.sendListConversations(g);
  }

  private loadConversationHistory(groupKey: string, conversationId: string): void {
    const conv = this.ensureConversation(conversationId);
    if (conv.historyLoaded) return;
    conv.historyLoaded = true;
    this.sendLoadHistory(groupKey, conversationId);
  }

  private openConversation(conversationId: string): void {
    const g = this.currentGroupKey();
    if (!g) return;
    this.renamingChat = false;
    this.chatsFor(g).activeId = conversationId;
    this.loadConversationHistory(g, conversationId);
    this.rebuildAll();
  }

  private startNewChat(): void {
    const g = this.currentGroupKey();
    if (!g) return;
    this.renamingChat = false;
    this.chatsFor(g).activeId = this.newConversationId();
    this.ensureConversation(this.chatsFor(g).activeId!);
    this.rebuildAll();
    this.focusInput();
  }

  private deleteConversation(conversationId: string): void {
    const g = this.currentGroupKey();
    if (!g) return;
    this.conversations.delete(conversationId);
    const m = this.chatsFor(g);
    if (m.activeId === conversationId) m.activeId = null;
    this.sendDelete(g, conversationId);
    this.rebuildAll();
  }

  private commitRename(conversationId: string, title: string): void {
    const g = this.currentGroupKey();
    const trimmed = title.trim();
    if (g && trimmed.length > 0) {
      const m = this.chatsFor(g);
      m.metas = m.metas.map((meta) => (meta.id === conversationId ? { ...meta, title: trimmed } : meta));
      this.sendRename(g, conversationId, trimmed);
    }
    this.rebuildAll();
  }

  private ensureConversation(conversationId: string): ChatConversation<TTurn> {
    let conv = this.conversations.get(conversationId);
    if (!conv) {
      conv = { turns: [], busy: false, error: null, pendingEvents: [], historyLoaded: false, historyApplied: false, model: ASSISTANT_DEFAULT_MODEL, effort: "default", stopped: false };
      this.conversations.set(conversationId, conv);
    }
    return conv;
  }

  private scheduleRender(conversationId: string): void {
    if (!this.open || conversationId !== this.currentKey()) return;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.rebuildHistory();
      this.updateSendBtn();
    });
  }

  protected refreshView(): void {
    if (!this.open) return;
    this.rebuildHead();
    this.rebuildHistory();
    this.updateSendBtn();
  }

  private rebuildAll(): void {
    this.rebuildHead();
    this.rebuildHistory();
    this.rebuildInput();
  }

  private rebuildHead(): void {
    clear(this.head);
    const g = this.currentGroupKey();
    const title = h("div", { className: "lib-asst-title", textContent: this.panelTitle() });
    const sub = h("div", { className: "lib-asst-sub", textContent: this.subtitle() });
    const newBtn = h("button", {
      className: "lib-asst-newchat",
      attrs: { type: "button", title: "Start a new chat" },
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
      h("div", { className: "lib-asst-head-actions" }, ...(g ? [newBtn] : []), closeBtn),
    ));
    if (g) {
      const conv = this.ensureConversation(this.ensureActiveConversation(g));
      this.head.appendChild(this.renderConversationBar(g));
      const extras = this.renderHeadExtras(conv);
      if (extras) this.head.appendChild(extras);
      this.head.appendChild(this.renderPickers(conv));
    }
  }

  private renderConversationBar(groupKey: string): HTMLElement {
    const m = this.chatsFor(groupKey);
    const activeId = this.ensureActiveConversation(groupKey);
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

    const options: { value: string; label: string }[] = [];
    if (!activeSaved) options.push({ value: activeId, label: "New chat (unsaved)" });
    for (const meta of m.metas) {
      options.push({ value: meta.id, label: `${meta.title} · ${relativeTime(meta.updatedAtMs)}` });
    }
    const select = buildDropdown({
      value: activeId,
      options,
      ariaLabel: "Chat history",
      buttonClass: "lib-asst-chat-select",
      onChange: (value) => this.openConversation(value),
    });
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

  private renderPickers(conv: ChatConversation<TTurn>): HTMLElement {
    const modelDd = buildDropdown({
      value: conv.model,
      options: MODEL_OPTIONS.map((o) => ({ value: o.id, label: o.label })),
      ariaLabel: "Assistant model",
      onChange: (value) => {
        conv.model = value as ModelChoice;
        if (!modelEffortLevels(conv.model).includes(conv.effort)) conv.effort = "default";
        this.rebuildHead();
      },
    });
    const levels = modelEffortLevels(conv.model);
    const effortDd = buildDropdown({
      value: conv.effort,
      options: EFFORT_OPTIONS.filter((o) => levels.includes(o.id)).map((o) => ({ value: o.id, label: o.label })),
      ariaLabel: "Assistant effort",
      onChange: (value) => { conv.effort = value as EffortChoice; },
    });
    return h("div", { className: "lib-asst-pick-row" },
      h("div", { className: "lib-asst-pick-group" }, h("span", { className: "lib-asst-pick-label", textContent: "Model" }), modelDd),
      h("div", { className: "lib-asst-pick-group" }, h("span", { className: "lib-asst-pick-label", textContent: "Effort" }), effortDd),
    );
  }

  private rebuildHistory(): void {
    clear(this.historyEl);
    const g = this.currentGroupKey();
    if (!g) {
      const empty = this.emptyState();
      this.historyEl.appendChild(this.renderEmpty(empty.title, empty.body));
      return;
    }
    const conv = this.conversations.get(this.ensureActiveConversation(g));
    if (!conv || (conv.turns.length === 0 && conv.pendingEvents.length === 0 && !conv.busy)) {
      const empty = this.emptyState();
      this.historyEl.appendChild(this.renderEmpty(empty.title, empty.body));
    } else {
      for (const turn of conv.turns) this.historyEl.appendChild(this.renderTurn(turn, conv));
      if (conv.busy) this.historyEl.appendChild(this.renderInflight(conv));
    }
    if (conv?.error) this.historyEl.appendChild(h("div", { className: "lib-asst-error", textContent: conv.error }));
    if (conv?.stopped && !conv.busy) {
      this.historyEl.appendChild(h("div", { className: "lib-asst-stopped", textContent: "Stopped." }));
    }
    this.historyEl.scrollTop = this.historyEl.scrollHeight;
  }

  private renderEmpty(title: string, body: string): HTMLElement {
    return h("div", { className: "lib-asst-empty" },
      h("div", { className: "lib-asst-empty-title", textContent: title }),
      h("div", { className: "lib-asst-empty-body", textContent: body }),
    );
  }

  private renderTurn(turn: TTurn, conv: ChatConversation<TTurn>): HTMLElement {
    const wrap = h("div", { className: turn.role === "user" ? "lib-asst-turn user" : "lib-asst-turn assistant" });
    if (turn.role === "user") {
      wrap.appendChild(h("div", { className: "lib-asst-turn-text" }, ...renderTextLines(turn.text)));
      return wrap;
    }
    if (turn.events && turn.events.length > 0) {
      wrap.appendChild(renderTimeline(turn.events));
    } else if (turn.text.length > 0) {
      wrap.appendChild(h("div", { className: "lib-asst-turn-text" }, ...renderTextLines(turn.text)));
    }
    const extras = this.renderReplyExtras(turn, conv);
    if (extras) wrap.appendChild(extras);
    return wrap;
  }

  private renderInflight(conv: ChatConversation<TTurn>): HTMLElement {
    const wrap = h("div", { className: "lib-asst-turn assistant inflight" });
    if (conv.pendingEvents.length > 0) wrap.appendChild(renderTimeline(conv.pendingEvents));
    wrap.appendChild(h("div", { className: "lib-asst-typing" },
      h("span", { className: "lib-asst-dot" }),
      h("span", { className: "lib-asst-dot" }),
      h("span", { className: "lib-asst-dot" }),
    ));
    return wrap;
  }

  private rebuildInput(): void {
    clear(this.inputContainer);
    const { element, textarea } = decorateTextarea({
      className: "lib-asst-input",
      rows: 3,
      placeholder: "Describe what you want, or ask a question…",
      ariaLabel: "Message to the assistant",
      expandTitle: "Compose your message",
    });
    this.inputTextarea = textarea;
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.sendCurrent();
      }
    });
    const sendBtn = h("button", {
      className: "lib-asst-send",
      attrs: { type: "button" },
      textContent: "Send",
      on: { click: () => this.sendCurrent() },
    });
    const cancelBtn = h("button", {
      className: "lib-asst-cancel hidden",
      attrs: { type: "button", title: "Stop the current turn" },
      textContent: "Stop",
      on: { click: () => this.cancelCurrent() },
    });
    this.sendBtn = sendBtn;
    this.cancelBtn = cancelBtn;
    this.inputContainer.appendChild(element);
    this.inputContainer.appendChild(h("div", { className: "lib-asst-input-foot" }, cancelBtn, sendBtn));
    this.updateSendBtn();
  }

  private updateSendBtn(): void {
    if (!this.sendBtn || !this.cancelBtn) return;
    const key = this.currentKey();
    const conv = key ? this.conversations.get(key) : null;
    const busy = conv?.busy ?? false;
    this.sendBtn.disabled = busy || !this.currentGroupKey();
    this.sendBtn.classList.toggle("busy", busy);
    this.cancelBtn.classList.toggle("hidden", !busy);
  }

  private focusInput(): void {
    window.setTimeout(() => this.inputTextarea?.focus(), 30);
  }

  private sendCurrent(): void {
    const g = this.currentGroupKey();
    if (!g || !this.inputTextarea) return;
    const text = this.inputTextarea.value.trim();
    if (text === "") return;
    const conversationId = this.ensureActiveConversation(g);
    const conv = this.ensureConversation(conversationId);
    if (conv.busy) return;
    conv.error = null;
    conv.stopped = false;
    conv.turns.push(this.makeUserTurn(text));
    this.inputTextarea.value = "";
    this.sendAsk(g, conversationId, conv, text);
    this.rebuildHistory();
    this.updateSendBtn();
  }

  private cancelCurrent(): void {
    const g = this.currentGroupKey();
    const key = this.currentKey();
    if (!g || !key) return;
    const conv = this.conversations.get(key);
    if (conv) conv.stopped = true;
    this.sendCancel(g, key);
  }

  private wireResize(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      const startX = e.clientX;
      const startWidth = this.root.getBoundingClientRect().width;
      const move = (ev: PointerEvent): void => {
        const delta = startX - ev.clientX;
        this.root.style.width = `${Math.max(300, Math.min(900, startWidth + delta))}px`;
      };
      const up = (ev: PointerEvent): void => {
        handle.releasePointerCapture(ev.pointerId);
        handle.classList.remove("dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
}

export const renderTextLines = (text: string): readonly Node[] => {
  const lines = text.split(/\r?\n/);
  const out: Node[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) out.push(document.createElement("br"));
    out.push(document.createTextNode(lines[i] ?? ""));
  }
  return out;
};

const findToolUseFor = (events: readonly TimelineEvent[], toolUseId: string): boolean => {
  for (const e of events) if (e.kind === "tool_use" && e.id === toolUseId) return true;
  return false;
};

export const renderTimeline = (events: readonly TimelineEvent[]): HTMLElement => {
  const wrap = h("div", { className: "lib-asst-timeline" });
  const resultsByToolUseId = new Map<string, TimelineEvent>();
  for (const e of events) if (e.kind === "tool_result") resultsByToolUseId.set(e.toolUseId, e);
  for (const e of events) {
    if (e.kind === "text") {
      wrap.appendChild(h("div", { className: "lib-asst-tl-text" }, ...renderTextLines(e.text)));
    } else if (e.kind === "tool_use") {
      wrap.appendChild(renderToolUseRow(e, resultsByToolUseId.get(e.id)));
    } else if (e.kind === "tool_result" && !findToolUseFor(events, e.toolUseId)) {
      wrap.appendChild(h("div", { className: "lib-asst-tl-tool-orphan", textContent: `↪ ${e.preview}` }));
    }
  }
  return wrap;
};

const renderToolUseRow = (use: TimelineEvent & { kind: "tool_use" }, result: TimelineEvent | undefined): HTMLElement => {
  const row = h("div", { className: `lib-asst-tl-tool${result?.kind === "tool_result" && result.isError ? " error" : ""}` });
  const head = h("div", { className: "lib-asst-tl-tool-head" });
  head.appendChild(h("span", { className: "lib-asst-tl-tool-icon", textContent: iconFor(use.name) }));
  head.appendChild(h("span", { className: "lib-asst-tl-tool-name", textContent: use.name }));
  if (use.input.length > 0) {
    head.appendChild(h("span", { className: "lib-asst-tl-tool-input", textContent: use.input, attrs: { title: use.input } }));
  }
  if (!result || result.kind !== "tool_result") {
    head.appendChild(h("span", { className: "lib-asst-tl-tool-running", textContent: "running…" }));
  }
  row.appendChild(head);
  if (result?.kind === "tool_result" && result.preview.length > 0) {
    row.appendChild(h("div", { className: "lib-asst-tl-tool-preview", textContent: result.preview, attrs: { title: result.preview } }));
  }
  return row;
};

const ICONS: Readonly<Record<string, string>> = {
  WebSearch: "🔎",
  WebFetch: "🌐",
  Read: "📄",
  Grep: "🔍",
  Glob: "🗂",
  TodoWrite: "✓",
  Write: "✍",
};
const iconFor = (name: string): string => ICONS[name] ?? "⚙";

const relativeTime = (ms: number): string => {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};
