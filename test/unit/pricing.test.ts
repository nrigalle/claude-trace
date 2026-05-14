import { describe, expect, it } from "vitest";
import { estimateUsageCost } from "../../src/domain/pricing";

const u = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

describe("estimateUsageCost", () => {
  it("returns 0 for empty usage", () => {
    expect(estimateUsageCost("claude-opus-4-7", u())).toBe(0);
  });

  it("Opus 4.7 input at $5 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(1_000_000))).toBeCloseTo(5);
  });

  it("Opus 4.7 output at $25 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(0, 1_000_000))).toBeCloseTo(25);
  });

  it("Opus 4.7 cache read at $0.50 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(0, 0, 1_000_000))).toBeCloseTo(0.5);
  });

  it("Opus 4.7 cache write at $6.25 / M tokens", () => {
    expect(estimateUsageCost("claude-opus-4-7", u(0, 0, 0, 1_000_000))).toBeCloseTo(6.25);
  });

  it("Sonnet 4.6 input at $3 / M tokens", () => {
    expect(estimateUsageCost("claude-sonnet-4-6", u(1_000_000))).toBeCloseTo(3);
  });

  it("Haiku 4.5 input at $1 / M tokens", () => {
    expect(estimateUsageCost("claude-haiku-4-5", u(1_000_000))).toBeCloseTo(1);
  });

  it("matches model by substring when exact key missing", () => {
    expect(estimateUsageCost("claude-opus-4-7-20260101", u(1_000_000))).toBeCloseTo(5);
    expect(estimateUsageCost("anthropic.claude-sonnet-4-7", u(1_000_000))).toBeCloseTo(3);
    expect(estimateUsageCost("haiku-of-some-kind", u(1_000_000))).toBeCloseTo(1);
  });

  it("monotonic: more tokens never reduces cost", () => {
    const a = estimateUsageCost("claude-opus-4-7", u(500, 500, 500, 500));
    const b = estimateUsageCost("claude-opus-4-7", u(1000, 1000, 1000, 1000));
    expect(b).toBeGreaterThan(a);
  });

  it("sums all four token types linearly", () => {
    const expected =
      (1000 * 5 + 2000 * 25 + 3000 * 0.5 + 4000 * 6.25) / 1_000_000;
    expect(estimateUsageCost("claude-opus-4-7", u(1000, 2000, 3000, 4000))).toBeCloseTo(expected);
  });
});
