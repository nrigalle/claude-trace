import type { DateFilter } from "../state/Store.js";

export const dateFilterCutoff = (filter: DateFilter, now: Date = new Date()): number | null => {
  if (filter === "all") return null;
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (filter === "today") return cutoff.getTime();
  if (filter === "week") {
    const dayOfWeek = cutoff.getDay();
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    cutoff.setDate(cutoff.getDate() - daysSinceMonday);
    return cutoff.getTime();
  }
  cutoff.setDate(1);
  return cutoff.getTime();
};

export const matchesDateFilter = (
  lastActivityMs: number,
  filter: DateFilter,
  now: Date = new Date(),
): boolean => {
  const cutoff = dateFilterCutoff(filter, now);
  return cutoff === null || lastActivityMs >= cutoff;
};

export const DATE_FILTER_LABELS: Record<DateFilter, string> = {
  all: "All",
  today: "Today",
  week: "This week",
  month: "This month",
};

export const DATE_FILTER_ORDER: readonly DateFilter[] = ["all", "today", "week", "month"];
