import type { SessionSummary } from "./types";

export const sumCostSince = (
  sessions: readonly SessionSummary[],
  sinceMs: number,
): number => {
  let total = 0;
  for (const s of sessions) {
    const ts = s.started_at ?? s.last_modified_ms;
    if (ts >= sinceMs) total += s.cost?.total_cost_usd ?? 0;
  }
  return total;
};

export const dayStartMs = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

export const nonNegativeNumber = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
