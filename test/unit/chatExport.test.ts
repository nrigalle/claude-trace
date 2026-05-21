import { describe, expect, it } from "vitest";
import { buildChatMarkdown, chatExportFilename } from "../../src/domain/chatExport";
import { toSessionId, type SessionDetail, type TraceEvent } from "../../src/domain/types";

const baseEvent = (overrides: Partial<TraceEvent>): TraceEvent => ({
  ts: 0,
  event: "Metrics",
  session_id: toSessionId("s"),
  cwd: null,
  tool_name: null,
  tool_input: null,
  tool_result: null,
  stop_reason: null,
  model: null,
  cost: null,
  context_window: null,
  tokens_freed: null,
  error: null,
  is_sidechain: false,
  ...overrides,
});

const detail = (overrides: Partial<SessionDetail>): SessionDetail => ({
  session_id: toSessionId("s"),
  title: null,
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
  last_modified_ms: 0,
  pinned: false,
  searchable_text: "",
  events: [],
  tool_stats: [],
  context_timeline: [],
  cost_timeline: [],
  memory_edits: [],
  files_touched: [],
  ...overrides,
});

describe("buildChatMarkdown", () => {
  it("renders user prompts under '## You' and assistant text under '## Claude'", () => {
    const md = buildChatMarkdown(
      detail({
        title: "Refactor auth",
        events: [
          baseEvent({ event: "UserPrompt", tool_result: "how does auth work?" }),
          baseEvent({ event: "AssistantText", tool_result: "Here's how:" }),
        ],
      }),
    );
    expect(md).toContain("# Refactor auth");
    expect(md).toContain("## You");
    expect(md).toContain("how does auth work?");
    expect(md).toContain("## Claude");
    expect(md).toContain("Here's how:");
  });

  it("falls back to a short session id when title is missing", () => {
    const md = buildChatMarkdown(
      detail({ session_id: toSessionId("abcdef0123"), title: null, events: [] }),
    );
    expect(md.split("\n")[0]).toBe("# Session abcdef01");
  });

  it("omits tool calls, tool results, and other non-chat events", () => {
    const md = buildChatMarkdown(
      detail({
        title: "ignored",
        events: [
          baseEvent({ event: "UserPrompt", tool_result: "hi" }),
          baseEvent({ event: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
          baseEvent({ event: "Metrics", tool_result: "tool ran" }),
          baseEvent({ event: "AssistantText", tool_result: "ok" }),
        ],
      }),
    );
    expect(md).toContain("hi");
    expect(md).toContain("ok");
    expect(md).not.toContain("Bash");
    expect(md).not.toContain("ls");
    expect(md).not.toContain("tool ran");
  });

  it("skips sidechain (subagent) chat turns so only the main thread is exported", () => {
    const md = buildChatMarkdown(
      detail({
        title: "t",
        events: [
          baseEvent({ event: "AssistantText", tool_result: "main turn" }),
          baseEvent({ event: "AssistantText", tool_result: "subagent turn", is_sidechain: true }),
        ],
      }),
    );
    expect(md).toContain("main turn");
    expect(md).not.toContain("subagent turn");
  });

  it("drops empty-text turns rather than emitting an empty section", () => {
    const md = buildChatMarkdown(
      detail({
        title: "t",
        events: [
          baseEvent({ event: "UserPrompt", tool_result: "" }),
          baseEvent({ event: "UserPrompt", tool_result: "   " }),
          baseEvent({ event: "AssistantText", tool_result: "real" }),
        ],
      }),
    );
    expect(md.split("## You").length).toBe(1);
    expect(md).toContain("## Claude");
    expect(md).toContain("real");
  });
});

describe("chatExportFilename", () => {
  it("slugifies the session title to ascii kebab-case .md", () => {
    expect(chatExportFilename(detail({ title: "Refactor Auth Middleware!" }))).toBe(
      "refactor-auth-middleware.md",
    );
  });

  it("falls back to session-<shortid>.md when no title is set", () => {
    expect(chatExportFilename(detail({ session_id: toSessionId("abcdef012345"), title: null }))).toBe(
      "session-abcdef01.md",
    );
  });

  it("clamps long titles to ~60 chars before the extension", () => {
    const longTitle = "a".repeat(120);
    const name = chatExportFilename(detail({ title: longTitle }));
    expect(name.endsWith(".md")).toBe(true);
    expect(name.replace(/\.md$/, "").length).toBeLessThanOrEqual(60);
  });
});
