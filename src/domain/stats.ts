import type { GlobalStats, SessionSummary } from "./types";

export const computeStats = (sessions: readonly SessionSummary[]): GlobalStats => {
  let totalCost = 0;
  let totalTools = 0;
  let totalDuration = 0;

  for (const s of sessions) {
    totalTools += s.tool_count;
    totalDuration += s.duration_ms;
    if (s.cost?.total_cost_usd) totalCost += s.cost.total_cost_usd;
  }

  return {
    total_sessions: sessions.length,
    total_tool_calls: totalTools,
    total_duration_ms: totalDuration,
    total_cost_usd: totalCost,
  };
};
