import type { SessionId, SessionSummary } from "../../../../src/features/dashboard/domain/types";
import { fmtCost, fmtDate, fmtDuration, shortId } from "../format.js";
import { h } from "../h.js";
import { ICONS } from "../icons.js";
import { attachTip } from "../tooltip.js";

export interface SessionItemHandlers {
  onSelect(id: SessionId): void;
  onTogglePin(id: SessionId): void;
  onCopyConversation(id: SessionId): void;
  onResumeInCockpit(id: SessionId): void;
  onDeleteSession(id: SessionId): void;
  onToggleSelect(id: SessionId): void;
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
  opts: { readonly selected: boolean } = { selected: false },
): HTMLButtonElement => {
  const title = deriveTitle(s);
  const project = deriveProject(s.cwd);
  const lastActivityTs = s.ended_at ?? s.last_modified_ms;

  const rowAction = (label: string, ariaLabel: string, tooltip: string, svg: string, onClick: () => void): HTMLElement => {
    const el = h(
      "span",
      {
        className: "session-item-action",
        dataset: { tip: tooltip },
        attrs: {
          role: "button",
          tabindex: "0",
          "aria-label": `${ariaLabel}: ${title}`,
        },
        on: {
          click: (ev: Event) => {
            ev.stopPropagation();
            ev.preventDefault();
            onClick();
          },
          keydown: (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              onClick();
            }
          },
        },
      },
      h("span", { className: "session-item-action-icon", innerHTML: svg }),
      h("span", { className: "session-item-action-label", textContent: label }),
    );
    attachTip(el);
    return el;
  };

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

  const checkHandler = (ev: Event): void => {
    ev.stopPropagation();
    ev.preventDefault();
    handlers.onToggleSelect(s.session_id);
  };
  const check = h("span", {
    className: `session-item-check${opts.selected ? " checked" : ""}`,
    attrs: {
      role: "button",
      tabindex: "0",
      "aria-label": `Select ${title}`,
      "aria-pressed": String(opts.selected),
      title: "Select for bulk actions",
    },
    on: {
      click: checkHandler,
      keydown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") checkHandler(e);
      },
    },
  });

  const content = h(
    "div",
    { className: "session-item-content" },
    h(
      "div",
      { className: "session-item-header" },
      h("span", { className: "session-item-name", textContent: title, attrs: { title } }),
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
      s.cost?.total_cost_usd ? h("span", { textContent: fmtCost(s.cost.total_cost_usd) }) : null,
    ),
    h(
      "div",
      { className: "session-item-actions" },
      rowAction(
        "Resume",
        "Resume session",
        "Reopen this session as a live terminal in the cockpit and keep working in it (runs claude --resume).",
        ICONS.play,
        () => handlers.onResumeInCockpit(s.session_id),
      ),
      rowAction(
        "Copy chat",
        "Copy conversation",
        "Copy the full conversation (your prompts and Claude's replies) to the clipboard as Markdown.",
        ICONS.clipboard,
        () => handlers.onCopyConversation(s.session_id),
      ),
      rowAction(
        "Details",
        "Open details",
        "Open this session's read-only dashboard: cost, tokens, the tool timeline, and the files it changed.",
        ICONS.info,
        () => handlers.onSelect(s.session_id),
      ),
      rowAction(
        "Delete",
        "Delete session",
        "Delete this session's transcript. It moves to the Trash and is removed from Claude Code, so 'claude --resume' will no longer find it.",
        ICONS.trash,
        () => handlers.onDeleteSession(s.session_id),
      ),
    ),
  );

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
    h("div", { className: "session-item-gutter" }, check, pin),
    content,
  );
  item.dataset.sessionId = s.session_id;
  return item;
};
