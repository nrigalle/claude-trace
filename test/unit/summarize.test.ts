import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { summarize } from "../../src/domain/summarize";
import { extractContextTimeline, extractCostTimeline } from "../../src/domain/timelines";
import { computeStats } from "../../src/domain/stats";
import { computeToolStats } from "../../src/domain/toolStats";
import { toSessionId, type SessionSummary, type TraceEvent } from "../../src/domain/types";

const makeEvent = (overrides: Partial<TraceEvent>): TraceEvent => ({
  ts: 0,
  event: "PostToolUse",
  session_id: toSessionId("s"),
  cwd: null,
  tool_name: null,
  tool_input: null,
  tool_result: null,
  stop_reason: null,
  model: null,
  cost: null,
  context_window: null,
  tokens_freed: null,
  error: null,
  ...overrides,
});

const baseSummary = (overrides: Partial<SessionSummary>): SessionSummary => ({
  session_id: toSessionId("x"),
  title: null,
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
  ...overrides,
});

describe("summarize", () => {
  it("empty event list yields zeroed summary, preserving meta.title and last_modified_ms", () => {
    const s = summarize(toSessionId("s"), [], 5000, { title: "Hello" });
    expect(s.event_count).toBe(0);
    expect(s.tool_count).toBe(0);
    expect(s.duration_ms).toBe(0);
    expect(s.title).toBe("Hello");
    expect(s.last_modified_ms).toBe(5000);
  });

  it("duration is last.ts minus first.ts", () => {
    const evs = [makeEvent({ ts: 100 }), makeEvent({ ts: 500 }), makeEvent({ ts: 1500 })];
    expect(summarize(toSessionId("s"), evs, 0).duration_ms).toBe(1400);
  });

  it("event_count is total events, tool_count counts only PostToolUse with tool_name", () => {
    const evs = [
      makeEvent({ event: "PostToolUse", tool_name: "Bash" }),
      makeEvent({ event: "PostToolUse", tool_name: null }),
      makeEvent({ event: "Metrics" }),
      makeEvent({ event: "PostToolUse", tool_name: "Read" }),
    ];
    const s = summarize(toSessionId("s"), evs, 0);
    expect(s.event_count).toBe(4);
    expect(s.tool_count).toBe(2);
  });

  it("tools is a unique set of names from PostToolUse events", () => {
    const evs = [
      makeEvent({ event: "PostToolUse", tool_name: "Bash" }),
      makeEvent({ event: "PostToolUse", tool_name: "Bash" }),
      makeEvent({ event: "PostToolUse", tool_name: "Read" }),
    ];
    expect(new Set(summarize(toSessionId("s"), evs, 0).tools)).toEqual(new Set(["Bash", "Read"]));
  });

  it("cwd is taken from the first event that has one", () => {
    const evs = [
      makeEvent({ ts: 1 }),
      makeEvent({ ts: 2, cwd: "/first" }),
      makeEvent({ ts: 3, cwd: "/second" }),
    ];
    expect(summarize(toSessionId("s"), evs, 0).cwd).toBe("/first");
  });

  it("cost/context/model: most recent non-null wins", () => {
    const evs = [
      makeEvent({ ts: 1, cost: { total_cost_usd: 0.1 }, context_window: { used_percentage: 10 }, model: { id: "a" } }),
      makeEvent({ ts: 2, cost: { total_cost_usd: 0.5 } }),
      makeEvent({ ts: 3, context_window: { used_percentage: 30 } }),
      makeEvent({ ts: 4, model: { id: "b" } }),
    ];
    const s = summarize(toSessionId("s"), evs, 0);
    expect(s.cost?.total_cost_usd).toBe(0.5);
    expect(s.context_window?.used_percentage).toBe(30);
    expect(s.model?.id).toBe("b");
  });

  it("duration_ms equals last.ts - first.ts for arbitrary event sequences", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 500 }),
        (tsArr) => {
          const evs = tsArr.map((ts) => makeEvent({ ts }));
          const s = summarize(toSessionId("s"), evs, 0);
          const first = tsArr[0]!;
          const last = tsArr[tsArr.length - 1]!;
          expect(s.duration_ms).toBe(last - first);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("computeToolStats", () => {
  it("returns empty for no events", () => {
    expect(computeToolStats([])).toEqual([]);
  });

  it("sorts descending by count", () => {
    const evs = [
      makeEvent({ event: "PostToolUse", tool_name: "Read" }),
      makeEvent({ event: "PostToolUse", tool_name: "Bash" }),
      makeEvent({ event: "PostToolUse", tool_name: "Bash" }),
      makeEvent({ event: "PostToolUse", tool_name: "Edit" }),
      makeEvent({ event: "PostToolUse", tool_name: "Edit" }),
      makeEvent({ event: "PostToolUse", tool_name: "Edit" }),
    ];
    expect(computeToolStats(evs)).toEqual([
      { name: "Edit", count: 3 },
      { name: "Bash", count: 2 },
      { name: "Read", count: 1 },
    ]);
  });

  it("ignores non-PostToolUse events", () => {
    const evs = [
      makeEvent({ event: "Metrics", tool_name: "Bash" }),
      makeEvent({ event: "PostToolUse", tool_name: null }),
      makeEvent({ event: "PostToolUse", tool_name: "Bash" }),
    ];
    expect(computeToolStats(evs)).toEqual([{ name: "Bash", count: 1 }]);
  });
});

describe("extractContextTimeline / extractCostTimeline", () => {
  it("filters events without the relevant snapshot", () => {
    const evs = [
      makeEvent({ ts: 1 }),
      makeEvent({ ts: 2, context_window: { used_percentage: 10 } }),
      makeEvent({ ts: 3, cost: { total_cost_usd: 0.5 } }),
    ];
    expect(extractContextTimeline(evs)).toEqual([{ ts: 2, value: 10 }]);
    expect(extractCostTimeline(evs)).toEqual([{ ts: 3, value: 0.5 }]);
  });

  it("preserves event order", () => {
    const evs = [
      makeEvent({ ts: 3, context_window: { used_percentage: 50 } }),
      makeEvent({ ts: 1, context_window: { used_percentage: 10 } }),
      makeEvent({ ts: 2, context_window: { used_percentage: 20 } }),
    ];
    expect(extractContextTimeline(evs).map((p) => p.value)).toEqual([50, 10, 20]);
  });
});

describe("computeStats", () => {
  it("returns zeros for empty input", () => {
    expect(computeStats([])).toEqual({
      total_sessions: 0,
      total_tool_calls: 0,
      total_duration_ms: 0,
      total_cost_usd: 0,
    });
  });

  it("aggregates linearly across sessions", () => {
    const stats = computeStats([
      baseSummary({ session_id: toSessionId("a"), tool_count: 5, duration_ms: 1000, cost: { total_cost_usd: 0.5 } }),
      baseSummary({ session_id: toSessionId("b"), tool_count: 3, duration_ms: 2000, cost: { total_cost_usd: 0.25 } }),
    ]);
    expect(stats.total_sessions).toBe(2);
    expect(stats.total_tool_calls).toBe(8);
    expect(stats.total_duration_ms).toBe(3000);
    expect(stats.total_cost_usd).toBeCloseTo(0.75);
  });

  it("ignores cost when total_cost_usd missing", () => {
    const stats = computeStats([baseSummary({ cost: {} })]);
    expect(stats.total_cost_usd).toBe(0);
  });
});
