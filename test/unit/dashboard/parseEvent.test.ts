import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createParseContext, parseNativeLine, type ParseContext } from "../../../src/features/dashboard/domain/parseEvent";
import { toSessionId } from "../../../src/features/dashboard/domain/types";

const ctx = (): ParseContext => createParseContext(toSessionId("s"));

const assistantLine = (opts: {
  ts?: string;
  tools?: { name: string; input?: Record<string, unknown> }[];
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>;
  model?: string;
  textOnly?: boolean;
  isSidechain?: boolean;
}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: opts.ts ?? "2026-05-01T10:00:00Z",
    cwd: "/p",
    sessionId: "s",
    isSidechain: opts.isSidechain ?? false,
    message: {
      model: opts.model ?? "claude-opus-4-7",
      content: opts.textOnly
        ? [{ type: "text", text: "hi" }]
        : (opts.tools ?? [{ name: "Bash", input: { command: "ls" } }]).map((t) => ({
            type: "tool_use",
            id: `id-${t.name}`,
            name: t.name,
            input: t.input ?? {},
          })),
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
        ...(opts.usage ?? {}),
      },
    },
  });

const userLine = (content: unknown, ts = "2026-05-01T10:00:00Z") =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    sessionId: "s",
    message: { content },
  });

describe("parseNativeLine — meta line handling", () => {
  it.each(["", "garbage", "{}"])("returns [] for: %s", (s) => {
    expect(parseNativeLine(s, ctx())).toEqual([]);
  });

  it.each(["last-prompt", "permission-mode", "attachment", "file-history-snapshot"])(
    "skips %s",
    (type) => {
      expect(parseNativeLine(JSON.stringify({ type }), ctx())).toEqual([]);
    },
  );

  it("captures aiTitle from ai-title event", () => {
    const c = ctx();
    parseNativeLine(JSON.stringify({ type: "ai-title", aiTitle: "Plan the migration" }), c);
    expect(c.aiTitle).toBe("Plan the migration");
  });

  it("ignores ai-title with empty/missing title", () => {
    const c = ctx();
    parseNativeLine(JSON.stringify({ type: "ai-title" }), c);
    parseNativeLine(JSON.stringify({ type: "ai-title", aiTitle: "" }), c);
    expect(c.aiTitle).toBeNull();
  });

  it("last ai-title wins", () => {
    const c = ctx();
    parseNativeLine(JSON.stringify({ type: "ai-title", aiTitle: "First" }), c);
    parseNativeLine(JSON.stringify({ type: "ai-title", aiTitle: "Second" }), c);
    expect(c.aiTitle).toBe("Second");
  });

  it("captures customTitle from a /rename custom-title record, last one wins", () => {
    const c = ctx();
    parseNativeLine(JSON.stringify({ type: "custom-title", customTitle: "Old name" }), c);
    parseNativeLine(JSON.stringify({ type: "custom-title", customTitle: "Improve Claude Trace" }), c);
    expect(c.customTitle).toBe("Improve Claude Trace");
  });

  it("ignores custom-title records with blank titles", () => {
    const c = ctx();
    parseNativeLine(JSON.stringify({ type: "custom-title", customTitle: "  " }), c);
    expect(c.customTitle).toBeNull();
  });
});

describe("parseNativeLine — timestamps", () => {
  it("rejects events with invalid timestamps", () => {
    expect(parseNativeLine('{"type":"assistant","timestamp":"not-a-date","message":{}}', ctx())).toEqual([]);
    expect(parseNativeLine('{"type":"assistant","message":{}}', ctx())).toEqual([]);
  });

  it("accepts ISO-8601 with timezone", () => {
    const events = parseNativeLine(
      assistantLine({ ts: "2026-05-01T10:30:45.123Z" }),
      ctx(),
    );
    expect(events[0]!.ts).toBe(Date.parse("2026-05-01T10:30:45.123Z"));
  });
});

