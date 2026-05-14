import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createParseContext, parseNativeLine, type ParseContext } from "../../src/domain/parseEvent";
import { toSessionId } from "../../src/domain/types";

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
}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: opts.ts ?? "2026-05-01T10:00:00Z",
    cwd: "/p",
    sessionId: "s",
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
  it("emits a single Metrics event when content has only text/thinking", () => {
    const events = parseNativeLine(assistantLine({ textOnly: true }), ctx());
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("Metrics");
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
  it("computes used_percentage from input+cache tokens against model size", () => {
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
    expect(events[0]!.context_window!.used_percentage).toBeCloseTo(50, 0);
    expect(events[0]!.context_window!.context_window_size).toBe(200_000);
  });

  it("uses 1M context for [1m] models", () => {
    const events = parseNativeLine(
      assistantLine({ model: "claude-opus-4-7[1m]", usage: { input_tokens: 100_000 } }),
      ctx(),
    );
    expect(events[0]!.context_window!.context_window_size).toBe(1_000_000);
    expect(events[0]!.context_window!.used_percentage).toBeCloseTo(10, 0);
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
