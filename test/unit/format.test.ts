import { describe, expect, it } from "vitest";
import { fmtCost, fmtDuration, fmtPct, fmtTokens, shortId } from "../../media/src/ui/format";

describe("fmtDuration boundaries", () => {
  it("ms below 1s", () => {
    expect(fmtDuration(0)).toBe("0ms");
    expect(fmtDuration(999)).toBe("999ms");
  });

  it("seconds between 1s and 1m", () => {
    expect(fmtDuration(1_000)).toBe("1.0s");
    expect(fmtDuration(59_999)).toMatch(/^60\.0s$|^59\.\ds$/);
  });

  it("minutes-and-seconds between 1m and 1h", () => {
    expect(fmtDuration(60_000)).toBe("1m 0s");
    expect(fmtDuration(3_599_999)).toMatch(/^59m \d+s$/);
  });

  it("hours-and-minutes from 1h up", () => {
    expect(fmtDuration(3_600_000)).toBe("1h 0m");
    expect(fmtDuration(7_500_000)).toBe("2h 5m");
  });
});

describe("fmtCost", () => {
  it("zero renders as $0.00", () => {
    expect(fmtCost(0)).toBe("$0.00");
    expect(fmtCost(null)).toBe("$0.00");
    expect(fmtCost(undefined)).toBe("$0.00");
  });

  it("sub-cent uses 4 decimals", () => {
    expect(fmtCost(0.0042)).toBe("$0.0042");
    expect(fmtCost(0.001)).toBe("$0.0010");
  });

  it("cent-or-more uses 2 decimals", () => {
    expect(fmtCost(0.01)).toBe("$0.01");
    expect(fmtCost(12.345)).toBe("$12.35");
    expect(fmtCost(1234.5)).toBe("$1234.50");
  });
});

describe("fmtTokens", () => {
  it("zero", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(null)).toBe("0");
  });

  it("hundreds use raw count", () => {
    expect(fmtTokens(999)).toBe("999");
  });

  it("thousands use K suffix", () => {
    expect(fmtTokens(1_000)).toBe("1.0K");
    expect(fmtTokens(45_678)).toBe("45.7K");
  });

  it("millions use M suffix", () => {
    expect(fmtTokens(1_000_000)).toBe("1.00M");
    expect(fmtTokens(2_345_678)).toBe("2.35M");
  });
});

describe("fmtPct", () => {
  it("rounds to integer", () => {
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(49.4)).toBe("49%");
    expect(fmtPct(49.5)).toBe("50%");
    expect(fmtPct(100)).toBe("100%");
  });

  it("treats null/undefined as 0", () => {
    expect(fmtPct(null)).toBe("0%");
    expect(fmtPct(undefined)).toBe("0%");
  });
});

describe("shortId", () => {
  it("returns input unchanged when short enough", () => {
    expect(shortId("abc", 12)).toBe("abc");
  });

  it("truncates with ellipsis", () => {
    expect(shortId("a".repeat(20))).toBe("a".repeat(12) + "…");
  });

  it("respects custom length", () => {
    expect(shortId("abcdefghij", 4)).toBe("abcd…");
  });
});