describe("parseNativeLine — assistant with tool_use", () => {
  it("emits one PostToolUse per tool_use block", () => {
    const events = parseNativeLine(
      assistantLine({ tools: [{ name: "Bash" }, { name: "Read" }, { name: "Edit" }] }),
      ctx(),
    );
    expect(events.map((e) => e.event)).toEqual(["PostToolUse", "PostToolUse", "PostToolUse"]);
    expect(events.map((e) => e.tool_name)).toEqual(["Bash", "Read", "Edit"]);
  });

  it("preserves cwd and timestamp on every emitted event", () => {
    const events = parseNativeLine(
      assistantLine({
        ts: "2026-05-01T10:00:00Z",
        tools: [{ name: "Bash" }, { name: "Read" }],
      }),
      ctx(),
    );
    for (const e of events) {
      expect(e.cwd).toBe("/p");
      expect(e.ts).toBe(Date.parse("2026-05-01T10:00:00Z"));
    }
  });

  it("sanitizes tool_input keeping only known fields", () => {
    const events = parseNativeLine(
      assistantLine({
        tools: [
          {
            name: "Bash",
            input: { command: "ls", file_path: "/x", secret: "hidden", _other: 123 },
          },
        ],
      }),
      ctx(),
    );
    const input = events[0]!.tool_input as Record<string, unknown>;
    expect(input["command"]).toBe("ls");
    expect(input["file_path"]).toBe("/x");
    expect(input["secret"]).toBeUndefined();
    expect(input["_other"]).toBeUndefined();
  });

  it("truncates long prompt/content/old_string/new_string", () => {
    const long = "a".repeat(1000);
    const events = parseNativeLine(
      assistantLine({
        tools: [{ name: "Write", input: { content: long, old_string: long, new_string: long, prompt: long } }],
      }),
      ctx(),
    );
    const input = events[0]!.tool_input as Record<string, unknown>;
    expect((input["content"] as string).length).toBeLessThan(long.length);
    expect((input["prompt"] as string).length).toBeLessThan(long.length);
  });

  it("falls back to _summary when no known keys present", () => {
    const events = parseNativeLine(
      assistantLine({ tools: [{ name: "Bash", input: { weird: "key", other: 42 } }] }),
      ctx(),
    );
    const input = events[0]!.tool_input as Record<string, unknown>;
    expect(typeof input["_summary"]).toBe("string");
  });
});

describe("parseNativeLine — assistant without tool_use", () => {
  it("emits an AssistantText event when content has only text", () => {
    const events = parseNativeLine(assistantLine({ textOnly: true }), ctx());
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.event === "AssistantText")).toBe(true);
  });
});

describe("parseNativeLine — cost accumulation", () => {
  it("cost increases monotonically across turns", () => {
    const c = ctx();
    const a = parseNativeLine(assistantLine({ usage: { input_tokens: 1000, output_tokens: 500 } }), c);
    const b = parseNativeLine(assistantLine({ usage: { input_tokens: 1000, output_tokens: 500 } }), c);
    expect(a[0]!.cost!.total_cost_usd!).toBeGreaterThan(0);
    expect(b[0]!.cost!.total_cost_usd!).toBeGreaterThan(a[0]!.cost!.total_cost_usd!);
  });

  it("emits 0 cost when usage is missing", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-01T10:00:00Z",
      message: { model: "claude-opus-4-7", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
    });
    const events = parseNativeLine(line, ctx());
    expect(events[0]!.cost).toBeNull();
  });
});

describe("parseNativeLine — context window", () => {
  it("stores total_input_tokens from usage fields", () => {
    const events = parseNativeLine(
      assistantLine({
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10_000,
          cache_read_input_tokens: 30_000,
          cache_creation_input_tokens: 60_000,
        },
      }),
      ctx(),
    );
    expect(events[0]!.context_window!.total_input_tokens).toBe(100_000);
    expect(events[0]!.context_window!.total_output_tokens).toBe(50);
  });

  it("leaves the denominator decision to the summary layer", () => {
    const events = parseNativeLine(
      assistantLine({ model: "claude-opus-4-7", usage: { input_tokens: 100_000 } }),
      ctx(),
    );
    expect(events[0]!.context_window!.used_percentage).toBeUndefined();
    expect(events[0]!.context_window!.context_window_size).toBeUndefined();
  });
});

