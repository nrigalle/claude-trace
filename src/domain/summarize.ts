import { effectiveContextSize, percentOfContext } from "./contextWindow";
import type {
  CostSnapshot,
  ContextSnapshot,
  ModelInfo,
  SessionId,
  SessionSummary,
  TraceEvent,
} from "./types";
import { isPostToolUse } from "./types";

export interface SummaryMeta {
  readonly title?: string | null;
}

export const summarize = (
  sessionId: SessionId,
  events: readonly TraceEvent[],
  lastModifiedMs: number,
  meta: SummaryMeta = {},
): SessionSummary => {
  if (events.length === 0) {
    return {
      session_id: sessionId,
      title: meta.title ?? null,
      event_count: 0,
      tool_count: 0,
      tools: [],
      duration_ms: 0,
      started_at: null,
      ended_at: null,
      cwd: null,
      cost: null,
      context_window: null,
      model: null,
      last_modified_ms: lastModifiedMs,
    };
  }

  const first = events[0]!;
  const last = events[events.length - 1]!;
  const uniqueTools = new Set<string>();
  let toolCount = 0;
  let cwd: string | null = null;
  let cost: CostSnapshot | null = null;
  let contextWindow: ContextSnapshot | null = null;
  let model: ModelInfo | null = null;

  for (const e of events) {
    if (cwd === null && e.cwd) cwd = e.cwd;
    if (isPostToolUse(e)) {
      toolCount += 1;
      uniqueTools.add(e.tool_name);
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (!cost && e.cost) cost = e.cost;
    if (!contextWindow && e.context_window) contextWindow = e.context_window;
    if (!model && e.model) model = e.model;
    if (cost && contextWindow && model) break;
  }

  if (contextWindow) {
    const contextSize = effectiveContextSize(events);
    const tokens = contextWindow.total_input_tokens ?? 0;
    const pct = percentOfContext(tokens, contextSize);
    contextWindow = {
      ...contextWindow,
      used_percentage: pct,
      remaining_percentage: 100 - pct,
      context_window_size: contextSize,
    };
  }

  return {
    session_id: sessionId,
    title: meta.title ?? null,
    event_count: events.length,
    tool_count: toolCount,
    tools: [...uniqueTools],
    duration_ms: last.ts - first.ts,
    started_at: first.ts,
    ended_at: last.ts,
    cwd,
    cost,
    context_window: contextWindow,
    model,
    last_modified_ms: lastModifiedMs,
  };
};
