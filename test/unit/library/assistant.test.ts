import { describe, expect, it } from "vitest";
import {
  concatTextEvents,
  encodeForClaudeProjects,
  extractTimelineEvents,
  LibraryAssistant,
  parseReply,
  systemPromptFor,
} from "../../../src/features/library/infra/LibraryAssistant";
import type {
  AssistantContext,
  TimelineEvent,
} from "../../../src/features/library/protocol";

const ctx = (over: Partial<AssistantContext> = {}): AssistantContext => ({
  itemKey: "skill:code-review",
  kind: "skill",
  name: "code-review",
  description: "Reviews diffs carefully",
  body: "Walk the diff file by file.",
  attachedSkills: [],
  ...over,
});

describe("systemPromptFor — what we tell Claude", () => {
  it("in writeBody mode, names the mode and the body-replacement behavior", () => {
    const prompt = systemPromptFor(ctx(), "writeBody");
    expect(prompt).toContain("Write to body");
    expect(prompt).toContain("body field will be REPLACED");
    expect(prompt).toContain("No preamble");
  });

  it("in writeBody mode, forbids common preambles that would corrupt the body", () => {
    const prompt = systemPromptFor(ctx(), "writeBody");
    expect(prompt).toContain("I hope this helps");
    expect(prompt).toContain("Here is the body");
  });

  it("in writeBody mode, tells Claude to always return the COMPLETE body, not a diff", () => {
    const prompt = systemPromptFor(ctx(), "writeBody");
    expect(prompt).toMatch(/complete .*body/i);
    expect(prompt).toMatch(/not a diff|not.*partial/i);
  });

  it("in discuss mode, tells Claude its reply will NOT touch the body", () => {
    const prompt = systemPromptFor(ctx(), "discuss");
    expect(prompt).toContain("Discuss");
    expect(prompt).toContain("NOT be written to the body");
  });

  it("for skills, references the kebab-case skill spec", () => {
    const prompt = systemPromptFor(ctx({ kind: "skill" }), "writeBody");
    expect(prompt).toContain("Claude Code Skill");
    expect(prompt).toContain("when_to_use");
    expect(prompt).toContain("allowed-tools");
  });

  it("for agents, references the subagent spec with camelCase fields", () => {
    const prompt = systemPromptFor(
      ctx({ kind: "agent", itemKey: "agent:reviewer", name: "reviewer" }),
      "writeBody",
    );
    expect(prompt).toContain("Claude Code Subagent");
    expect(prompt).toContain("disallowedTools");
    expect(prompt).toContain("permissionMode");
  });

  it("declares which tools are available and which are forbidden", () => {
    const prompt = systemPromptFor(ctx(), "writeBody");
    expect(prompt).toContain("WebSearch");
    expect(prompt).toContain("WebFetch");
    expect(prompt).toContain("Forbidden tools");
    expect(prompt).toContain("Bash");
  });

  it("embeds the current draft body so Claude has full context", () => {
    const prompt = systemPromptFor(
      ctx({ body: "Walk the diff file by file. Look for secrets." }),
      "writeBody",
    );
    expect(prompt).toContain("Walk the diff file by file. Look for secrets.");
    expect(prompt).toContain("<current_body>");
  });

  it("notes when the current body is empty so Claude does not hallucinate one", () => {
    const prompt = systemPromptFor(ctx({ body: "" }), "writeBody");
    expect(prompt).toContain("(empty)");
  });

  it("includes attached skills so Claude knows what context the agent already has", () => {
    const prompt = systemPromptFor(
      ctx({ kind: "agent", attachedSkills: ["lint", "test-doctor"] }),
      "writeBody",
    );
    expect(prompt).toContain("lint");
    expect(prompt).toContain("test-doctor");
  });

  it("describes the SUGGESTED_DESCRIPTION sentinel so the UI can parse it", () => {
    expect(systemPromptFor(ctx(), "writeBody")).toContain("SUGGESTED_DESCRIPTION:");
  });
});

