import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __reset, __testState, __waitForProcessesToExit } from "../stubs/vscode";
import { RealAutomationRunner } from "../../src/features/pipelines/infra/RealAutomationRunner";
import { toBlockId, toRunId } from "../../src/features/pipelines/domain/types";

const writeMockClaudeScript = (filePath: string): void => {
  const script = `const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectsDir = process.env.MOCK_PROJECTS_DIR;
const bootMs = parseInt(process.env.MOCK_BOOT_MS || '50', 10);
const responseLines = JSON.parse(process.env.MOCK_RESPONSE_LINES || '["ok"]');
const cwd = process.cwd();

const argv = process.argv.slice(2);
const effortFlagIdx = argv.indexOf('--effort');
if (effortFlagIdx !== -1) {
  const value = argv[effortFlagIdx + 1];
  const valid = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
  if (!valid.includes(value)) {
    process.stderr.write('MOCK_REJECTED: invalid --effort value: ' + JSON.stringify(value) + '\\n');
    process.exit(2);
  }
}

const knownFlagsWithValue = new Set(['--effort', '--model', '--resume', '--permission-mode']);
const knownBoolFlags = new Set(['--dangerously-skip-permissions']);
const positionalArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (knownFlagsWithValue.has(a)) { i++; continue; }
  if (knownBoolFlags.has(a)) continue;
  if (a.startsWith('--')) continue;
  positionalArgs.push(a);
}
const positionalPrompt = positionalArgs.join(' ');

const encodeCwd = (c) => c.replace(/[^a-zA-Z0-9]/g, '-');
const cwdDir = path.join(projectsDir, encodeCwd(cwd));
fs.mkdirSync(cwdDir, { recursive: true });

const sessionId = crypto.randomUUID();
let firstInputProcessed = false;

const writeJsonlOnce = (line) => {
  if (firstInputProcessed) return;
  firstInputProcessed = true;
  const now = new Date().toISOString();
  const jsonlPath = path.join(cwdDir, sessionId + '.jsonl');
  const events = [
    {
      type: 'user',
      message: { role: 'user', content: line },
      timestamp: now,
      sessionId,
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: responseLines.join('\\n') }],
        stop_reason: 'end_turn',
      },
      timestamp: now,
      sessionId,
    },
  ];
  fs.writeFileSync(jsonlPath, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
};

setTimeout(() => {
  if (positionalPrompt.length > 0) {
    writeJsonlOnce(positionalPrompt);
  } else {
    process.stdout.write('Ready. Type your prompt:\\n');
  }
}, bootMs);

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes('\\n')) {
    const idx = buffer.indexOf('\\n');
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim().length === 0) continue;
    if (line.startsWith('/effort')) {
      process.stderr.write('MOCK_REJECTED: /effort should be a CLI flag, not a TUI slash command\\n');
      process.exit(2);
    }
    writeJsonlOnce(line);
  }
});

process.on('SIGTERM', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
`;
  fs.writeFileSync(filePath, script, { mode: 0o755 });
};

let tmpRoot: string;
let projectsDir: string;
let runner: RealAutomationRunner;
let mockScript: string;

beforeEach(() => {
  __reset();
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-itest-")));
  projectsDir = path.join(tmpRoot, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });

  mockScript = path.join(tmpRoot, "mock-claude.cjs");
  writeMockClaudeScript(mockScript);
  __testState.mockBinary = mockScript;

  process.env.MOCK_PROJECTS_DIR = projectsDir;
  process.env.MOCK_TRUST_DIALOG = "0";
  process.env.MOCK_BOOT_MS = "80";
  process.env.MOCK_RESPONSE_LINES = JSON.stringify(["all done"]);

  runner = new RealAutomationRunner({
    claudeCommand: "MOCK_CLAUDE",
    projectsDir,
  });
});

