import { describe, expect, it, vi } from "vitest";
import { renderSessionItem } from "../../../media/src/ui/layout/SessionItem";
import { toSessionId, type SessionSummary } from "../../../src/domain/types";

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
};

describe("renderSessionItem — tags row", () => {
  it("renders the model tag and NO session-id tag", () => {
    const node = renderSessionItem(base({}), false, handlers);
    const tags = node.querySelectorAll<HTMLElement>(".tag");
    const texts = [...tags].map((t) => t.textContent);
    expect(texts).toContain("Claude Opus 4.7");
    expect(texts.every((t) => t !== null && !t.includes("abc123de"))).toBe(true);
  });

  it("renders no tags container at all when model is missing", () => {
    const node = renderSessionItem(base({ model: null }), false, handlers);
    expect(node.querySelector(".session-item-tags")).toBeNull();
  });

  it("renders no session-id tag even when model is also missing", () => {
    const node = renderSessionItem(base({ model: null }), false, handlers);
    expect(node.querySelector(".tag")).toBeNull();
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
    const node = renderSessionItem(base({}), false, { onSelect, onTogglePin });
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
    const node = renderSessionItem(base({}), false, { onSelect, onTogglePin });
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
