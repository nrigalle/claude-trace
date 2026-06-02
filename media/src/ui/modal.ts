import { h } from "./h.js";

interface PromptOptions {
  readonly title: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly initial?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly validate?: (value: string) => string | null;
}

interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
}

interface ModalHandles {
  readonly overlay: HTMLElement;
  readonly card: HTMLElement;
  readonly close: () => void;
}

const openModal = (host: HTMLElement, build: (handles: ModalHandles) => void): void => {
  const overlay = h("div", { className: "ct-modal-overlay", attrs: { role: "presentation" } });
  const card = h("div", {
    className: "ct-modal-card",
    attrs: { role: "dialog", "aria-modal": "true" },
  });
  overlay.appendChild(card);
  host.appendChild(overlay);
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const close = (): void => {
    overlay.classList.add("closing");
    window.setTimeout(() => {
      overlay.remove();
      previouslyFocused?.focus?.();
    }, 140);
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  build({ overlay, card, close });
  window.setTimeout(() => overlay.classList.add("open"), 16);
};

export const askName = (host: HTMLElement, options: PromptOptions): Promise<string | null> =>
  new Promise((resolve) => {
    let resolved = false;
    const settle = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    openModal(host, ({ card, close }) => {
      const title = h("div", { className: "ct-modal-title", textContent: options.title });
      const description = options.description
        ? h("div", { className: "ct-modal-desc", textContent: options.description })
        : null;
      const errorEl = h("div", { className: "ct-modal-error" });
      const input = h("input", {
        className: "ct-modal-input",
        attrs: {
          type: "text",
          placeholder: options.placeholder ?? "",
          spellcheck: "false",
          autocomplete: "off",
          autocapitalize: "off",
        },
      });
      input.value = options.initial ?? "";

      const cancelBtn = h("button", {
        className: "ct-modal-ghost",
        attrs: { type: "button" },
        textContent: options.cancelLabel ?? "Cancel",
        on: { click: () => { close(); settle(null); } },
      });
      const confirmBtn = h("button", {
        className: "ct-modal-primary",
        attrs: { type: "button" },
        textContent: options.confirmLabel ?? "Create",
      });

      const submit = (): void => {
        const value = input.value;
        const error = options.validate ? options.validate(value) : null;
        if (error !== null) {
          errorEl.textContent = error;
          errorEl.classList.add("show");
          input.focus();
          input.select();
          return;
        }
        close();
        settle(value);
      };
      confirmBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
          settle(null);
        }
      });

      const body = h("div", { className: "ct-modal-body" }, title);
      if (description) body.appendChild(description);
      body.appendChild(input);
      body.appendChild(errorEl);

      const foot = h("div", { className: "ct-modal-foot" }, cancelBtn, confirmBtn);
      card.appendChild(body);
      card.appendChild(foot);

      window.setTimeout(() => {
        input.focus();
        input.select();
      }, 30);
    });
  });

export const askConfirm = (host: HTMLElement, options: ConfirmOptions): Promise<boolean> =>
  new Promise((resolve) => {
    let resolved = false;
    const settle = (value: boolean): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    openModal(host, ({ card, close }) => {
      const title = h("div", { className: "ct-modal-title", textContent: options.title });
      const message = h("div", { className: "ct-modal-desc", textContent: options.message });
      const cancelBtn = h("button", {
        className: "ct-modal-ghost",
        attrs: { type: "button" },
        textContent: options.cancelLabel ?? "Cancel",
        on: { click: () => { close(); settle(false); } },
      });
      const confirmBtn = h("button", {
        className: `ct-modal-primary${options.destructive ? " destructive" : ""}`,
        attrs: { type: "button" },
        textContent: options.confirmLabel ?? "Confirm",
        on: { click: () => { close(); settle(true); } },
      });
      const body = h("div", { className: "ct-modal-body" }, title, message);
      const foot = h("div", { className: "ct-modal-foot" }, cancelBtn, confirmBtn);
      card.appendChild(body);
      card.appendChild(foot);
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === "Escape") { close(); settle(false); }
        else if (e.key === "Enter") { close(); settle(true); }
      };
      document.addEventListener("keydown", onKey, { once: false });
      const observer = new MutationObserver(() => {
        if (!document.body.contains(card)) {
          document.removeEventListener("keydown", onKey);
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.setTimeout(() => confirmBtn.focus(), 30);
    });
  });
