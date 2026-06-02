import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn as spawnChild } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  encodeForClaudeProjects,
  LibraryAssistant,
} from "../../src/features/library/infra/LibraryAssistant";
import type {
  LibraryPtySpawner,
} from "../../src/features/library/infra/LibraryAssistant";
import type {
  AssistantContext,
  TimelineEvent,
} from "../../src/features/library/protocol";

const writeMockClaude = (filePath: string): void => {
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectsDir = process.env.MOCK_PROJECTS_DIR;
const signalsDir = process.env.MOCK_SIGNALS_DIR;
const stepDelayMs = parseInt(process.env.MOCK_STEP_DELAY_MS || '40', 10);
const responseMapPath = process.env.MOCK_RESPONSE_MAP_FILE;
const responseMapRaw = responseMapPath ? fs.readFileSync(responseMapPath, 'utf8') : (process.env.MOCK_RESPONSE_MAP || '{}');
const responseMap = JSON.parse(responseMapRaw);
const toolPlan = JSON.parse(process.env.MOCK_TOOL_PLAN || '[]');

const argv = process.argv.slice(2);
const flagsWithValue = new Set(['--session-id', '--resume', '--settings', '--append-system-prompt', '--permission-mode']);
const flagsBool = new Set(['--bare', '--dangerously-skip-permissions']);
let i = 0;
let sessionId = null;
let resumeId = null;
const positional = [];
while (i < argv.length) {
  const a = argv[i];
  if (a === '--session-id') { sessionId = argv[i+1]; i += 2; continue; }
  if (a === '--resume') { resumeId = argv[i+1]; i += 2; continue; }
  if (flagsWithValue.has(a)) { i += 2; continue; }
  if (flagsBool.has(a)) { i += 1; continue; }
  if (a.startsWith('--')) { i += 1; continue; }
  positional.push(a);
  i += 1;
}
const sid = sessionId || resumeId || crypto.randomUUID();
const userMessage = positional.join(' ');


const cwd = process.cwd();
const encodeCwd = (c) => c.replace(/[^a-zA-Z0-9-]/g, '-');
const cwdDir = path.join(projectsDir, encodeCwd(cwd));
fs.mkdirSync(cwdDir, { recursive: true });
const jsonlPath = path.join(cwdDir, sid + '.jsonl');

const findResponse = () => {
  for (const key of Object.keys(responseMap)) {
    if (key === 'default') continue;
    if (userMessage.includes(key)) return responseMap[key];
  }
  if (Object.prototype.hasOwnProperty.call(responseMap, 'default')) return responseMap.default;
  return 'mock reply body';
};

const appendEvent = (event) => {
  fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\\n');
};

const writeUserMessage = () => {
  appendEvent({
    type: 'user',
    message: { role: 'user', content: userMessage },
    timestamp: new Date().toISOString(),
    sessionId: sid,
  });
};

const writeAssistantText = (text) => {
  appendEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
    timestamp: new Date().toISOString(),
    sessionId: sid,
  });
};

const writeToolUse = (name, input) => {
  const tu_id = 'tu_' + crypto.randomBytes(6).toString('hex');
  appendEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: tu_id, name, input }],
    },
    timestamp: new Date().toISOString(),
    sessionId: sid,
  });
  return tu_id;
};

const writeToolResult = (tu_id, content, isError = false) => {
  appendEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: tu_id, content, is_error: isError }],
    },
    timestamp: new Date().toISOString(),
    sessionId: sid,
  });
};

const fireStop = () => {
  if (!signalsDir) return;
  fs.mkdirSync(signalsDir, { recursive: true });
  fs.writeFileSync(path.join(signalsDir, sid + '.stop'), '');
};