describe("parseNativeLine — user messages", () => {
  it("first user text is captured", () => {
    const c = ctx();
    parseNativeLine(userLine("What does this function do?"), c);
    expect(c.firstUserText).toBe("What does this function do?");
  });

  it("skips local-command-caveat synthetic user messages", () => {
    const c = ctx();
    parseNativeLine(userLine("<local-command-caveat>blah</local-command-caveat>"), c);
    expect(c.firstUserText).toBeNull();
  });

  it("skips system-reminder synthetic user messages", () => {
    const c = ctx();
    parseNativeLine(userLine("<system-reminder>blah</system-reminder>"), c);
    expect(c.firstUserText).toBeNull();
  });

  it("skips Caveat: prefix", () => {
    const c = ctx();
    parseNativeLine(userLine("Caveat: the messages below"), c);
    expect(c.firstUserText).toBeNull();
  });

  it("only the first non-synthetic user message is captured", () => {
    const c = ctx();
    parseNativeLine(userLine("First real prompt"), c);
    parseNativeLine(userLine("Second prompt"), c);
    expect(c.firstUserText).toBe("First real prompt");
  });

  it("clamps user text to 120 chars", () => {
    const c = ctx();
    const long = "a".repeat(500);
    parseNativeLine(userLine(long), c);
    expect(c.firstUserText!.length).toBe(120);
  });

  it("extracts text from array content blocks", () => {
    const c = ctx();
    parseNativeLine(userLine([{ type: "text", text: "Hello from block" }]), c);
    expect(c.firstUserText).toBe("Hello from block");
  });

  it("emits Metrics event for tool_result blocks", () => {
    const events = parseNativeLine(
      userLine([{ type: "tool_result", tool_use_id: "t", content: "result text" }]),
      ctx(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("Metrics");
    expect(events[0]!.tool_result).toContain("result text");
  });

  it("marks is_error tool_result events", () => {
    const events = parseNativeLine(
      userLine([{ type: "tool_result", content: "boom", is_error: true }]),
      ctx(),
    );
    expect(events[0]!.error).not.toBeNull();
  });
});

const assistantLineWithCacheSplit = (split: {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  cache_creation_input_tokens?: number;
  model?: string;
  isSidechain?: boolean;
}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-01T10:00:00Z",
    cwd: "/p",
    sessionId: "s",
    isSidechain: split.isSidechain ?? false,
    message: {
      model: split.model ?? "claude-opus-4-7",
      content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: split.cache_creation_input_tokens ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: split.ephemeral_5m_input_tokens ?? 0,
          ephemeral_1h_input_tokens: split.ephemeral_1h_input_tokens ?? 0,
        },
      },
    },
  });

