import { describe, expect, it, beforeEach } from "vitest";
import { AssistantPanel } from "../../../media/src/library/AssistantPanel";
import type {
  AssistantContext,
  LibraryWebviewToHost,
  TimelineEvent,
} from "../../../src/features/library/protocol";

const baseCtx: AssistantContext = {
  itemKey: "skill:code-review",
  kind: "skill",
  name: "code-review",
  description: "Reviews diffs",
  body: "current body",
  attachedSkills: [],
};

let sent: LibraryWebviewToHost[];
let appliedBody: string[];
let appliedDescription: string[];
let ctx: AssistantContext | null;

const mount = (): { panel: AssistantPanel; root: HTMLElement } => {
  sent = [];
  appliedBody = [];
  appliedDescription = [];
  ctx = baseCtx;
  const panel = new AssistantPanel({
    send: (m) => sent.push(m),
    getContext: () => ctx,
    onApplyBody: (t) => appliedBody.push(t),
    onApplyDescription: (t) => appliedDescription.push(t),
  });
  document.body.appendChild(panel.element());
  return { panel, root: panel.element() };
};

beforeEach(() => {
  document.body.innerHTML = "";
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const flushRaf = async (): Promise<void> => {
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  await tick();
};

const sendUserMessage = async (root: HTMLElement, text: string): Promise<void> => {
  const input = root.querySelector(".lib-asst-input .ct-ta-input") as HTMLTextAreaElement;
  input.value = text;
  (root.querySelector(".lib-asst-send") as HTMLButtonElement).click();
  await tick();
};

describe("AssistantPanel — visibility and mode toggle", () => {
  it("renders hidden by default and visible after setOpen(true)", () => {
    const { panel, root } = mount();
    expect(root.classList.contains("hidden")).toBe(true);
    panel.setOpen(true);
    expect(root.classList.contains("hidden")).toBe(false);
  });

  it("defaults to 'Write to body' mode (the bulletproof default)", () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    const active = root.querySelector(".lib-asst-mode.active");
    expect(active?.getAttribute("data-mode")).toBe("writeBody");
  });

  it("clicking the Discuss mode toggle switches modes (visually)", () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    (root.querySelector('.lib-asst-mode[data-mode="discuss"]') as HTMLButtonElement).click();
    const active = root.querySelector(".lib-asst-mode.active") as HTMLElement;
    expect(active.getAttribute("data-mode")).toBe("discuss");
  });

  it("send is disabled and cancel hidden when no context is selected", async () => {
    ctx = null;
    sent = [];
    appliedBody = [];
    appliedDescription = [];
    const panel = new AssistantPanel({
      send: (m) => sent.push(m),
      getContext: () => ctx,
      onApplyBody: (t) => appliedBody.push(t),
      onApplyDescription: (t) => appliedDescription.push(t),
    });
    document.body.appendChild(panel.element());
    panel.setOpen(true);
    const sendBtn = panel.element().querySelector(".lib-asst-send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    expect(panel.element().querySelector(".lib-asst-cancel")?.classList.contains("hidden")).toBe(true);
  });
});

describe("AssistantPanel — send mechanics", () => {
  it("emits assistantAsk with full context, message, and current mode on first send", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "draft a body for me");
    const asked = sent.find((m) => m.type === "assistantAsk");
    expect(asked).toBeDefined();
    const a = asked as { context: AssistantContext; message: string; mode: string };
    expect(a.context.itemKey).toBe("skill:code-review");
    expect(a.message).toBe("draft a body for me");
    expect(a.mode).toBe("writeBody");
  });

  it("includes the selected model and effort in assistantAsk", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    const modelSel = root.querySelectorAll(".lib-asst-pick")[0] as HTMLSelectElement;
    modelSel.value = "claude-sonnet-4-6";
    modelSel.dispatchEvent(new Event("change"));
    const effortSel = root.querySelectorAll(".lib-asst-pick")[1] as HTMLSelectElement;
    effortSel.value = "high";
    effortSel.dispatchEvent(new Event("change"));
    await sendUserMessage(root, "draft");
    const asked = sent.find((m) => m.type === "assistantAsk") as { model: string; effort: string };
    expect(asked.model).toBe("claude-sonnet-4-6");
    expect(asked.effort).toBe("high");
  });

  it("Send is ignored when input is empty or whitespace-only", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "   ");
    expect(sent.some((m) => m.type === "assistantAsk")).toBe(false);
  });

  it("Send is ignored while the assistant is busy", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "first");
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    await flushRaf();
    sent.length = 0;
    await sendUserMessage(root, "while busy");
    expect(sent.some((m) => m.type === "assistantAsk")).toBe(false);
  });

  it("⌘+Enter in the input fires Send", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    const input = root.querySelector(".lib-asst-input .ct-ta-input") as HTMLTextAreaElement;
    input.value = "via shortcut";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    expect(sent.some((m) => m.type === "assistantAsk")).toBe(true);
  });
});

