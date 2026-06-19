import { h } from "./h.js";

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
}

export interface DropdownConfig {
  readonly value: string;
  readonly options: readonly DropdownOption[];
  readonly ariaLabel: string;
  readonly buttonClass?: string;
  readonly wrapClass?: string;
  readonly onChange?: (value: string) => void;
}

export interface DropdownEl extends HTMLElement {
  setDropdownValue(value: string): void;
  getDropdownValue(): string;
}

const CARET_SVG =
  `<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">` +
  `<path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const CHECK_SVG =
  `<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">` +
  `<path d="M2.5 6.5 5 9l4.5-5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const buildDropdown = (config: DropdownConfig): DropdownEl => {
  let selected = config.value;
  const initial = config.options.find((o) => o.value === selected) ?? config.options[0];
  const labelEl = h("span", { className: "ct-dd-label", textContent: initial?.label ?? "" });
  const caretEl = h("span", { className: "ct-dd-caret", attrs: { "aria-hidden": "true" }, innerHTML: CARET_SVG });
  const btn = h("button", {
    className: `ct-dd-btn${config.buttonClass ? ` ${config.buttonClass}` : ""}`,
    attrs: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": config.ariaLabel },
  }, labelEl, caretEl);
  const wrap = h("div", { className: `ct-dd${config.wrapClass ? ` ${config.wrapClass}` : ""}` }, btn) as unknown as DropdownEl;

  let menu: HTMLElement | null = null;
  let observer: MutationObserver | null = null;

  const detach = (): void => {
    window.removeEventListener("scroll", dismiss, true);
    window.removeEventListener("resize", dismiss);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    observer?.disconnect();
    observer = null;
  };
  const close = (): void => {
    if (!menu) return;
    menu.remove();
    menu = null;
    btn.setAttribute("aria-expanded", "false");
    detach();
  };
  const dismiss = (): void => close();
  const onPointerDown = (e: Event): void => {
    const target = e.target as Node;
    if (menu && !menu.contains(target) && !btn.contains(target)) close();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); }
  };

  const position = (): void => {
    if (!menu) return;
    const rect = btn.getBoundingClientRect();
    menu.style.minWidth = `${Math.round(rect.width)}px`;
    menu.style.left = `${Math.round(rect.left)}px`;
    const menuHeight = menu.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    menu.style.top = spaceBelow < menuHeight + 8 && rect.top > menuHeight + 8
      ? `${Math.round(rect.top - menuHeight - 5)}px`
      : `${Math.round(rect.bottom + 5)}px`;
  };

  const open = (): void => {
    menu = h("div", { className: "ct-dd-menu", attrs: { role: "listbox" } });
    for (const opt of config.options) {
      const isSel = opt.value === selected;
      const item = h("button", {
        className: `ct-dd-opt${isSel ? " selected" : ""}`,
        attrs: { type: "button", role: "option", "aria-selected": isSel ? "true" : "false", "data-value": opt.value },
        on: {
          click: () => {
            selected = opt.value;
            labelEl.textContent = opt.label;
            close();
            config.onChange?.(opt.value);
          },
        },
      },
        h("span", { className: "ct-dd-check", attrs: { "aria-hidden": "true" }, innerHTML: isSel ? CHECK_SVG : "" }),
        h("span", { className: "ct-dd-opt-label", textContent: opt.label }),
      );
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    position();
    btn.setAttribute("aria-expanded", "true");
    observer = new MutationObserver(() => {
      if (!btn.isConnected) close();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  };

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (menu) close(); else open();
  });

  wrap.getDropdownValue = (): string => selected;
  wrap.setDropdownValue = (v: string): void => {
    const opt = config.options.find((o) => o.value === v);
    if (!opt) return;
    selected = v;
    labelEl.textContent = opt.label;
    if (menu) close();
  };
  return wrap;
};
