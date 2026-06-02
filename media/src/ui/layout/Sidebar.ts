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

export interface SidebarHandlers {
  onSelect(id: SessionId): void;
  onTogglePin(id: SessionId): void;
  onCopyConversation(id: SessionId): void;
  onResumeInCockpit(id: SessionId): void;
  onToggleCollapsed(): void;
  onDeleteSessions(ids: readonly SessionId[], permanent?: boolean): void;
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
  private selectMode = false;
  private readonly selectedIds = new Set<string>();
  private readonly itemHandlers: SessionItemHandlers;
  private selectToggle!: HTMLButtonElement;
  private selectRow!: HTMLElement;
  private bulkCount!: HTMLElement;
  private bulkRemoveBtn!: HTMLButtonElement;
  private bulkDeleteBtn!: HTMLButtonElement;

  constructor(
    private readonly store: Store,
    private readonly handlers: SidebarHandlers,
  ) {
    this.itemHandlers = {
      onSelect: (id) => {
        if (this.selectMode) this.toggleSelect(id);
        else this.handlers.onSelect(id);
      },
      onTogglePin: (id) => this.handlers.onTogglePin(id),
      onCopyConversation: (id) => this.handlers.onCopyConversation(id),
      onResumeInCockpit: (id) => this.handlers.onResumeInCockpit(id),
      onDeleteSession: (id) => this.handlers.onDeleteSessions([id], false),
      onToggleSelect: (id) => this.toggleSelect(id),
    };
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
    this.root.appendChild(this.buildSelectBar());

    this.listContainer = h("div", {
      className: "session-list",
      attrs: { role: "list", "aria-label": "Sessions" },
    });
    for (const skel of renderSidebarSkeletons()) this.listContainer.appendChild(skel);
    this.root.appendChild(this.listContainer);

    const resizer = new SidebarResizer({
      target: this.root,
      initialPx: this.store.state.sidebarWidth,
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
    const liveIds = new Set<string>(sessions.map((s) => s.session_id));
    for (const id of [...this.selectedIds]) if (!liveIds.has(id)) this.selectedIds.delete(id);

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
        node = renderSessionItem(s, isActive, this.itemHandlers, {
          selected: this.selectMode && this.selectedIds.has(s.session_id),
        });
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
    this.renderBulkBar();
    this.restoreFocus(previousFocusedId);
  }

  private buildSelectBar(): HTMLElement {
    this.selectToggle = h("button", {
      className: "sidebar-select-btn",
      attrs: { type: "button", title: "Select multiple sessions to remove from the dashboard" },
      textContent: "Select",
      on: { click: () => this.toggleSelectMode() },
    });
    this.bulkCount = h("span", { className: "sidebar-bulk-count" });
    this.bulkRemoveBtn = h("button", {
      className: "sidebar-bulk-remove",
      attrs: { type: "button", title: "Hide the selected sessions from the dashboard (reversible; transcripts kept)" },
      textContent: "Remove",
      on: { click: () => this.removeSelected() },
    });
    this.bulkDeleteBtn = h("button", {
      className: "sidebar-bulk-delete",
      attrs: { type: "button", title: "Delete the selected transcripts from disk (moves to Trash, also removes them from Claude Code)" },
      textContent: "Delete files",
      on: { click: () => this.deleteFilesSelected() },
    });
    const buttons = h(
      "div",
      { className: "sidebar-bulk-buttons" },
      this.selectToggle,
      this.bulkDeleteBtn,
      this.bulkRemoveBtn,
    );
    this.selectRow = h("div", { className: "sidebar-selectrow" }, this.bulkCount, buttons);
    return this.selectRow;
  }

  private toggleSelectMode(): void {
    this.selectMode = !this.selectMode;
    this.listContainer.classList.toggle("select-mode", this.selectMode);
    this.selectToggle.textContent = this.selectMode ? "Done" : "Select";
    this.selectToggle.classList.toggle("active", this.selectMode);
    if (!this.selectMode) this.clearSelectionDom();
    this.renderBulkBar();
  }

  private toggleSelect(id: string): void {
    const has = this.selectedIds.has(id);
    if (has) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
    const node = this.listContainer.querySelector(`.session-item[data-session-id="${CSS.escape(id)}"]`);
    if (node) {
      node.classList.toggle("selected", !has);
      const check = node.querySelector(".session-item-check");
      check?.classList.toggle("checked", !has);
      check?.setAttribute("aria-pressed", String(!has));
    }
    this.renderBulkBar();
  }

  private removeSelected(): void {
    const ids = [...this.selectedIds] as SessionId[];
    if (ids.length === 0) return;
    this.handlers.onDeleteSessions(ids, false);
    this.selectMode = false;
    this.listContainer.classList.remove("select-mode");
    this.selectToggle.textContent = "Select";
    this.selectToggle.classList.remove("active");
    this.clearSelectionDom();
    this.renderBulkBar();
  }

  private deleteFilesSelected(): void {
    const ids = [...this.selectedIds] as SessionId[];
    if (ids.length === 0) return;
    this.handlers.onDeleteSessions(ids, true);
  }

  private clearSelectionDom(): void {
    this.selectedIds.clear();
    this.listContainer.querySelectorAll(".session-item.selected").forEach((n) => n.classList.remove("selected"));
    this.listContainer.querySelectorAll(".session-item-check.checked").forEach((n) => {
      n.classList.remove("checked");
      n.setAttribute("aria-pressed", "false");
    });
  }

  private renderBulkBar(): void {
    this.selectRow.classList.toggle("select-active", this.selectMode);
    if (!this.selectMode) return;
    const count = this.selectedIds.size;
    this.bulkCount.textContent = count === 0 ? "Tap sessions to select" : `${count} selected`;
    this.bulkRemoveBtn.textContent = count > 0 ? `Remove ${count}` : "Remove";
    this.bulkRemoveBtn.disabled = count === 0;
    this.bulkDeleteBtn.textContent = count > 0 ? `Delete ${count}` : "Delete files";
    this.bulkDeleteBtn.disabled = count === 0;
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
      const title = session.title?.trim() || `Session ${session.session_id.slice(0, 8)}`;
      const searchHit = !q || title.toLowerCase().includes(q);
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
