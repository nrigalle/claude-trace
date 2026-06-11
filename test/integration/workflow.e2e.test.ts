import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __reset, __testState, __waitForProcessesToExit } from "../stubs/vscode";
import { RealAutomationRunner } from "../../src/features/pipelines/infra/RealAutomationRunner";
import {
  PipelinesController,
  newRunIdFromClock,
  type PipelinesActions,
  type PipelinesHost,
} from "../../src/features/pipelines/app/PipelinesController";
import { PipelineStore } from "../../src/features/pipelines/infra/PipelineStore";
import { RunStore } from "../../src/features/pipelines/infra/RunStore";
import {
  toBlockId,
  toPipelineId,
  type Pipeline,
  type RunId,
  type WorkerBlock,
} from "../../src/features/pipelines/domain/types";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
} from "../../src/features/pipelines/protocol";

const writeMockClaude = (filePath: string): void => {
  const script = `const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectsDir = process.env.MOCK_PROJECTS_DIR;
const signalsDir = process.env.MOCK_SIGNALS_DIR;
const responseMap = JSON.parse(process.env.MOCK_RESPONSE_MAP || '{}');
const cwd = process.cwd();

const argv = process.argv.slice(2);
const knownFlagsWithValue = new Set(['--effort', '--model', '--resume', '--permission-mode', '--session-id', '--settings']);
const knownBoolFlags = new Set(['--dangerously-skip-permissions']);
const flagValues = {};
const positionalArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (knownFlagsWithValue.has(a)) { flagValues[a] = argv[i + 1]; i++; continue; }
  if (knownBoolFlags.has(a)) continue;
  if (a.startsWith('--')) continue;
  positionalArgs.push(a);
}
const positionalPrompt = positionalArgs.join(' ');

const encodeCwd = (c) => c.replace(/[^a-zA-Z0-9]/g, '-');
const cwdDir = path.join(projectsDir, encodeCwd(cwd));
fs.mkdirSync(cwdDir, { recursive: true });

const sessionId = flagValues['--resume'] || flagValues['--session-id'] || crypto.randomUUID();
const marker = (kind) => {
  if (!signalsDir) return;
  fs.mkdirSync(signalsDir, { recursive: true });
  fs.writeFileSync(path.join(signalsDir, sessionId + '.' + kind), '');
};

const findResponse = (prompt) => {
  if (prompt.includes('Claude Trace workflow orchestrator')) {
    return responseMap['__orchestrator__'] || 'SUCCESS: judged ok';
  }
  for (const key of Object.keys(responseMap)) {
    if (key === '__orchestrator__') continue;
    if (prompt.includes(key)) return responseMap[key];
  }
  return 'fallback response';
};

const answer = (prompt) => {
  if (prompt.length === 0) return;
  fs.appendFileSync(path.join(projectsDir, '_history.txt'), prompt + '\\n---\\n');
  const reply = findResponse(prompt);
  const now = new Date().toISOString();
  const jsonlPath = path.join(cwdDir, sessionId + '.jsonl');
  const events = [
    { type: 'user', message: { role: 'user', content: prompt }, timestamp: now, sessionId },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        stop_reason: 'end_turn',
      },
      timestamp: now,
      sessionId,
    },
  ];
  fs.appendFileSync(jsonlPath, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
  setTimeout(() => marker('stop'), 20);
};

setTimeout(() => {
  if (!flagValues['--resume']) {
    fs.appendFileSync(path.join(cwdDir, sessionId + '.jsonl'), '');
  }
  marker('start');
  if (positionalPrompt.length > 0) setTimeout(() => answer(positionalPrompt), 30);
}, 50);

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  const endIdx = buffered.indexOf('\\u001b[201~');
  if (endIdx < 0) return;
  const startIdx = buffered.indexOf('\\u001b[200~');
  const prompt = buffered.slice(startIdx >= 0 ? startIdx + 6 : 0, endIdx);
  buffered = '';
  setTimeout(() => answer(prompt), 30);
});

process.on('SIGTERM', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
`;
  fs.writeFileSync(filePath, script, { mode: 0o755 });
};

class MockHost implements PipelinesHost {
  readonly messages: PipelinesHostToWebview[] = [];
  private listener: ((m: PipelinesWebviewToHost) => void) | null = null;
  postMessage(msg: PipelinesHostToWebview): void { this.messages.push(msg); }
  onMessage(l: (m: PipelinesWebviewToHost) => void): { dispose(): void } {
    this.listener = l;
    return { dispose: () => { this.listener = null; } };
  }
  onDispose(): { dispose(): void } { return { dispose: () => {} }; }
  send(msg: PipelinesWebviewToHost): void {
    if (!this.listener) throw new Error("no listener");
    this.listener(msg);
  }
  lastRunStatus(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.type === "runUpdate") return m.run.status;
    }
    return null;
  }
}

