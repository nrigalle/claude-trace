import type {
  AssistantContext,
  AssistantMode,
  AssistantTurn,
  LibraryHostToWebview,
  LibraryWebviewToHost,
  TimelineEvent,
} from "../../../src/features/library/protocol";
import { assertNever } from "../../../src/shared/assertNever";
import { clear, h } from "../ui/h.js";
import { decorateTextarea } from "../ui/textarea.js";
import {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  DEFAULT_MODEL_CHOICE,
  modelEffortLevels,
  type ModelChoice,
  type EffortChoice,
} from "../../../src/shared/models";

export interface AssistantPanelDeps {
  readonly send: (msg: LibraryWebviewToHost) => void;
  readonly onApplyBody: (text: string) => void;
  readonly onApplyDescription: (text: string) => void;
  readonly getContext: () => AssistantContext | null;
}

interface AssistantTurnFull extends AssistantTurn {
  readonly events?: readonly TimelineEvent[];
}

type AssistantHostMessage = Extract<
  LibraryHostToWebview,
  { readonly type: "assistantReply" | "assistantProgress" | "assistantError" | "assistantBusy" }
>;

interface Conversation {
  readonly itemKey: string;
  readonly turns: AssistantTurnFull[];
  busy: boolean;
  error: string | null;
  lastSuggestedDescription: string | null;
  pendingEvents: readonly TimelineEvent[];
  mode: AssistantMode;
  model: ModelChoice;
  effort: EffortChoice;
}

export class AssistantPanel {
  private readonly root: HTMLElement;
  private readonly head: HTMLElement;
  private readonly historyEl: HTMLElement;
  private readonly footerEl: HTMLElement;
  private readonly inputContainer: HTMLElement;
  private readonly conversations = new Map<string, Conversation>();
  private inputTextarea: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private open = false;
  private renderScheduled = false;

