import type {
  GlobalStats,
  SessionId,
  SessionSummary,
} from "../../../../src/features/dashboard/domain/types";
import type { DateFilter, Store } from "../../state/Store.js";
import {
  DATE_FILTER_LABELS,
  DATE_FILTER_ORDER,
  matchesDateFilter,
} from "../dateFilter.js";
import { setIfChanged } from "../dom.js";
import { fmtCost } from "../format.js";
import { h } from "../h.js";
import { ICONS, icon } from "../icons.js";
import { renderSidebarSkeletons } from "./Loading.js";
import { renderSessionItem, type SessionItemHandlers } from "./SessionItem.js";
import { SidebarResizer } from "./SidebarResizer.js";

export interface SidebarHandlers extends SessionItemHandlers {
  onToggleCollapsed(): void;
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
  private byIdCache: Map<string, SessionSummary> | null = null;
  private byIdCacheFor: readonly SessionSummary[] | null = null;
  private hasLoaded = false;

  constructor(
    private readonly store: Store,
    private readonly handlers: SidebarHandlers,
  ) {
    this.root = h("nav", {
      className: "sidebar",
      attrs: { "aria-label": "Claude Code sessions" },
    });

    const collapseBtn = h(
      "button",
      {
        className: "sidebar-collapse-btn",
        attrs: { type: "button", "aria-label": "Collapse sidebar", title: "Collapse sidebar" },
        on: { click: () => this.handlers.onToggleCollapsed() },
      },
      icon("chevron-left", 14),
    );

    const brand = h(
      "div",
      { className: "brand" },
      h("div", { className: "brand-icon", innerHTML: ICONS.zap }),
      h("span", { className: "brand-title", textContent: "Claude Trace" }),
      collapseBtn,
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

    const resizer = new SidebarResizer({
      target: this.root,
      initialPx: this.store.state.sidebarWidth,
      onLivePx: () => {},
      onCommitPx: (px) => this.store.update({ sidebarWidth: px }),
    });
    this.root.appendChild(resizer.element);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  updateStats(stats: GlobalStats | null): void {
    if (stats === null) return;
    if (stats.total_sessions === 0) {
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
    this.byIdCache = null;
    this.byIdCacheFor = null;

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
    const onlyFavorites = dateFilter === "favorites";
    const byId = this.sessionsById();
    const now = new Date();
    this.listContainer.querySelectorAll<HTMLButtonElement>(".session-item").forEach((el) => {
      const id = el.dataset.sessionId;
      const session = id ? byId.get(id) : undefined;
      if (!session) {
        el.style.display = "none";
        return;
      }
      if (onlyFavorites && !session.pinned) {
        el.style.display = "none";
        return;
      }
      if (!onlyFavorites) {
        const lastActivity = session.ended_at ?? session.last_modified_ms;
        if (!matchesDateFilter(lastActivity, dateFilter, now)) {
          el.style.display = "none";
          return;
        }
      }
      const searchHit =
        !q ||
        session.session_id.toLowerCase().includes(q) ||
        (session.cwd?.toLowerCase().includes(q) ?? false) ||
        (session.title?.toLowerCase().includes(q) ?? false) ||
        session.searchable_text.toLowerCase().includes(q);
      el.style.display = searchHit ? "" : "none";
    });
  }

  private sessionsById(): Map<string, SessionSummary> {
    if (this.byIdCache && this.byIdCacheFor === this.sessions) return this.byIdCache;
    const map = new Map<string, SessionSummary>();
    for (const s of this.sessions) map.set(s.session_id, s);
    this.byIdCache = map;
    this.byIdCacheFor = this.sessions;
    return map;
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

