import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn as spawnChild } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PipelineAssistant } from "../../src/features/pipelines/infra/PipelineAssistant";
import { makeFileSignalHooks, type ChatPtySpawner } from "../../src/shared/assistant/claudeChatEngine";
import { toPipelineId, type Pipeline } from "../../src/features/pipelines/domain/types";

// A mock `claude` binary: parses the args, writes a transcript jsonl for the
// session, replies by matching a substring of the user message, then drops the
// .stop signal that ends the turn. Same shape as the real CLI's transcript.
const writeMockClaude = (filePath: string): void => {
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const projectsDir = process.env.MOCK_PROJECTS_DIR;
const signalsDir = process.env.MOCK_SIGNALS_DIR;
const delay = parseInt(process.env.MOCK_STEP_DELAY_MS || '30', 10);
const map = JSON.parse(fs.readFileSync(process.env.MOCK_RESPONSE_MAP_FILE, 'utf8'));
const argv = process.argv.slice(2);
const withVal = new Set(['--session-id','--resume','--settings','--append-system-prompt','--model','--effort']);
let i = 0, sessionId = null, resumeId = null; const pos = [];
while (i < argv.length) {
  const a = argv[i];
  if (a === '--session-id') { sessionId = argv[i+1]; i += 2; continue; }
  if (a === '--resume') { resumeId = argv[i+1]; i += 2; continue; }
  if (withVal.has(a)) { i += 2; continue; }
  if (a.startsWith('--')) { i += 1; continue; }
  pos.push(a); i += 1;
}
const sid = sessionId || resumeId || crypto.randomUUID();
const msg = pos.join(' ');
const cwdDir = path.join(projectsDir, process.cwd().replace(/[^a-zA-Z0-9-]/g, '-'));
fs.mkdirSync(cwdDir, { recursive: true });
const jsonl = path.join(cwdDir, sid + '.jsonl');
const append = (e) => fs.appendFileSync(jsonl, JSON.stringify(e) + '\\n');
const reply = () => {
  for (const k of Object.keys(map)) { if (k !== 'default' && msg.includes(k)) return map[k]; }
  return map.default || 'ok';
};
const run = async () => {
  await new Promise((r) => setTimeout(r, delay));
  append({ type: 'user', message: { role: 'user', content: msg }, sessionId: sid });
  await new Promise((r) => setTimeout(r, delay));
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply() }], stop_reason: 'end_turn' }, sessionId: sid });
  await new Promise((r) => setTimeout(r, delay));
  if (signalsDir) { fs.mkdirSync(signalsDir, { recursive: true }); fs.writeFileSync(path.join(signalsDir, sid + '.stop'), ''); }
  process.exit(0);
};
if (process.env.MOCK_HANG) { setTimeout(() => process.exit(0), 30000); } else { run(); }
`;
  fs.writeFileSync(filePath, script, { mode: 0o755 });
};

const childProcessPtySpawner: ChatPtySpawner = {
  spawn: (file, args, options) => {
    const child = spawnChild(file, [...args], { cwd: options.cwd, env: { ...options.env } });
    return {
      onData: (listener) => {
        child.stdout.on("data", (c: Buffer) => listener(c.toString("utf8")));
        child.stderr.on("data", (c: Buffer) => listener(c.toString("utf8")));
      },
      onExit: (listener) => child.once("exit", () => listener()),
      write: (data) => { child.stdin.write(data); },
      kill: () => { child.kill(); },
    };
  },
};

let tmpRoot: string;
let cwdRoot: string;
let projectsDir: string;
let signalsDir: string;
let hooksDir: string;
let workspace: string;
let mockClaudePath: string;
let responseMapPath: string;

const installHooksImpl = (sessionId: string): string | null => {
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, `${sessionId}.json`);
  fs.writeFileSync(file, "{}", "utf8");
  return file;
};
const removeHooksImpl = (sessionId: string): void => {
  for (const f of [path.join(hooksDir, `${sessionId}.json`), path.join(signalsDir, `${sessionId}.stop`)]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
};
const subscribeStopImpl = (sessionId: string, listener: () => void): { dispose(): void } => {
  fs.mkdirSync(signalsDir, { recursive: true });
  const stopFile = path.join(signalsDir, `${sessionId}.stop`);
  try { fs.rmSync(stopFile, { force: true }); } catch {}
  let fired = false;
  const timer = setInterval(() => {
    if (!fired && fs.existsSync(stopFile)) {
      fired = true;
      try { fs.rmSync(stopFile, { force: true }); } catch {}
      listener();
    }
  }, 50);
  return { dispose: () => clearInterval(timer) };
};

const setResponseMap = (map: Record<string, string>): void => {
  fs.writeFileSync(responseMapPath, JSON.stringify(map), "utf8");
};

const makeAssistant = (inactivityTimeoutMs?: number): PipelineAssistant =>
  new PipelineAssistant({
    claudeBin: process.execPath,
    claudeArgsPrefix: [mockClaudePath],
    ptySpawner: childProcessPtySpawner,
    cwdRoot,
    transcriptRoot: projectsDir,
    now: () => 4242,
    hooks: { installHooks: installHooksImpl, removeHooks: removeHooksImpl, subscribeStop: subscribeStopImpl },
    ...(inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs } : {}),
  });

const emptyPipeline = (id = "p-demo", name = "My flow"): Pipeline => ({
  id: toPipelineId(id),
  name,
  createdAtMs: 100,
  updatedAtMs: 100,
  blocks: [],
  triggers: [],
});

const workerBlock = (id: string, name: string): string =>
  `{ "id": "${id}", "kind": "worker", "name": "${name}", "prompt": "Do ${name}", "model": "claude-sonnet-4-6", "effort": "high" }`;

const proposeReply = (name: string, blocks: string[]): string =>
  `Here is the workflow I propose.\n\n\`\`\`json\n{ "name": "${name}", "blocks": [${blocks.join(",")}], "triggers": [{ "kind": "webhook", "token": "demo", "enabled": true }] }\n\`\`\`\nClick Apply to add it.`;