afterEach(async () => {
  runner.dispose();
  await __waitForProcessesToExit();
  __reset();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const newWorkerCwd = (suffix: string): string => {
  const dir = path.join(tmpRoot, suffix);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
};

describe("RealAutomationRunner — end-to-end against a mock claude binary", () => {
  it("the initial prompt rides on the claude CLI itself as a positional arg — no TUI typing, no separate send step", async () => {
    const handle = await runner.spawn({
      runId: toRunId("r1"),
      blockId: toBlockId("b1"),
      cwd: newWorkerCwd("work1"),
      prompt: "Hello world prompt",
      model: "claude-sonnet-4-6",
      effort: "medium",
      resumeSessionId: null,
      signal: new AbortController().signal,
    });

    expect(handle.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(handle.jsonlPath)).toBe(true);

    const launchEntries = __testState.sentTexts.filter((s) => s.text.startsWith("MOCK_CLAUDE"));
    expect(launchEntries.length, "exactly one MOCK_CLAUDE invocation").toBe(1);
    expect(launchEntries[0]!.text).toContain("'Hello world prompt'");

    const promptOnlyEntries = __testState.sentTexts.filter((s) => s.text === "Hello world prompt");
    expect(promptOnlyEntries.length, "prompt must NOT be typed into the TUI separately").toBe(0);

    const submitEntries = __testState.sentTexts.filter((s) => s.text === "" && s.addNewLine);
    expect(submitEntries.length, "no separate Enter-press should be sent").toBe(0);

    const content = fs.readFileSync(handle.jsonlPath, "utf8");
    expect(content).toContain("Hello world prompt");
  });

  it("waitForTurnEnd resolves 'stopped' once the Stop event lands in the JSONL", async () => {
    const handle = await runner.spawn({
      runId: toRunId("r2"),
      blockId: toBlockId("b2"),
      cwd: newWorkerCwd("work2"),
      prompt: "do the work",
      model: "claude-sonnet-4-6",
      effort: "medium",
      resumeSessionId: null,
      signal: new AbortController().signal,
    });
    const turnEnd = await handle.waitForTurnEnd(Date.now() - 5000, new AbortController().signal);
    expect(turnEnd).toBe("stopped");
  });

  it("Abort during the boot delay rejects spawn and does NOT send the prompt", async () => {
    process.env.MOCK_BOOT_MS = "5000";
    const ctrl = new AbortController();
    const spawnPromise = runner.spawn({
      runId: toRunId("r3"),
      blockId: toBlockId("b3"),
      cwd: newWorkerCwd("work3"),
      prompt: "should not be sent",
      model: "claude-sonnet-4-6",
      effort: "medium",
      resumeSessionId: null,
      signal: ctrl.signal,
    });
    await new Promise((r) => setTimeout(r, 80));
    ctrl.abort();
    await expect(spawnPromise).rejects.toThrow();

    expect(__testState.sentTexts.some((s) => s.text === "should not be sent")).toBe(false);
  });

  it("handle.dispose triggers terminal.dispose so the underlying claude process is torn down", async () => {
    const handle = await runner.spawn({
      runId: toRunId("r4"),
      blockId: toBlockId("b4"),
      cwd: newWorkerCwd("work4"),
      prompt: "live then die",
      model: "default",
      effort: "medium",
      resumeSessionId: null,
      signal: new AbortController().signal,
    });
    const disposedBefore = __testState.disposedTerminalIds.length;
    handle.dispose();
    expect(__testState.disposedTerminalIds.length).toBe(disposedBefore + 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(__testState.processes.size).toBe(0);
  });

  it("effort is passed as a --effort CLI flag (NOT as a /effort TUI slash command) so it can't get concatenated with the prompt — regression for the 'lowWrite' bug", async () => {
    const handle = await runner.spawn({
      runId: toRunId("r5"),
      blockId: toBlockId("b5"),
      cwd: newWorkerCwd("work5"),
      prompt: "Write one tagline (max 8 words)",
      model: "default",
      effort: "low",
      resumeSessionId: null,
      signal: new AbortController().signal,
    });

    const launchLine = __testState.sentTexts.find((s) => s.text.startsWith("MOCK_CLAUDE"));
    expect(launchLine, "claude launch command must be recorded").toBeDefined();
    expect(launchLine!.text).toContain("--effort low");

    expect(__testState.sentTexts.some((s) => s.text === "/effort low")).toBe(false);
    expect(__testState.sentTexts.some((s) => s.text.includes("/effort"))).toBe(false);

    const content = fs.readFileSync(handle.jsonlPath, "utf8");
    expect(content).toContain("Write one tagline (max 8 words)");
    expect(content).not.toContain("/effort");
  });

  it("prompts containing single quotes, shell metacharacters, and newlines survive shell escaping and reach claude intact", async () => {
    const trickyPrompt = "It's a $TEST `whoami` \"with\" 'nested' quotes\nand a second line";
    const handle = await runner.spawn({
      runId: toRunId("r-shell"),
      blockId: toBlockId("b-shell"),
      cwd: newWorkerCwd("work-shell"),
      prompt: trickyPrompt,
      model: "default",
      effort: "medium",
      resumeSessionId: null,
      signal: new AbortController().signal,
    });
    const content = fs.readFileSync(handle.jsonlPath, "utf8");
    const userEventLine = content.split("\n").find((l) => l.includes('"type":"user"'));
    expect(userEventLine).toBeDefined();
    const parsed = JSON.parse(userEventLine!) as { message: { content: string } };
    expect(parsed.message.content).toBe(trickyPrompt);
  });

  it("every supported effort level lands in the --effort CLI flag without ever pasting a /effort line into the conversation", async () => {
    const levels = ["low", "medium", "high", "max"] as const;
    for (const level of levels) {
      __reset();
      __testState.mockBinary = mockScript;
      const handle = await runner.spawn({
        runId: toRunId(`r-eff-${level}`),
        blockId: toBlockId(`b-eff-${level}`),
        cwd: newWorkerCwd(`work-eff-${level}`),
        prompt: `effort ${level} prompt`,
        model: "default",
        effort: level,
        resumeSessionId: null,
        signal: new AbortController().signal,
      });
      const launchLine = __testState.sentTexts.find((s) => s.text.startsWith("MOCK_CLAUDE"));
      expect(launchLine!.text, `effort ${level} must be in CLI args`).toContain(`--effort ${level}`);
      expect(__testState.sentTexts.some((s) => s.text.includes("/effort"))).toBe(false);
      expect(fs.existsSync(handle.jsonlPath)).toBe(true);
      handle.dispose();
      await __waitForProcessesToExit();
    }
  });
});