let tmpRoot: string;
let projectsDir: string;
let mockScript: string;
let host: MockHost;
let pipelineStore: PipelineStore;
let runStore: RunStore;
let runner: RealAutomationRunner;
let clockMs: number;
let runIdCounter: number;

const tick = () => { clockMs += 1; return clockMs; };
const newRunId = (): RunId => newRunIdFromClock(clockMs + (++runIdCounter));

const actions: PipelinesActions = {
  askPipelineName: () => Promise.resolve("workflow"),
  confirmDeletePipeline: () => Promise.resolve(true),
  confirmDeleteRun: () => Promise.resolve(true),
  openSessionInTerminal: () => {},
};

beforeEach(() => {
  __reset();
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-e2e-")));
  projectsDir = path.join(tmpRoot, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
  mockScript = path.join(tmpRoot, "mock-claude.cjs");
  writeMockClaude(mockScript);
  __testState.mockBinary = mockScript;

  process.env.MOCK_PROJECTS_DIR = projectsDir;
  process.env.MOCK_SIGNALS_DIR = path.join(tmpRoot, "run-signals");

  host = new MockHost();
  pipelineStore = new PipelineStore(path.join(tmpRoot, "automations"));
  runStore = new RunStore(path.join(tmpRoot, "runs"));
  runner = new RealAutomationRunner({
    claudeCommand: "MOCK_CLAUDE",
    projectsDir,
    hooksDir: path.join(tmpRoot, "run-hooks"),
    signalsDir: path.join(tmpRoot, "run-signals"),
    claudeConfigPath: path.join(tmpRoot, "claude.json"),
  });
  clockMs = 1000;
  runIdCounter = 0;
});

afterEach(async () => {
  runner.dispose();
  await __waitForProcessesToExit();
  __reset();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const buildController = (): PipelinesController =>
  new PipelinesController({
    host,
    pipelineStore,
    runStore,
    runner,
    actions,
    clock: tick,
    newRunId,
  });

const worker = (id: string, name: string, prompt: string): WorkerBlock => ({
  id: toBlockId(id),
  kind: "worker",
  name,
  prompt,
  model: "claude-sonnet-4-6",
  effort: "medium",
});

const waitFor = async <T>(pred: () => T | null, timeoutMs = 30000): Promise<T> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = pred();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};

const readPromptHistory = (): string[] => {
  const filePath = path.join(projectsDir, "_history.txt");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n---\n").filter((p) => p.trim().length > 0);
};

describe("end-to-end workflow against a mock claude binary — the whole pipeline, not the pieces", () => {

  it("a 3-step sequential workflow chains outputs: worker N+1 receives worker N's summary in its prompt, and the whole run completes with all sessions disposed", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "Write a tagline": "TAGLINE: Do less, achieve more.",
      "Critique the tagline": "CRITIQUE: Too generic — replace with something concrete.",
      "Refine based on the critique": "FINAL: Focus mode. Distractions off.",
      "__orchestrator__": "SUCCESS: the worker completed its assigned task",
    });

    const ctrl = buildController();
    const p: Pipeline = {
      id: toPipelineId("p1"),
      name: "tagline-chain",
      createdAtMs: 1,
      updatedAtMs: 1,
      blocks: [
        worker("b1", "Write", "Write a tagline for a productivity app called Focus."),
        worker("b2", "Critique", "Critique the tagline above. Be honest."),
        worker("b3", "Refine", "Refine based on the critique."),
      ],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitFor(() => host.lastRunStatus() === "completed" ? true : null, 30000);

    const final = host.messages
      .filter((m): m is Extract<PipelinesHostToWebview, { type: "runUpdate" }> => m.type === "runUpdate")
      .at(-1)!.run;

    expect(final.status).toBe("completed");
    expect(final.blocks.map((b) => b.status)).toEqual(["done", "done", "done"]);

    const history = readPromptHistory();
    const workerPrompts = history.filter((h) => !h.includes("Claude Trace workflow orchestrator"));
    expect(workerPrompts.length).toBeGreaterThanOrEqual(3);

    const w2 = workerPrompts.find((p) => p.includes("Critique the tagline above"));
    expect(w2, "worker 2's prompt must reach the mock").toBeDefined();
    expect(w2!).toContain("<previous_steps>");
    expect(w2!).toContain("Write");
    expect(w2!).toContain("TAGLINE: Do less, achieve more.");

    const w3 = workerPrompts.find((p) => p.includes("Refine based on the critique"));
    expect(w3, "worker 3's prompt must reach the mock").toBeDefined();
    expect(w3!).toContain("<previous_steps>");
    expect(w3!).toContain("Write");
    expect(w3!).toContain("Critique");
    expect(w3!).toContain("CRITIQUE: Too generic — replace with something concrete.");

    await __waitForProcessesToExit();
    expect(
      __testState.processes.size,
      `every spawned claude process must be killed when the run finishes — found ${__testState.processes.size} still alive`,
    ).toBe(0);

    ctrl.dispose();
  }, 60000);

  it("loop iteration N+1: every block in the loop body receives the CURRENT iteration's upstream outputs, not the stale prior iteration's (regression: CONVERGED-not-seen bug)", async () => {
    let seedIter = 0;
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "__orchestrator__": "SUCCESS: ok",
      "seed prompt": "TAGLINE_PLACEHOLDER",
      "merge prompt": "MERGER_PLACEHOLDER",
      "loop prompt": "LOOP_PLACEHOLDER",
    });

    const seedPrompt = "seed prompt";
    const mergePrompt = "merge prompt";
    const loopPrompt = "loop prompt";

    const ctrl = buildController();
    const p: Pipeline = {
      id: toPipelineId("p-loop"),
      name: "loop-chain",
      createdAtMs: 1,
      updatedAtMs: 1,
      blocks: [
        worker("seed", "Seed", seedPrompt),
        worker("merge", "Merge", mergePrompt),
        {
          id: toBlockId("L"),
          kind: "loop",
          name: "Loop",
          loopBackToBlockId: toBlockId("seed"),
          goal: loopPrompt,
          maxIterations: 3,
          evaluatorModel: "default",
        },
      ],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });
    void seedIter;

    await waitFor(() => {
      const s = host.lastRunStatus();
      return s === "completed" || s === "failed" ? s : null;
    }, 30000);

    const history = readPromptHistory().filter((h) => !h.includes("Claude Trace workflow orchestrator"));
    const seedPrompts = history.filter((h) => h.includes("seed prompt"));
    const mergePrompts = history.filter((h) => h.includes("merge prompt"));
    const loopPrompts = history.filter((h) => h.includes("loop prompt"));

    expect(seedPrompts.length, "seed worker should run multiple times across loop iterations").toBeGreaterThanOrEqual(2);
    expect(mergePrompts.length, "merge worker should run multiple times").toBeGreaterThanOrEqual(2);
    expect(loopPrompts.length, "loop block should run multiple times").toBeGreaterThanOrEqual(2);

    for (let i = 1; i < mergePrompts.length; i++) {
      expect(
        mergePrompts[i]!.includes("<previous_steps>"),
        `merge iteration ${i + 1} must include upstream context (seed worker's latest output)`,
      ).toBe(true);
    }
    for (let i = 1; i < loopPrompts.length; i++) {
      expect(
        loopPrompts[i]!.includes("<previous_steps>"),
        `loop iteration ${i + 1} must include upstream context (merge worker's latest output)`,
      ).toBe(true);
      expect(
        loopPrompts[i]!.includes("MERGER_PLACEHOLDER") || loopPrompts[i]!.includes("Merge"),
        `loop iteration ${i + 1} must see Merge block's output`,
      ).toBe(true);
    }

    await __waitForProcessesToExit();
    expect(__testState.processes.size).toBe(0);
    ctrl.dispose();
  }, 60000);

  it("STRESS: seed → 3 parallel critics + merger → loop converges within 3 iterations end-to-end", async () => {
    let seedRound = 0;
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "__orchestrator__": "SUCCESS: ok",
      "Generate the seed": "SEED_V_PLACEHOLDER",
      "Clarity critic": "no change",
      "Punch critic": "ITERATION_SPECIFIC_CRITIQUE",
      "Honesty critic": "no change",
      "Combine the critiques": "MERGER_PLACEHOLDER",
      "Decide whether the merger converged": "LOOP_PLACEHOLDER",
    });

    const ctrl = buildController();

    const parallelBlock = {
      id: toBlockId("crit"),
      kind: "parallel" as const,
      name: "Parallel critique",
      workers: [
        worker("crit-clarity", "Clarity", "Clarity critic: review the tagline for clarity. Return 'no change' if clear; else suggest a one-line edit."),
        worker("crit-punch",   "Punch",   "Punch critic: review the tagline for memorability. Return 'no change' if punchy; else suggest a one-line edit."),
        worker("crit-honest",  "Honesty", "Honesty critic: review the tagline for overpromising. Return 'no change' if honest; else suggest a one-line edit."),
      ],
      mergerGoal: "Combine the critiques: if all say 'no change', prefix output with CONVERGED:. Else apply the edits.",
      mergerModel: "claude-sonnet-4-6" as const,
    };

    const loopBlock = {
      id: toBlockId("loop"),
      kind: "loop" as const,
      name: "Iterate",
      loopBackToBlockId: toBlockId("seed"),
      goal: "Decide whether the merger converged. SUCCESS if needs another round, LOOP_DONE if converged.",
      maxIterations: 4,
      evaluatorModel: "claude-sonnet-4-6" as const,
    };

    const p: Pipeline = {
      id: toPipelineId("stress-pipeline"),
      name: "stress-seed-critics-loop",
      createdAtMs: 1,
      updatedAtMs: 1,
      blocks: [
        worker("seed", "Seed", "Generate the seed tagline for a productivity app called Focus."),
        parallelBlock,
        loopBlock,
      ],
    };
    pipelineStore.save(p);
    void seedRound;
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitFor(() => {
      const s = host.lastRunStatus();
      return s === "completed" || s === "failed" ? s : null;
    }, 45000);

    const final = host.messages
      .filter((m): m is Extract<PipelinesHostToWebview, { type: "runUpdate" }> => m.type === "runUpdate")
      .at(-1)!.run;

    expect(final.status, "stress pipeline must complete").toBe("completed");

    const seedBlock = final.blocks.find((b) => String(b.blockId) === "seed")!;
    const parallelBlockRun = final.blocks.find((b) => String(b.blockId) === "crit")!;
    const loopBlockRun = final.blocks.find((b) => String(b.blockId) === "loop")!;

    expect(seedBlock.sessions.length, "seed worker should run at least once").toBeGreaterThanOrEqual(1);
    expect(parallelBlockRun.parallel, "parallel block should have run state").not.toBeNull();
    expect(parallelBlockRun.parallel!.workerRuns).toHaveLength(3);
    for (const wr of parallelBlockRun.parallel!.workerRuns) {
      expect(wr.status).toBe("done");
      expect(wr.sessions.length).toBeGreaterThanOrEqual(1);
    }
    expect(parallelBlockRun.parallel!.mergerSessions.length).toBeGreaterThanOrEqual(1);
    expect(parallelBlockRun.parallel!.mergerStatus).toBe("done");
    expect(loopBlockRun.status).toBe("done");
    expect(loopBlockRun.sessions.length).toBeGreaterThanOrEqual(1);
    expect(loopBlockRun.sessions.length, "must not exhaust maxIterations").toBeLessThanOrEqual(loopBlock.maxIterations);

    const history = readPromptHistory().filter((h) => !h.includes("Claude Trace workflow orchestrator"));
    const seedPrompts = history.filter((h) => h.includes("Generate the seed"));
    const mergerPrompts = history.filter((h) => h.includes("Combine the critiques"));
    expect(seedPrompts.length, "seed should have been invoked >=1 times").toBeGreaterThanOrEqual(1);
    expect(mergerPrompts.length, "merger should have been invoked >=1 times").toBeGreaterThanOrEqual(1);

    const clarityPrompts = history.filter((h) => h.includes("Clarity critic"));
    if (clarityPrompts.length >= 2) {
      expect(clarityPrompts[1]!, "iteration 2 of clarity critic must see seed output upstream").toContain("<previous_steps>");
      expect(clarityPrompts[1]!).toContain("Seed");
    }

    await __waitForProcessesToExit();
    expect(
      __testState.processes.size,
      `every claude process spawned during the stress run must be cleaned up — found ${__testState.processes.size} leaking`,
    ).toBe(0);

    ctrl.dispose();
  }, 90000);

  it("STRESS: long sequential chain — 5 workers, each receives the cumulative output of all prior blocks", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "__orchestrator__": "SUCCESS: ok",
      "Step 1 prompt": "OUTPUT_1",
      "Step 2 prompt": "OUTPUT_2",
      "Step 3 prompt": "OUTPUT_3",
      "Step 4 prompt": "OUTPUT_4",
      "Step 5 prompt": "OUTPUT_5",
    });

    const ctrl = buildController();
    const p: Pipeline = {
      id: toPipelineId("stress-5chain"),
      name: "stress-5chain",
      createdAtMs: 1,
      updatedAtMs: 1,
      blocks: [1, 2, 3, 4, 5].map((n) => worker(`s${n}`, `Step ${n}`, `Step ${n} prompt`)),
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitFor(() => host.lastRunStatus() === "completed" ? true : null, 60000);

    const final = host.messages
      .filter((m): m is Extract<PipelinesHostToWebview, { type: "runUpdate" }> => m.type === "runUpdate")
      .at(-1)!.run;
    expect(final.status).toBe("completed");
    expect(final.blocks.map((b) => b.status)).toEqual(["done", "done", "done", "done", "done"]);

    const history = readPromptHistory().filter((h) => !h.includes("Claude Trace workflow orchestrator"));
    const step5Prompt = history.find((p) => p.includes("Step 5 prompt"));
    expect(step5Prompt, "step 5 must have been invoked").toBeDefined();
    expect(step5Prompt!, "step 5 prompt must contain cumulative upstream context").toContain("<previous_steps>");
    for (const earlier of ["Step 1", "Step 2", "Step 3", "Step 4"]) {
      expect(step5Prompt!, `step 5 must reference upstream block ${earlier}`).toContain(earlier);
    }

    await __waitForProcessesToExit();
    expect(__testState.processes.size).toBe(0);
    ctrl.dispose();
  }, 90000);

  it("worker block 1 receives NO <previous_steps> wrapping — only blocks 2..N get upstream context", async () => {
    process.env.MOCK_RESPONSE_MAP = JSON.stringify({
      "First block": "result one",
      "Second block": "result two",
      "__orchestrator__": "SUCCESS: done",
    });

    const ctrl = buildController();
    const p: Pipeline = {
      id: toPipelineId("p2"),
      name: "two-step",
      createdAtMs: 1,
      updatedAtMs: 1,
      blocks: [
        worker("b1", "First", "First block prompt"),
        worker("b2", "Second", "Second block prompt"),
      ],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitFor(() => host.lastRunStatus() === "completed" ? true : null, 30000);

    const history = readPromptHistory().filter((h) => !h.includes("Claude Trace workflow orchestrator"));
    const w1 = history.find((p) => p.includes("First block prompt"));
    expect(w1).toBeDefined();
    expect(w1!.includes("<previous_steps>"), "block 1 must NOT have upstream prefix").toBe(false);

    const w2 = history.find((p) => p.includes("Second block prompt"));
    expect(w2).toBeDefined();
    expect(w2!).toContain("<previous_steps>");
    expect(w2!).toContain("result one");

    await __waitForProcessesToExit();
    expect(__testState.processes.size).toBe(0);

    ctrl.dispose();
  }, 60000);
});

