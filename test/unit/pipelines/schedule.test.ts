import { describe, expect, it } from "vitest";
import {
  describeRecurrence,
  formatMinute,
  intervalToMs,
  isValidRecurrence,
  nextScheduleDelayMs,
  splitInterval,
} from "../../../src/features/pipelines/domain/schedule";

const HOUR = 3_600_000;
const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();

describe("schedule — interval value/unit conversion", () => {
  it("splits round multiples into the largest matching unit", () => {
    expect(splitInterval(3_600_000)).toEqual({ value: 1, unit: "hours" });
    expect(splitInterval(604_800_000)).toEqual({ value: 1, unit: "weeks" });
    expect(splitInterval(90_000)).toEqual({ value: 90, unit: "seconds" });
    expect(splitInterval(120_000)).toEqual({ value: 2, unit: "minutes" });
  });

  it("intervalToMs round-trips and floors to >= 1 unit", () => {
    expect(intervalToMs(2, "hours")).toBe(7_200_000);
    expect(intervalToMs(0, "minutes")).toBe(60_000);
    expect(intervalToMs(3, "weeks")).toBe(3 * 604_800_000);
  });
});

describe("schedule — validation", () => {
  it("accepts a positive interval and rejects a non-positive one", () => {
    expect(isValidRecurrence({ type: "interval", everyMs: 1000 })).toBe(true);
    expect(isValidRecurrence({ type: "interval", everyMs: 0 })).toBe(false);
  });
  it("requires at least one weekday for weekly", () => {
    expect(isValidRecurrence({ type: "weekly", weekdays: [5], atMinute: 540 })).toBe(true);
    expect(isValidRecurrence({ type: "weekly", weekdays: [], atMinute: 540 })).toBe(false);
    expect(isValidRecurrence({ type: "weekly", weekdays: [1.5], atMinute: 540 })).toBe(false);
  });
  it("bounds the monthly day and the time-of-day", () => {
    expect(isValidRecurrence({ type: "monthly", day: 31, atMinute: 0 })).toBe(true);
    expect(isValidRecurrence({ type: "monthly", day: 1.5, atMinute: 0 })).toBe(false);
    expect(isValidRecurrence({ type: "monthly", day: 32, atMinute: 0 })).toBe(false);
    expect(isValidRecurrence({ type: "daily", atMinute: 1440 })).toBe(false);
  });
});

describe("schedule — labels", () => {
  it("formats minutes as HH:MM", () => {
    expect(formatMinute(540)).toBe("09:00");
    expect(formatMinute(0)).toBe("00:00");
    expect(formatMinute(1439)).toBe("23:59");
  });
  it("describes each recurrence in plain language", () => {
    expect(describeRecurrence({ type: "interval", everyMs: 3_600_000 })).toBe("every 1 hour");
    expect(describeRecurrence({ type: "daily", atMinute: 540 })).toBe("every day at 09:00");
    expect(describeRecurrence({ type: "weekly", weekdays: [5], atMinute: 540 })).toBe("every Fri at 09:00");
    expect(describeRecurrence({ type: "monthly", day: 1, atMinute: 540 })).toBe("monthly on day 1 at 09:00");
  });
});

describe("schedule — next fire delay", () => {
  it("interval returns the interval itself", () => {
    expect(nextScheduleDelayMs({ type: "interval", everyMs: 5000 }, Date.now())).toBe(5000);
  });

  it("daily fires later today when the time has not passed", () => {
    expect(nextScheduleDelayMs({ type: "daily", atMinute: 540 }, at(2026, 5, 1, 8, 0))).toBe(HOUR);
  });

  it("daily rolls to tomorrow when the time has passed", () => {
    expect(nextScheduleDelayMs({ type: "daily", atMinute: 540 }, at(2026, 5, 1, 10, 0))).toBe(23 * HOUR);
  });

  it("weekly fires later today if today is selected and the time has not passed", () => {
    const now = at(2026, 5, 1, 8, 0);
    const today = new Date(now).getDay();
    expect(nextScheduleDelayMs({ type: "weekly", weekdays: [today], atMinute: 540 }, now)).toBe(HOUR);
  });

  it("weekly rolls a full week if only today is selected and the time has passed", () => {
    const now = at(2026, 5, 1, 10, 0);
    const today = new Date(now).getDay();
    expect(nextScheduleDelayMs({ type: "weekly", weekdays: [today], atMinute: 540 }, now)).toBe(167 * HOUR);
  });

  it("monthly fires on the chosen day at the chosen time", () => {
    expect(nextScheduleDelayMs({ type: "monthly", day: 1, atMinute: 540 }, at(2026, 5, 1, 8, 0))).toBe(HOUR);
  });
});
