import { describe, expect, it } from "vitest";
import { dateFilterCutoff, matchesDateFilter } from "../../../media/src/ui/dateFilter";

const fixedNow = new Date(2026, 4, 14, 11, 30);

describe("dateFilterCutoff", () => {
  it("returns null for 'all'", () => {
    expect(dateFilterCutoff("all", fixedNow)).toBeNull();
  });

  it("returns null for 'favorites'", () => {
    expect(dateFilterCutoff("favorites", fixedNow)).toBeNull();
  });

  it("'today' returns midnight of the current day", () => {
    const cutoff = dateFilterCutoff("today", fixedNow);
    expect(cutoff).toBe(new Date(2026, 4, 14, 0, 0).getTime());
  });

  it("'week' (last 7 days) returns midnight six days ago", () => {
    const cutoff = dateFilterCutoff("week", fixedNow);
    expect(cutoff).toBe(new Date(2026, 4, 8, 0, 0).getTime());
  });

  it("'week' on a Monday still includes the previous weekend", () => {
    const monday = new Date(2026, 4, 11, 10, 0);
    expect(dateFilterCutoff("week", monday)).toBe(new Date(2026, 4, 5, 0, 0).getTime());
  });

  it("'week' on a Sunday includes the entire prior week", () => {
    const sunday = new Date(2026, 4, 17, 10, 0);
    expect(dateFilterCutoff("week", sunday)).toBe(new Date(2026, 4, 11, 0, 0).getTime());
  });

  it("'month' (last 30 days) returns midnight 29 days ago", () => {
    expect(dateFilterCutoff("month", fixedNow)).toBe(new Date(2026, 3, 15, 0, 0).getTime());
  });

  it("'month' on the 1st of the month does not snap to the calendar month boundary", () => {
    const firstOfJune = new Date(2026, 5, 1, 10, 0);
    expect(dateFilterCutoff("month", firstOfJune)).toBe(new Date(2026, 4, 3, 0, 0).getTime());
  });
});

describe("matchesDateFilter", () => {
  it("always matches for 'all'", () => {
    expect(matchesDateFilter(0, "all", fixedNow)).toBe(true);
    expect(matchesDateFilter(Date.now(), "all", fixedNow)).toBe(true);
  });

  it("always matches for 'favorites' (Sidebar handles the pinned check separately)", () => {
    expect(matchesDateFilter(0, "favorites", fixedNow)).toBe(true);
  });

  it("includes activity from today", () => {
    const today = new Date(2026, 4, 14, 9, 0).getTime();
    expect(matchesDateFilter(today, "today", fixedNow)).toBe(true);
  });

  it("excludes activity from yesterday under 'today'", () => {
    const yesterday = new Date(2026, 4, 13, 23, 59).getTime();
    expect(matchesDateFilter(yesterday, "today", fixedNow)).toBe(false);
  });

  it("'week' includes activity from up to six days ago", () => {
    const sixDaysAgo = new Date(2026, 4, 8, 0, 0).getTime();
    const sevenDaysAgo = new Date(2026, 4, 7, 23, 59).getTime();
    expect(matchesDateFilter(sixDaysAgo, "week", fixedNow)).toBe(true);
    expect(matchesDateFilter(sevenDaysAgo, "week", fixedNow)).toBe(false);
  });

  it("'week' includes a session from yesterday regardless of where the week boundary falls", () => {
    const monday = new Date(2026, 4, 11, 10, 0);
    const yesterday = new Date(2026, 4, 10, 14, 0).getTime();
    expect(matchesDateFilter(yesterday, "week", monday)).toBe(true);
  });

  it("'month' includes activity from up to 29 days ago", () => {
    const twentyNineDaysAgo = new Date(2026, 3, 15, 0, 0).getTime();
    const thirtyDaysAgo = new Date(2026, 3, 14, 23, 59).getTime();
    expect(matchesDateFilter(twentyNineDaysAgo, "month", fixedNow)).toBe(true);
    expect(matchesDateFilter(thirtyDaysAgo, "month", fixedNow)).toBe(false);
  });

  it("'month' on the 1st of June still includes May activity (no calendar-month snap)", () => {
    const firstOfJune = new Date(2026, 5, 1, 12, 0);
    const may31 = new Date(2026, 4, 31, 12, 0).getTime();
    expect(matchesDateFilter(may31, "month", firstOfJune)).toBe(true);
  });
});
