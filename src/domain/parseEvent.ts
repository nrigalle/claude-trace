import { lineDiffFromToolInput } from "./lineDiff";
import { isAutoMemoryFile, memoryActionForTool, type RawMemoryEdit } from "./memory";
import { estimateUsageCost, type Usage } from "./pricing";
import type { ContextSnapshot, CostSnapshot, SessionId, ToolInput, TraceEvent } from "./types";

export interface ParseContext {
  sessionId: SessionId;
  totalCostUsd: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  lastCacheWriteTokens: number;
  maxTotalInputTokens: number;
  lastModel: string | null;
  aiTitle: string | null;
  firstUserText: string | null;
  memoryEdits: RawMemoryEdit[];
}

export const createParseContext = (sessionId: SessionId): ParseContext => ({
  sessionId,
  totalCostUsd: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  lastInputTokens: 0,
  lastOutputTokens: 0,
  lastCacheReadTokens: 0,
  lastCacheWriteTokens: 0,
  maxTotalInputTokens: 0,
  lastModel: null,
  aiTitle: null,
  firstUserText: null,
  memoryEdits: [],
});

export const parseNativeLine = (line: string, ctx: ParseContext): TraceEvent[] => {
  if (!line) return [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = raw["type"];

  if (type === "ai-title") {
    const title = raw["aiTitle"];
    if (typeof title === "string" && title.length > 0) ctx.aiTitle = title;
    return [];
  }

  if (type !== "user" && type !== "assistant") return [];

  const timestamp = raw["timestamp"];
  const ts = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(ts)) return [];

  const cwd = typeof raw["cwd"] === "string" ? (raw["cwd"] as string) : null;
  const isSidechain = raw["isSidechain"] === true;
  const message = raw["message"];

  if (type === "assistant" && isObject(message)) {
    return parseAssistant(ts, cwd, isSidechain, message, ctx);
  }

  if (type === "user" && isObject(message)) {
    captureFirstUserText(ctx, message);
    return parseUser(ts, cwd, message, ctx);
  }

  return [];
};

const parseAssistant = (
  ts: number,
  cwd: string | null,
  isSidechain: boolean,
  message: Record<string, unknown>,
  ctx: ParseContext,
): TraceEvent[] => {
  const model = typeof message["model"] === "string" ? (message["model"] as string) : null;
  if (model) ctx.lastModel = model;

  const usage = isObject(message["usage"]) ? (message["usage"] as Record<string, unknown>) : null;
  let contextSnapshot: ContextSnapshot | null = null;

  if (usage) {
    const u: Usage = {
      input_tokens: numOrZero(usage["input_tokens"]),
      output_tokens: numOrZero(usage["output_tokens"]),
      cache_read_input_tokens: numOrZero(usage["cache_read_input_tokens"]),
      cache_creation_input_tokens: numOrZero(usage["cache_creation_input_tokens"]),
    };
    ctx.totalCostUsd += estimateUsageCost(ctx.lastModel ?? "", u);
    ctx.lastInputTokens = u.input_tokens;
    ctx.lastOutputTokens = u.output_tokens;
    ctx.lastCacheReadTokens = u.cache_read_input_tokens;
    ctx.lastCacheWriteTokens = u.cache_creation_input_tokens;

    if (!isSidechain) {
      const used =
        u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
      if (used > ctx.maxTotalInputTokens) ctx.maxTotalInputTokens = used;

      contextSnapshot = {
        total_input_tokens: used,
        total_output_tokens: u.output_tokens,
      };
    }
  }

  const modelInfo = model ? { id: model, display_name: humanizeModel(model) } : null;
  const sessionId = ctx.sessionId;
  const content = Array.isArray(message["content"]) ? (message["content"] as unknown[]) : [];
  const toolUses: TraceEvent[] = [];

  for (const block of content) {
    if (!isObject(block)) continue;
    if (block["type"] !== "tool_use") continue;
    const toolName = typeof block["name"] === "string" ? (block["name"] as string) : null;
    if (!toolName) continue;
    const rawInput = isObject(block["input"]) ? (block["input"] as Record<string, unknown>) : null;
    if (rawInput) {
      const diff = lineDiffFromToolInput(toolName, rawInput);
      ctx.totalLinesAdded += diff.added;
      ctx.totalLinesRemoved += diff.removed;
      recordMemoryEdit(ctx, ts, toolName, rawInput, diff);
    }

    toolUses.push({
      ts,
      event: "PostToolUse",
      session_id: sessionId,
      cwd,
      tool_name: toolName,
      tool_input: rawInput ? sanitizeInput(rawInput) : null,
      tool_result: null,
      stop_reason: null,
      model: modelInfo,
      cost: buildCostSnapshot(ctx),
      context_window: contextSnapshot,
      tokens_freed: null,
      error: null,
    });
  }

  if (toolUses.length > 0) return toolUses;

  return [
    {
      ts,
      event: "Metrics",
      session_id: sessionId,
      cwd,
      tool_name: null,
      tool_input: null,
      tool_result: null,
      stop_reason:
        typeof message["stop_reason"] === "string" ? (message["stop_reason"] as string) : null,
      model: modelInfo,
      cost: buildCostSnapshot(ctx),
      context_window: contextSnapshot,
      tokens_freed: null,
      error: null,
    },
  ];
};

