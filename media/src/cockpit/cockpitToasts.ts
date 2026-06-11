import { h } from "../ui/h.js";
import { ICONS } from "../ui/icons.js";

export const flashToast = (
  root: HTMLElement,
  message: string,
  level: "info" | "warning" | "error",
): void => {
  const icon = level === "error" || level === "warning" ? ICONS.alert : ICONS.check;
  const note = h(
    "div",
    { className: `tc-flash ${level}` },
    h("span", { className: "tc-flash-icon", innerHTML: icon }),
    h("div", { className: "tc-flash-body" }, h("div", { className: "tc-flash-msg", textContent: message })),
  );
  root.appendChild(note);
  requestAnimationFrame(() => note.classList.add("in"));
  setTimeout(() => {
    note.classList.remove("in");
    setTimeout(() => note.remove(), 220);
  }, 4000);
};