describe("parseNativeLine — cache-tier billing", () => {
  it("1h cache tier costs $10 / MTok on Opus 4.7, not the 5m rate", () => {
    const c = ctx();
    parseNativeLine(
      assistantLineWithCacheSplit({
        ephemeral_1h_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }),
      c,
    );
    expect(c.totalCostUsd).toBeCloseTo(10, 2);
  });

  it("5m cache tier costs $6.25 / MTok on Opus 4.7", () => {
    const c = ctx();
    parseNativeLine(
      assistantLineWithCacheSplit({
        ephemeral_5m_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }),
      c,
    );
    expect(c.totalCostUsd).toBeCloseTo(6.25, 2);
  });

  it("falls back to 5m rate when cache_creation object is absent (legacy JSONL)", () => {
    const c = ctx();
    parseNativeLine(
      assistantLine({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 1_000_000,
        },
      }),
      c,
    );
    expect(c.totalCostUsd).toBeCloseTo(6.25, 2);
  });

  it("real-world 48,111 1h-cache turn costs ~$0.481 on Opus 4.7", () => {
    const c = ctx();
    parseNativeLine(
      assistantLineWithCacheSplit({
        ephemeral_1h_input_tokens: 48_111,
        cache_creation_input_tokens: 48_111,
      }),
      c,
    );
    expect(c.totalCostUsd).toBeCloseTo(0.48111, 4);
  });

  it("Sonnet 4.6 1h cache write costs $6 / MTok (not $3.75)", () => {
    const c = ctx();
    parseNativeLine(
      assistantLineWithCacheSplit({
        ephemeral_1h_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        model: "claude-sonnet-4-6",
      }),
      c,
    );
    expect(c.totalCostUsd).toBeCloseTo(6, 2);
  });
});

describe("parseNativeLine — sidechain isolation", () => {
  it("sidechain assistant turn still emits tool_use events", () => {
    const events = parseNativeLine(
      assistantLine({ tools: [{ name: "Read" }], isSidechain: true }),
      ctx(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("PostToolUse");
  });

  it("sidechain assistant turn does NOT emit a context_window snapshot", () => {
    const events = parseNativeLine(
      assistantLine({ tools: [{ name: "Read" }], isSidechain: true }),
      ctx(),
    );
    expect(events[0]!.context_window).toBeNull();
  });

  it("main-thread turns continue to emit context_window snapshots", () => {
    const events = parseNativeLine(
      assistantLine({ tools: [{ name: "Read" }], isSidechain: false }),
      ctx(),
    );
    expect(events[0]!.context_window).not.toBeNull();
  });

  it("sidechain usage still accumulates into total cost", () => {
    const c = ctx();
    parseNativeLine(assistantLine({ isSidechain: true, usage: { input_tokens: 1000, output_tokens: 500 } }), c);
    expect(c.totalCostUsd).toBeGreaterThan(0);
  });

  it("sidechain usage does NOT inflate maxTotalInputTokens", () => {
    const c = ctx();
    parseNativeLine(
      assistantLine({ isSidechain: true, usage: { input_tokens: 500_000 } }),
      c,
    );
    expect(c.maxTotalInputTokens).toBe(0);
  });
});

describe("parseNativeLine — line diff aggregation", () => {
  it("Edit tool_use rolls lines into ParseContext and cost snapshot", () => {
    const c = ctx();
    const events = parseNativeLine(
      assistantLine({
        tools: [{ name: "Edit", input: { old_string: "a\nb", new_string: "x\ny\nz" } }],
      }),
      c,
    );
    expect(c.totalLinesAdded).toBe(3);
    expect(c.totalLinesRemoved).toBe(2);
    expect(events[0]!.cost?.total_lines_added).toBe(3);
    expect(events[0]!.cost?.total_lines_removed).toBe(2);
  });

  it("multiple edits across turns accumulate", () => {
    const c = ctx();
    parseNativeLine(
      assistantLine({ tools: [{ name: "Write", input: { content: "1\n2\n3" } }] }),
      c,
    );
    parseNativeLine(
      assistantLine({ tools: [{ name: "Edit", input: { old_string: "x", new_string: "y" } }] }),
      c,
    );
    expect(c.totalLinesAdded).toBe(4);
    expect(c.totalLinesRemoved).toBe(1);
  });

  it("Bash and Read do not contribute to line counts", () => {
    const c = ctx();
    parseNativeLine(
      assistantLine({ tools: [{ name: "Bash", input: { command: "ls" } }, { name: "Read", input: { file_path: "/x" } }] }),
      c,
    );
    expect(c.totalLinesAdded).toBe(0);
    expect(c.totalLinesRemoved).toBe(0);
  });
});

describe("parseNativeLine — property invariants", () => {
  it("# of PostToolUse events = # of tool_use blocks", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ name: fc.constantFrom("Bash", "Read", "Edit", "Grep", "Write") }),
          { minLength: 1, maxLength: 10 },
        ),
        (tools) => {
          const events = parseNativeLine(assistantLine({ tools }), ctx());
          expect(events.filter((e) => e.event === "PostToolUse")).toHaveLength(tools.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("cost never decreases across two turns", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (a, b) => {
        const c = ctx();
        const first = parseNativeLine(assistantLine({ usage: { input_tokens: a } }), c);
        const second = parseNativeLine(assistantLine({ usage: { input_tokens: b } }), c);
        const firstCost = first[0]!.cost?.total_cost_usd ?? 0;
        const secondCost = second[0]!.cost?.total_cost_usd ?? 0;
        expect(secondCost).toBeGreaterThanOrEqual(firstCost);
      }),
      { numRuns: 100 },
    );
  });
});

