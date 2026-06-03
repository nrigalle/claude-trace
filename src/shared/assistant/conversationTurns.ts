import type { ReplayTurn, TimelineEvent } from "./timeline";

const TOOL_RESULT_PREVIEW_CHARS = 220;

export const SESSION_CONTEXT_OPEN = "<session_context>";
export const SESSION_CONTEXT_CLOSE = "</session_context>";
export const INTERNAL_MESSAGE_MARKER = "[[CT_INTERNAL]]";

export const wrapSessionContext = (body: string): string =>
  `${SESSION_CONTEXT_OPEN}\n${body}\n${SESSION_CONTEXT_CLOSE}`;

export const extractTimelineEvents = (jsonlChunk: string): readonly TimelineEvent[] => {
  const events: TimelineEvent[] = [];
  for (const line of jsonlChunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const obj = parseJsonLine(trimmed);
    if (obj === null) continue;
    pushEventsFromEntry(obj, events);
  }
  return events;
};

export const extractConversationTurns = (jsonlChunk: string): readonly ReplayTurn[] => {
  const turns: ReplayTurn[] = [];
  let assistantEvents: TimelineEvent[] = [];
  const flushAssistant = (): void => {
    if (assistantEvents.length > 0) {
      turns.push({ role: "assistant", text: "", events: assistantEvents });
      assistantEvents = [];
    }
  };
  for (const line of jsonlChunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const obj = parseJsonLine(trimmed);
    if (obj === null || typeof obj !== "object") continue;
    const entry = obj as { type?: unknown };
    if (entry.type === "user") {
      const prompt = userPromptText(obj);
      if (prompt !== null) {
        flushAssistant();
        turns.push({ role: "user", text: prompt, events: [] });
        continue;
      }
    }
    pushEventsFromEntry(obj, assistantEvents);
  }
  flushAssistant();
  return turns;
};

export const concatTextEvents = (events: readonly TimelineEvent[]): string => {
  const hasTools = events.some((e) => e.kind === "tool_use");
  const pick = (subset: readonly TimelineEvent[]): string =>
    subset
      .filter((e): e is TimelineEvent & { kind: "text" } => e.kind === "text")
      .map((e) => e.text)
      .join("\n")
      .trim();
  if (!hasTools) return pick(events);
  let lastToolIdx = -1;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    if (ev.kind === "tool_use" || ev.kind === "tool_result") lastToolIdx = i;
  }
  return pick(events.slice(lastToolIdx + 1));
};

const userPromptText = (entry: unknown): string | null => {
  const message = (entry as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  let raw: string;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "tool_result") return null;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    raw = parts.join("\n");
  } else {
    return null;
  }
  return displayablePrompt(raw);
};

const displayablePrompt = (raw: string): string | null => {
  let text = raw;
  const start = text.indexOf(SESSION_CONTEXT_OPEN);
  if (start !== -1) {
    const end = text.indexOf(SESSION_CONTEXT_CLOSE, start);
    if (end !== -1) text = text.slice(0, start) + text.slice(end + SESSION_CONTEXT_CLOSE.length);
  }
  text = text.trim();
  if (text.length === 0 || text.startsWith(INTERNAL_MESSAGE_MARKER)) return null;
  return text;
};

const parseJsonLine = (line: string): unknown | null => {
  try { return JSON.parse(line) as unknown; } catch { return null; }
};

const pushEventsFromEntry = (entry: unknown, out: TimelineEvent[]): void => {
  if (!entry || typeof entry !== "object") return;
  const e = entry as { type?: unknown; message?: unknown };
  if (e.type === "assistant" && e.message && typeof e.message === "object") {
    const content = (e.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
        out.push({ kind: "text", text: b.text });
      } else if (b.type === "tool_use" && typeof b.name === "string" && typeof b.id === "string") {
        out.push({ kind: "tool_use", id: b.id, name: b.name, input: previewToolInput(b.input) });
      }
    }
    return;
  }
  if (e.type === "user" && e.message && typeof e.message === "object") {
    const content = (e.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
      if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      out.push({
        kind: "tool_result",
        toolUseId: b.tool_use_id,
        preview: previewToolResult(b.content),
        isError: b.is_error === true,
      });
    }
  }
};

const previewToolInput = (input: unknown): string => {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, TOOL_RESULT_PREVIEW_CHARS);
  const json = JSON.stringify(input);
  return typeof json === "string" ? truncate(json, TOOL_RESULT_PREVIEW_CHARS) : "";
};

const previewToolResult = (content: unknown): string => {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return truncate(content, TOOL_RESULT_PREVIEW_CHARS);
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : ""))
      .filter((s) => s.length > 0)
      .join("\n");
    return truncate(text, TOOL_RESULT_PREVIEW_CHARS);
  }
  const json = JSON.stringify(content);
  return typeof json === "string" ? truncate(json, TOOL_RESULT_PREVIEW_CHARS) : "";
};

const truncate = (s: string, max: number): string => {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
};
