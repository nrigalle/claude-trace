import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  pinned: false,
  searchable_text: "",
});

const noopHandlers = {
  onSelect: (_: SessionId) => {},
  onTogglePin: (_: SessionId) => {},
  onStartNewSession: () => {},
  onToggleCollapsed: () => {},
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

describe("Sidebar — pin behaviour", () => {
  beforeEach(() => installVsCodeStub());
  afterEach(() => cleanupVsCodeStub());

  const pinned = (id: string): SessionSummary => ({ ...summary(id), pinned: true });

  it("keeps pinned sessions visible in the default (all) filter", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateSessions([pinned("a"), summary("b")], new Set());

    const items = host.querySelectorAll<HTMLElement>(".session-item");
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.style.display).not.toBe("none");
  });

  it("shows only pinned sessions when the Favorites filter is active", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    store.update({ dateFilter: "favorites" });
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateSessions([pinned("a"), summary("b")], new Set());

    const items = host.querySelectorAll<HTMLElement>(".session-item");
    const visibleIds = [...items]
      .filter((el) => el.style.display !== "none")
      .map((el) => el.dataset["sessionId"]);
    expect(visibleIds).toEqual(["a"]);
  });

  it("rebuilds a pinned row so the star fills after a changed event", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    sidebar.updateSessions([summary("a")], new Set());
    let star = host.querySelector(".session-item-pin");
    expect(star?.textContent).toBe("☆");
    expect(star?.classList.contains("pinned")).toBe(false);

    sidebar.updateSessions([pinned("a")], new Set([toSessionId("a")]));
    star = host.querySelector(".session-item-pin");
    expect(star?.textContent).toBe("★");
    expect(star?.classList.contains("pinned")).toBe(true);
    const item = host.querySelector<HTMLElement>(".session-item");
    expect(item?.style.display).not.toBe("none");
  });

  it("ignores date cutoffs when Favorites is active, so old pinned sessions still show", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    store.update({ dateFilter: "favorites" });
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const ancient: SessionSummary = { ...pinned("old"), last_modified_ms: 0, ended_at: 0 };
    sidebar.updateSessions([ancient], new Set());
    const item = host.querySelector<HTMLElement>(".session-item");
    expect(item?.style.display).not.toBe("none");
  });
});

describe("Sidebar — collapse button", () => {
  beforeEach(() => installVsCodeStub());
  afterEach(() => cleanupVsCodeStub());

  it("renders a chevron-left collapse button with an accessible label", async () => {
    const { Store, Sidebar } = await loadModules();
    const sidebar = new Sidebar(new Store(), noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);
    const btn = host.querySelector<HTMLButtonElement>(".sidebar-collapse-btn");
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("Collapse sidebar");
  });

  it("clicking the collapse button calls handlers.onToggleCollapsed exactly once", async () => {
    const { Store, Sidebar } = await loadModules();
    const onToggleCollapsed = vi.fn();
    const sidebar = new Sidebar(new Store(), { ...noopHandlers, onToggleCollapsed });
    const host = document.createElement("div");
    sidebar.mount(host);
    host.querySelector<HTMLButtonElement>(".sidebar-collapse-btn")!.click();
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("the collapse button does NOT trigger any session-selection callback", async () => {
    const { Store, Sidebar } = await loadModules();
    const onSelect = vi.fn();
    const sidebar = new Sidebar(new Store(), { ...noopHandlers, onSelect });
    const host = document.createElement("div");
    sidebar.mount(host);
    sidebar.updateSessions([summary("a")], new Set());
    host.querySelector<HTMLButtonElement>(".sidebar-collapse-btn")!.click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("Sidebar — realistic filter stress (100 sessions, mixed pinned and dates)", () => {
  beforeEach(() => installVsCodeStub());
  afterEach(() => cleanupVsCodeStub());

  const DAY = 24 * 60 * 60 * 1000;
  const mkSession = (i: number): SessionSummary => {
    const daysAgo = i % 60;
    const ts = Date.now() - daysAgo * DAY;
    const pinned = i % 7 === 0;
    return {
      ...summary(`s-${i}`),
      title: i % 3 === 0 ? `feature ${i}` : `bug ${i}`,
      last_modified_ms: ts,
      ended_at: ts,
      pinned,
      searchable_text: i % 5 === 0 ? "auth middleware refactor" : "nothing special",
    };
  };

  const isVisible = (host: HTMLElement, id: string): boolean => {
    const el = host.querySelector<HTMLElement>(`.session-item[data-session-id="${id}"]`);
    return el !== null && el.style.display !== "none";
  };

  const countVisible = (host: HTMLElement): number =>
    [...host.querySelectorAll<HTMLElement>(".session-item")].filter((el) => el.style.display !== "none").length;

  it("renders all 100 sessions in 'All' regardless of date or pinned state", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const sessions = Array.from({ length: 100 }, (_, i) => mkSession(i));
    sidebar.updateSessions(sessions, new Set());

    expect(host.querySelectorAll(".session-item")).toHaveLength(100);
    expect(countVisible(host)).toBe(100);
  });

  it("'Favorites' shows ONLY the pinned subset, regardless of how old they are", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const sessions = Array.from({ length: 100 }, (_, i) => mkSession(i));
    const expectedPinned = sessions.filter((s) => s.pinned).length;
    expect(expectedPinned).toBeGreaterThan(10);

    store.update({ dateFilter: "favorites" });
    sidebar.updateSessions(sessions, new Set());
    expect(countVisible(host)).toBe(expectedPinned);

    const visibleIds = [...host.querySelectorAll<HTMLElement>(".session-item")]
      .filter((el) => el.style.display !== "none")
      .map((el) => el.dataset["sessionId"]!);
    for (const id of visibleIds) {
      const s = sessions.find((x) => x.session_id === id)!;
      expect(s.pinned).toBe(true);
    }
  });

  it("date filters narrow correctly: Today ⊆ Week ⊆ Month ⊆ All", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const sessions = Array.from({ length: 100 }, (_, i) => mkSession(i));
    sidebar.updateSessions(sessions, new Set());

    const visibleFor = (filter: "all" | "today" | "week" | "month") => {
      store.update({ dateFilter: filter });
      sidebar.updateSessions(sessions, new Set());
      return countVisible(host);
    };

    const today = visibleFor("today");
    const week = visibleFor("week");
    const month = visibleFor("month");
    const all = visibleFor("all");

    expect(today).toBeLessThanOrEqual(week);
    expect(week).toBeLessThanOrEqual(month);
    expect(month).toBeLessThanOrEqual(all);
    expect(all).toBe(100);
  });

  it("search 'auth' surfaces every seeded match across pinned and unpinned alike", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const sessions = Array.from({ length: 100 }, (_, i) => mkSession(i));
    sidebar.updateSessions(sessions, new Set());

    const input = host.querySelector<HTMLInputElement>(".search-input")!;
    input.value = "auth";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const visibleIds = [...host.querySelectorAll<HTMLElement>(".session-item")]
      .filter((el) => el.style.display !== "none")
      .map((el) => el.dataset["sessionId"]!);

    const expectedMatches = sessions.filter((s) => s.searchable_text.includes("auth"));
    expect(visibleIds).toHaveLength(expectedMatches.length);
    for (const s of expectedMatches) expect(visibleIds).toContain(s.session_id);
  });

  it("a pinned-today session is visible in EVERY filter (today, week, month, all, favorites)", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const pinnedRecent: SessionSummary = {
      ...summary("pinned-recent"),
      pinned: true,
      last_modified_ms: Date.now(),
      ended_at: Date.now(),
    };
    sidebar.updateSessions([pinnedRecent], new Set());

    for (const filter of ["all", "today", "week", "month", "favorites"] as const) {
      store.update({ dateFilter: filter });
      sidebar.updateSessions([pinnedRecent], new Set([toSessionId("pinned-recent")]));
      expect(isVisible(host, "pinned-recent")).toBe(true);
    }
  });

  it("an unpinned ancient session shows in 'All' but disappears from Today/Week/Month/Favorites", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const ancient: SessionSummary = {
      ...summary("ancient"),
      pinned: false,
      last_modified_ms: 0,
      ended_at: 0,
    };
    sidebar.updateSessions([ancient], new Set());

    const cases: Array<["all" | "today" | "week" | "month" | "favorites", boolean]> = [
      ["all", true],
      ["today", false],
      ["week", false],
      ["month", false],
      ["favorites", false],
    ];
    for (const [filter, shouldShow] of cases) {
      store.update({ dateFilter: filter });
      sidebar.updateSessions([ancient], new Set([toSessionId("ancient")]));
      expect(isVisible(host, "ancient")).toBe(shouldShow);
    }
  });
});