describe("AssistantPanel — bulletproof 'write to body' guarantee", () => {
  it("writeBody mode auto-applies the assistant text to the body when the reply arrives", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "draft");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "## Body markdown\n\nUse me when…" }],
      text: "## Body markdown\n\nUse me when…",
      suggestedDescription: null,
    });
    await flushRaf();
    expect(appliedBody).toEqual(["## Body markdown\n\nUse me when…"]);
  });

  it("writeBody mode ALSO applies a suggested description automatically", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "draft");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "the body" }],
      text: "the body",
      suggestedDescription: "Reviews diffs for security and clarity.",
    });
    await flushRaf();
    expect(appliedBody).toEqual(["the body"]);
    expect(appliedDescription).toEqual(["Reviews diffs for security and clarity."]);
  });

  it("discuss mode does NOT touch the body when the reply arrives", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    const discussBtn = root.querySelector('.lib-asst-mode[data-mode="discuss"]') as HTMLButtonElement;
    discussBtn.click();
    await sendUserMessage(root, "what do you think about X?");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "I think Y." }],
      text: "I think Y.",
      suggestedDescription: null,
    });
    await flushRaf();
    expect(appliedBody).toEqual([]);
  });

  it("empty assistant reply does NOT call onApplyBody (avoid clobbering body with empty string)", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [],
      text: "",
      suggestedDescription: null,
    });
    await flushRaf();
    expect(appliedBody).toEqual([]);
  });

  it("MULTI-TURN: each new reply replaces the body — last reply wins", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "v1");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "version one" }],
      text: "version one",
      suggestedDescription: null,
    });
    await flushRaf();
    await sendUserMessage(root, "v2");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "version two — better" }],
      text: "version two — better",
      suggestedDescription: null,
    });
    await flushRaf();
    expect(appliedBody).toEqual(["version one", "version two — better"]);
  });

  it("a reply for a DIFFERENT item (user switched away) does NOT touch the current body", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    ctx = { ...baseCtx, itemKey: "skill:other", name: "other" };
    panel.switchItem();
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "answer for old item" }],
      text: "answer for old item",
      suggestedDescription: null,
    });
    await flushRaf();
    expect(appliedBody).toEqual(["answer for old item"]);
  });

  it("multiple replies for the same item never produce more onApplyBody calls than expected", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    for (let i = 0; i < 5; i++) {
      panel.receive({
        type: "assistantReply",
        itemKey: "skill:code-review",
        events: [{ kind: "text", text: `t${i}` }],
        text: `t${i}`,
        suggestedDescription: null,
      });
    }
    await flushRaf();
    expect(appliedBody).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("the chat panel marks each applied turn with a visible 'Written to body field' badge", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "the body" }],
      text: "the body",
      suggestedDescription: null,
    });
    await flushRaf();
    const applied = root.querySelector(".lib-asst-applied");
    expect(applied).not.toBeNull();
    expect(applied?.textContent).toContain("body field");
  });
});

