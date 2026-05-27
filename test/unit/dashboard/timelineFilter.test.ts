import { describe, expect, it } from "vitest";
import {
  filterEvents,
  isVisibleEvent,
  uniqueToolNames,
  visibleCount,
} from "../../../media/src/ui/panels/timelineFilter";
import { toSessionId, type TraceEvent } from "../../../src/features/dashboard/domain/types";

const ev = (overrides: Partial<TraceEvent>): TraceEvent => ({
  ts: 0,
  event: "PostToolUse",
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

describe("isVisibleEvent", () => {
  it("treats PostToolUse, UserPrompt, AssistantText as visible", () => {
    expect(isVisibleEvent(ev({ event: "PostToolUse", tool_name: "Bash" }))).toBe(true);
    expect(isVisibleEvent(ev({ event: "UserPrompt", tool_result: "hi" }))).toBe(true);
    expect(isVisibleEvent(ev({ event: "AssistantText", tool_result: "ok" }))).toBe(true);
  });

  it("treats Metrics events as visible only when they carry an error", () => {
    expect(isVisibleEvent(ev({ event: "Metrics" }))).toBe(false);
    expect(isVisibleEvent(ev({ event: "Metrics", error: "boom" }))).toBe(true);
  });

  it("hides SessionStart, SessionEnd, and other hook events", () => {
    expect(isVisibleEvent(ev({ event: "SessionStart" }))).toBe(false);
    expect(isVisibleEvent(ev({ event: "SessionEnd" }))).toBe(false);
    expect(isVisibleEvent(ev({ event: "PreToolUse" }))).toBe(false);
  });
});

describe("visibleCount", () => {
  it("counts only visible events", () => {
    const events = [
      ev({ event: "PostToolUse", tool_name: "Bash" }),
      ev({ event: "Metrics" }),
      ev({ event: "UserPrompt", tool_result: "x" }),
      ev({ event: "PreToolUse" }),
    ];
    expect(visibleCount(events)).toBe(2);
  });
});

describe("filterEvents — main filters", () => {
  const events: TraceEvent[] = [
    ev({ event: "UserPrompt", ts: 1, tool_result: "do this" }),
    ev({ event: "PostToolUse", ts: 2, tool_name: "Bash", tool_input: { command: "ls" } }),
    ev({ event: "AssistantText", ts: 3, tool_result: "done" }),
    ev({ event: "Metrics", ts: 4, error: "boom" }),
    ev({ event: "PostToolUse", ts: 5, tool_name: "Read" }),
  ];

  it("'all' shows every visible event", () => {
    expect(filterEvents(events, "all", null).map((e) => e.ts)).toEqual([1, 2, 3, 4, 5]);
  });

  it("'tools' shows only PostToolUse events", () => {
    expect(filterEvents(events, "tools", null).map((e) => e.ts)).toEqual([2, 5]);
  });

  it("'errors' shows only events with an error", () => {
    expect(filterEvents(events, "errors", null).map((e) => e.ts)).toEqual([4]);
  });

  it("'conversation' shows only UserPrompt and AssistantText events", () => {
    expect(filterEvents(events, "conversation", null).map((e) => e.ts)).toEqual([1, 3]);
  });
});

describe("filterEvents — tool filter", () => {
  const events: TraceEvent[] = [
    ev({ event: "PostToolUse", ts: 1, tool_name: "Bash" }),
    ev({ event: "PostToolUse", ts: 2, tool_name: "Read" }),
    ev({ event: "PostToolUse", ts: 3, tool_name: "Bash" }),
    ev({ event: "AssistantText", ts: 4, tool_result: "ok" }),
  ];

  it("toolFilter narrows to one tool name", () => {
    expect(filterEvents(events, "all", "Bash").map((e) => e.ts)).toEqual([1, 3]);
  });

  it("toolFilter on 'conversation' hides the AssistantText that has no tool_name", () => {
    expect(filterEvents(events, "conversation", "Bash")).toEqual([]);
  });

  it("toolFilter = null is a no-op", () => {
    expect(filterEvents(events, "all", null)).toHaveLength(4);
  });
});

describe("uniqueToolNames", () => {
  it("returns each tool name once, ordered by frequency descending", () => {
    const events = [
      ev({ event: "PostToolUse", tool_name: "Read" }),
      ev({ event: "PostToolUse", tool_name: "Bash" }),
      ev({ event: "PostToolUse", tool_name: "Bash" }),
      ev({ event: "PostToolUse", tool_name: "Bash" }),
      ev({ event: "PostToolUse", tool_name: "Read" }),
      ev({ event: "PostToolUse", tool_name: "Edit" }),
    ];
    expect(uniqueToolNames(events)).toEqual(["Bash", "Read", "Edit"]);
  });

  it("ignores non-tool events and entries without a tool_name", () => {
    const events = [
      ev({ event: "UserPrompt", tool_result: "no tool here" }),
      ev({ event: "Metrics" }),
      ev({ event: "PostToolUse", tool_name: null }),
      ev({ event: "PostToolUse", tool_name: "Edit" }),
    ];
    expect(uniqueToolNames(events)).toEqual(["Edit"]);
  });
});
