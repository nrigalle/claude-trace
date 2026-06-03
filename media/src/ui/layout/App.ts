import type {
  GlobalStats,
  SessionDetail,
  SessionId,
  SessionSummary,
} from "../../../../src/features/dashboard/domain/types";
import type { Store } from "../../state/Store.js";
import { DETAIL_BLOCKS, normalizeDetailLayout, type DetailBlockConfig, type DetailBlockId } from "../../state/Store.js";
import type { DetailLayoutEntry } from "../../../../src/features/dashboard/protocol";
import { conversationTurns } from "../../../../src/features/dashboard/domain/chatExport";
import { DetailHeaderView } from "../panels/DetailHeader.js";
import { FilesTouchedSection } from "../panels/FilesTouchedSection.js";
import { MemorySection } from "../panels/MemorySection.js";
import { SummaryCardsView } from "../panels/SummaryCards.js";
import { ChartsRowView, CostChartView } from "../panels/ChartsRow.js";
import { Timeline } from "../panels/Timeline.js";
import { h } from "../h.js";
import { ICONS, icon } from "../icons.js";
import { renderEmptyState } from "./Empty.js";
import { renderMainSkeleton } from "./Loading.js";
import { Sidebar } from "./Sidebar.js";

export interface AppHandlers {
  onSelect(id: SessionId): void;
  onRename(id: SessionId): void;
  onResume(id: SessionId): void;
  onOpenMemoryFile(filePath: string): void;
  onOpenMemoryFolder(id: SessionId): void;
  onOpenFile(filePath: string): void;
  onViewFileDiff(id: SessionId, filePath: string): void;
  onExportChat(id: SessionId): void;
  onCopyConversation(id: SessionId): void;
  onResumeInCockpit(id: SessionId): void;
  onTogglePin(id: SessionId): void;
  onDeleteSessions(ids: readonly SessionId[]): void;
  onBackToHome(): void;
  onSaveDetailLayout(layout: readonly DetailBlockConfig[]): void;
}

export interface HomeView {
  element(): HTMLElement;
  fitActive(): void;
}

interface SectionSignatures {
  header: string;
  cards: string;
  charts: string;
  cost: string;
  memory: string;
  files: string;
  timeline: string;
}

const EMPTY_SIGS: SectionSignatures = {
  header: "",
  cards: "",
  charts: "",
  cost: "",
  memory: "",
  files: "",
  timeline: "",
};

export class App {
  readonly root: HTMLElement;
  private readonly sidebar: Sidebar;
  private readonly mainEl: HTMLElement;
  private readonly detailRoot: HTMLElement;
  private readonly detailGrid: HTMLElement;
  private readonly emptyHost: HTMLElement;
  private readonly expandSidebarBtn: HTMLButtonElement;

  private readonly detailHeader: DetailHeaderView;
  private readonly summaryCards = new SummaryCardsView();
  private readonly chartsRow = new ChartsRowView();
  private readonly costChart = new CostChartView();
  private readonly memorySection: MemorySection;
  private readonly filesSection: FilesTouchedSection;
  private readonly timeline: Timeline;

  private sigs: SectionSignatures = { ...EMPTY_SIGS };
  private sessions: readonly SessionSummary[] = [];
  private currentDetail: SessionDetail | null = null;
  private mode: "empty" | "detail" = "empty";
  private hasLoaded = false;
  private renderedEmptyKey: "skeleton" | "no-sessions" | "select-session" | null = null;
  private readonly home: HomeView | null;
  private readonly homeRoot: HTMLElement | null;
  private detailBlocks!: Record<DetailBlockId, HTMLElement>;
  private customizeOpen = false;
  private customizePanel: HTMLElement | null = null;
  private chatPanel: HTMLElement | null = null;
  private czDragFrom: number | null = null;
  private readonly onSaveDetailLayout: (layout: readonly DetailBlockConfig[]) => void;