describe("extractTimelineEvents — JSONL event parsing", () => {
  it("returns empty array for an empty chunk", () => {
    expect(extractTimelineEvents("")).toEqual([]);
  });

  it("ignores whitespace-only lines without throwing", () => {
    expect(extractTimelineEvents("\n\n   \n\n")).toEqual([]);
  });

  it("extracts a text event from an assistant message with one text block", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello there." }] },
    });
    expect(extractTimelineEvents(chunk)).toEqual([{ kind: "text", text: "Hello there." }]);
  });

  it("extracts MULTIPLE text events when an assistant message has multiple text blocks", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ] },
    });
    expect(extractTimelineEvents(chunk)).toEqual([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
  });

  it("extracts a tool_use event with name, id, and stringified input preview", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        id: "tu_1",
        name: "WebSearch",
        input: { query: "python production 2026" },
      }] },
    });
    const events = extractTimelineEvents(chunk);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool_use",
      id: "tu_1",
      name: "WebSearch",
    });
    expect((events[0] as { input: string }).input).toContain("python production 2026");
  });

  it("interleaves text and tool_use blocks in source order within a single message", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "text", text: "Let me search." },
        { type: "tool_use", id: "tu_1", name: "WebSearch", input: { query: "x" } },
        { type: "text", text: "Done." },
      ] },
    });
    const kinds = extractTimelineEvents(chunk).map((e) => e.kind);
    expect(kinds).toEqual(["text", "tool_use", "text"]);
  });

  it("extracts a tool_result event from a user message containing tool_result content", () => {
    const chunk = JSON.stringify({
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "found 12 results",
      }] },
    });
    expect(extractTimelineEvents(chunk)).toEqual([{
      kind: "tool_result",
      toolUseId: "tu_1",
      preview: "found 12 results",
      isError: false,
    }]);
  });

  it("marks tool_result events as errors when is_error is true", () => {
    const chunk = JSON.stringify({
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "network failed",
        is_error: true,
      }] },
    });
    const events = extractTimelineEvents(chunk);
    expect(events).toHaveLength(1);
    expect((events[0] as { isError: boolean }).isError).toBe(true);
  });

  it("flattens an array-of-text-blocks tool_result into a single preview string", () => {
    const chunk = JSON.stringify({
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tu_1",
        content: [
          { type: "text", text: "line a" },
          { type: "text", text: "line b" },
        ],
      }] },
    });
    const events = extractTimelineEvents(chunk);
    expect((events[0] as { preview: string }).preview).toContain("line a");
    expect((events[0] as { preview: string }).preview).toContain("line b");
  });

  it("truncates a long tool_result preview to keep memory bounded", () => {
    const longText = "x".repeat(2000);
    const chunk = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: longText }] },
    });
    const events = extractTimelineEvents(chunk);
    const preview = (events[0] as { preview: string }).preview;
    expect(preview.length).toBeLessThanOrEqual(220);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("survives interleaved garbage lines (claude logs sometimes have stray output)", () => {
    const chunk = [
      "this is not json at all",
      "{ broken: json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
      "another garbage line",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "two" }] } }),
    ].join("\n");
    const events = extractTimelineEvents(chunk);
    expect(events).toEqual([
      { kind: "text", text: "ok" },
      { kind: "text", text: "two" },
    ]);
  });

  it("ignores empty text blocks (Claude sometimes emits these between tool uses)", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "text", text: "" },
        { type: "text", text: "real" },
      ] },
    });
    expect(extractTimelineEvents(chunk)).toEqual([{ kind: "text", text: "real" }]);
  });

  it("ignores unknown content block types instead of throwing", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "visible" },
      ] },
    });
    expect(extractTimelineEvents(chunk)).toEqual([{ kind: "text", text: "visible" }]);
  });

  it("ignores events that aren't assistant or user (system, summary, etc)", () => {
    const chunk = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "summary", summary: "..." }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "keep" }] } }),
    ].join("\n");
    expect(extractTimelineEvents(chunk)).toEqual([{ kind: "text", text: "keep" }]);
  });

  it("ignores assistant messages whose content is missing or malformed", () => {
    const chunk = [
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({ type: "assistant", message: { content: null } }),
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    ].join("\n");
    expect(extractTimelineEvents(chunk)).toEqual([{ kind: "text", text: "ok" }]);
  });
});