describe("AssistantPanel — streaming progress", () => {
  it("renders text events progressively as assistantProgress arrives", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    const events1: TimelineEvent[] = [{ kind: "text", text: "writing now…" }];
    panel.receive({ type: "assistantProgress", itemKey: "skill:code-review", events: events1 });
    await flushRaf();
    expect(root.querySelector(".lib-asst-tl-text")?.textContent).toContain("writing now");
  });

  it("renders tool_use events with the right icon + name + input preview", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    panel.receive({
      type: "assistantProgress",
      itemKey: "skill:code-review",
      events: [{ kind: "tool_use", id: "tu_1", name: "WebSearch", input: '{"query":"python production"}' }],
    });
    await flushRaf();
    const tool = root.querySelector(".lib-asst-tl-tool");
    expect(tool).not.toBeNull();
    expect(tool?.textContent).toContain("WebSearch");
    expect(tool?.textContent).toContain("python production");
    expect(tool?.textContent).toContain("running…");
  });

  it("pairs tool_result with the matching tool_use, showing the result preview", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    panel.receive({
      type: "assistantProgress",
      itemKey: "skill:code-review",
      events: [
        { kind: "tool_use", id: "tu_1", name: "WebSearch", input: '{"query":"x"}' },
        { kind: "tool_result", toolUseId: "tu_1", preview: "5 results found", isError: false },
      ],
    });
    await flushRaf();
    const tool = root.querySelector(".lib-asst-tl-tool");
    expect(tool?.textContent).toContain("WebSearch");
    expect(tool?.textContent).toContain("5 results found");
    expect(tool?.textContent).not.toContain("running…");
  });

  it("marks failed tool results with an error class", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    panel.receive({
      type: "assistantProgress",
      itemKey: "skill:code-review",
      events: [
        { kind: "tool_use", id: "tu_1", name: "WebFetch", input: "{}" },
        { kind: "tool_result", toolUseId: "tu_1", preview: "Network error", isError: true },
      ],
    });
    await flushRaf();
    expect(root.querySelector(".lib-asst-tl-tool.error")).not.toBeNull();
  });

  it("progress events are coalesced via rAF (multiple incoming events render in one frame, not N)", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    for (let i = 0; i < 5; i++) {
      panel.receive({
        type: "assistantProgress",
        itemKey: "skill:code-review",
        events: [{ kind: "text", text: `chunk ${i}` }],
      });
    }
    await flushRaf();
    const texts = root.querySelectorAll(".lib-asst-tl-text");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.textContent).toContain("chunk 4");
  });

  it("progress for a DIFFERENT item does not render in the current item's panel", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({
      type: "assistantProgress",
      itemKey: "skill:something-else",
      events: [{ kind: "text", text: "leaked content from another item" }],
    });
    await flushRaf();
    expect(root.textContent ?? "").not.toContain("leaked content");
  });
});

describe("AssistantPanel — cancel and reset", () => {
  it("the Stop (cancel) button is hidden when idle and visible when busy", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    expect(root.querySelector(".lib-asst-cancel")?.classList.contains("hidden")).toBe(true);
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    await flushRaf();
    expect(root.querySelector(".lib-asst-cancel")?.classList.contains("hidden")).toBe(false);
  });

  it("clicking Stop sends an assistantCancel to the host", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    await flushRaf();
    (root.querySelector(".lib-asst-cancel") as HTMLButtonElement).click();
    expect(sent.some((m) => m.type === "assistantCancel" && (m as { itemKey: string }).itemKey === "skill:code-review")).toBe(true);
  });

  it("Reset (↻) sends assistantReset and clears the local conversation", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "first");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "answered" }],
      text: "answered",
      suggestedDescription: null,
    });
    await flushRaf();
    (root.querySelector('.lib-asst-icon-btn[aria-label="Restart conversation"]') as HTMLButtonElement).click();
    expect(sent.some((m) => m.type === "assistantReset")).toBe(true);
    expect(root.querySelector(".lib-asst-turn")).toBeNull();
  });
});

