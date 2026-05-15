import { describe, expect, it } from "vitest";
import {
  baselineContextSize,
  effectiveContextSize,
  percentOfContext,
} from "../../src/domain/contextWindow";
import { toSessionId, type TraceEvent } from "../../src/domain/types";

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

describe("baselineContextSize", () => {
  it("returns 200K for unknown or null models", () => {
    expect(baselineContextSize(null)).toBe(200_000);
    expect(baselineContextSize(undefined)).toBe(200_000);
    expect(baselineContextSize("")).toBe(200_000);
    expect(baselineContextSize("some-other-model")).toBe(200_000);
  });

  it("returns 1M for Claude Opus 4.7 by default", () => {
    expect(baselineContextSize("claude-opus-4-7")).toBe(1_000_000);
    expect(baselineContextSize("claude-opus-4-7-20260415")).toBe(1_000_000);
  });

  it("returns 200K for Opus 4.6 by default", () => {
    expect(baselineContextSize("claude-opus-4-6")).toBe(200_000);
  });

  it("returns 1M for any model carrying the [1m] flag", () => {
    expect(baselineContextSize("claude-opus-4-6[1m]")).toBe(1_000_000);
    expect(baselineContextSize("claude-sonnet-4-6-1m")).toBe(1_000_000);
  });

  it("returns 200K for Sonnet and Haiku by default", () => {
    expect(baselineContextSize("claude-sonnet-4-6")).toBe(200_000);
    expect(baselineContextSize("claude-haiku-4-5")).toBe(200_000);
  });
});

describe("effectiveContextSize", () => {
  it("returns 200K for an empty event list", () => {
    expect(effectiveContextSize([])).toBe(200_000);
  });

  it("uses model baseline when no event has tokens", () => {
    const evs = [makeEvent({ model: { id: "claude-opus-4-7", display_name: "Opus" } })];
    expect(effectiveContextSize(evs)).toBe(1_000_000);
  });

  it("upgrades to 1M when observed tokens exceed any 200K baseline", () => {
    const evs = [
      makeEvent({ model: { id: "claude-sonnet-4-6" }, context_window: { total_input_tokens: 250_000 } }),
    ];
    expect(effectiveContextSize(evs)).toBe(1_000_000);
  });

  it("stays at 200K when observed tokens never cross the threshold", () => {
    const evs = [
      makeEvent({ model: { id: "claude-sonnet-4-6" }, context_window: { total_input_tokens: 50_000 } }),
      makeEvent({ model: { id: "claude-sonnet-4-6" }, context_window: { total_input_tokens: 80_000 } }),
    ];
    expect(effectiveContextSize(evs)).toBe(200_000);
  });

  it("picks the largest baseline across mixed-model events", () => {
    const evs = [
      makeEvent({ model: { id: "claude-sonnet-4-6" } }),
      makeEvent({ model: { id: "claude-opus-4-7" } }),
    ];
    expect(effectiveContextSize(evs)).toBe(1_000_000);
  });
});

describe("percentOfContext", () => {
  it("returns 0 for zero or negative context size", () => {
    expect(percentOfContext(100, 0)).toBe(0);
    expect(percentOfContext(100, -1)).toBe(0);
  });

  it("computes a percentage relative to the context size", () => {
    expect(percentOfContext(100_000, 1_000_000)).toBeCloseTo(10);
    expect(percentOfContext(50_000, 200_000)).toBeCloseTo(25);
  });

  it("caps at 100 when tokens exceed the context size", () => {
    expect(percentOfContext(2_000_000, 1_000_000)).toBe(100);
  });
});

describe("session-wide consistency", () => {
  it("a monotonic token sequence yields a monotonic percent sequence under one denominator", () => {
    const tokens = [10_000, 50_000, 100_000, 250_000, 500_000];
    const evs = tokens.map((t) =>
      makeEvent({ model: { id: "claude-opus-4-7" }, context_window: { total_input_tokens: t } }),
    );
    const size = effectiveContextSize(evs);
    const percents = tokens.map((t) => percentOfContext(t, size));
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]!);
    }
  });
});