  constructor(private readonly store: Store, handlers: AppHandlers, home?: HomeView) {
    this.home = home ?? null;
    this.homeRoot = home ? home.element() : null;
    this.onSaveDetailLayout = handlers.onSaveDetailLayout;
    this.root = h("div", { className: "app-shell" });
    this.sidebar = new Sidebar(store, {
      onSelect: handlers.onSelect,
      onTogglePin: handlers.onTogglePin,
      onCopyConversation: handlers.onCopyConversation,
      onResumeInCockpit: handlers.onResumeInCockpit,
      onToggleCollapsed: () => this.setSidebarCollapsed(!this.store.state.sidebarCollapsed),
      onDeleteSessions: handlers.onDeleteSessions,
    });
    this.sidebar.mount(this.root);

    this.expandSidebarBtn = h(
      "button",
      {
        className: "sidebar-expand-btn",
        attrs: { type: "button", "aria-label": "Show sidebar", title: "Show sidebar" },
        on: { click: () => this.setSidebarCollapsed(false) },
      },
      icon("chevron-right", 14),
    );
    this.root.appendChild(this.expandSidebarBtn);

    this.detailHeader = new DetailHeaderView({
      onRename: () => {
        if (this.currentDetail) handlers.onRename(this.currentDetail.session_id);
      },
      onResume: () => {
        if (this.currentDetail) handlers.onResume(this.currentDetail.session_id);
      },
      onExportChat: () => {
        if (this.currentDetail) handlers.onExportChat(this.currentDetail.session_id);
      },
      onViewChat: () => {
        if (this.currentDetail) this.showConversation(this.currentDetail);
      },
    });

    this.memorySection = new MemorySection({
      onOpenFile: (filePath) => handlers.onOpenMemoryFile(filePath),
      onOpenFolder: () => {
        if (this.currentDetail) handlers.onOpenMemoryFolder(this.currentDetail.session_id);
      },
      onViewDiff: (filePath) => {
        if (this.currentDetail) handlers.onViewFileDiff(this.currentDetail.session_id, filePath);
      },
      isCollapsed: () => this.store.state.memoryEditsCollapsed,
      onToggleCollapsed: () => {
        this.store.update({ memoryEditsCollapsed: !this.store.state.memoryEditsCollapsed });
        if (this.currentDetail) this.memorySection.update(this.currentDetail);
      },
    });

    this.filesSection = new FilesTouchedSection({
      onOpenFile: (filePath) => handlers.onOpenFile(filePath),
      onViewDiff: (filePath) => {
        if (this.currentDetail) handlers.onViewFileDiff(this.currentDetail.session_id, filePath);
      },
      isCollapsed: () => this.store.state.filesTouchedCollapsed,
      onToggleCollapsed: () => {
        this.store.update({ filesTouchedCollapsed: !this.store.state.filesTouchedCollapsed });
        if (this.currentDetail) this.filesSection.update(this.currentDetail);
      },
    });

    this.timeline = new Timeline(store, () => {
      if (this.currentDetail) this.timeline.update(this.currentDetail);
    });

    const backBtn = this.home
      ? h("button", {
          className: "detail-back-btn",
          attrs: { type: "button", "aria-label": "Back to terminals" },
          textContent: "← Terminals",
          on: { click: () => handlers.onBackToHome() },
        })
      : null;
    const customizeBtn = h(
      "button",
      {
        className: "detail-customize-btn",
        attrs: { type: "button", "aria-label": "Customize dashboard" },
        on: { click: () => this.toggleCustomize() },
      },
      icon("sliders", 13),
      h("span", { textContent: "Customize" }),
    );
    const toolbar = h("div", { className: "detail-toolbar" }, backBtn, h("div", { className: "detail-toolbar-spacer" }), customizeBtn);

    this.detailBlocks = {
      cards: this.summaryCards.element(),
      charts: this.chartsRow.element(),
      cost: this.costChart.element(),
      files: this.filesSection.element(),
      memory: this.memorySection.element(),
      timeline: this.timeline.element(),
    };

    this.detailGrid = h(
      "div",
      { className: "detail-grid" },
      this.detailBlocks.cards,
      this.detailBlocks.charts,
      this.detailBlocks.cost,
      this.detailBlocks.memory,
      this.detailBlocks.files,
      this.detailBlocks.timeline,
    );
    this.detailRoot = h(
      "div",
      { className: "detail-root" },
      toolbar,
      this.detailHeader.element(),
      this.detailGrid,
    );
    this.detailRoot.hidden = true;
    this.applyDetailLayout();

    this.emptyHost = h("div", { className: "empty-host" });

    this.mainEl = h(
      "main",
      { className: "main-content", attrs: { "aria-label": "Session detail" } },
      this.emptyHost,
      this.detailRoot,
    );
    if (this.homeRoot) {
      this.homeRoot.hidden = true;
      this.mainEl.appendChild(this.homeRoot);
    }

    this.mainEl.scrollTop = this.store.state.mainScroll;
    this.mainEl.addEventListener("scroll", () => {
      this.store.update({ mainScroll: this.mainEl.scrollTop });
    }, { passive: true });

    this.root.appendChild(this.mainEl);
    this.applySidebarCollapsed();
    this.showEmpty();
  }

