import type { ScheduleRecurrence } from "./types";

export const MINUTES_PER_DAY = 1440;
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface IntervalUnit {
  readonly id: "seconds" | "minutes" | "hours" | "days" | "weeks";
  readonly label: string;
  readonly ms: number;
}

export const INTERVAL_UNITS: readonly IntervalUnit[] = [
  { id: "seconds", label: "seconds", ms: 1000 },
  { id: "minutes", label: "minutes", ms: 60_000 },
  { id: "hours", label: "hours", ms: 3_600_000 },
  { id: "days", label: "days", ms: 86_400_000 },
  { id: "weeks", label: "weeks", ms: 604_800_000 },
];

export const splitInterval = (everyMs: number): { value: number; unit: IntervalUnit["id"] } => {
  for (let i = INTERVAL_UNITS.length - 1; i >= 0; i -= 1) {
    const unit = INTERVAL_UNITS[i]!;
    if (everyMs >= unit.ms && everyMs % unit.ms === 0) {
      return { value: everyMs / unit.ms, unit: unit.id };
    }
  }
  return { value: Math.max(1, Math.round(everyMs / 1000)), unit: "seconds" };
};

export const intervalToMs = (value: number, unit: string): number => {
  const found = INTERVAL_UNITS.find((u) => u.id === unit) ?? INTERVAL_UNITS[1]!;
  return Math.max(1, Math.round(value)) * found.ms;
};

export const isValidRecurrence = (r: ScheduleRecurrence): boolean => {
  switch (r.type) {
    case "interval":
      return Number.isFinite(r.everyMs) && r.everyMs > 0;
    case "daily":
      return isMinute(r.atMinute);
    case "weekly":
      return isMinute(r.atMinute) && r.weekdays.length > 0 && r.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    case "monthly":
      return isMinute(r.atMinute) && Number.isInteger(r.day) && r.day >= 1 && r.day <= 31;
  }
};

const isMinute = (m: number): boolean => Number.isInteger(m) && m >= 0 && m < MINUTES_PER_DAY;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

export const formatMinute = (atMinute: number): string => {
  const h = Math.floor(atMinute / 60);
  const m = atMinute % 60;
  return `${pad2(h)}:${pad2(m)}`;
};

export const describeRecurrence = (r: ScheduleRecurrence): string => {
  switch (r.type) {
    case "interval": {
      const { value, unit } = splitInterval(r.everyMs);
      return `every ${value} ${value === 1 ? unit.replace(/s$/, "") : unit}`;
    }
    case "daily":
      return `every day at ${formatMinute(r.atMinute)}`;
    case "weekly": {
      const days = [...r.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]).join(", ");
      return `every ${days} at ${formatMinute(r.atMinute)}`;
    }
    case "monthly":
      return `monthly on day ${r.day} at ${formatMinute(r.atMinute)}`;
  }
};

export const nextScheduleDelayMs = (r: ScheduleRecurrence, nowMs: number): number => {
  if (r.type === "interval") return Math.max(1, r.everyMs);
  const next = nextCalendarFireMs(r, nowMs);
  return Math.max(1000, next - nowMs);
};

const nextCalendarFireMs = (
  r: Exclude<ScheduleRecurrence, { type: "interval" }>,
  nowMs: number,
): number => {
  const now = new Date(nowMs);
  const hour = Math.floor(r.atMinute / 60);
  const minute = r.atMinute % 60;

  if (r.type === "daily") {
    const probe = new Date(now);
    probe.setHours(hour, minute, 0, 0);
    if (probe.getTime() <= nowMs) probe.setDate(probe.getDate() + 1);
    return probe.getTime();
  }
  if (r.type === "weekly") {
    const wanted = new Set(r.weekdays);
    for (let add = 0; add <= 7; add += 1) {
      const probe = new Date(now);
      probe.setDate(now.getDate() + add);
      probe.setHours(hour, minute, 0, 0);
      if (wanted.has(probe.getDay()) && probe.getTime() > nowMs) return probe.getTime();
    }
    return nowMs + 7 * 86_400_000;
  }
  for (let add = 0; add <= 13; add += 1) {
    const probe = new Date(now.getFullYear(), now.getMonth() + add, 1, hour, minute, 0, 0);
    probe.setDate(Math.min(r.day, daysInMonth(probe.getFullYear(), probe.getMonth())));
    if (probe.getTime() > nowMs) return probe.getTime();
  }
  return nowMs + 31 * 86_400_000;
};

const daysInMonth = (year: number, month: number): number => new Date(year, month + 1, 0).getDate();
