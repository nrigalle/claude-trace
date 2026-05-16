import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GlobalStats, SessionSummary, SessionId } from "../../../src/domain/types";
import { toSessionId } from "../../../src/domain/types";
import type { WebviewToHost } from "../../../src/protocol";

interface MockApi {
  postMessage(m: WebviewToHost): void;
  setState(state: unknown): void;
  getState(): unknown;
}

const installVsCodeStub = (): void => {
  const api: MockApi = {
    postMessage() {},
    setState() {},
    getState() { return undefined; },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => MockApi }).acquireVsCodeApi = () => api;
};

const cleanupVsCodeStub = (): void => {
  delete (globalThis as unknown as { acquireVsCodeApi?: () => MockApi }).acquireVsCodeApi;
};

const loadModules = async (): Promise<{
  Sidebar: typeof import("../../../media/src/ui/layout/Sidebar").Sidebar;
  Store: typeof import("../../../media/src/state/Store").Store;
}> => {
  const stamp = Date.now();
  const storeMod = await import(`../../../media/src/state/Store?ts=${stamp}`);
  const sidebarMod = await import(`../../../media/src/ui/layout/Sidebar?ts=${stamp}`);
  return { Store: storeMod.Store, Sidebar: sidebarMod.Sidebar };
};

const summary = (id: string): SessionSummary => ({
  session_id: toSessionId(id),
  title: id,
  event_count: 0,
  tool_count: 0,
  tools: [],
  duration_ms: 0,
  started_at: null,
  ended_at: null,
  cwd: null,
  cost: null,
  context_window: null,
  model: null,
  last_modified_ms: 0,
});

const noopHandlers = {
  onSelect: (_: SessionId) => {},
  onStartNewSession: () => {},
};

const stats = (total: number, tools: number, cost: number): GlobalStats => ({
  total_sessions: total,
  total_tool_calls: tools,
  total_duration_ms: 0,
  total_cost_usd: cost,
});

describe("Sidebar — skeleton transition", () => {
  beforeEach(() => installVsCodeStub());
  afterEach(() => cleanupVsCodeStub());

  it("renders skeleton placeholders before any update arrives", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);
    expect(host.querySelectorAll(".session-item-skeleton").length).toBeGreaterThan(0);
    expect(host.querySelector(".session-item")).toBeNull();
  });

  it("removes skeletons on the first updateSessions and inserts real items", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateSessions([summary("a"), summary("b")], new Set());

    expect(host.querySelectorAll(".session-item-skeleton")).toHaveLength(0);
    expect(host.querySelectorAll(".session-item")).toHaveLength(2);
  });

  it("removes skeletons and falls back to the empty-list hint when the first update has no sessions", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateSessions([], new Set());

    expect(host.querySelectorAll(".session-item-skeleton")).toHaveLength(0);
    expect(host.querySelector(".empty-list-hint")).not.toBeNull();
  });

  it("does not re-introduce skeletons on subsequent updates", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateSessions([summary("a")], new Set());
    sidebar.updateSessions([summary("a"), summary("b")], new Set());

    expect(host.querySelectorAll(".session-item-skeleton")).toHaveLength(0);
    expect(host.querySelectorAll(".session-item")).toHaveLength(2);
  });

  it("reuses the same stat value spans across multiple updates (no flicker)", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateStats(stats(3, 12, 0.5));
    const before = host.querySelectorAll(".stat-pill-value");
    expect(before).toHaveLength(3);
    expect(before[0]!.textContent).toBe("3");

    sidebar.updateStats(stats(4, 18, 0.91));
    const after = host.querySelectorAll(".stat-pill-value");
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(after[0]!.textContent).toBe("4");
    expect(after[1]!.textContent).toBe("18");
  });

  it("hides stats when total_sessions is zero, without removing the value spans", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateStats(stats(2, 5, 0.1));
    const before = host.querySelectorAll(".stat-pill-value");
    sidebar.updateStats(stats(0, 0, 0));
    const container = host.querySelector(".global-stats") as HTMLElement;
    expect(container.style.display).toBe("none");
    sidebar.updateStats(stats(1, 1, 0.05));
    const after = host.querySelectorAll(".stat-pill-value");
    expect(after[0]).toBe(before[0]);
  });

  it("preserves DOM identity for an unchanged session across the skeleton-to-real transition and a re-update", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateSessions([summary("a")], new Set());
    const before = host.querySelector(".session-item");
    sidebar.updateSessions([summary("a")], new Set());
    const after = host.querySelector(".session-item");
    expect(after).toBe(before);
  });
});