  private applyDetailLayout(): void {
    for (const cfg of this.store.state.detailLayout) {
      const el = this.detailBlocks[cfg.id];
      el.classList.toggle("ct-block-hidden", !cfg.visible);
      el.classList.toggle("ct-block-half", cfg.span === 1);
      el.style.gridColumn = cfg.span === 1 ? "span 1" : "1 / -1";
      this.detailGrid.appendChild(el);
    }
  }

  applyHostDetailLayout(layout: readonly DetailLayoutEntry[]): void {
    if (layout.length === 0) return;
    this.store.update({ detailLayout: normalizeDetailLayout(layout) });
    this.applyDetailLayout();
    if (this.customizeOpen) this.renderCustomizePanel();
  }

  private toggleCustomize(): void {
    this.customizeOpen = !this.customizeOpen;
    this.renderCustomizePanel();
  }

  private renderCustomizePanel(): void {
    this.customizePanel?.remove();
    this.customizePanel = null;
    if (!this.customizeOpen) return;

    const labelOf = (id: DetailBlockId): string =>
      DETAIL_BLOCKS.find((b) => b.id === id)?.label ?? id;
    const layout = [...this.store.state.detailLayout];
    const commit = (next: readonly DetailBlockConfig[]): void => {
      this.store.update({ detailLayout: next });
      this.onSaveDetailLayout(next);
      this.applyDetailLayout();
      this.renderCustomizePanel();
    };

    const rows = layout.map((cfg, index) => {
      const toggle = h("button", {
        className: `ct-cz-switch${cfg.visible ? " on" : ""}`,
        attrs: { type: "button", role: "switch", "aria-checked": String(cfg.visible) },
        on: {
          click: () =>
            commit(layout.map((c) => (c.id === cfg.id ? { ...c, visible: !c.visible } : c))),
        },
      });
      const width = h("button", {
        className: "ct-cz-width",
        attrs: { type: "button", title: cfg.span === 1 ? "Half width. Click for full" : "Full width. Click for half" },
        textContent: cfg.span === 1 ? "½" : "▭",
        on: {
          click: () =>
            commit(layout.map((c) => (c.id === cfg.id ? { ...c, span: c.span === 1 ? 2 : 1 } : c))),
        },
      });
      const row = h(
        "div",
        { className: "ct-cz-row", attrs: { draggable: "true" }, dataset: { index: String(index) } },
        h("span", { className: "ct-cz-grip", innerHTML: ICONS.grip }),
        h("span", { className: "ct-cz-label", textContent: labelOf(cfg.id) }),
        width,
        toggle,
      );
      row.addEventListener("dragstart", (e) => {
        this.czDragFrom = index;
        row.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => {
        if (this.czDragFrom === null || this.czDragFrom === index) return;
        e.preventDefault();
      });
      row.addEventListener("drop", (e) => {
        if (this.czDragFrom === null || this.czDragFrom === index) return;
        e.preventDefault();
        const next = [...layout];
        const [moved] = next.splice(this.czDragFrom, 1);
        if (moved) next.splice(index, 0, moved);
        this.czDragFrom = null;
        commit(next);
      });
      return row;
    });

    const panel = h(
      "div",
      { className: "ct-cz-backdrop", on: { click: (e: Event) => { if (e.target === panel) this.toggleCustomize(); } } },
      h(
        "div",
        { className: "ct-cz-sheet" },
        h(
          "div",
          { className: "ct-cz-head" },
          h("span", { className: "ct-cz-title", textContent: "Customize dashboard" }),
          h("button", {
            className: "ct-cz-done",
            attrs: { type: "button" },
            textContent: "Done",
            on: { click: () => this.toggleCustomize() },
          }),
        ),
        h("div", { className: "ct-cz-hint", textContent: "Toggle sections on or off and drag to reorder. Applies to every session." }),
        h("div", { className: "ct-cz-list" }, ...rows),
      ),
    );
    this.customizePanel = panel;
    this.root.appendChild(panel);
  }

  private showConversation(detail: SessionDetail): void {
    this.chatPanel?.remove();
    const turns = conversationTurns(detail);
    const title = detail.title?.trim() || `Session ${detail.session_id.slice(0, 8)}`;

    const close = (): void => {
      document.removeEventListener("keydown", onKey);
      this.chatPanel?.remove();
      this.chatPanel = null;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };

    const renderTurn = (t: { role: string; text: string }): HTMLElement => {
      const copyBtn = h("button", {
        className: "ct-chat-copy",
        attrs: { type: "button", title: "Copy this message to the clipboard" },
        textContent: "Copy",
        on: {
          click: async () => {
            try {
              await navigator.clipboard.writeText(t.text);
              copyBtn.textContent = "Copied";
              copyBtn.classList.add("copied");
              window.setTimeout(() => {
                copyBtn.textContent = "Copy";
                copyBtn.classList.remove("copied");
              }, 1400);
            } catch {
              copyBtn.textContent = "Failed";
              window.setTimeout(() => { copyBtn.textContent = "Copy"; }, 1400);
            }
          },
        },
      });
      return h(
        "div",
        { className: `ct-chat-turn ${t.role}` },
        h("div", { className: "ct-chat-turn-head" },
          h("div", { className: "ct-chat-role", textContent: t.role === "you" ? "You" : "Claude" }),
          copyBtn,
        ),
        h("div", { className: "ct-chat-text", textContent: t.text }),
      );
    };
    const messages =
      turns.length === 0
        ? [h("div", { className: "ct-chat-empty", textContent: "No conversation has been captured for this session yet." })]
        : turns.map(renderTurn);

    const panel = h(
      "div",
      { className: "ct-chat-backdrop", on: { click: (e: Event) => { if (e.target === panel) close(); } } },
      h(
        "div",
        { className: "ct-chat-sheet" },
        h(
          "div",
          { className: "ct-chat-head" },
          h("span", { className: "ct-chat-title", textContent: title }),
          h("span", { className: "ct-chat-count", textContent: `${turns.length} message${turns.length === 1 ? "" : "s"}` }),
          h("button", {
            className: "ct-chat-done",
            attrs: { type: "button", "aria-label": "Close conversation" },
            innerHTML: ICONS.close,
            on: { click: close },
          }),
        ),
        h("div", { className: "ct-chat-scroll" }, ...messages),
      ),
    );
    this.chatPanel = panel;
    this.root.appendChild(panel);
    document.addEventListener("keydown", onKey);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  private setSidebarCollapsed(collapsed: boolean): void {
    if (this.store.state.sidebarCollapsed === collapsed) return;
    this.store.update({ sidebarCollapsed: collapsed });
    this.applySidebarCollapsed();
  }

  private applySidebarCollapsed(): void {
    const collapsed = this.store.state.sidebarCollapsed;
    this.root.classList.toggle("sidebar-collapsed", collapsed);
  }

  updateSessions(
    sessions: readonly SessionSummary[],
    stats: GlobalStats | null,
    changedIds: ReadonlySet<SessionId>,
  ): void {
    this.sessions = sessions;
    this.hasLoaded = true;
    this.sidebar.updateStats(stats);
    this.sidebar.updateSessions(sessions, changedIds);
    if (this.mode === "empty") this.refreshEmptyMessage();
  }

  updateDetail(detail: SessionDetail | null): void {
    this.currentDetail = detail;
    if (!detail) {
      this.showEmpty();
      return;
    }
    this.showDetail(detail);
  }

  noSelection(): void {
    this.currentDetail = null;
    this.showEmpty();
  }

  private showEmpty(): void {
    if (this.mode !== "empty") this.renderedEmptyKey = null;
    this.mode = "empty";
    this.detailRoot.hidden = true;
    this.refreshEmptyMessage();
    if (this.home && this.homeRoot && this.hasLoaded && !this.homeRoot.hidden) {
      requestAnimationFrame(() => this.home?.fitActive());
    }
    this.sigs = { ...EMPTY_SIGS };
  }

  private refreshEmptyMessage(): void {
    if (this.home && this.homeRoot && this.hasLoaded) {
      this.emptyHost.hidden = true;
      this.mainEl.classList.remove("empty", "loading");
      this.homeRoot.hidden = false;
      this.renderedEmptyKey = null;
      return;
    }
    const key: "skeleton" | "no-sessions" | "select-session" = !this.hasLoaded
      ? "skeleton"
      : this.sessions.length === 0
        ? "no-sessions"
        : "select-session";
    if (this.renderedEmptyKey === key) return;
    this.renderedEmptyKey = key;

    while (this.emptyHost.firstChild) this.emptyHost.removeChild(this.emptyHost.firstChild);
    this.emptyHost.hidden = false;
    if (key === "skeleton") {
      this.mainEl.classList.add("loading");
      this.mainEl.classList.remove("empty");
      this.emptyHost.appendChild(renderMainSkeleton());
    } else {
      this.mainEl.classList.add("empty");
      this.mainEl.classList.remove("loading");
      this.emptyHost.appendChild(renderEmptyState(key === "select-session"));
    }
  }

  private showDetail(d: SessionDetail): void {
    if (this.mode !== "detail") {
      this.mode = "detail";
      this.emptyHost.hidden = true;
      if (this.homeRoot) this.homeRoot.hidden = true;
      this.detailRoot.hidden = false;
      this.mainEl.classList.remove("empty");
      this.mainEl.classList.remove("loading");
    }

    const next = computeSignatures(d);

    if (next.header !== this.sigs.header) {
      this.detailHeader.update(d);
      this.sigs.header = next.header;
    }
    if (next.cards !== this.sigs.cards) {
      this.summaryCards.update(d);
      this.sigs.cards = next.cards;
    }
    if (next.charts !== this.sigs.charts) {
      this.chartsRow.update(d);
      this.sigs.charts = next.charts;
    }
    if (next.cost !== this.sigs.cost) {
      this.costChart.update(d);
      this.sigs.cost = next.cost;
    }
    if (next.memory !== this.sigs.memory) {
      this.memorySection.update(d);
      this.sigs.memory = next.memory;
    }
    if (next.files !== this.sigs.files) {
      this.filesSection.update(d);
      this.sigs.files = next.files;
    }
    if (next.timeline !== this.sigs.timeline) {
      this.timeline.update(d);
      this.sigs.timeline = next.timeline;
    }
  }
}

const computeSignatures = (d: SessionDetail): SectionSignatures => {
  const cards = [
    d.duration_ms,
    d.tool_count,
    d.cost?.total_cost_usd ?? 0,
    d.context_window?.used_percentage ?? 0,
    d.context_window?.total_input_tokens ?? 0,
    d.context_window?.total_output_tokens ?? 0,
    d.cost?.total_lines_added ?? 0,
    d.cost?.total_lines_removed ?? 0,
  ].join("|");

  const charts = `${d.context_timeline.length}|${d.tool_stats.length}|${d.tool_stats.map((t) => `${t.name}:${t.count}`).join(",")}`;

  const lastCost = d.cost_timeline[d.cost_timeline.length - 1]?.value ?? 0;
  const cost = `${d.cost_timeline.length}|${lastCost}`;

  const lastTs = d.events[d.events.length - 1]?.ts ?? 0;
  const timeline = `${d.events.length}|${lastTs}`;

  const fileEditSignature = (edits: readonly typeof d.memory_edits[number][]): string =>
    `${edits.length}|${edits.map((e) => `${e.filePath}:${e.count}:${e.added}:${e.removed}`).join(",")}`;

  const memory = fileEditSignature(d.memory_edits);
  const files = fileEditSignature(d.files_touched);

  return {
    header: JSON.stringify([d.title, d.cwd, d.session_id, d.model?.display_name ?? null]),
    cards,
    charts,
    cost,
    memory,
    files,
    timeline,
  };
};
