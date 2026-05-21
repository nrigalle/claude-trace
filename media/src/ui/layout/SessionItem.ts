import type { SessionId, SessionSummary } from "../../../../src/domain/types";
import { fmtCost, fmtDate, fmtDuration, shortId } from "../format.js";
import { h } from "../h.js";

export interface SessionItemHandlers {
  onSelect(id: SessionId): void;
  onTogglePin(id: SessionId): void;
}

const deriveProject = (cwd: string | null): string => {
  if (!cwd) return "Untitled project";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
};

const deriveTitle = (s: SessionSummary): string => {
  if (s.title && s.title.length > 0) return s.title;
  return `Session ${shortId(s.session_id, 8)}`;
};

export const renderSessionItem = (
  s: SessionSummary,
  isActive: boolean,
  handlers: SessionItemHandlers,
): HTMLButtonElement => {
  const title = deriveTitle(s);
  const project = deriveProject(s.cwd);
  const model = s.model?.display_name ?? null;
  const lastActivityTs = s.ended_at ?? s.last_modified_ms;

  const pinHandler = (ev: Event): void => {
    ev.stopPropagation();
    ev.preventDefault();
    handlers.onTogglePin(s.session_id);
  };
  const pin = h("span", {
    className: `session-item-pin${s.pinned ? " pinned" : ""}`,
    textContent: s.pinned ? "★" : "☆",
    attrs: {
      role: "button",
      tabindex: "0",
      "aria-label": s.pinned ? `Unpin ${title}` : `Pin ${title}`,
      "aria-pressed": String(s.pinned),
      title: s.pinned ? "Unpin session" : "Pin session",
    },
    on: {
      click: pinHandler,
      keydown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") pinHandler(e);
      },
    },
  });

  const item = h(
    "button",
    {
      className: `session-item${isActive ? " active" : ""}${s.pinned ? " pinned" : ""}`,
      attrs: {
        type: "button",
        "aria-pressed": String(isActive),
        "aria-label": `${title}, ${project}, ${s.tool_count} tools, last active ${fmtDate(lastActivityTs)}`,
      },
      on: { click: () => handlers.onSelect(s.session_id) },
    },
    h(
      "div",
      { className: "session-item-header" },
      pin,
      h("span", {
        className: "session-item-name",
        textContent: title,
        attrs: { title },
      }),
      lastActivityTs
        ? h("span", {
            className: "session-item-date",
            textContent: fmtDate(lastActivityTs),
            attrs: { title: `Last activity: ${new Date(lastActivityTs).toLocaleString()}` },
          })
        : null,
    ),
    h(
      "div",
      { className: "session-item-project" },
      h("span", { className: "session-item-project-name", textContent: project }),
    ),
    h(
      "div",
      { className: "session-item-meta" },
      h("span", { textContent: `${s.tool_count} tools` }),
      h("span", { textContent: fmtDuration(s.duration_ms) }),
      s.cost?.total_cost_usd
        ? h("span", { textContent: fmtCost(s.cost.total_cost_usd) })
        : null,
    ),
    model
      ? h(
          "div",
          { className: "session-item-tags" },
          h("span", { className: "tag", textContent: model }),
        )
      : null,
  );
  item.dataset.sessionId = s.session_id;
  return item;
};