describe("AssistantPanel — resizable width", () => {
  it("has a resize handle on the left edge of the panel", () => {
    const { panel } = mount();
    panel.setOpen(true);
    const handle = panel.element().querySelector(".lib-asst-resize");
    expect(handle).not.toBeNull();
  });

  it("dragging the resize handle leftward grows the panel width", () => {
    const { panel } = mount();
    panel.setOpen(true);
    const root = panel.element();
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => ({ width: 380, height: 600, top: 0, left: 1000, right: 1380, bottom: 600, x: 1000, y: 0, toJSON: () => ({}) }),
      configurable: true,
    });
    const handle = root.querySelector(".lib-asst-resize") as HTMLElement;
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 1000, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 800, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 800, pointerId: 1, bubbles: true }));
    expect(root.style.width).toBe("580px");
  });

  it("dragging clamps the width to the minimum (300px)", () => {
    const { panel } = mount();
    panel.setOpen(true);
    const root = panel.element();
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => ({ width: 320, height: 600, top: 0, left: 1000, right: 1320, bottom: 600, x: 1000, y: 0, toJSON: () => ({}) }),
      configurable: true,
    });
    const handle = root.querySelector(".lib-asst-resize") as HTMLElement;
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 1000, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 9999, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 9999, pointerId: 1, bubbles: true }));
    expect(root.style.width).toBe("300px");
  });

  it("dragging clamps the width to the maximum (900px)", () => {
    const { panel } = mount();
    panel.setOpen(true);
    const root = panel.element();
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => ({ width: 380, height: 600, top: 0, left: 1000, right: 1380, bottom: 600, x: 1000, y: 0, toJSON: () => ({}) }),
      configurable: true,
    });
    const handle = root.querySelector(".lib-asst-resize") as HTMLElement;
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 1000, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: -5000, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: -5000, pointerId: 1, bubbles: true }));
    expect(root.style.width).toBe("900px");
  });
});

describe("AssistantPanel — error handling", () => {
  it("assistantError shows the message inline and re-enables Send", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: true });
    panel.receive({ type: "assistantError", itemKey: "skill:code-review", message: "Claude CLI not found." });
    panel.receive({ type: "assistantBusy", itemKey: "skill:code-review", busy: false });
    await flushRaf();
    expect(root.querySelector(".lib-asst-error")?.textContent).toContain("Claude CLI not found");
    expect((root.querySelector(".lib-asst-send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a new send after an error clears the error", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "go");
    panel.receive({ type: "assistantError", itemKey: "skill:code-review", message: "transient fail" });
    await flushRaf();
    expect(root.querySelector(".lib-asst-error")).not.toBeNull();
    await sendUserMessage(root, "retry");
    await flushRaf();
    expect(root.querySelector(".lib-asst-error")).toBeNull();
  });
});

describe("AssistantPanel — item switching isolation", () => {
  it("switching to a different item shows that item's conversation, not the previous one", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "for code-review");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "code-review answer" }],
      text: "code-review answer",
      suggestedDescription: null,
    });
    await flushRaf();
    ctx = { ...baseCtx, itemKey: "skill:lint", name: "lint" };
    panel.switchItem();
    await flushRaf();
    expect(root.textContent ?? "").not.toContain("code-review answer");
    expect(root.querySelector(".lib-asst-empty")).not.toBeNull();
  });

  it("switching BACK to the original item restores its conversation", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    await sendUserMessage(root, "for code-review");
    panel.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      events: [{ kind: "text", text: "code-review answer" }],
      text: "code-review answer",
      suggestedDescription: null,
    });
    await flushRaf();
    ctx = { ...baseCtx, itemKey: "skill:lint", name: "lint" };
    panel.switchItem();
    await flushRaf();
    ctx = baseCtx;
    panel.switchItem();
    await flushRaf();
    expect(root.textContent ?? "").toContain("code-review answer");
  });

  it("mode is per-item: switching items does not leak the previous item's mode to the new one", async () => {
    const { panel, root } = mount();
    panel.setOpen(true);
    await tick();
    const discussBtn = root.querySelector('.lib-asst-mode[data-mode="discuss"]') as HTMLButtonElement;
    discussBtn.click();
    await flushRaf();
    ctx = { ...baseCtx, itemKey: "skill:lint", name: "lint" };
    panel.switchItem();
    await flushRaf();
    const activeMode = root.querySelector(".lib-asst-mode.active") as HTMLElement;
    expect(activeMode.getAttribute("data-mode")).toBe("writeBody");
  });
});
