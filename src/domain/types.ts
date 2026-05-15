export type SessionId = string & { readonly __brand: "SessionId" };

export const toSessionId = (s: string): SessionId => s as SessionId;
export const fromSessionId = (id: SessionId): string => id;

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "StopFailure"
  | "PreCompact"
  | "PostCompact"
  | "Metrics";

export interface CostSnapshot {
  readonly total_cost_usd?: number;
  readonly total_duration_ms?: number;
  readonly total_lines_added?: number;
  readonly total_lines_removed?: number;
}

export interface ContextSnapshot {
  readonly used_percentage?: number;
  readonly remaining_percentage?: number;
  readonly total_input_tokens?: number;
  readonly total_output_tokens?: number;
  readonly context_window_size?: number;
}

export interface ModelInfo {
  readonly display_name?: string;
  readonly id?: string;
}

export type ToolInput = Readonly<Record<string, unknown>>;
export type ToolResult = string | Readonly<Record<string, unknown>>;

export interface TraceEvent {
  readonly ts: number;
  readonly event: HookEvent;
  readonly session_id: SessionId;
  readonly cwd: string | null;
  readonly tool_name: string | null;
  readonly tool_input: ToolInput | null;
  readonly tool_result: ToolResult | null;
  readonly stop_reason: string | null;
  readonly model: ModelInfo | null;
  readonly cost: CostSnapshot | null;
  readonly context_window: ContextSnapshot | null;
  readonly tokens_freed: number | null;
  readonly error: string | null;
  readonly is_sidechain: boolean;
}

export interface SessionSummary {
  readonly session_id: SessionId;
  readonly title: string | null;
  readonly event_count: number;
  readonly tool_count: number;
  readonly tools: readonly string[];
  readonly duration_ms: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly cwd: string | null;
  readonly cost: CostSnapshot | null;
  readonly context_window: ContextSnapshot | null;
  readonly model: ModelInfo | null;
  readonly last_modified_ms: number;
}

export interface ToolStat {
  readonly name: string;
  readonly count: number;
}

export interface ChartPoint {
  readonly ts: number;
  readonly value: number;
}

export interface FileEditSummary {
  readonly filePath: string;
  readonly fileName: string;
  readonly latestTs: number;
  readonly count: number;
  readonly added: number;
  readonly removed: number;
  readonly dominantAction: "write" | "edit" | "multiedit";
}

export interface SessionDetail extends SessionSummary {
  readonly events: readonly TraceEvent[];
  readonly tool_stats: readonly ToolStat[];
  readonly context_timeline: readonly ChartPoint[];
  readonly cost_timeline: readonly ChartPoint[];
  readonly memory_edits: readonly FileEditSummary[];
  readonly files_touched: readonly FileEditSummary[];
}

export interface GlobalStats {
  readonly total_sessions: number;
  readonly total_tool_calls: number;
  readonly total_duration_ms: number;
  readonly total_cost_usd: number;
}

export const isPostToolUse = (
  e: TraceEvent,
): e is TraceEvent & { event: "PostToolUse"; tool_name: string } =>
  e.event === "PostToolUse" && e.tool_name !== null;

export const hasContextSnapshot = (e: TraceEvent): boolean =>
  e.context_window?.used_percentage != null;

export const hasCostSnapshot = (e: TraceEvent): boolean =>
  e.cost?.total_cost_usd != null;
