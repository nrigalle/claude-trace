import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openExpand } from "../../../media/src/ui/textarea";

const mountSource = (value = ""): HTMLTextAreaElement => {
  const ta = document.createElement("textarea");
  ta.className = "source-ta";
  ta.value = value;
  document.body.appendChild(ta);
  return ta;
};

const overlay = (): HTMLElement | null => document.querySelector(".ct-ta-expand-overlay");
const card = (): HTMLElement | null => document.querySelector(".ct-ta-expand-card");
const editor = (): HTMLTextAreaElement | null => document.querySelector(".ct-ta-expand-editor");
const doneBtn = (): HTMLButtonElement | null => document.querySelector(".ct-ta-expand-done");

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("openExpand — modal focus management (WCAG 2.4.3, 2.4.7, 2.1.2)", () => {
  it("mounts a dialog-role card holding the editor seeded from the source value", () => {
    const source = mountSource("hello world");
    openExpand(source, "Initial prompt");
    expect(overlay()).not.toBeNull();
    expect(card()!.getAttribute("role")).toBe("dialog");
    expect(card()!.getAttribute("aria-modal")).toBe("true");
    expect(editor()!.value).toBe("hello world");
  });

  it("restores focus to the originating element when closed via the Done button", () => {
    const source = mountSource("x");
    source.focus();
    expect(document.activeElement).toBe(source);
    openExpand(source, "Initial prompt");
    editor()!.focus();
    expect(document.activeElement).toBe(editor());
    doneBtn()!.click();
    expect(document.activeElement).toBe(source);
  });

  it("restores focus to the originating element when closed via Escape (so it is never a keyboard trap)", () => {
    const source = mountSource("x");
    source.focus();
    openExpand(source, "Initial prompt");
    editor()!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(source);
    expect(overlay()!.classList.contains("closing")).toBe(true);
  });

  it("restores focus when closed by clicking the backdrop outside the card", () => {
    const source = mountSource("x");
    source.focus();
    openExpand(source, "Initial prompt");
    editor()!.focus();
    overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.activeElement).toBe(source);
  });

  it("traps Tab: from the last control it wraps to the first focusable in the card", () => {
    const source = mountSource("x");
    openExpand(source, "Initial prompt");
    const focusable = Array.from(
      card()!.querySelectorAll<HTMLElement>("button, textarea, input, select, a[href]"),
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    last.focus();
    expect(document.activeElement).toBe(last);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(card()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("traps Shift+Tab: from the first control it wraps backward to the last focusable in the card", () => {
    const source = mountSource("x");
    openExpand(source, "Initial prompt");
    const focusable = Array.from(
      card()!.querySelectorAll<HTMLElement>("button, textarea, input, select, a[href]"),
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    first.focus();
    expect(document.activeElement).toBe(first);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);
  });

  it("does not restore focus to a source element that was removed while the modal was open", () => {
    const source = mountSource("x");
    source.focus();
    openExpand(source, "Initial prompt");
    source.remove();
    expect(() => doneBtn()!.click()).not.toThrow();
  });
});
