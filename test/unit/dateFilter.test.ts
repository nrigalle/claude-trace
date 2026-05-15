import { describe, expect, it } from "vitest";
import { dateFilterCutoff, matchesDateFilter } from "../../media/src/ui/dateFilter";

const fixedNow = new Date(2026, 4, 14, 11, 30);

describe("dateFilterCutoff", () => {
  it("returns null for 'all'", () => {
    expect(dateFilterCutoff("all", fixedNow)).toBeNull();
  });

  it("'today' returns midnight of the current day", () => {
    const cutoff = dateFilterCutoff("today", fixedNow);
    expect(cutoff).toBe(new Date(2026, 4, 14, 0, 0).getTime());
  });

  it("'week' returns the most recent Monday at midnight", () => {
    const cutoff = dateFilterCutoff("week", fixedNow);
    expect(cutoff).toBe(new Date(2026, 4, 11, 0, 0).getTime());
  });

  it("'week' on a Monday returns the same day at midnight", () => {
    const monday = new Date(2026, 4, 11, 10, 0);
    expect(dateFilterCutoff("week", monday)).toBe(new Date(2026, 4, 11, 0, 0).getTime());
  });

  it("'week' on a Sunday returns the previous Monday", () => {
    const sunday = new Date(2026, 4, 17, 10, 0);
    expect(dateFilterCutoff("week", sunday)).toBe(new Date(2026, 4, 11, 0, 0).getTime());
  });

  it("'month' returns the first of the current calendar month", () => {
    expect(dateFilterCutoff("month", fixedNow)).toBe(new Date(2026, 4, 1, 0, 0).getTime());
  });
});

describe("matchesDateFilter", () => {
  it("always matches for 'all'", () => {
    expect(matchesDateFilter(0, "all", fixedNow)).toBe(true);
    expect(matchesDateFilter(Date.now(), "all", fixedNow)).toBe(true);
  });

  it("includes activity from today", () => {
    const today = new Date(2026, 4, 14, 9, 0).getTime();
    expect(matchesDateFilter(today, "today", fixedNow)).toBe(true);
  });

  it("excludes activity from yesterday under 'today'", () => {
    const yesterday = new Date(2026, 4, 13, 23, 59).getTime();
    expect(matchesDateFilter(yesterday, "today", fixedNow)).toBe(false);
  });

  it("'week' includes activity from earlier this week but not last week", () => {
    const monday = new Date(2026, 4, 11, 10, 0).getTime();
    const sundayPrior = new Date(2026, 4, 10, 23, 59).getTime();
    expect(matchesDateFilter(monday, "week", fixedNow)).toBe(true);
    expect(matchesDateFilter(sundayPrior, "week", fixedNow)).toBe(false);
  });

  it("'month' includes earlier this month but not last month", () => {
    const may1 = new Date(2026, 4, 1, 0, 0).getTime();
    const april30 = new Date(2026, 3, 30, 23, 59).getTime();
    expect(matchesDateFilter(may1, "month", fixedNow)).toBe(true);
    expect(matchesDateFilter(april30, "month", fixedNow)).toBe(false);
  });
});
