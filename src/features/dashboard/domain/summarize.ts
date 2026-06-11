import {
  createContextSizeAccumulator,
  finalizeContextSize,
  foldContextSize,
  percentOfContext,
  type ContextSizeAccumulator,
} from "./contextWindow";
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
  readonly pinned?: boolean;
}

export interface SummaryAccumulator {
  eventCount: number;
  toolCount: number;
  uniqueTools: Set<string>;
  cwd: string | null;
  firstTs: number | null;
  lastTs: number | null;
  cost: CostSnapshot | null;
  contextWindow: ContextSnapshot | null;
  model: ModelInfo | null;
  contextSize: ContextSizeAccumulator;
  searchableParts: string[];
  searchableLength: number;
}

export const createSummaryAccumulator = (): SummaryAccumulator => ({
  eventCount: 0,
  toolCount: 0,
  uniqueTools: new Set(),
  cwd: null,
  firstTs: null,
  lastTs: null,
  cost: null,
  contextWindow: null,
  model: null,
  contextSize: createContextSizeAccumulator(),
  searchableParts: [],
  searchableLength: 0,
});

export const foldSummaryEvent = (acc: SummaryAccumulator, e: TraceEvent): void => {
  acc.eventCount += 1;
  if (acc.firstTs === null) acc.firstTs = e.ts;
  acc.lastTs = e.ts;
  if (acc.cwd === null && e.cwd) acc.cwd = e.cwd;
  if (isPostToolUse(e)) {
    acc.toolCount += 1;
    acc.uniqueTools.add(e.tool_name);
  }
  if (e.cost) acc.cost = e.cost;
  if (e.context_window) acc.contextWindow = e.context_window;
  if (e.model) acc.model = e.model;
  foldContextSize(acc.contextSize, e);
  if (acc.searchableLength < SEARCHABLE_CAP) {
    const piece = searchablePiece(e);
    if (piece) {
      acc.searchableParts.push(piece);
      acc.searchableLength += piece.length + 1;
    }
  }
};

export const finalizeSummary = (
  sessionId: SessionId,
  acc: SummaryAccumulator,
  lastModifiedMs: number,
  meta: SummaryMeta = {},
): SessionSummary => {
  if (acc.eventCount === 0) {
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
      pinned: meta.pinned ?? false,
      searchable_text: "",
    };
  }

  let contextWindow = acc.contextWindow;
  if (contextWindow) {
    const contextSize = finalizeContextSize(acc.contextSize);
    const tokens = contextWindow.total_input_tokens ?? 0;
    const pct = percentOfContext(tokens, contextSize);
    contextWindow = {
      ...contextWindow,
      used_percentage: pct,
      remaining_percentage: 100 - pct,
      context_window_size: contextSize,
    };
  }

  const joined = acc.searchableParts.join("\n");
  return {
    session_id: sessionId,
    title: meta.title ?? null,
    event_count: acc.eventCount,
    tool_count: acc.toolCount,
    tools: [...acc.uniqueTools],
    duration_ms: acc.lastTs! - acc.firstTs!,
    started_at: acc.firstTs,
    ended_at: acc.lastTs,
    cwd: acc.cwd,
    cost: acc.cost,
    context_window: contextWindow,
    model: acc.model,
    last_modified_ms: lastModifiedMs,
    pinned: meta.pinned ?? false,
    searchable_text: joined.length <= SEARCHABLE_CAP ? joined : joined.slice(0, SEARCHABLE_CAP),
  };
};

export const summarize = (
  sessionId: SessionId,
  events: readonly TraceEvent[],
  lastModifiedMs: number,
  meta: SummaryMeta = {},
): SessionSummary => {
  const acc = createSummaryAccumulator();
  for (const e of events) foldSummaryEvent(acc, e);
  return finalizeSummary(sessionId, acc, lastModifiedMs, meta);
};

const SEARCHABLE_CAP = 5000;

const searchablePiece = (e: TraceEvent): string => {
  if (e.event === "UserPrompt" || e.event === "AssistantText") {
    return typeof e.tool_result === "string" ? e.tool_result : "";
  }
  if (e.event !== "PostToolUse") return "";
  const out: string[] = [];
  if (e.tool_name) out.push(e.tool_name);
  if (e.tool_input) {
    const inp = e.tool_input as Record<string, unknown>;
    for (const value of Object.values(inp)) {
      if (typeof value === "string") out.push(value);
    }
  }
  return out.join(" ");
};
