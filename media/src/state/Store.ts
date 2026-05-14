import type { SessionId } from "../../../src/domain/types";

export interface UiState {
  selectedId: SessionId | null;
  searchQuery: string;
  timelineFilter: "all" | "tools" | "lifecycle" | "errors";
  expandedEvent: number | null;
  mainScroll: number;
  timelineScroll: number;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}

declare const acquireVsCodeApi: <_S = unknown>() => VsCodeApi;

const DEFAULTS: UiState = {
  selectedId: null,
  searchQuery: "",
  timelineFilter: "all",
  expandedEvent: null,
  mainScroll: 0,
  timelineScroll: 0,
};

export class Store {
  readonly vscode: VsCodeApi;
  private current: UiState;
  private persistTimer: number | null = null;
  private readonly listeners = new Set<(s: UiState) => void>();

  constructor() {
    this.vscode = acquireVsCodeApi();
    const saved = this.vscode.getState() as Partial<UiState> | undefined;
    this.current = { ...DEFAULTS, ...(saved ?? {}) };
  }

  get state(): Readonly<UiState> {
    return this.current;
  }

  update(patch: Partial<UiState>): void {
    this.current = { ...this.current, ...patch };
    this.schedulePersist();
    this.notify();
  }

  subscribe(listener: (s: UiState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.vscode.setState(this.current);
    }, 100);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(this.current); } catch { }
    }
  }
}
