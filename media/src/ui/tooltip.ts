import { h } from "./h.js";

let tipEl: HTMLElement | null = null;
let timer: number | null = null;

const ensure = (): HTMLElement => {
  if (!tipEl) {
    tipEl = h("div", { className: "ct-tip", attrs: { role: "tooltip" } });
    document.body.appendChild(tipEl);
    window.addEventListener("scroll", hide, true);
  }
  return tipEl;
};

const show = (anchor: HTMLElement, text: string): void => {
  const tip = ensure();
  tip.textContent = text;
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, a.left + a.width / 2 - t.width / 2));
  const above = a.top - t.height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${above < 8 ? a.bottom + 8 : above}px`;
  tip.classList.add("show");
};

const hide = (): void => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  tipEl?.classList.remove("show");
};

export const attachTip = (el: HTMLElement): void => {
  el.addEventListener("mouseenter", () => {
    const text = el.dataset["tip"];
    if (!text) return;
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => show(el, text), 110);
  });
  el.addEventListener("mouseleave", hide);
  el.addEventListener("pointerdown", hide);
};