const buildCostSnapshot = (ctx: ParseContext): CostSnapshot | null => {
  if (ctx.totalCostUsd === 0 && ctx.totalLinesAdded === 0 && ctx.totalLinesRemoved === 0) {
    return null;
  }
  return {
    total_cost_usd: ctx.totalCostUsd,
    total_lines_added: ctx.totalLinesAdded,
    total_lines_removed: ctx.totalLinesRemoved,
  };
};

const parseUser = (
  ts: number,
  cwd: string | null,
  message: Record<string, unknown>,
  ctx: ParseContext,
): TraceEvent[] => {
  const content = message["content"];
  if (!Array.isArray(content)) return [];
  const out: TraceEvent[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block["type"] !== "tool_result") continue;
    const contentField = block["content"];
    const text =
      typeof contentField === "string"
        ? contentField
        : Array.isArray(contentField)
          ? contentField
              .map((b) => (isObject(b) && typeof b["text"] === "string" ? b["text"] : ""))
              .join(" ")
          : null;
    const isError = block["is_error"] === true;
    out.push({
      ts,
      event: "Metrics",
      session_id: ctx.sessionId,
      cwd,
      tool_name: null,
      tool_input: null,
      tool_result: text ? truncate(text, 400) : null,
      stop_reason: null,
      model: null,
      cost: null,
      context_window: null,
      tokens_freed: null,
      error: isError && text ? truncate(text, 400) : null,
    });
  }
  return out;
};

const captureFirstUserText = (ctx: ParseContext, message: Record<string, unknown>): void => {
  if (ctx.firstUserText !== null) return;
  const content = message["content"];
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (isObject(b) && b["type"] === "text" && typeof b["text"] === "string") {
        text = b["text"] as string;
        break;
      }
    }
  }
  if (!text) return;
  if (SYNTHETIC_PREFIXES.some((p) => text.startsWith(p))) return;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return;
  ctx.firstUserText = cleaned.slice(0, 120);
};

const SYNTHETIC_PREFIXES = [
  "<local-command-caveat>",
  "<system-",
  "<command-",
  "<bash-stdout>",
  "<bash-stderr>",
  "<ide_selection>",
  "<ide_diagnostics>",
  "Caveat:",
  "[Request interrupted",
];

const recordMemoryEdit = (
  ctx: ParseContext,
  ts: number,
  toolName: string,
  input: Record<string, unknown>,
  diff: { added: number; removed: number },
): void => {
  const action = memoryActionForTool(toolName);
  if (!action) return;
  const filePath = input["file_path"];
  if (typeof filePath !== "string") return;
  if (!isAutoMemoryFile(filePath)) return;
  ctx.memoryEdits.push({ ts, filePath, added: diff.added, removed: diff.removed, action });
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const numOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + "…");

const sanitizeInput = (input: Record<string, unknown>): ToolInput => {
  const out: Record<string, unknown> = {};
  const keys = ["command", "file_path", "pattern", "query", "description", "skill", "subagent_type"];
  for (const k of keys) {
    if (typeof input[k] === "string") out[k] = input[k];
  }
  if (typeof input["prompt"] === "string") out["prompt"] = truncate(input["prompt"] as string, 200);
  if (typeof input["content"] === "string") out["content"] = truncate(input["content"] as string, 200);
  if (typeof input["old_string"] === "string") out["old_string"] = truncate(input["old_string"] as string, 120);
  if (typeof input["new_string"] === "string") out["new_string"] = truncate(input["new_string"] as string, 120);
  if (Object.keys(out).length === 0) {
    const s = JSON.stringify(input);
    return { _summary: truncate(s, 300) };
  }
  return out;
};

const humanizeModel = (model: string): string => {
  if (model.startsWith("claude-")) {
    const trimmed = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
    const parts = trimmed.split("-");
    if (parts[0]) parts[0] = parts[0]![0]!.toUpperCase() + parts[0]!.slice(1);
    return `Claude ${parts.join(" ")}`;
  }
  return model;
};
