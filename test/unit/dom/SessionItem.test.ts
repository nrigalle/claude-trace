import { describe, expect, it, vi } from "vitest";
import { renderSessionItem } from "../../../media/src/ui/layout/SessionItem";
import { toSessionId, type SessionSummary } from "../../../src/features/dashboard/domain/types";

const base = (overrides: Partial<SessionSummary>): SessionSummary => ({
  session_id: toSessionId("abc123def-very-long-id"),
  title: "Refactor auth",
  event_count: 0,
  tool_count: 0,
  tools: [],
  duration_ms: 0,
  started_at: null,
  ended_at: null,
  cwd: null,
  cost: null,
  context_window: null,
  model: { display_name: "Claude Opus 4.7" },
  last_modified_ms: 0,
  pinned: false,
  searchable_text: "",
  ...overrides,
});

const handlers = {
  onSelect: vi.fn(),
  onTogglePin: vi.fn(),
  onCopyConversation: vi.fn(),
  onResumeInCockpit: vi.fn(),
};

describe("renderSessionItem — actions row", () => {
  it("renders Resume, Copy and View-info action buttons, and never the model tag or session id", () => {
    const node = renderSessionItem(base({}), false, handlers);
    const actions = node.querySelectorAll<HTMLElement>(".session-item-action");
    const labels = [...actions].map((a) => a.getAttribute("title"));
    expect(labels).toContain("Resume in cockpit");
    expect(labels).toContain("Copy conversation");
    expect(labels).toContain("View info");
    expect(node.querySelector(".session-item-tags")).toBeNull();
    expect(node.querySelector(".tag")).toBeNull();
    expect(node.textContent).not.toContain("Claude Opus 4.7");
  });

  it("renders the action buttons regardless of whether a model is present", () => {
    const node = renderSessionItem(base({ model: null }), false, handlers);
    expect(node.querySelectorAll(".session-item-action")).toHaveLength(3);
  });

  it("the Resume button adopts the session into the cockpit and does not also select", () => {
    const onResumeInCockpit = vi.fn();
    const onSelect = vi.fn();
    const node = renderSessionItem(base({}), false, {
      onSelect,
      onTogglePin: vi.fn(),
      onCopyConversation: vi.fn(),
      onResumeInCockpit,
    });
    document.body.appendChild(node);
    const resume = [...node.querySelectorAll<HTMLElement>(".session-item-action")].find(
      (a) => a.getAttribute("title") === "Resume in cockpit",
    )!;
    resume.click();
    expect(onResumeInCockpit).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    node.remove();
  });

  it("the Copy button calls onCopyConversation and stops the row from also selecting", () => {
    const onSelect = vi.fn();
    const onCopyConversation = vi.fn();
    const node = renderSessionItem(base({}), false, { onSelect, onTogglePin: vi.fn(), onCopyConversation, onResumeInCockpit: vi.fn() });
    document.body.appendChild(node);
    const copy = [...node.querySelectorAll<HTMLElement>(".session-item-action")].find(
      (a) => a.getAttribute("title") === "Copy conversation",
    )!;
    copy.click();
    expect(onCopyConversation).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    node.remove();
  });
});

describe("renderSessionItem — pin star", () => {
  it("renders an unfilled star with the unpin-disabled aria-pressed for an unpinned session", () => {
    const node = renderSessionItem(base({ pinned: false }), false, handlers);
    const pin = node.querySelector<HTMLElement>(".session-item-pin")!;
    expect(pin.textContent).toBe("☆");
    expect(pin.classList.contains("pinned")).toBe(false);
    expect(pin.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders a filled star and pinned class when pinned is true", () => {
    const node = renderSessionItem(base({ pinned: true }), false, handlers);
    const pin = node.querySelector<HTMLElement>(".session-item-pin")!;
    expect(pin.textContent).toBe("★");
    expect(pin.classList.contains("pinned")).toBe(true);
    expect(pin.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking the star calls onTogglePin and STOPS the click from reaching the parent (no onSelect)", () => {
    const onSelect = vi.fn();
    const onTogglePin = vi.fn();
    const node = renderSessionItem(base({}), false, { onSelect, onTogglePin, onCopyConversation: vi.fn(), onResumeInCockpit: vi.fn() });
    document.body.appendChild(node);
    const pin = node.querySelector<HTMLElement>(".session-item-pin")!;
    pin.click();
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    node.remove();
  });

  it("keyboard Enter on the pin star toggles without selecting", () => {
    const onSelect = vi.fn();
    const onTogglePin = vi.fn();
    const node = renderSessionItem(base({}), false, { onSelect, onTogglePin, onCopyConversation: vi.fn(), onResumeInCockpit: vi.fn() });
    document.body.appendChild(node);
    const pin = node.querySelector<HTMLElement>(".session-item-pin")!;
    pin.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    node.remove();
  });
});

describe("renderSessionItem — body content", () => {
  it("falls back to a short-id-based session label when title is missing", () => {
    const node = renderSessionItem(base({ title: null }), false, handlers);
    const name = node.querySelector<HTMLElement>(".session-item-name")!;
    expect(name.textContent).toMatch(/^Session [a-z0-9]{1,}/);
  });

  it("shows the project name derived from the cwd path basename", () => {
    const node = renderSessionItem(base({ cwd: "/home/alex/my-api" }), false, handlers);
    expect(node.querySelector(".session-item-project-name")?.textContent).toBe("my-api");
  });
});
