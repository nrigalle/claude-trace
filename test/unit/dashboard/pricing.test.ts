import { describe, expect, it } from "vitest";
import { estimateUsageCost } from "../../../src/features/dashboard/domain/pricing";

const u = (input = 0, output = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_5m_input_tokens: cacheWrite5m,
  cache_creation_1h_input_tokens: cacheWrite1h,
});

describe("estimateUsageCost — Opus 4.7", () => {
  it("returns 0 for empty usage", () => {
    expect(estimateUsageCost("claude-opus-4-7", u())).toBe(0);
  });

  it("input at $5 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(1_000_000))).toBeCloseTo(5);
  });

  it("output at $25 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(0, 1_000_000))).toBeCloseTo(25);
  });

  it("cache read at $0.50 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(0, 0, 1_000_000))).toBeCloseTo(0.5);
  });

  it("5-minute cache write at $6.25 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(0, 0, 0, 1_000_000))).toBeCloseTo(6.25);
  });

  it("1-hour cache write at $10 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(0, 0, 0, 0, 1_000_000))).toBeCloseTo(10);
  });

  it("1h cache write costs 1.6× the 5m cache write", () => {
    const fiveM = estimateUsageCost("claude-opus-4-7", u(0, 0, 0, 1_000_000));
    const oneH = estimateUsageCost("claude-opus-4-7", u(0, 0, 0, 0, 1_000_000));
    expect(oneH / fiveM).toBeCloseTo(1.6);
  });
});

describe("estimateUsageCost — Sonnet 4.6", () => {
  it("input at $3 / M tokens", () => {
    expect(estimateUsageCost("claude-sonnet-4-6", u(1_000_000))).toBeCloseTo(3);
  });

  it("5-minute cache write at $3.75 / M tokens", () => {
    expect(estimateUsageCost("claude-sonnet-4-6", u(0, 0, 0, 1_000_000))).toBeCloseTo(3.75);
  });

  it("1-hour cache write at $6 / M tokens", () => {
    expect(estimateUsageCost("claude-sonnet-4-6", u(0, 0, 0, 0, 1_000_000))).toBeCloseTo(6);
  });
});

describe("estimateUsageCost — Haiku 4.5", () => {
  it("input at $1 / M tokens", () => {
    expect(estimateUsageCost("claude-haiku-4-5", u(1_000_000))).toBeCloseTo(1);
  });

  it("5-minute cache write at $1.25 / M tokens", () => {
    expect(estimateUsageCost("claude-haiku-4-5", u(0, 0, 0, 1_000_000))).toBeCloseTo(1.25);
  });

  it("1-hour cache write at $2 / M tokens", () => {
    expect(estimateUsageCost("claude-haiku-4-5", u(0, 0, 0, 0, 1_000_000))).toBeCloseTo(2);
  });
});

describe("estimateUsageCost — legacy / deprecated models", () => {
  it("Opus 4.1 billed at $15 / M input (3× the 4.5+ rate)", () => {
    expect(estimateUsageCost("claude-opus-4-1", u(1_000_000))).toBeCloseTo(15);
  });

  it("Opus 4.1 billed at $75 / M output", () => {
    expect(estimateUsageCost("claude-opus-4-1", u(0, 1_000_000))).toBeCloseTo(75);
  });

  it("Opus 4 (deprecated) billed at the $15 / $75 tier", () => {
    expect(estimateUsageCost("claude-opus-4", u(1_000_000, 1_000_000))).toBeCloseTo(15 + 75);
  });

  it("Sonnet 4 (deprecated) billed at $3 / $15", () => {
    expect(estimateUsageCost("claude-sonnet-4", u(1_000_000, 1_000_000))).toBeCloseTo(3 + 15);
  });

  it("Haiku 3.5 billed at $0.80 / $4 (not the 4.5 rate)", () => {
    expect(estimateUsageCost("claude-haiku-3-5", u(1_000_000))).toBeCloseTo(0.8);
    expect(estimateUsageCost("claude-haiku-3-5", u(0, 1_000_000))).toBeCloseTo(4);
  });
});

describe("estimateUsageCost — model ID resolution", () => {
  it("dated suffix resolves to the same family rate (Opus 4.7)", () => {
    expect(estimateUsageCost("claude-opus-4-7-20260101", u(1_000_000))).toBeCloseTo(5);
  });

  it("dated suffix on Opus 4.1 still uses the $15 tier (not the cheaper Opus fallback)", () => {
    expect(estimateUsageCost("claude-opus-4-1-20250805", u(1_000_000))).toBeCloseTo(15);
  });

  it("dated suffix on Haiku 4.5 uses Haiku 4.5 rates", () => {
    expect(estimateUsageCost("claude-haiku-4-5-20251001", u(1_000_000))).toBeCloseTo(1);
  });

  it("dated suffix on Sonnet 4.5 uses Sonnet 4.5 rates (same as 4.6)", () => {
    expect(estimateUsageCost("claude-sonnet-4-5-20250929", u(1_000_000))).toBeCloseTo(3);
  });

  it("unknown model with 'haiku' in name falls back to Haiku 4.5 rates", () => {
    expect(estimateUsageCost("some-future-haiku-model", u(1_000_000))).toBeCloseTo(1);
  });

  it("completely unknown model falls back to Sonnet rates", () => {
    expect(estimateUsageCost("completely-foreign-model", u(1_000_000))).toBeCloseTo(3);
  });
});

describe("estimateUsageCost — invariants", () => {
  it("monotonic: more tokens never reduces cost", () => {
    const a = estimateUsageCost("claude-opus-4-7", u(500, 500, 500, 500, 500));
    const b = estimateUsageCost("claude-opus-4-7", u(1000, 1000, 1000, 1000, 1000));
    expect(b).toBeGreaterThan(a);
  });

  it("sums all five token types linearly", () => {
    const expected =
      (1000 * 5 + 2000 * 25 + 3000 * 0.5 + 4000 * 6.25 + 5000 * 10) / 1_000_000;
    expect(estimateUsageCost("claude-opus-4-7", u(1000, 2000, 3000, 4000, 5000))).toBeCloseTo(expected);
  });

  it("a real-world 48k 1h-cache turn costs $0.48 on Opus 4.7 (not $0.30 from the 5m rate)", () => {
    const actual = estimateUsageCost("claude-opus-4-7", u(0, 0, 0, 0, 48_111));
    expect(actual).toBeCloseTo(0.48111, 4);
    expect(actual).toBeGreaterThan(48_111 * 6.25 / 1_000_000);
  });
});