describe("Sidebar — date filter × pinned interaction (user spec)", () => {
  beforeEach(() => installVsCodeStub());
  afterEach(() => cleanupVsCodeStub());

  const isVisible = (host: HTMLElement, id: string): boolean => {
    const el = host.querySelector<HTMLElement>(`.session-item[data-session-id="${id}"]`);
    return el !== null && el.style.display !== "none";
  };

  const sessionAt = (id: string, daysAgo: number, isPinned: boolean): SessionSummary => {
    const ts = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
    return { ...summary(id), last_modified_ms: ts, ended_at: ts, pinned: isPinned };
  };

  it("a pinned session from a month ago is visible in All, Last 30 days, and Favorites", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const aMonthAgo = sessionAt("old-pinned", 28, true);
    sidebar.updateSessions([aMonthAgo], new Set());

    store.update({ dateFilter: "all" });
    sidebar.updateSessions([aMonthAgo], new Set([toSessionId("old-pinned")]));
    expect(isVisible(host, "old-pinned")).toBe(true);

    store.update({ dateFilter: "month" });
    sidebar.updateSessions([aMonthAgo], new Set([toSessionId("old-pinned")]));
    expect(isVisible(host, "old-pinned")).toBe(true);

    store.update({ dateFilter: "favorites" });
    sidebar.updateSessions([aMonthAgo], new Set([toSessionId("old-pinned")]));
    expect(isVisible(host, "old-pinned")).toBe(true);
  });

  it("a pinned session from a month ago is HIDDEN in Today and Last 7 days", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const aMonthAgo = sessionAt("old-pinned", 28, true);
    sidebar.updateSessions([aMonthAgo], new Set());

    store.update({ dateFilter: "today" });
    sidebar.updateSessions([aMonthAgo], new Set([toSessionId("old-pinned")]));
    expect(isVisible(host, "old-pinned")).toBe(false);

    store.update({ dateFilter: "week" });
    sidebar.updateSessions([aMonthAgo], new Set([toSessionId("old-pinned")]));
    expect(isVisible(host, "old-pinned")).toBe(false);
  });

  it("an unpinned session never shows in Favorites regardless of how recent it is", async () => {
    const { Store, Sidebar } = await loadModules();
    const store = new Store();
    store.update({ dateFilter: "favorites" });
    const sidebar = new Sidebar(store, noopHandlers);
    const host = document.createElement("div");
    sidebar.mount(host);

    const justNow = sessionAt("fresh-but-not-pinned", 0, false);
    sidebar.updateSessions([justNow], new Set());
    expect(isVisible(host, "fresh-but-not-pinned")).toBe(false);
  });
});
