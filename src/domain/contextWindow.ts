import type { TraceEvent } from "./types";

const STANDARD_200K = 200_000;
const STANDARD_1M = 1_000_000;

const MODEL_BASELINE_1M = new Set([
  "claude-opus-4-7",
]);

const has1MFlag = (model: string): boolean =>
  model.includes("[1m]") || model.includes("-1m") || /\b1m\b/.test(model);

export const baselineContextSize = (model: string | null | undefined): number => {
  if (!model) return STANDARD_200K;
  if (has1MFlag(model)) return STANDARD_1M;
  for (const m of MODEL_BASELINE_1M) {
    if (model.startsWith(m)) return STANDARD_1M;
  }
  return STANDARD_200K;
};

export const effectiveContextSize = (events: readonly TraceEvent[]): number => {
  let observedMax = 0;
  let baseline = STANDARD_200K;
  for (const e of events) {
    const tokens = e.context_window?.total_input_tokens;
    if (typeof tokens === "number" && tokens > observedMax) observedMax = tokens;
    if (e.model?.id) {
      const candidate = baselineContextSize(e.model.id);
      if (candidate > baseline) baseline = candidate;
    }
  }
  if (observedMax > baseline) return STANDARD_1M;
  return baseline;
};

export const percentOfContext = (tokens: number, contextSize: number): number => {
  if (contextSize <= 0) return 0;
  return Math.min((tokens / contextSize) * 100, 100);
};
