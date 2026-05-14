import type { ChartPoint, TraceEvent } from "./types";

export const extractContextTimeline = (events: readonly TraceEvent[]): ChartPoint[] => {
  const out: ChartPoint[] = [];
  for (const e of events) {
    const pct = e.context_window?.used_percentage;
    if (pct != null) out.push({ ts: e.ts, value: pct });
  }
  return out;
};

export const extractCostTimeline = (events: readonly TraceEvent[]): ChartPoint[] => {
  const out: ChartPoint[] = [];
  for (const e of events) {
    const usd = e.cost?.total_cost_usd;
    if (usd != null) out.push({ ts: e.ts, value: usd });
  }
  return out;
};