describe("parseNativeLine — conversation events", () => {
  it("emits a UserPrompt event for plain-string user content", () => {
    const events = parseNativeLine(userLine("What does this function do?"), ctx());
    const prompt = events.find((e) => e.event === "UserPrompt");
    expect(prompt).toBeDefined();
    expect(prompt!.tool_result).toBe("What does this function do?");
  });

  it("emits a UserPrompt event for text content blocks", () => {
    const events = parseNativeLine(userLine([{ type: "text", text: "Hello from block" }]), ctx());
    const prompts = events.filter((e) => e.event === "UserPrompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.tool_result).toBe("Hello from block");
  });

  it("does NOT emit a UserPrompt for synthetic system-reminder prefixes", () => {
    const events = parseNativeLine(userLine("<system-reminder>internal</system-reminder>"), ctx());
    expect(events.some((e) => e.event === "UserPrompt")).toBe(false);
  });

  it("does NOT emit a UserPrompt for local-command-caveat", () => {
    const events = parseNativeLine(userLine("<local-command-caveat>x</local-command-caveat>"), ctx());
    expect(events.some((e) => e.event === "UserPrompt")).toBe(false);
  });

  it("does NOT emit a UserPrompt for empty/whitespace text", () => {
    const events = parseNativeLine(userLine("   "), ctx());
    expect(events.some((e) => e.event === "UserPrompt")).toBe(false);
  });

  it("a user turn with both text and tool_result emits one UserPrompt + one Metrics", () => {
    const events = parseNativeLine(
      userLine([
        { type: "text", text: "Please run ls" },
        { type: "tool_result", tool_use_id: "t", content: "file1.txt\nfile2.txt" },
      ]),
      ctx(),
    );
    expect(events.filter((e) => e.event === "UserPrompt")).toHaveLength(1);
    expect(events.filter((e) => e.event === "Metrics")).toHaveLength(1);
  });

  it("an assistant turn with text + tool_use emits BOTH AssistantText and PostToolUse", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-01T10:00:00Z",
      message: {
        model: "claude-opus-4-7",
        content: [
          { type: "text", text: "I'll run ls for you." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    const events = parseNativeLine(line, ctx());
    expect(events.filter((e) => e.event === "AssistantText")).toHaveLength(1);
    expect(events.filter((e) => e.event === "PostToolUse")).toHaveLength(1);
    const text = events.find((e) => e.event === "AssistantText");
    expect(text!.tool_result).toBe("I'll run ls for you.");
  });

  it("AssistantText events carry the running cost snapshot AFTER tool-derived line counts accumulate", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-01T10:00:00Z",
      message: {
        model: "claude-opus-4-7",
        content: [
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/x", old_string: "a", new_string: "b\nc" } },
          { type: "text", text: "Done." },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    const events = parseNativeLine(line, ctx());
    const text = events.find((e) => e.event === "AssistantText");
    expect(text).toBeDefined();
    expect(text!.cost?.total_lines_added).toBeGreaterThan(0);
  });
});