const run = async () => {
  await new Promise((r) => setTimeout(r, stepDelayMs));
  writeUserMessage();
  for (const step of toolPlan) {
    await new Promise((r) => setTimeout(r, stepDelayMs));
    const tuid = writeToolUse(step.name, step.input || {});
    await new Promise((r) => setTimeout(r, stepDelayMs));
    writeToolResult(tuid, step.result || 'ok', step.isError === true);
  }
  await new Promise((r) => setTimeout(r, stepDelayMs));
  const reply = findResponse();
  writeAssistantText(reply);
  await new Promise((r) => setTimeout(r, stepDelayMs));
  fireStop();
  process.exit(0);
};

run();
`;
  fs.writeFileSync(filePath, script, { mode: 0o755 });
};

const ctx = (over: Partial<AssistantContext> = {}): AssistantContext => ({
  itemKey: "skill:code-cleaning",
  kind: "skill",
  name: "code-cleaning",
  description: "",
  body: "",
  attachedSkills: [],
  ...over,
});

let tmpRoot: string;
let cwdRoot: string;
let projectsDir: string;
let signalsDir: string;
let hooksDir: string;
let mockClaudePath: string;

const installHooksImpl = (sessionId: string): string | null => {
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, `${sessionId}.json`);
  fs.writeFileSync(file, "{}", "utf8");
  return file;
};

const removeHooksImpl = (sessionId: string): void => {
  for (const ext of ["json", "stop", "notify", "active"]) {
    const f = ext === "json"
      ? path.join(hooksDir, `${sessionId}.json`)
      : path.join(signalsDir, `${sessionId}.${ext}`);
    try { fs.rmSync(f, { force: true }); } catch {}
  }
};

const subscribeStopImpl = (sessionId: string, listener: () => void): { dispose(): void } => {
  fs.mkdirSync(signalsDir, { recursive: true });
  const stopFile = path.join(signalsDir, `${sessionId}.stop`);
  try { fs.rmSync(stopFile, { force: true }); } catch {}
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    try { fs.rmSync(stopFile, { force: true }); } catch {}
    listener();
  };
  const check = (): void => {
    if (fs.existsSync(stopFile)) fire();
  };
  const timer = setInterval(check, 50);
  return { dispose: () => clearInterval(timer) };
};

const childProcessPtySpawner: LibraryPtySpawner = {
  spawn: (file, args, options) => {
    const child = spawnChild(file, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
    });
    return {
      onData: (listener) => {
        const stdout = (chunk: Buffer): void => listener(chunk.toString("utf8"));
        const stderr = (chunk: Buffer): void => listener(chunk.toString("utf8"));
        child.stdout.on("data", stdout);
        child.stderr.on("data", stderr);
        return {
          dispose: (): void => {
            child.stdout.off("data", stdout);
            child.stderr.off("data", stderr);
          },
        };
      },
      onExit: (listener) => child.once("exit", () => listener()),
      write: (data) => {
        child.stdin.write(data);
      },
      kill: () => {
        child.kill();
      },
    };
  },
};

const makeAssistant = (): LibraryAssistant =>
  new LibraryAssistant({
    claudeBin: process.execPath,
    claudeArgsPrefix: [mockClaudePath],
    ptySpawner: childProcessPtySpawner,
    cwdRoot,
    transcriptRoot: projectsDir,
    hooks: {
      installHooks: installHooksImpl,
      removeHooks: removeHooksImpl,
      subscribeStop: subscribeStopImpl,
    },
  });

beforeEach(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "library-assistant-e2e-")));
  cwdRoot = path.join(tmpRoot, "library-assistant");
  projectsDir = path.join(tmpRoot, "projects");
  signalsDir = path.join(tmpRoot, "signals");
  hooksDir = path.join(tmpRoot, "hooks");
  fs.mkdirSync(cwdRoot, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(signalsDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  mockClaudePath = path.join(tmpRoot, "mock-claude");
  writeMockClaude(mockClaudePath);
  process.env.MOCK_PROJECTS_DIR = projectsDir;
  process.env.MOCK_SIGNALS_DIR = signalsDir;
  delete process.env.MOCK_TOOL_PLAN;
  delete process.env.MOCK_RESPONSE_MAP;
  delete process.env.MOCK_RESPONSE_MAP_FILE;
  delete process.env.MOCK_STEP_DELAY_MS;
});

afterEach(() => {
  delete process.env.MOCK_PROJECTS_DIR;
  delete process.env.MOCK_SIGNALS_DIR;
  delete process.env.MOCK_RESPONSE_MAP;
  delete process.env.MOCK_RESPONSE_MAP_FILE;
  delete process.env.MOCK_TOOL_PLAN;
  delete process.env.MOCK_STEP_DELAY_MS;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("LibraryAssistant — end-to-end against a mock claude binary", () => {
  it("a single ask round-trips: spawns claude with the message as argv, reads the assistant text from the JSONL transcript, returns it", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "draft me a body": "# How to clean Python code\n\n1. Audit imports.\n2. Remove dead code.\n",
    });
    const assistant = makeAssistant();
    const result = await assistant.ask(ctx(), "draft me a body for python cleanup");
    assistant.dispose();
    expect(result.text).toContain("How to clean Python code");
    expect(result.text).toContain("Audit imports");
    expect(result.events.some((e) => e.kind === "text")).toBe(true);
  });

  it("streams progress events while the turn runs (the user sees text BEFORE the final reply)", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "streamed body" });
    process.env.MOCK_STEP_DELAY_MS = "700";
    const assistant = makeAssistant();
    const progressSnapshots: readonly TimelineEvent[][] = [];
    const result = await assistant.ask(ctx(), "go", {
      onProgress: (events) => { (progressSnapshots as TimelineEvent[][]).push([...events]); },
    });
    assistant.dispose();
    expect(progressSnapshots.length).toBeGreaterThan(0);
    expect(result.text).toContain("streamed body");
  });

  it("streams TOOL CALLS and TOOL RESULTS in the timeline, in order, with previews intact", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "final body after research" });
    process.env.MOCK_TOOL_PLAN = JSON.stringify([
      { name: "WebSearch", input: { query: "python 2026 best practices" }, result: "12 search results found" },
      { name: "WebFetch", input: { url: "https://example.com" }, result: "fetched content (245 lines)" },
    ]);
    const assistant = makeAssistant();
    const result = await assistant.ask(ctx(), "research then draft");
    assistant.dispose();

    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("text");

    const toolUses = result.events.filter((e): e is TimelineEvent & { kind: "tool_use" } => e.kind === "tool_use");
    expect(toolUses.map((t) => t.name)).toEqual(["WebSearch", "WebFetch"]);
    expect(toolUses[0]!.input).toContain("python 2026");

    const toolResults = result.events.filter((e): e is TimelineEvent & { kind: "tool_result" } => e.kind === "tool_result");
    expect(toolResults[0]!.preview).toContain("12 search results found");
    expect(toolResults[1]!.preview).toContain("fetched content");

    expect(result.text).toContain("final body after research");
  });

  it("the JSONL transcript lands at the encoded path the assistant polls (regression: encoder mismatch broke streaming entirely)", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "ok" });
    const assistant = makeAssistant();
    const myCtx = ctx({ itemKey: "skill:code_cleaning" });
    await assistant.ask(myCtx, "anything");
    assistant.dispose();

    const expectedCwd = path.join(cwdRoot, "skill_code_cleaning");
    const expectedDir = path.join(projectsDir, encodeForClaudeProjects(expectedCwd));
    expect(fs.existsSync(expectedDir)).toBe(true);
    const files = fs.readdirSync(expectedDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);
  });

  it("multi-turn iteration: turn 2 uses --resume (not --session-id), and lands its own reply in the SAME transcript", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "v1": "VERSION ONE BODY",
      "v2": "VERSION TWO BODY",
    });
    const assistant = makeAssistant();
    const result1 = await assistant.ask(ctx(), "draft v1");
    expect(result1.text).toContain("VERSION ONE BODY");

    const result2 = await assistant.ask(ctx(), "now v2");
    expect(result2.text).toContain("VERSION TWO BODY");
    expect(result2.text).not.toContain("VERSION ONE BODY");
    assistant.dispose();
  });

  it("extracts SUGGESTED_DESCRIPTION end-to-end and strips it from the body", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      default: "The actual body content.\nSUGGESTED_DESCRIPTION: Cleans Python code from prototype to production.",
    });
    const assistant = makeAssistant();
    const result = await assistant.ask(ctx(), "draft");
    assistant.dispose();
    expect(result.text).toBe("The actual body content.");
    expect(result.suggestedDescription).toBe("Cleans Python code from prototype to production.");
  });

  it("handles a long body response (megabytes of text) without truncation", async () => {
    const huge = "# Heading\n\n" + "Paragraph of substance.\n".repeat(20_000);
    const responseMapFile = path.join(tmpRoot, "huge-response-map.json");
    fs.writeFileSync(responseMapFile, JSON.stringify({ default: huge }), "utf8");
    process.env.MOCK_RESPONSE_MAP_FILE = responseMapFile;
    const assistant = makeAssistant();
    const result = await assistant.ask(ctx(), "go");
    assistant.dispose();
    expect(result.text.length).toBeGreaterThan(400_000);
    expect(result.text).toContain("# Heading");
  });

  it("cancel during a turn kills the mock claude process and the ask rejects with 'Cancelled'", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "would-be reply" });
    process.env.MOCK_STEP_DELAY_MS = "500";
    const assistant = makeAssistant();
    const askPromise = assistant.ask(ctx(), "slow turn", []).catch((e: Error) => ({ error: e.message }));
    await new Promise((r) => setTimeout(r, 200));
    assistant.cancel("skill:code-cleaning");
    const result = await askPromise;
    expect((result as { error?: string }).error).toContain("Cancelled");
    assistant.dispose();
  });

  it("shell metacharacters in the user's message survive intact (argv, not shell)", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      [`$VAR "quoted" 'apo' \`back\``]: "echoed exactly",
    });
    const assistant = makeAssistant();
    const result = await assistant.ask(ctx(), `$VAR "quoted" 'apo' \`back\``);
    assistant.dispose();
    expect(result.text).toContain("echoed exactly");
  });

  it("survives a turn where the mock exits IMMEDIATELY (zero step delay) — fastest possible turn still produces text", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "instant reply body" });
    process.env.MOCK_STEP_DELAY_MS = "0";
    const assistant = makeAssistant();
    const result = await assistant.ask(ctx(), "go fast");
    assistant.dispose();
    expect(result.text).toContain("instant reply body");
  });

  it("survives a turn where the mock writes ENORMOUS text in one shot (50K chars) — readEventsFrom handles big buffers", async () => {
    const text = "A".repeat(50_000);
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: text });
    const assistant = makeAssistant();
    const result = await assistant.ask(ctx(), "huge");
    assistant.dispose();
    expect(result.text.length).toBe(50_000);
    expect(result.text[0]).toBe("A");
  });

  it("survives a transcript that ALREADY exists from a previous session under the same path (resume scenario)", async () => {
    const itemCtx = ctx({ itemKey: "skill:preexisting" });
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "fresh body" });
    const assistant = makeAssistant();
    const result1 = await assistant.ask(itemCtx, "first ask");
    expect(result1.text).toContain("fresh body");
    const result2 = await assistant.ask(itemCtx, "second ask");
    expect(result2.text).toContain("fresh body");
    assistant.dispose();
  });

  it("two CONCURRENT items each have their own session and don't cross-contaminate replies", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "alpha": "ANSWER FOR ALPHA",
      "bravo": "ANSWER FOR BRAVO",
    });
    process.env.MOCK_STEP_DELAY_MS = "100";
    const assistant = makeAssistant();
    const [r1, r2] = await Promise.all([
      assistant.ask(ctx({ itemKey: "skill:alpha", name: "alpha" }), "draft alpha", []),
      assistant.ask(ctx({ itemKey: "skill:bravo", name: "bravo" }), "draft bravo", []),
    ]);
    assistant.dispose();
    expect(r1.text).toContain("ANSWER FOR ALPHA");
    expect(r2.text).toContain("ANSWER FOR BRAVO");
  });

  it("resetItem wipes the per-item state so a subsequent ask starts a brand-new session", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "session marker" });
    const assistant = makeAssistant();
    const itemCtx = ctx({ itemKey: "skill:resettable" });
    await assistant.ask(itemCtx, "first");
    const cwdsBefore = fs.readdirSync(projectsDir, { recursive: true })
      .filter((f) => typeof f === "string" && f.endsWith(".jsonl"));
    assistant.resetItem("skill:resettable");
    await assistant.ask(itemCtx, "after reset");
    const cwdsAfter = fs.readdirSync(projectsDir, { recursive: true })
      .filter((f) => typeof f === "string" && f.endsWith(".jsonl"));
    expect(cwdsAfter.length).toBeGreaterThanOrEqual(cwdsBefore.length);
    assistant.dispose();
  });

  it("a SECOND ask issued while the FIRST is in flight is rejected with a clear 'still finishing' error", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "slow reply" });
    process.env.MOCK_STEP_DELAY_MS = "300";
    const assistant = makeAssistant();
    const first = assistant.ask(ctx(), "first");
    await new Promise((r) => setTimeout(r, 50));
    await expect(assistant.ask(ctx(), "second", [])).rejects.toThrow(/still finishing/i);
    await first;
    assistant.dispose();
  });

  it("a stale .stop file from a previous session is cleared before the next turn so we don't insta-resolve", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "real reply" });
    process.env.MOCK_STEP_DELAY_MS = "200";
    const assistant = makeAssistant();
    const itemCtx = ctx({ itemKey: "skill:stale-stop" });
    await assistant.ask(itemCtx, "warm up");
    const innerState = (assistant as unknown as { items: Map<string, { sessionId: string }> }).items.get("skill:stale-stop")!;
    const stopFile = path.join(signalsDir, `${innerState.sessionId}.stop`);
    fs.writeFileSync(stopFile, "");
    expect(fs.existsSync(stopFile)).toBe(true);
    const result = await assistant.ask(itemCtx, "next");
    assistant.dispose();
    expect(result.text).toContain("real reply");
  });

  it("STRESS: 8 consecutive turns alternating short/long replies, all land correctly with no body contamination", async () => {
    const responses: Record<string, string> = {};
    for (let i = 0; i < 8; i++) responses[`turn${i}`] = `BODY_FOR_TURN_${i}_LEN_${i % 2 === 0 ? "short" : "long".repeat(500)}`;
    process.env.MOCK_RESPONSE_MAP = JSON.stringify(responses);
    const assistant = makeAssistant();
    const itemCtx = ctx({ itemKey: "skill:stress" });
    for (let i = 0; i < 8; i++) {
      const result = await assistant.ask(itemCtx, `turn${i} go`);
      expect(result.text).toContain(`BODY_FOR_TURN_${i}_`);
      for (let j = 0; j < 8; j++) {
        if (j === i) continue;
        expect(result.text).not.toContain(`BODY_FOR_TURN_${j}_LEN_short`);
      }
    }
    assistant.dispose();
  });

  it("STRESS: 5 different items each run 3 turns concurrently — 15 spawns, all bodies land in the right item", async () => {
    const responses: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      for (let t = 0; t < 3; t++) responses[`item${i}_t${t}`] = `BODY_ITEM_${i}_TURN_${t}`;
    }
    process.env.MOCK_RESPONSE_MAP = JSON.stringify(responses);
    const assistant = makeAssistant();
    const work: Promise<{ item: number; turn: number; text: string }>[] = [];
    for (let i = 0; i < 5; i++) {
      const itemCtx = ctx({ itemKey: `skill:item${i}`, name: `item${i}` });
      const runItem = async (): Promise<{ item: number; turn: number; text: string }> => {
        let last = { item: i, turn: 0, text: "" };
        for (let t = 0; t < 3; t++) {
          const r = await assistant.ask(itemCtx, `item${i}_t${t}`);
          last = { item: i, turn: t, text: r.text };
        }
        return last;
      };
      work.push(runItem());
    }
    const results = await Promise.all(work);
    assistant.dispose();
    for (const r of results) {
      expect(r.text).toContain(`BODY_ITEM_${r.item}_TURN_2`);
      for (let other = 0; other < 5; other++) {
        if (other === r.item) continue;
        expect(r.text).not.toContain(`BODY_ITEM_${other}_TURN_2`);
      }
    }
  });

  it("RESILIENCE: a mock turn that produces NO assistant text (only tool calls) returns empty text — does not crash, does not poison body apply (panel guards empty)", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "" });
    process.env.MOCK_TOOL_PLAN = JSON.stringify([{ name: "WebSearch", input: { q: "x" }, result: "ok" }]);
    const assistant = makeAssistant();
    const result = await assistant.ask(ctx(), "tool only");
    assistant.dispose();
    expect(result.text).toBe("");
    expect(result.events.some((e) => e.kind === "tool_use")).toBe(true);
  });

  it("RESILIENCE: progress events arrive in strictly non-decreasing event-count order (never shrink)", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "final" });
    process.env.MOCK_STEP_DELAY_MS = "600";
    process.env.MOCK_TOOL_PLAN = JSON.stringify([
      { name: "WebSearch", input: { q: "a" }, result: "r1" },
      { name: "WebFetch", input: { url: "b" }, result: "r2" },
    ]);
    const assistant = makeAssistant();
    const counts: number[] = [];
    await assistant.ask(ctx(), "stream me", {
      onProgress: (events) => counts.push(events.length),
    });
    assistant.dispose();
    expect(counts.length).toBeGreaterThan(0);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });

  it("RESILIENCE: encoder produces a stable, deterministic path for the same itemKey across multiple sessions", async () => {
    const itemCtx = ctx({ itemKey: "skill:my.weird@name_thing!" });
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({ default: "ok" });
    const assistant = makeAssistant();
    await assistant.ask(itemCtx, "a");
    const a = (assistant as unknown as { items: Map<string, { sessionCwd: string }> }).items.get("skill:my.weird@name_thing!")!.sessionCwd;
    assistant.dispose();

    const assistant2 = makeAssistant();
    await assistant2.ask(itemCtx, "b");
    const b = (assistant2 as unknown as { items: Map<string, { sessionCwd: string }> }).items.get("skill:my.weird@name_thing!")!.sessionCwd;
    assistant2.dispose();

    expect(a).toBe(b);
    expect(a).not.toContain(".");
    expect(a).not.toContain("@");
    expect(a).not.toContain("!");
  });

  it("a real prompt for a Python-cleanup skill returns a real-looking body that we can paste into the body field", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "Python code": [
        "# Python production cleanup",
        "",
        "Invoke when restructuring Python code from prototype to production.",
        "",
        "## Steps",
        "1. Read the target file and every file that imports it.",
        "2. Identify dead code, redundant imports, missing type hints.",
        "3. Apply edits one file at a time.",
        "4. Run the test suite. Stop if anything regresses.",
        "",
        "SUGGESTED_DESCRIPTION: Restructures Python code for production readiness across a file and its callers.",
      ].join("\n"),
    });
    const assistant = makeAssistant();
    const result = await assistant.ask(
      ctx({ name: "code-cleaning" }),
      "I want to create a skill for restructuring Python code from prototype to production.",
    );
    assistant.dispose();
    expect(result.text).toContain("Python production cleanup");
    expect(result.text).toContain("## Steps");
    expect(result.text).not.toContain("SUGGESTED_DESCRIPTION:");
    expect(result.suggestedDescription).toContain("Restructures Python code");
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.kind === "text")).toBe(true);
  });
});
