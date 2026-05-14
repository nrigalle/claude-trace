import type {
  GlobalStats,
  SessionId,
  SessionSummary,
} from "../../../../src/domain/types";
import type { Store } from "../../state/Store.js";
import { fmtCost } from "../format.js";
import { h } from "../h.js";
import { ICONS } from "../icons.js";
import { renderSessionItem, type SessionItemHandlers } from "./SessionItem.js";

export class Sidebar {
  private readonly root: HTMLElement;
  private readonly statsContainer: HTMLElement;
  private readonly listContainer: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private sessions: readonly SessionSummary[] = [];

  constructor(
    private readonly store: Store,
    private readonly handlers: SessionItemHandlers,
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

    this.listContainer = h("div", {
      className: "session-list",
      attrs: { role: "list", "aria-label": "Sessions" },
    });
    this.root.appendChild(this.listContainer);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  updateStats(stats: GlobalStats | null): void {
    while (this.statsContainer.firstChild) this.statsContainer.removeChild(this.statsContainer.firstChild);
    if (!stats || stats.total_sessions === 0) {
      this.statsContainer.style.display = "none";
      return;
    }
    this.statsContainer.style.display = "";
    this.statsContainer.appendChild(this.pill("Sessions", String(stats.total_sessions)));
    this.statsContainer.appendChild(this.pill("Tools", String(stats.total_tool_calls)));
    this.statsContainer.appendChild(this.pill("Cost", fmtCost(stats.total_cost_usd)));
  }

  updateSessions(sessions: readonly SessionSummary[], changedIds: ReadonlySet<SessionId>): void {
    const previousFocusedId = this.capturedActiveSessionId();
    this.sessions = sessions;

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
    this.listContainer.querySelectorAll<HTMLButtonElement>(".session-item").forEach((el) => {
      const id = el.dataset.sessionId;
      const session = this.sessions.find((s) => s.session_id === id);
      if (!session) {
        el.style.display = "none";
        return;
      }
      const match =
        !q ||
        session.session_id.toLowerCase().includes(q) ||
        (session.cwd?.toLowerCase().includes(q) ?? false);
      el.style.display = match ? "" : "none";
    });
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

  private pill(label: string, value: string): HTMLElement {
    return h(
      "div",
      { className: "stat-pill" },
      h("span", { className: "stat-pill-label", textContent: label }),
      h("span", { className: "stat-pill-value", textContent: value }),
    );
  }
}
