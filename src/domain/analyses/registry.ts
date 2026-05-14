import type { TraceEvent } from "../types";

export interface AnalysisPlugin<TResult> {
  readonly id: string;
  compute(events: readonly TraceEvent[]): TResult;
}