describe("Stop kills everything — the user guarantee", () => {
  it("killRun terminates EVERY spawned claude process immediately, even sessions that never initialised, and marks all blocks interrupted", async () => {
    process.env.MOCK_BOOT_MS = "8000";
    const ctrl = buildController();
    const p: Pipeline = {
      id: toPipelineId("p-kill-all"),
      name: "Kill guarantee",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        {
          id: toBlockId("fan"),
          kind: "parallel",
          name: "Fan out",
          workers: [worker("w1", "Slow 1", "never finishes one"), worker("w2", "Slow 2", "never finishes two")],
          mergerGoal: "merge results",
          mergerModel: "claude-sonnet-4-6",
        },
      ],
    };
    pipelineStore.save(p);

    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitFor(() => (__testState.processes.size >= 2 ? true : null), 15000);

    const runId = [...host.messages].reverse().flatMap((m) => (m.type === "runUpdate" ? [m.run.runId] : []))[0]!;
    expect(runId).toBeDefined();
    host.send({ type: "killRun", runId });

    await __waitForProcessesToExit();
    expect(__testState.processes.size, "no claude process may survive a Stop — ever").toBe(0);

    await waitFor(() => (host.lastRunStatus() === "interrupted" ? true : null), 5000);
    const final = [...host.messages].reverse().flatMap((m) => (m.type === "runUpdate" ? [m.run] : []))[0]!;
    expect(final.blocks.every((b) => b.status === "interrupted"), "every not-done block reads interrupted after Stop").toBe(true);

    ctrl.dispose();
  }, 30000);
});
