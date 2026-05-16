import type {
  GlobalStats,
  SessionDetail,
  SessionId,
  SessionSummary,
} from "../../../../src/domain/types";
import type { Store } from "../../state/Store.js";
import { DetailHeaderView } from "../panels/DetailHeader.js";
import { FilesTouchedSection } from "../panels/FilesTouchedSection.js";
import { MemorySection } from "../panels/MemorySection.js";
import { SummaryCardsView } from "../panels/SummaryCards.js";
import { ChartsRowView, CostChartView } from "../panels/ChartsRow.js";
import { Timeline } from "../panels/Timeline.js";
import { h } from "../h.js";
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
  onStartNewSession(): void;
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
  private readonly emptyHost: HTMLElement;

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

  constructor(private readonly store: Store, handlers: AppHandlers) {
    this.root = h("div", { className: "app-shell" });
    this.sidebar = new Sidebar(store, {
      onSelect: handlers.onSelect,
      onStartNewSession: handlers.onStartNewSession,
    });
    this.sidebar.mount(this.root);

    this.detailHeader = new DetailHeaderView({
      onRename: () => {
        if (this.currentDetail) handlers.onRename(this.currentDetail.session_id);
      },
      onResume: () => {
        if (this.currentDetail) handlers.onResume(this.currentDetail.session_id);
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
    });

    this.filesSection = new FilesTouchedSection({
      onOpenFile: (filePath) => handlers.onOpenFile(filePath),
      onViewDiff: (filePath) => {
        if (this.currentDetail) handlers.onViewFileDiff(this.currentDetail.session_id, filePath);
      },
    });

    this.timeline = new Timeline(store, () => {
      if (this.currentDetail) this.timeline.update(this.currentDetail);
    });

    this.detailRoot = h(
      "div",
      { className: "detail-root" },
      this.detailHeader.element(),
      this.summaryCards.element(),
      this.chartsRow.element(),
      this.costChart.element(),
      this.memorySection.element(),
      this.filesSection.element(),
      this.timeline.element(),
    );
    this.detailRoot.hidden = true;

    this.emptyHost = h("div", { className: "empty-host" });

    this.mainEl = h(
      "main",
      { className: "main-content", attrs: { "aria-label": "Session detail" } },
      this.emptyHost,
      this.detailRoot,
    );

    this.mainEl.scrollTop = this.store.state.mainScroll;
    this.mainEl.addEventListener("scroll", () => {
      this.store.update({ mainScroll: this.mainEl.scrollTop });
    }, { passive: true });

    this.root.appendChild(this.mainEl);
    this.showEmpty();
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
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
    this.sigs = { ...EMPTY_SIGS };
  }

  private refreshEmptyMessage(): void {
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
