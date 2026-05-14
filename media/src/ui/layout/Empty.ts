import { h } from "../h.js";
import { ICONS } from "../icons.js";

export const renderEmptyState = (hasSessions: boolean): HTMLElement =>
  h(
    "div",
    { className: "empty-state" },
    h(
      "div",
      { className: "empty-state-inner" },
      h("div", { className: "empty-icon", innerHTML: ICONS.zap }),
      h("h2", {
        className: "empty-title",
        textContent: hasSessions ? "Select a session" : "No sessions recorded",
      }),
      h("p", {
        className: "empty-desc",
        textContent: hasSessions
          ? "Choose a session from the sidebar to view its timeline, tool usage, context consumption, and cost breakdown."
          : "Install the Claude Trace hooks, then start a Claude Code session. Events will appear here in real time.",
      }),
    ),
  );