describe("concatTextEvents — what becomes the body (trailing-text-after-tools semantics)", () => {
  it("with NO tools used, joins all text events in order (whole response is the body)", () => {
    const events: TimelineEvent[] = [
      { kind: "text", text: "line one" },
      { kind: "text", text: "line two" },
    ];
    expect(concatTextEvents(events)).toBe("line one\nline two");
  });

  it("with tools used, returns ONLY the text AFTER the last tool call (the closing body) — drops the intro preamble", () => {
    const events: TimelineEvent[] = [
      { kind: "text", text: "I'll research best practices then write the body." },
      { kind: "tool_use", id: "x", name: "WebSearch", input: "..." },
      { kind: "tool_result", toolUseId: "x", preview: "...", isError: false },
      { kind: "text", text: "# The actual body" },
    ];
    expect(concatTextEvents(events)).toBe("# The actual body");
  });

  it("returns empty string when claude did tools but ended with no closing body (the bug the user hit)", () => {
    const events: TimelineEvent[] = [
      { kind: "text", text: "I'll research..." },
      { kind: "tool_use", id: "x", name: "WebSearch", input: "..." },
      { kind: "tool_result", toolUseId: "x", preview: "...", isError: false },
    ];
    expect(concatTextEvents(events)).toBe("");
  });

  it("multiple text blocks AFTER the last tool are joined", () => {
    const events: TimelineEvent[] = [
      { kind: "text", text: "intro" },
      { kind: "tool_use", id: "x", name: "WebSearch", input: "..." },
      { kind: "tool_result", toolUseId: "x", preview: "...", isError: false },
      { kind: "text", text: "## body part 1" },
      { kind: "text", text: "## body part 2" },
    ];
    expect(concatTextEvents(events)).toBe("## body part 1\n## body part 2");
  });

  it("interleaved text between tools is also dropped (only trailing-after-last-tool counts)", () => {
    const events: TimelineEvent[] = [
      { kind: "tool_use", id: "a", name: "WebSearch", input: "..." },
      { kind: "tool_result", toolUseId: "a", preview: "...", isError: false },
      { kind: "text", text: "let me search more" },
      { kind: "tool_use", id: "b", name: "WebSearch", input: "..." },
      { kind: "tool_result", toolUseId: "b", preview: "...", isError: false },
      { kind: "text", text: "FINAL BODY" },
    ];
    expect(concatTextEvents(events)).toBe("FINAL BODY");
  });

  it("returns empty string when there are no text events at all", () => {
    const events: TimelineEvent[] = [
      { kind: "tool_use", id: "x", name: "WebSearch", input: "..." },
    ];
    expect(concatTextEvents(events)).toBe("");
  });

  it("preserves multi-line text blocks (newlines inside a single block are kept)", () => {
    const events: TimelineEvent[] = [
      { kind: "text", text: "## heading\n\nparagraph\nwith lines" },
    ];
    expect(concatTextEvents(events)).toBe("## heading\n\nparagraph\nwith lines");
  });

  it("with tools used and intro+closing text, drops only the intro — the closing body wins", () => {
    const events: TimelineEvent[] = [
      { kind: "text", text: "Researching..." },
      { kind: "tool_use", id: "x", name: "WebSearch", input: "..." },
      { kind: "tool_result", toolUseId: "x", preview: "results", isError: false },
      { kind: "text", text: "Here is the complete body markdown ready to paste." },
    ];
    expect(concatTextEvents(events)).toBe("Here is the complete body markdown ready to paste.");
    expect(concatTextEvents(events)).not.toContain("Researching");
  });
});

