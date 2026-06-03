import type { SessionId } from "../../../src/features/dashboard/domain/types";
import { clampSidebarWidth, SIDEBAR_DEFAULT_PX } from "../ui/layout/sidebarWidth.js";

export type TimelineFilter = "all" | "tools" | "errors" | "conversation";
export type DateFilter = "all" | "today" | "week" | "month" | "favorites";
export type ActiveTab = "sessions" | "pipelines" | "library";

export type DetailBlockId = "cards" | "charts" | "cost" | "files" | "memory" | "timeline";

export interface DetailBlock {
  readonly id: DetailBlockId;
  readonly label: string;
}

export const DETAIL_BLOCKS: readonly DetailBlock[] = [
  { id: "cards", label: "Summary cards" },
  { id: "charts", label: "Context & tool usage" },
  { id: "cost", label: "Cost over time" },
  { id: "files", label: "Files touched" },
  { id: "memory", label: "Memory edits" },
  { id: "timeline", label: "Activity timeline" },
];

export interface DetailBlockConfig {
  readonly id: DetailBlockId;
  readonly visible: boolean;
  readonly span: 1 | 2;
}

export interface UiState {
  selectedId: SessionId | null;
  activeTab: ActiveTab;
  searchQuery: string;
  dateFilter: DateFilter;
  folderFilter: string | null;
  timelineFilter: TimelineFilter;
  toolFilter: string | null;
  expandedEvent: number | null;
  mainScroll: number;
  timelineScroll: number;
  filesTouchedCollapsed: boolean;
  memoryEditsCollapsed: boolean;
  timelineCollapsed: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  detailLayout: readonly DetailBlockConfig[];
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}

declare const acquireVsCodeApi: () => VsCodeApi;

const DEFAULTS: UiState = {
  selectedId: null,
  activeTab: "sessions",
  searchQuery: "",
  dateFilter: "all",
  folderFilter: null,
  timelineFilter: "all",
  toolFilter: null,
  expandedEvent: null,
  mainScroll: 0,
  timelineScroll: 0,
  filesTouchedCollapsed: false,
  memoryEditsCollapsed: false,
  timelineCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_PX,
  sidebarCollapsed: false,
  detailLayout: DETAIL_BLOCKS.map((b) => ({ id: b.id, visible: true, span: 2 as const })),
};

const KNOWN_BLOCKS: ReadonlySet<string> = new Set(DETAIL_BLOCKS.map((b) => b.id));

export const normalizeDetailLayout = (value: unknown): DetailBlockConfig[] => {
  const result: DetailBlockConfig[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === null || typeof item !== "object") continue;
      const id = (item as Record<string, unknown>)["id"];
      if (typeof id !== "string" || !KNOWN_BLOCKS.has(id) || seen.has(id)) continue;
      seen.add(id);
      const rec = item as Record<string, unknown>;
      result.push({ id: id as DetailBlockId, visible: rec["visible"] !== false, span: rec["span"] === 1 ? 1 : 2 });
    }
  }
  for (const b of DETAIL_BLOCKS) {
    if (!seen.has(b.id)) result.push({ id: b.id, visible: true, span: 2 });
  }
  return result;
};

const normalizeFilter = (value: unknown): TimelineFilter =>
  value === "tools" || value === "errors" || value === "conversation" ? value : "all";

const normalizeDateFilter = (value: unknown): DateFilter =>
  value === "today" || value === "week" || value === "month" || value === "favorites" ? value : "all";

const normalizeToolFilter = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const normalizeBool = (value: unknown): boolean => value === true;

const normalizeActiveTab = (value: unknown): ActiveTab =>
  value === "pipelines" || value === "library" ? value : "sessions";

export class Store {
  readonly vscode: VsCodeApi;
  private current: UiState;
  private persistTimer: number | null = null;

  constructor() {
    this.vscode = acquireVsCodeApi();
    const saved = this.vscode.getState() as Partial<UiState> | undefined;
    this.current = {
      ...DEFAULTS,
      ...(saved ?? {}),
      timelineFilter: normalizeFilter(saved?.timelineFilter),
      dateFilter: normalizeDateFilter(saved?.dateFilter),
      activeTab: normalizeActiveTab(saved?.activeTab),
      folderFilter: typeof saved?.folderFilter === "string" ? saved.folderFilter : null,
      toolFilter: normalizeToolFilter(saved?.toolFilter),
      filesTouchedCollapsed: normalizeBool(saved?.filesTouchedCollapsed),
      memoryEditsCollapsed: normalizeBool(saved?.memoryEditsCollapsed),
      timelineCollapsed: normalizeBool(saved?.timelineCollapsed),
      sidebarWidth: clampSidebarWidth(saved?.sidebarWidth),
      sidebarCollapsed: normalizeBool(saved?.sidebarCollapsed),
      detailLayout: normalizeDetailLayout(saved?.detailLayout),
    };
  }

  get state(): Readonly<UiState> {
    return this.current;
  }

  update(patch: Partial<UiState>): void {
    this.current = { ...this.current, ...patch };
    this.schedulePersist();
  }

  flush(): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.vscode.setState(this.current);
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.vscode.setState(this.current);
    }, 100);
  }
}
