import { effectiveContextSize, percentOfContext } from "./contextWindow";
import type { ChartPoint, TraceEvent } from "./types";

export const extractContextTimeline = (events: readonly TraceEvent[]): ChartPoint[] => {
  const contextSize = effectiveContextSize(events);
  const out: ChartPoint[] = [];
  for (const e of events) {
    const tokens = e.context_window?.total_input_tokens;
    if (typeof tokens !== "number") continue;
    out.push({ ts: e.ts, value: percentOfContext(tokens, contextSize) });
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