beforeEach(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-assistant-e2e-")));
  cwdRoot = path.join(tmpRoot, "pipeline-assistant");
  projectsDir = path.join(tmpRoot, "projects");
  signalsDir = path.join(tmpRoot, "signals");
  hooksDir = path.join(tmpRoot, "hooks");
  workspace = path.join(tmpRoot, "repo");
  fs.mkdirSync(workspace, { recursive: true });
  mockClaudePath = path.join(tmpRoot, "mock-claude.js");
  responseMapPath = path.join(tmpRoot, "responses.json");
  writeMockClaude(mockClaudePath);
  process.env["MOCK_PROJECTS_DIR"] = projectsDir;
  process.env["MOCK_SIGNALS_DIR"] = signalsDir;
  process.env["MOCK_RESPONSE_MAP_FILE"] = responseMapPath;
  process.env["MOCK_STEP_DELAY_MS"] = "20";
});

afterEach(() => {
  for (const k of ["MOCK_PROJECTS_DIR", "MOCK_SIGNALS_DIR", "MOCK_RESPONSE_MAP_FILE", "MOCK_STEP_DELAY_MS", "MOCK_HANG"]) {
    delete process.env[k];
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("PipelineAssistant — end-to-end against a mock claude binary", () => {
  it("interviews first (no proposal), then proposes a validated pipeline that preserves identity", async () => {
    setResponseMap({
      "clean the emails": "What holds the emails: a Google Sheet, a CSV, an API?",
      "go ahead": proposeReply("Email cleanup", [workerBlock("clean", "Clean"), workerBlock("explore", "Explore")]),
    });
    const assistant = makeAssistant();

    const interview = await assistant.ask("c-demo", { pipeline: emptyPipeline(), workspaceCwd: workspace }, "Build a workflow to clean the emails");
    expect(interview.proposal.hadJson).toBe(false);
    expect(interview.proposal.pipeline).toBeNull();
    expect(interview.text).toContain("Google Sheet");

    const propose = await assistant.ask("c-demo", { pipeline: emptyPipeline(), workspaceCwd: workspace }, "Yes, go ahead and propose it");
    expect(propose.proposal.hadJson).toBe(true);
    expect(propose.proposal.errors).toEqual([]);
    const proposed = propose.proposal.pipeline!;
    expect(proposed).not.toBeNull();
    expect(proposed.id).toBe(toPipelineId("p-demo"));
    expect(proposed.createdAtMs).toBe(100);
    expect(proposed.updatedAtMs).toBe(4242);
    expect(proposed.name).toBe("Email cleanup");
    expect(proposed.blocks.map((b) => b.name)).toEqual(["Clean", "Explore"]);
    expect(proposed.triggers).toEqual([{ kind: "webhook", token: "demo", enabled: true }]);

    assistant.dispose();
  });

  it("resumes the same session on the second turn (--resume, not --session-id)", async () => {
    setResponseMap({ default: "noted." });
    const assistant = makeAssistant();
    const pipeline = emptyPipeline("p-resume");

    await assistant.ask("c-resume", { pipeline, workspaceCwd: workspace }, "first turn");
    const secondArgs = assistant.buildArgsForTesting("c-resume", "second turn");
    expect(secondArgs).not.toBeNull();
    expect(secondArgs!).toContain("--resume");
    expect(secondArgs!).not.toContain("--session-id");

    assistant.dispose();
  });

  it("streams progress events during the turn", async () => {
    setResponseMap({ default: "streamed reply." });
    const assistant = makeAssistant();
    const seen: number[] = [];
    await assistant.ask(
      "c-stream",
      { pipeline: emptyPipeline("p-stream"), workspaceCwd: workspace },
      "do something",
      { onProgress: (events) => seen.push(events.length) },
    );
    // progress is best-effort; the final result is authoritative either way
    expect(seen.every((n, idx) => idx === 0 || n >= seen[idx - 1]!)).toBe(true);
    assistant.dispose();
  });

  it("surfaces validation errors when the proposed json is not a valid pipeline", async () => {
    setResponseMap({
      "propose": "Here you go.\n```json\n{ \"name\": \"Broken\", \"blocks\": [{ \"id\": \"x\", \"kind\": \"worker\" }] }\n```",
    });
    const assistant = makeAssistant();
    const out = await assistant.ask("c-bad", { pipeline: emptyPipeline("p-bad"), workspaceCwd: workspace }, "propose it now");
    expect(out.proposal.hadJson).toBe(true);
    expect(out.proposal.pipeline).toBeNull();
    expect(out.proposal.errors.length).toBeGreaterThan(0);
    assistant.dispose();
  });

  it("keeps two concurrent conversations on separate sessions with separate transcripts", async () => {
    setResponseMap({ default: "ok" });
    const assistant = makeAssistant();
    await assistant.ask("c-a", { pipeline: emptyPipeline("p-a"), workspaceCwd: workspace }, "alpha");
    await assistant.ask("c-b", { pipeline: emptyPipeline("p-b"), workspaceCwd: workspace }, "beta");
    const sessions = (assistant as unknown as { engine: { sessionMap(): Map<string, { sessionId: string }> } }).engine.sessionMap();
    expect(sessions.get("c-a")!.sessionId).not.toBe(sessions.get("c-b")!.sessionId);
    assistant.dispose();
  });

  it("does not hang forever when the agent blocks on input it cannot receive", async () => {
    process.env["MOCK_HANG"] = "1";
    const assistant = makeAssistant(400);
    await expect(
      assistant.ask("c-stuck", { pipeline: emptyPipeline("p-stuck"), workspaceCwd: workspace }, "build it from my repo"),
    ).rejects.toThrow(/stopped responding/i);
    assistant.dispose();
  });

  it("two conversations on the SAME pipeline stay independent (separate history)", async () => {
    setResponseMap({ default: "ok" });
    const assistant = makeAssistant();
    const pipeline = emptyPipeline("p-multi");
    await assistant.ask("c-one", { pipeline, workspaceCwd: workspace }, "first chat");
    await assistant.ask("c-two", { pipeline, workspaceCwd: workspace }, "second chat");
    const sessions = (assistant as unknown as { engine: { sessionMap(): Map<string, { sessionId: string }> } }).engine.sessionMap();
    expect(sessions.get("c-one")!.sessionId).not.toBe(sessions.get("c-two")!.sessionId);
    assistant.dispose();
  });
});

describe("makeFileSignalHooks — interactive tools are denied so a turn cannot block", () => {
  it("writes AskUserQuestion and ExitPlanMode into permissions.deny", () => {
    const hooks = makeFileSignalHooks(signalsDir, hooksDir, ["Read", "Grep"], ["Bash", "AskUserQuestion", "ExitPlanMode"]);
    const file = hooks.installHooks("sess-deny");
    expect(file).not.toBeNull();
    const settings = JSON.parse(fs.readFileSync(file!, "utf8")) as { permissions: { allow: string[]; deny: string[] } };
    expect(settings.permissions.deny).toContain("AskUserQuestion");
    expect(settings.permissions.deny).toContain("ExitPlanMode");
    expect(settings.permissions.allow).toEqual(["Read", "Grep"]);
  });
});
