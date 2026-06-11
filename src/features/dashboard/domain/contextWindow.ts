import type { TraceEvent } from "./types";

const STANDARD_200K = 200_000;
const STANDARD_1M = 1_000_000;

const MODEL_BASELINE_1M = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
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

export interface ContextSizeAccumulator {
  observedMax: number;
  baseline: number;
}

export const createContextSizeAccumulator = (): ContextSizeAccumulator => ({
  observedMax: 0,
  baseline: STANDARD_200K,
});

export const foldContextSize = (acc: ContextSizeAccumulator, e: TraceEvent): void => {
  const tokens = e.context_window?.total_input_tokens;
  if (typeof tokens === "number" && tokens > acc.observedMax) acc.observedMax = tokens;
  if (e.model?.id) {
    const candidate = baselineContextSize(e.model.id);
    if (candidate > acc.baseline) acc.baseline = candidate;
  }
};

export const finalizeContextSize = (acc: ContextSizeAccumulator): number =>
  acc.observedMax > acc.baseline ? STANDARD_1M : acc.baseline;

export const effectiveContextSize = (events: readonly TraceEvent[]): number => {
  const acc = createContextSizeAccumulator();
  for (const e of events) foldContextSize(acc, e);
  return finalizeContextSize(acc);
};

export const percentOfContext = (tokens: number, contextSize: number): number => {
  if (contextSize <= 0) return 0;
  return Math.min((tokens / contextSize) * 100, 100);
};
