import { describe, expect, it } from "vitest";
import { dayKey, dayStartMs, nonNegativeNumber, sumCostSince } from "../../../src/features/dashboard/domain/budgetMath";
import { toSessionId, type SessionSummary } from "../../../src/features/dashboard/domain/types";

const session = (overrides: Partial<SessionSummary>): SessionSummary => ({
  session_id: toSessionId("s"),
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
  pinned: false,
  searchable_text: "",
  ...overrides,
});

const at = (y: number, m: number, d: number, h = 12): number =>
  new Date(y, m - 1, d, h, 0).getTime();

describe("sumCostSince", () => {
  it("sums total_cost_usd across sessions started on or after sinceMs", () => {
    const today = at(2026, 5, 14);
    const sessions = [
      session({ started_at: today, cost: { total_cost_usd: 1.5 } }),
      session({ started_at: today + 60_000, cost: { total_cost_usd: 0.5 } }),
      session({ started_at: at(2026, 5, 13), cost: { total_cost_usd: 9.9 } }),
    ];
    expect(sumCostSince(sessions, today)).toBeCloseTo(2.0);
  });

  it("falls back to last_modified_ms when started_at is null", () => {
    const today = at(2026, 5, 14);
    const sessions = [
      session({ started_at: null, last_modified_ms: today + 1000, cost: { total_cost_usd: 0.42 } }),
    ];
    expect(sumCostSince(sessions, today)).toBeCloseTo(0.42);
  });

  it("treats missing cost.total_cost_usd as zero (does not crash)", () => {
    const today = at(2026, 5, 14);
    const sessions = [
      session({ started_at: today, cost: null }),
      session({ started_at: today, cost: {} }),
    ];
    expect(sumCostSince(sessions, today)).toBe(0);
  });

  it("excludes sessions with timestamps strictly before sinceMs", () => {
    const today = at(2026, 5, 14);
    const sessions = [
      session({ started_at: today - 1, cost: { total_cost_usd: 5 } }),
    ];
    expect(sumCostSince(sessions, today)).toBe(0);
  });
});

describe("dayStartMs", () => {
  it("returns midnight local time for the given Date", () => {
    const middleOfDay = new Date(2026, 4, 14, 15, 47, 12);
    expect(dayStartMs(middleOfDay)).toBe(new Date(2026, 4, 14, 0, 0, 0).getTime());
  });
});

describe("dayKey", () => {
  it("returns a stable string per calendar day", () => {
    const morning = new Date(2026, 4, 14, 8, 0);
    const evening = new Date(2026, 4, 14, 23, 59);
    expect(dayKey(morning)).toBe(dayKey(evening));
  });

  it("rolls over across midnight", () => {
    const may14Late = new Date(2026, 4, 14, 23, 59);
    const may15Early = new Date(2026, 4, 15, 0, 1);
    expect(dayKey(may14Late)).not.toBe(dayKey(may15Early));
  });
});

describe("nonNegativeNumber", () => {
  it("returns the value when it is a positive finite number", () => {
    expect(nonNegativeNumber(5)).toBe(5);
    expect(nonNegativeNumber(0.01)).toBeCloseTo(0.01);
  });

  it.each([0, -1, NaN, Infinity, -Infinity, "5", null, undefined, {}])(
    "returns 0 for invalid input: %p",
    (input) => {
      expect(nonNegativeNumber(input)).toBe(0);
    },
  );
});