  constructor(private readonly deps: AssistantPanelDeps) {
    this.head = h("div", { className: "lib-asst-head" });
    this.historyEl = h("div", { className: "lib-asst-history" });
    this.inputContainer = h("div", { className: "lib-asst-input-row" });
    this.footerEl = h("div", { className: "lib-asst-footer" }, this.inputContainer);
    const resizeHandle = h("div", {
      className: "lib-asst-resize",
      attrs: { "aria-hidden": "true", title: "Drag to resize the assistant panel" },
    });
    this.wireResize(resizeHandle);
    this.root = h("aside", {
      className: "lib-asst hidden",
      attrs: { "aria-label": "Library assistant" },
    }, resizeHandle, this.head, this.historyEl, this.footerEl);
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
        const next = Math.max(300, Math.min(900, startWidth + delta));
        this.root.style.width = `${next}px`;
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
      this.rebuildHead();
      this.rebuildHistory();
      this.rebuildInput();
      this.focusInput();
    }
  }

  switchItem(): void {
    if (this.open) {
      this.rebuildHead();
      this.rebuildHistory();
      this.rebuildInput();
    }
  }

  private currentItemKey(): string | null {
    return this.deps.getContext()?.itemKey ?? null;
  }

  receive(msg: AssistantHostMessage): void {
    switch (msg.type) {
      case "assistantReply": {
        const conv = this.ensureConversation(msg.itemKey);
        conv.turns.push({ role: "assistant", text: msg.text, events: msg.events });
        conv.lastSuggestedDescription = msg.suggestedDescription;
        conv.busy = false;
        conv.pendingEvents = [];
        const hasTools = msg.events.some((e) => e.kind === "tool_use");
        if (conv.mode === "writeBody" && msg.text.length === 0 && hasTools) {
          conv.error = "Claude finished with tool calls but did not write a closing body. Send 'now write the body' as a follow-up.";
        } else {
          conv.error = null;
        }
        if (conv.mode === "writeBody" && msg.text.length > 0) {
          this.deps.onApplyBody(msg.text);
        }
        if (msg.suggestedDescription && msg.suggestedDescription.length > 0) {
          this.deps.onApplyDescription(msg.suggestedDescription);
        }
        this.scheduleRender(msg.itemKey);
        return;
      }
      case "assistantProgress": {
        const conv = this.ensureConversation(msg.itemKey);
        conv.pendingEvents = msg.events;
        this.scheduleRender(msg.itemKey);
        return;
      }
      case "assistantError": {
        const conv = this.conversations.get(msg.itemKey);
        if (!conv) return;
        conv.busy = false;
        conv.error = msg.message;
        conv.pendingEvents = [];
        this.scheduleRender(msg.itemKey);
        return;
      }
      case "assistantBusy": {
        const conv = this.ensureConversation(msg.itemKey);
        conv.busy = msg.busy;
        if (!msg.busy) conv.pendingEvents = [];
        this.scheduleRender(msg.itemKey);
        return;
      }
      default:
        assertNever(msg);
    }
  }

  private scheduleRender(itemKey: string): void {
    if (!this.open || itemKey !== this.currentItemKey()) return;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.rebuildHistory();
      this.updateSendBtn();
    });
  }

  private ensureConversation(itemKey: string): Conversation {
    let conv = this.conversations.get(itemKey);
    if (!conv) {
      conv = {
        itemKey,
        turns: [],
        busy: false,
        error: null,
        lastSuggestedDescription: null,
        pendingEvents: [],
        mode: "writeBody",
        model: DEFAULT_MODEL_CHOICE,
        effort: "default",
      };
      this.conversations.set(itemKey, conv);
    }
    return conv;
  }

  private rebuildHead(): void {
    clear(this.head);
    const title = h("div", { className: "lib-asst-title", textContent: "Assistant" });
    const sub = h("div", { className: "lib-asst-sub", textContent: this.subtitleForCurrent() });

    const ctx = this.deps.getContext();
    const conv = ctx ? this.ensureConversation(ctx.itemKey) : null;
    const modeRow = ctx ? this.renderModeToggle(conv!) : null;

    const resetBtn = h("button", {
      className: "lib-asst-icon-btn",
      attrs: { type: "button", title: "Restart conversation", "aria-label": "Restart conversation" },
      textContent: "↻",
      on: { click: () => this.resetCurrent() },
    });
    const closeBtn = h("button", {
      className: "lib-asst-icon-btn",
      attrs: { type: "button", title: "Close assistant", "aria-label": "Close assistant" },
      innerHTML: "&times;",
      on: { click: () => this.setOpen(false) },
    });

    const headTop = h("div", { className: "lib-asst-head-top" },
      h("div", { className: "lib-asst-head-text" }, title, sub),
      h("div", { className: "lib-asst-head-actions" }, resetBtn, closeBtn),
    );
    this.head.appendChild(headTop);
    if (modeRow) this.head.appendChild(modeRow);
    if (conv) this.head.appendChild(this.renderPickers(conv));
  }

  private renderPickers(conv: Conversation): HTMLElement {
    const modelSelect = h(
      "select",
      {
        className: "lib-asst-pick",
        attrs: { "aria-label": "Assistant model", title: "Model the assistant uses to draft" },
        on: {
          change: (e: Event) => {
            conv.model = (e.target as HTMLSelectElement).value as ModelChoice;
            if (!modelEffortLevels(conv.model).includes(conv.effort)) conv.effort = "default";
            this.rebuildHead();
          },
        },
      },
      ...MODEL_OPTIONS.map((o) =>
        h("option", {
          attrs: { value: o.id, ...(o.id === conv.model ? { selected: "selected" } : {}) },
          textContent: o.label,
        }),
      ),
    );
    const levels = modelEffortLevels(conv.model);
    const effortSelect = h(
      "select",
      {
        className: "lib-asst-pick",
        attrs: { "aria-label": "Assistant effort", title: "Thinking effort per reply" },
        on: {
          change: (e: Event) => {
            conv.effort = (e.target as HTMLSelectElement).value as EffortChoice;
          },
        },
      },
      ...EFFORT_OPTIONS.filter((o) => levels.includes(o.id)).map((o) =>
        h("option", {
          attrs: { value: o.id, ...(o.id === conv.effort ? { selected: "selected" } : {}) },
          textContent: o.label,
        }),
      ),
    );
    return h("div", { className: "lib-asst-pick-row" },
      h("div", { className: "lib-asst-pick-group" },
        h("span", { className: "lib-asst-pick-label", textContent: "Model" }),
        modelSelect,
      ),
      h("div", { className: "lib-asst-pick-group" },
        h("span", { className: "lib-asst-pick-label", textContent: "Effort" }),
        effortSelect,
      ),
    );
  }

  private renderModeToggle(conv: Conversation): HTMLElement {
    const make = (mode: AssistantMode, label: string, desc: string): HTMLElement => {
      const btn = h("button", {
        className: `lib-asst-mode${conv.mode === mode ? " active" : ""}`,
        attrs: { type: "button", title: desc, "data-mode": mode },
        on: { click: () => {
          if (conv.mode === mode) return;
          conv.mode = mode;
          this.rebuildHead();
        } },
      },
        h("span", { className: "lib-asst-mode-label", textContent: label }),
      );
      return btn;
    };
    return h("div", { className: "lib-asst-mode-row", attrs: { role: "tablist" } },
      make("writeBody", "Write to body", "Claude's reply replaces the body field automatically when the turn ends."),
      make("discuss", "Discuss", "Reply stays in chat. The body field is not touched."),
    );
  }

  private subtitleForCurrent(): string {
    const ctx = this.deps.getContext();
    if (!ctx) return "Pick a skill or agent to start";
    return `Helping with ${ctx.kind === "skill" ? "skill" : "agent"} “${ctx.name}”`;
  }

  private rebuildHistory(): void {
    clear(this.historyEl);
    const ctx = this.deps.getContext();
    if (!ctx) {
      this.historyEl.appendChild(this.renderEmpty(
        "Select a skill or agent first",
        "Pick a row on the left to open it, then come back here. I'll help you draft the body.",
      ));
      return;
    }
    const conv = this.conversations.get(ctx.itemKey);
    if (!conv || (conv.turns.length === 0 && conv.pendingEvents.length === 0 && !conv.busy)) {
      this.historyEl.appendChild(this.renderEmpty(
        `Let's draft this ${ctx.kind}.`,
        conv?.mode === "discuss"
          ? "Discuss the design with me. I won't touch the body field in this mode."
          : "Tell me what this " + ctx.kind + " should do. My reply will land directly in the body field.",
      ));
    } else {
      for (const turn of conv.turns) this.historyEl.appendChild(this.renderTurn(turn, conv));
      if (conv.busy) this.historyEl.appendChild(this.renderInflight(conv));
    }
    if (conv?.error) this.historyEl.appendChild(this.renderError(conv.error));
    this.historyEl.scrollTop = this.historyEl.scrollHeight;
  }

  private renderEmpty(title: string, body: string): HTMLElement {
    return h("div", { className: "lib-asst-empty" },
      h("div", { className: "lib-asst-empty-title", textContent: title }),
      h("div", { className: "lib-asst-empty-body", textContent: body }),
    );
  }

  private renderTurn(turn: AssistantTurnFull, conv: Conversation): HTMLElement {
    const cls = turn.role === "user" ? "lib-asst-turn user" : "lib-asst-turn assistant";
    const wrap = h("div", { className: cls });
    if (turn.role === "user") {
      wrap.appendChild(h("div", { className: "lib-asst-turn-text" }, ...renderTextLines(turn.text)));
      return wrap;
    }
    if (turn.events && turn.events.length > 0) {
      wrap.appendChild(this.renderTimeline(turn.events));
    } else {
      wrap.appendChild(h("div", { className: "lib-asst-turn-text" }, ...renderTextLines(turn.text)));
    }
    if (conv.mode === "writeBody" && turn.text.length > 0) {
      const lastTurn = conv.turns[conv.turns.length - 1] === turn;
      const note = h("div", { className: "lib-asst-applied" },
        h("span", { className: "lib-asst-applied-dot" }),
        h("span", { textContent: lastTurn ? "Written to body field" : "Was written to body field" }),
      );
      wrap.appendChild(note);
    }
    return wrap;
  }

  private renderInflight(conv: Conversation): HTMLElement {
    const wrap = h("div", { className: "lib-asst-turn assistant inflight" });
    if (conv.pendingEvents.length > 0) {
      wrap.appendChild(this.renderTimeline(conv.pendingEvents));
    }
    wrap.appendChild(h("div", { className: "lib-asst-typing" },
      h("span", { className: "lib-asst-dot" }),
      h("span", { className: "lib-asst-dot" }),
      h("span", { className: "lib-asst-dot" }),
    ));
    return wrap;
  }

  private renderTimeline(events: readonly TimelineEvent[]): HTMLElement {
    const wrap = h("div", { className: "lib-asst-timeline" });
    const resultsByToolUseId = new Map<string, TimelineEvent>();
    for (const e of events) {
      if (e.kind === "tool_result") resultsByToolUseId.set(e.toolUseId, e);
    }
    for (const e of events) {
      if (e.kind === "text") {
        wrap.appendChild(h("div", { className: "lib-asst-tl-text" }, ...renderTextLines(e.text)));
      } else if (e.kind === "tool_use") {
        const result = resultsByToolUseId.get(e.id);
        wrap.appendChild(this.renderToolUseRow(e, result));
      } else if (e.kind === "tool_result" && !findToolUseFor(events, e.toolUseId)) {
        wrap.appendChild(h("div", { className: "lib-asst-tl-tool-orphan", textContent: `↪ ${e.preview}` }));
      }
    }
    return wrap;
  }

  private renderToolUseRow(use: TimelineEvent & { kind: "tool_use" }, result: TimelineEvent | undefined): HTMLElement {
    const row = h("div", { className: `lib-asst-tl-tool${result?.kind === "tool_result" && result.isError ? " error" : ""}` });
    const head = h("div", { className: "lib-asst-tl-tool-head" });
    head.appendChild(h("span", { className: "lib-asst-tl-tool-icon", textContent: iconFor(use.name) }));
    head.appendChild(h("span", { className: "lib-asst-tl-tool-name", textContent: use.name }));
    if (use.input.length > 0) {
      head.appendChild(h("span", {
        className: "lib-asst-tl-tool-input",
        textContent: use.input,
        attrs: { title: use.input },
      }));
    }
    if (!result || result.kind !== "tool_result") {
      head.appendChild(h("span", { className: "lib-asst-tl-tool-running", textContent: "running…" }));
    }
    row.appendChild(head);
    if (result?.kind === "tool_result" && result.preview.length > 0) {
      row.appendChild(h("div", {
        className: "lib-asst-tl-tool-preview",
        textContent: result.preview,
        attrs: { title: result.preview },
      }));
    }
    return row;
  }

  private renderError(message: string): HTMLElement {
    return h("div", { className: "lib-asst-error", textContent: message });
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
    this.inputContainer.appendChild(h("div", { className: "lib-asst-input-foot" },
      cancelBtn,
      sendBtn,
    ));
    this.updateSendBtn();
  }

  private updateSendBtn(): void {
    if (!this.sendBtn || !this.cancelBtn) return;
    const ctx = this.deps.getContext();
    const conv = ctx ? this.conversations.get(ctx.itemKey) : null;
    const busy = conv?.busy ?? false;
    this.sendBtn.disabled = busy || !ctx;
    this.sendBtn.classList.toggle("busy", busy);
    this.cancelBtn.classList.toggle("hidden", !busy);
  }

  private focusInput(): void {
    window.setTimeout(() => this.inputTextarea?.focus(), 30);
  }

  private sendCurrent(): void {
    const ctx = this.deps.getContext();
    if (!ctx || !this.inputTextarea) return;
    const text = this.inputTextarea.value.trim();
    if (text === "") return;
    const conv = this.ensureConversation(ctx.itemKey);
    if (conv.busy) return;
    conv.error = null;
    conv.turns.push({ role: "user", text });
    this.inputTextarea.value = "";
    this.deps.send({
      type: "assistantAsk",
      context: ctx,
      message: text,
      mode: conv.mode,
      model: conv.model,
      effort: conv.effort,
    });
    this.rebuildHistory();
    this.updateSendBtn();
  }

  private cancelCurrent(): void {
    const ctx = this.deps.getContext();
    if (!ctx) return;
    this.deps.send({ type: "assistantCancel", itemKey: ctx.itemKey });
  }

  private resetCurrent(): void {
    const ctx = this.deps.getContext();
    if (!ctx) return;
    this.conversations.delete(ctx.itemKey);
    this.deps.send({ type: "assistantReset", itemKey: ctx.itemKey });
    this.rebuildHistory();
    this.updateSendBtn();
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

const findToolUseFor = (events: readonly TimelineEvent[], toolUseId: string): boolean => {
  for (const e of events) if (e.kind === "tool_use" && e.id === toolUseId) return true;
  return false;
};

const ICONS: Readonly<Record<string, string>> = {
  WebSearch: "🔎",
  WebFetch: "🌐",
  Read: "📄",
  Grep: "🔍",
  Glob: "🗂",
  TodoWrite: "✓",
};
const iconFor = (name: string): string => ICONS[name] ?? "⚙";
