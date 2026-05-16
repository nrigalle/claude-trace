import type {
  GlobalStats,
  SessionId,
  SessionSummary,
} from "../../../../src/domain/types";
import type { DateFilter, Store } from "../../state/Store.js";
import {
  DATE_FILTER_LABELS,
  DATE_FILTER_ORDER,
  matchesDateFilter,
} from "../dateFilter.js";
import { fmtCost } from "../format.js";
import { h } from "../h.js";
import { ICONS, icon } from "../icons.js";
import { renderSidebarSkeletons } from "./Loading.js";
import { renderSessionItem, type SessionItemHandlers } from "./SessionItem.js";

export interface SidebarHandlers extends SessionItemHandlers {
  onStartNewSession(): void;
}

export class Sidebar {
  private readonly root: HTMLElement;
  private readonly statsContainer: HTMLElement;
  private readonly statsSessions: HTMLElement;
  private readonly statsTools: HTMLElement;
  private readonly statsCost: HTMLElement;
  private readonly listContainer: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly dateFilterChips = new Map<DateFilter, HTMLButtonElement>();
  private sessions: readonly SessionSummary[] = [];
  private hasLoaded = false;

  constructor(
    private readonly store: Store,
    private readonly handlers: SidebarHandlers,
  ) {
    this.root = h("nav", {
      className: "sidebar",
      attrs: { "aria-label": "Claude Code sessions" },
    });

    const brand = h(
      "div",
      { className: "brand" },
      h("div", { className: "brand-icon", innerHTML: ICONS.zap }),
      h("span", { className: "brand-title", textContent: "Claude Trace" }),
    );

    this.statsContainer = h("div", { className: "global-stats", attrs: { role: "status", "aria-live": "polite" } });
    this.statsContainer.style.display = "none";
    this.statsSessions = h("span", { className: "stat-pill-value" });
    this.statsTools = h("span", { className: "stat-pill-value" });
    this.statsCost = h("span", { className: "stat-pill-value" });
    this.statsContainer.appendChild(this.buildPill("Sessions", this.statsSessions));
    this.statsContainer.appendChild(this.buildPill("Tools", this.statsTools));
    this.statsContainer.appendChild(this.buildPill("Cost", this.statsCost));

    const header = h("div", { className: "sidebar-header" }, brand, this.statsContainer);
    this.root.appendChild(header);

    const startButton = h(
      "button",
      {
        className: "start-session-btn",
        attrs: { type: "button", "aria-label": "Start a new Claude Code session" },
        on: { click: () => this.handlers.onStartNewSession() },
      },
      icon("plus", 14),
      h("span", { textContent: "Start new session" }),
    );
    this.root.appendChild(startButton);

    this.searchInput = h("input", {
      className: "search-input",
      attrs: {
        type: "text",
        placeholder: "Search sessions…",
        "aria-label": "Search sessions",
        value: this.store.state.searchQuery,
      },
      on: {
        input: () => {
          this.store.update({ searchQuery: this.searchInput.value });
          this.applyFilter();
        },
      },
    });
    this.searchInput.value = this.store.state.searchQuery;
    const searchBox = h("div", { className: "search-box" }, this.searchInput);
    this.root.appendChild(searchBox);

    this.root.appendChild(this.buildDateFilters());

    this.listContainer = h("div", {
      className: "session-list",
      attrs: { role: "list", "aria-label": "Sessions" },
    });
    for (const skel of renderSidebarSkeletons()) this.listContainer.appendChild(skel);
    this.root.appendChild(this.listContainer);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  updateStats(stats: GlobalStats | null): void {
    if (!stats || stats.total_sessions === 0) {
      this.statsContainer.style.display = "none";
      return;
    }
    this.statsContainer.style.display = "";
    setIfChanged(this.statsSessions, String(stats.total_sessions));
    setIfChanged(this.statsTools, String(stats.total_tool_calls));
    setIfChanged(this.statsCost, fmtCost(stats.total_cost_usd));
  }

  updateSessions(sessions: readonly SessionSummary[], changedIds: ReadonlySet<SessionId>): void {
    const previousFocusedId = this.capturedActiveSessionId();
    this.sessions = sessions;

    if (!this.hasLoaded) {
      this.listContainer.querySelectorAll(".session-item-skeleton").forEach((el) => el.remove());
      this.hasLoaded = true;
    }

    if (sessions.length === 0) {
      while (this.listContainer.firstChild) this.listContainer.removeChild(this.listContainer.firstChild);
      this.listContainer.appendChild(
        h("div", { className: "empty-list-hint", textContent: "No sessions recorded yet" }),
      );
      return;
    }

    const existing = new Map<string, HTMLButtonElement>();
    this.listContainer.querySelectorAll<HTMLButtonElement>(".session-item").forEach((el) => {
      const id = el.dataset.sessionId;
      if (id) existing.set(id, el);
    });

    const seen = new Set<string>();
    let prevNode: HTMLButtonElement | null = null;
    const selectedId = this.store.state.selectedId;

    for (const s of sessions) {
      seen.add(s.session_id);
      const isActive = s.session_id === selectedId;
      const cached = existing.get(s.session_id);
      const needsRebuild = !cached || changedIds.has(s.session_id);
      let node: HTMLButtonElement;

      if (needsRebuild) {
        node = renderSessionItem(s, isActive, this.handlers);
        if (cached) {
          cached.replaceWith(node);
        } else if (prevNode && prevNode.nextSibling) {
          this.listContainer.insertBefore(node, prevNode.nextSibling);
        } else if (!prevNode) {
          this.listContainer.insertBefore(node, this.listContainer.firstChild);
        } else {
          this.listContainer.appendChild(node);
        }
      } else {
        node = cached;
        node.classList.toggle("active", isActive);
        node.setAttribute("aria-pressed", String(isActive));
      }

      const expectedNext: ChildNode | null = prevNode
        ? prevNode.nextSibling
        : this.listContainer.firstChild;
      if (node !== expectedNext) {
        this.listContainer.insertBefore(node, expectedNext);
      }
      prevNode = node;
    }

    for (const [id, el] of existing) {
      if (!seen.has(id)) el.remove();
    }
    this.listContainer.querySelector(".empty-list-hint")?.remove();
    this.applyFilter();
    this.restoreFocus(previousFocusedId);
  }

  private applyFilter(): void {
    const q = this.store.state.searchQuery.toLowerCase().trim();
    const dateFilter = this.store.state.dateFilter;
    const now = new Date();
    this.listContainer.querySelectorAll<HTMLButtonElement>(".session-item").forEach((el) => {
      const id = el.dataset.sessionId;
      const session = this.sessions.find((s) => s.session_id === id);
      if (!session) {
        el.style.display = "none";
        return;
      }
      const lastActivity = session.ended_at ?? session.last_modified_ms;
      const inRange = matchesDateFilter(lastActivity, dateFilter, now);
      const searchHit =
        !q ||
        session.session_id.toLowerCase().includes(q) ||
        (session.cwd?.toLowerCase().includes(q) ?? false) ||
        (session.title?.toLowerCase().includes(q) ?? false);
      el.style.display = inRange && searchHit ? "" : "none";
    });
  }

  private buildDateFilters(): HTMLElement {
    const row = h("div", {
      className: "date-filters",
      attrs: { role: "group", "aria-label": "Filter by date" },
    });
    for (const value of DATE_FILTER_ORDER) {
      const active = this.store.state.dateFilter === value;
      const chip = h(
        "button",
        {
          className: `date-filter-chip${active ? " active" : ""}`,
          attrs: { type: "button", "aria-pressed": String(active) },
          on: { click: () => this.setDateFilter(value) },
        },
        h("span", { textContent: DATE_FILTER_LABELS[value] }),
      );
      this.dateFilterChips.set(value, chip);
      row.appendChild(chip);
    }
    return row;
  }

  private setDateFilter(next: DateFilter): void {
    if (this.store.state.dateFilter === next) return;
    this.store.update({ dateFilter: next });
    for (const [value, chip] of this.dateFilterChips) {
      const active = value === next;
      chip.classList.toggle("active", active);
      chip.setAttribute("aria-pressed", String(active));
    }
    this.applyFilter();
  }

  private capturedActiveSessionId(): string | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    if (!active.classList.contains("session-item")) return null;
    return active.dataset.sessionId ?? null;
  }

  private restoreFocus(previousId: string | null): void {
    if (!previousId) return;
    const target = this.listContainer.querySelector<HTMLButtonElement>(
      `.session-item[data-session-id="${CSS.escape(previousId)}"]`,
    );
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  }

  private buildPill(label: string, valueEl: HTMLElement): HTMLElement {
    return h(
      "div",
      { className: "stat-pill" },
      h("span", { className: "stat-pill-label", textContent: label }),
      valueEl,
    );
  }
}

const setIfChanged = (el: HTMLElement, value: string): void => {
  if (el.textContent !== value) el.textContent = value;
};
