import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardController, type DashboardActions } from "../../../src/features/dashboard/app/DashboardController";
import type { SessionService } from "../../../src/features/dashboard/app/SessionService";
import type { HostToWebview, WebviewToHost } from "../../../src/features/dashboard/protocol";
import { toSessionId } from "../../../src/features/dashboard/domain/types";
import type { SessionSummary } from "../../../src/features/dashboard/domain/types";
import type { WatcherChange, WatcherListener } from "../../../src/features/dashboard/infra/SessionDirectoryWatcher";

const summary = (id: string, mtime: number): SessionSummary =>
  ({
    session_id: toSessionId(id),
    title: id,
    last_modified_ms: mtime,
    ended_at: null,
  }) as unknown as SessionSummary;

interface FakeWorld {
  posted: HostToWebview[];
  emit: (c: WatcherChange) => void;
  receive: (msg: WebviewToHost) => void;
  setSessions: (s: SessionSummary[]) => void;
  listCalls: (ReadonlySet<string> | undefined)[];
  detailCalls: string[];
  controller: DashboardController;
}

const build = (initial: SessionSummary[]): FakeWorld => {
  const posted: HostToWebview[] = [];
  let sessions = initial;
  const listCalls: (ReadonlySet<string> | undefined)[] = [];
  const detailCalls: string[] = [];
  let watcherCb: WatcherListener = () => {};
  let messageCb: (msg: unknown) => void = () => {};

  const host = {
    visible: true,
    postMessage: (m: unknown) => posted.push(m as HostToWebview),
    onMessage: (cb: (msg: unknown) => void) => {
      messageCb = cb;
      return { dispose: () => {} };
    },
    onViewStateChange: () => ({ dispose: () => {} }),
    onDispose: () => ({ dispose: () => {} }),
  };
  const service = {
    list: (hint?: ReadonlySet<string>) => {
      listCalls.push(hint ? new Set(hint) : undefined);
      return sessions;
    },
    prepareInitialScan: () =>
      [...sessions]
        .sort((a, b) => b.last_modified_ms - a.last_modified_ms)
        .map((s) => ({ ref: { sessionId: s.session_id, projectDirName: "p", filePath: "f" }, stats: { mtime: s.last_modified_ms, size: 0 } })),
    summarizeOne: (ref: { sessionId: string }) => sessions.find((s) => s.session_id === ref.sessionId)!,
    invalidate: () => {},
    stats: () => ({}),
    detail: (id: string) => {
      detailCalls.push(id);
      return { session_id: id, events: [] };
    },
  };
  const actions: DashboardActions = {
    renameSession: async () => {},
    resumeSession: async () => {},
    openMemoryFile: () => {},
    openMemoryFolder: () => {},
    openFile: () => {},
    viewFileDiff: async () => {},
    exportChatMarkdown: async () => {},
    copyConversation: () => {},
    togglePin: async () => {},
    deleteSessionFiles: async () => {},
    setActiveSession: () => {},
    invalidateSession: () => {},
    loadDetailLayout: () => [],
    saveDetailLayout: () => {},
  };
  const controller = new DashboardController(
    host as never,
    service as unknown as SessionService,
    { onChange: (cb: WatcherListener) => { watcherCb = cb; return { dispose: () => {} }; } } as never,
    actions,
  );
  return {
    posted,
    emit: (c) => watcherCb(c),
    receive: (msg) => messageCb(msg),
    setSessions: (s) => { sessions = s; },
    listCalls,
    detailCalls,
    controller,
  };
};

const flushDelay = 400;