describe("systemPromptFor — strengthened to force closing body after tools", () => {
  it("explicitly tells claude that the body is the text AFTER the last tool call", () => {
    const prompt = systemPromptFor({
      itemKey: "skill:t", kind: "skill", name: "t", description: "", body: "", attachedSkills: [],
    }, "writeBody");
    expect(prompt).toContain("AFTER your last tool call");
  });

  it("calls out the bug explicitly — a turn ending with only tools is a failure", () => {
    const prompt = systemPromptFor({
      itemKey: "skill:t", kind: "skill", name: "t", description: "", body: "", attachedSkills: [],
    }, "writeBody");
    expect(prompt).toMatch(/only tool calls and no closing body text/i);
    expect(prompt).toContain("failure");
  });

  it("specifically forbids the 'I'll research' style preamble", () => {
    const prompt = systemPromptFor({
      itemKey: "skill:t", kind: "skill", name: "t", description: "", body: "", attachedSkills: [],
    }, "writeBody");
    expect(prompt).toContain("I'll research");
  });
});

describe("encodeForClaudeProjects — matches Claude Code's actual encoding (every non-alphanumeric → '-')", () => {
  it("encodes path separators (regression: my old encoder only did this)", () => {
    expect(encodeForClaudeProjects("/Users/alex/code/foo")).toBe("-Users-alex-code-foo");
  });

  it("encodes a leading dot in a hidden directory (regression: the dot-was-preserved bug that broke streaming)", () => {
    expect(encodeForClaudeProjects("/Users/alex/.claude-trace")).toBe("-Users-alex--claude-trace");
  });

  it("encodes underscores (regression: path had skill_code-cleaning → must become skill-code-cleaning)", () => {
    expect(encodeForClaudeProjects("/foo/skill_code-cleaning")).toBe("-foo-skill-code-cleaning");
  });

  it("encodes a real assistant cwd (regression for the stuck-session bug)", () => {
    const cwd = "/Users/alex/.claude-trace/library-assistant/skill_code-cleaning";
    const encoded = encodeForClaudeProjects(cwd);
    expect(encoded).toBe("-Users-alex--claude-trace-library-assistant-skill-code-cleaning");
  });

  it("encodes the @ in email-like usernames", () => {
    expect(encodeForClaudeProjects("/home/alex@my-api.dev/x")).toBe("-home-alex-my-api-dev-x");
  });

  it("preserves existing dashes (does not double them)", () => {
    expect(encodeForClaudeProjects("/foo/a-b-c")).toBe("-foo-a-b-c");
  });

  it("preserves digits", () => {
    expect(encodeForClaudeProjects("/x/foo123/bar")).toBe("-x-foo123-bar");
  });
});

