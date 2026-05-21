import type { DateFilter } from "../state/Store.js";

export const dateFilterCutoff = (filter: DateFilter, now: Date = new Date()): number | null => {
  if (filter === "all" || filter === "favorites") return null;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (filter === "today") return startOfDay.getTime();
  if (filter === "week") {
    startOfDay.setDate(startOfDay.getDate() - 6);
    return startOfDay.getTime();
  }
  startOfDay.setDate(startOfDay.getDate() - 29);
  return startOfDay.getTime();
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
  week: "Last 7 days",
  month: "Last 30 days",
  favorites: "★ Favorites",
};

export const DATE_FILTER_ORDER: readonly DateFilter[] = ["all", "today", "week", "month", "favorites"];