describe("DashboardController — delta updates keep the per-tick payload tiny while sessions stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the full session list once on startup", () => {
    const w = build([summary("a", 1), summary("b", 2)]);
    const updates = w.posted.filter((m) => m.type === "update");
    expect(updates).toHaveLength(1);
    expect((updates[0] as { sessions: unknown[] }).sessions).toHaveLength(2);
    w.controller.dispose();
  });

  it("streams a large history in batches instead of one blocking scan (regression: first open froze the IDE ~3s)", () => {
    const many = Array.from({ length: 70 }, (_, i) => summary(`s${i}`, i + 1));
    const w = build(many);
    const firstUpdate = w.posted.filter((m) => m.type === "update");
    expect(firstUpdate, "exactly one authoritative update").toHaveLength(1);
    expect((firstUpdate[0] as { sessions: unknown[] }).sessions.length, "first paint is a small recent batch, not all 70").toBeLessThanOrEqual(25);
    expect(w.posted.some((m) => m.type === "updateDelta"), "the rest is deferred until timers run").toBe(false);

    vi.advanceTimersByTime(1000);
    const deltas = w.posted.filter((m) => m.type === "updateDelta");
    expect(deltas.length, "remaining sessions arrive as background delta batches").toBeGreaterThanOrEqual(2);
    const delivered = new Set<string>();
    for (const m of w.posted) {
      if (m.type === "update") for (const s of (m as { sessions: { session_id: string }[] }).sessions) delivered.add(s.session_id);
      if (m.type === "updateDelta") for (const s of (m as { changed: { session_id: string }[] }).changed) delivered.add(s.session_id);
    }
    expect(delivered.size, "every session is eventually delivered").toBe(70);
    w.controller.dispose();
  });

  it("never loses a watcher change that arrives while the initial scan is still running", () => {
    const many = Array.from({ length: 70 }, (_, i) => summary(`s${i}`, i + 1));
    const w = build(many);
    w.setSessions([summary("s0", 999), ...many.slice(1)]);
    w.emit({ kind: "changed", sessionId: toSessionId("s0"), projectDirName: "p" });
    vi.advanceTimersByTime(3000);
    let lastS0: number | undefined;
    for (const m of w.posted) {
      const arr =
        m.type === "update"
          ? (m as { sessions: { session_id: string; last_modified_ms: number }[] }).sessions
          : m.type === "updateDelta"
            ? (m as { changed: { session_id: string; last_modified_ms: number }[] }).changed
            : [];
      for (const s of arr) if (s.session_id === toSessionId("s0")) lastS0 = s.last_modified_ms;
    }
    expect(lastS0, "the updated s0 summary must reach the webview").toBe(999);
    w.controller.dispose();
  });

  it("a changed session produces an updateDelta carrying only that summary, not all sessions", () => {
    const w = build([summary("a", 1), summary("b", 2)]);
    w.posted.length = 0;
    w.setSessions([summary("a", 9), summary("b", 2)]);
    w.emit({ kind: "changed", sessionId: toSessionId("a"), projectDirName: "p" });
    vi.advanceTimersByTime(flushDelay);

    expect(w.posted.filter((m) => m.type === "update")).toHaveLength(0);
    const deltas = w.posted.filter((m) => m.type === "updateDelta");
    expect(deltas).toHaveLength(1);
    const delta = deltas[0] as { changed: SessionSummary[] };
    expect(delta.changed.map((s) => s.session_id)).toEqual([toSessionId("a")]);
    expect(w.listCalls[w.listCalls.length - 1]).toEqual(new Set([toSessionId("a")]));
    w.controller.dispose();
  });

  it("added or removed sessions fall back to a full update so the webview list stays authoritative", () => {
    const w = build([summary("a", 1)]);
    w.posted.length = 0;
    w.setSessions([summary("a", 1), summary("c", 5)]);
    w.emit({ kind: "added", sessionId: toSessionId("c"), projectDirName: "p" });
    vi.advanceTimersByTime(flushDelay);

    expect(w.posted.filter((m) => m.type === "updateDelta")).toHaveLength(0);
    expect(w.posted.filter((m) => m.type === "update")).toHaveLength(1);
    expect(w.listCalls[w.listCalls.length - 1]).toBeUndefined();
    w.controller.dispose();
  });

  it("stops flushing entirely while the sessions view is off-screen (cockpit fullscreen or another tab), then catches up once on return", () => {
    const w = build([summary("a", 1)]);
    w.posted.length = 0;
    w.receive({ type: "sessionsViewVisible", visible: false });

    for (let tick = 1; tick <= 5; tick++) {
      w.setSessions([summary("a", 1 + tick)]);
      w.emit({ kind: "changed", sessionId: toSessionId("a"), projectDirName: "p" });
      vi.advanceTimersByTime(2000);
    }
    expect(w.posted, "no update of any kind may be sent while the view is hidden").toHaveLength(0);

    w.receive({ type: "sessionsViewVisible", visible: true });
    expect(w.posted.length, "pending changes flush once when the view returns").toBeGreaterThanOrEqual(1);
    w.controller.dispose();
  });

  it("throttles detail re-sends to one per 2s while the active session streams (each send serializes the full event list)", () => {
    const w = build([summary("a", 1)]);
    w.receive({ type: "selectSession", sessionId: toSessionId("a") });
    expect(w.detailCalls).toHaveLength(1);

    for (let tick = 1; tick <= 6; tick++) {
      w.setSessions([summary("a", 1 + tick)]);
      w.emit({ kind: "changed", sessionId: toSessionId("a"), projectDirName: "p" });
      vi.advanceTimersByTime(500);
    }

    expect(w.detailCalls.length, "3s of streaming after a fresh select must yield at most 2 throttled re-sends").toBeLessThanOrEqual(3);
    expect(w.detailCalls.length, "the trailing timer must still deliver the latest detail").toBeGreaterThanOrEqual(2);
    w.controller.dispose();
  });
});