describe("LibraryAssistant.buildArgs — positional-message argv (the fix for the stuck-session bug)", () => {
  const ctx: AssistantContext = {
    itemKey: "skill:test",
    kind: "skill",
    name: "test",
    description: "",
    body: "",
    attachedSkills: [],
  };
  const makeAssistant = (): LibraryAssistant => new LibraryAssistant({
    hooks: {
      installHooks: () => "/tmp/fake-hooks.json",
      removeHooks: () => {},
      subscribeStop: () => ({ dispose: () => {} }),
    },
  });
  const makeAssistantWithPrefix = (): LibraryAssistant => new LibraryAssistant({
    claudeArgsPrefix: ["/tmp/mock-claude.js"],
    hooks: {
      installHooks: () => "/tmp/fake-hooks.json",
      removeHooks: () => {},
      subscribeStop: () => ({ dispose: () => {} }),
    },
  });

  const seedItem = (assistant: LibraryAssistant): void => {
    (assistant as unknown as { ensureItem: (c: AssistantContext, m: string) => unknown }).ensureItem(ctx, "writeBody");
  };

  it("first turn passes the user's message as the LAST positional argument, not via stdin", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "draft me a body")!;
    expect(args[args.length - 1]).toBe("draft me a body");
    expect(args).toContain("--session-id");
    expect(args).toContain("--append-system-prompt");
  });

  it("places configured launcher args before Claude flags", () => {
    const assistant = makeAssistantWithPrefix();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "draft me a body")!;
    expect(args[0]).toBe("/tmp/mock-claude.js");
    expect(args[1]).toBe("--session-id");
  });

  it("adds --model and --effort (before the message) when a model and effort are chosen", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "draft", "claude-opus-4-7", "high")!;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-7");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.length - 1]).toBe("draft");
  });

  it("omits --model and --effort when they are 'default'", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "draft", "default", "default")!;
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
  });

  it("first turn uses --session-id (a fresh session) NOT --resume", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "anything")!;
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  it("subsequent turn uses --resume (NOT --session-id) and DROPS --append-system-prompt", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const state = (assistant as unknown as { items: Map<string, { hasFirstTurn: boolean }> }).items.get("skill:test")!;
    state.hasFirstTurn = true;
    const args = assistant.buildArgsForTesting("skill:test", "second turn")!;
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--append-system-prompt");
    expect(args[args.length - 1]).toBe("second turn");
  });

  it("does NOT use --permission-mode bypassPermissions (regression: it triggered a confirm dialog that hung the session)", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "anything")!;
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBe(-1);
  });

  it("does NOT use --disallowedTools as a CLI flag (variadic flag would swallow the positional message — bug confirmed by e2e)", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "anything")!;
    expect(args).not.toContain("--disallowedTools");
  });

  it("ALWAYS passes the hooks file via --settings (so Stop signal fires on turn end)", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "anything")!;
    const idx = args.indexOf("--settings");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/tmp/fake-hooks.json");
  });

  it("argv never contains a literal '\\n' or whitespace-only message that would lose the prompt", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const args = assistant.buildArgsForTesting("skill:test", "real prompt")!;
    const message = args[args.length - 1]!;
    expect(message.length).toBeGreaterThan(0);
    expect(message.trim()).toBe(message);
  });

  it("messages containing shell metacharacters survive intact (argv, not shell-parsed)", () => {
    const assistant = makeAssistant();
    seedItem(assistant);
    const message = `produce a body with $VAR and "quoted" and 'apostrophe' and \`backticks\``;
    const args = assistant.buildArgsForTesting("skill:test", message)!;
    expect(args[args.length - 1]).toBe(message);
  });
});

describe("parseReply — SUGGESTED_DESCRIPTION extraction", () => {
  it("returns text unchanged when no sentinel is present", () => {
    expect(parseReply("Just the body.")).toEqual({
      text: "Just the body.",
      suggestedDescription: null,
    });
  });

  it("extracts the description and strips the sentinel line from the body", () => {
    const out = parseReply("Body here.\nSUGGESTED_DESCRIPTION: Reviews diffs.");
    expect(out.text).toBe("Body here.");
    expect(out.suggestedDescription).toBe("Reviews diffs.");
  });

  it("only takes the first SUGGESTED_DESCRIPTION when Claude accidentally emits two", () => {
    const input = "body\nSUGGESTED_DESCRIPTION: first\nSUGGESTED_DESCRIPTION: second";
    expect(parseReply(input).suggestedDescription).toBe("first");
  });

  it("handles SUGGESTED_DESCRIPTION at the very start of the response", () => {
    const out = parseReply("SUGGESTED_DESCRIPTION: just a desc\nbody after");
    expect(out.text).toBe("body after");
    expect(out.suggestedDescription).toBe("just a desc");
  });

  it("ignores 'SUGGESTED_DESCRIPTION:' that is part of a sentence (not at line start)", () => {
    const input = "We write SUGGESTED_DESCRIPTION: as a sentinel in the prompt.";
    expect(parseReply(input).suggestedDescription).toBe(null);
    expect(parseReply(input).text).toBe(input);
  });

  it("returns empty string text when only the sentinel was present", () => {
    expect(parseReply("SUGGESTED_DESCRIPTION: desc only")).toEqual({
      text: "",
      suggestedDescription: "desc only",
    });
  });
});
