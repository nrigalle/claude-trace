import { h } from "../ui/h.js";
import { ICONS } from "../ui/icons.js";

const buildToast = (root: HTMLElement, level: string, icon: string, title: string | undefined, message: string): HTMLElement => {
  const body = h("div", { className: "tc-flash-body" });
  if (title) body.appendChild(h("div", { className: "tc-flash-title", textContent: title }));
  body.appendChild(h("div", { className: "tc-flash-msg", textContent: message }));
  const note = h(
    "div",
    { className: `tc-flash ${level}` },
    h("span", { className: "tc-flash-icon", innerHTML: icon }),
    body,
  );
  root.appendChild(note);
  requestAnimationFrame(() => note.classList.add("in"));
  return note;
};

const removeToast = (note: HTMLElement): void => {
  note.classList.remove("in");
  setTimeout(() => note.remove(), 220);
};

export const flashToast = (
  root: HTMLElement,
  message: string,
  level: "info" | "warning" | "error",
  title?: string,
): void => {
  const icon = level === "error" || level === "warning" ? ICONS.alert : ICONS.check;
  const note = buildToast(root, level, icon, title, message);
  setTimeout(() => removeToast(note), 4000);
};
