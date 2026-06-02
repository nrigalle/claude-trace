import { h } from "./h.js";

export interface DecorateTextareaOptions {
  readonly className?: string;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly spellcheck?: boolean;
  readonly expandTitle?: string;
  readonly minHeight?: number;
  readonly mono?: boolean;
  readonly value?: string;
  readonly ariaLabel?: string;
}

export interface DecoratedTextarea {
  readonly element: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
}

const EXPAND_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 2h5v1.5H3.5V7H2V2zm12 0v5h-1.5V3.5H9V2h5zM2 14V9h1.5v3.5H7V14H2zm12 0H9v-1.5h3.5V9H14v5z"/></svg>';

export const decorateTextarea = (opts: DecorateTextareaOptions = {}): DecoratedTextarea => {
  const wrapClass = `ct-ta-wrap${opts.className ? ` ${opts.className}` : ""}${opts.mono ? " ct-ta-mono" : ""}`;
  const wrapper = h("div", { className: wrapClass });

  const textarea = h("textarea", {
    className: "ct-ta-input",
    attrs: {
      ...(opts.rows ? { rows: String(opts.rows) } : {}),
      ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
      ...(opts.spellcheck === false ? { spellcheck: "false" } : {}),
      ...(opts.ariaLabel ? { "aria-label": opts.ariaLabel } : {}),
    },
  });
  if (opts.value !== undefined) textarea.value = opts.value;

  const topHandle = h("div", {
    className: "ct-ta-handle ct-ta-handle-top",
    attrs: { "aria-hidden": "true" },
  });
  const bottomHandle = h("div", {
    className: "ct-ta-handle ct-ta-handle-bottom",
    attrs: { "aria-hidden": "true" },
  });

  const expandBtn = h("button", {
    className: "ct-ta-expand",
    attrs: {
      type: "button",
      title: opts.expandTitle ?? "Expand",
      "aria-label": opts.expandTitle ?? "Expand to fullscreen",
    },
    innerHTML: EXPAND_ICON,
    on: { click: () => openExpand(textarea, opts.expandTitle ?? "Edit") },
  });

  const minHeight = opts.minHeight ?? 40;
  wireResize(textarea, topHandle, "top", minHeight);
  wireResize(textarea, bottomHandle, "bottom", minHeight);

  wrapper.appendChild(topHandle);
  wrapper.appendChild(textarea);
  wrapper.appendChild(bottomHandle);
  wrapper.appendChild(expandBtn);
  return { element: wrapper, textarea };
};

const wireResize = (
  ta: HTMLTextAreaElement,
  handle: HTMLElement,
  edge: "top" | "bottom",
  minHeight: number,
): void => {
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const startY = e.clientY;
    const startHeight = ta.getBoundingClientRect().height;
    const move = (ev: PointerEvent): void => {
      const delta = ev.clientY - startY;
      const newHeight = edge === "bottom" ? startHeight + delta : startHeight - delta;
      ta.style.height = `${Math.max(minHeight, newHeight)}px`;
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
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusableWithin = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

export const openExpand = (source: HTMLTextAreaElement, title: string): void => {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = h("div", { className: "ct-ta-expand-overlay" });
  const card = h("div", { className: "ct-ta-expand-card", attrs: { role: "dialog", "aria-modal": "true", "aria-label": title } });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    overlay.classList.add("closing");
    window.setTimeout(() => overlay.remove(), 160);
    document.removeEventListener("keydown", onKey);
    if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
    else source.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      const focusable = focusableWithin(card);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !card.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !card.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const editor = h("textarea", {
    className: "ct-ta-expand-editor",
    attrs: { spellcheck: "false", "aria-label": title },
  });
  editor.value = source.value;
  editor.addEventListener("input", () => {
    source.value = editor.value;
    source.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const doneBtn = h("button", {
    className: "ct-ta-expand-done",
    attrs: { type: "button" },
    textContent: "Done",
    on: { click: close },
  });
  const head = h("div", { className: "ct-ta-expand-head" },
    h("div", { className: "ct-ta-expand-title", textContent: title }),
    h("div", { className: "ct-ta-expand-hint", textContent: "Esc or click outside to close" }),
    doneBtn,
  );
  card.appendChild(head);
  card.appendChild(editor);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  window.setTimeout(() => overlay.classList.add("open"), 16);
  window.setTimeout(() => {
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, 30);
};
