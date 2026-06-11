import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PipelinesController,
  newRunIdFromClock,
  type PipelinesActions,
  type PipelinesHost,
} from "../../../src/features/pipelines/app/PipelinesController";
import { StubAutomationRunner } from "../../stubs/StubAutomationRunner";
import { StubDeterministicRunner } from "../../stubs/StubDeterministicRunner";
import { PipelineStore } from "../../../src/features/pipelines/infra/PipelineStore";
import { RunStore } from "../../../src/features/pipelines/infra/RunStore";
import {
  initialRunState,
  applyBlockSpawned,
  applyBlockCrashed,
  applyInputPaused,
  applyInputSubmitted,
  applyBlockStopped,
  applyDecision,
} from "../../../src/features/pipelines/domain/scheduler";
import { AssistantSessionStore } from "../../../src/features/pipelines/infra/AssistantSessionStore";
import type { PipelineAssistant } from "../../../src/features/pipelines/infra/PipelineAssistant";
import {
  toBlockId,
  toPipelineId,
  type LoopBlock,
  type Pipeline,
  type RunId,
  type WorkerBlock,
} from "../../../src/features/pipelines/domain/types";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
} from "../../../src/features/pipelines/protocol";

const block = (id: string, name: string, prompt: string): WorkerBlock => ({
  id: toBlockId(id),
  kind: "worker",
  name,
  prompt,
  model: "default",
  effort: "medium",
});

const pipeline = (id: string, name: string, blocks: readonly WorkerBlock[]): Pipeline => ({
  id: toPipelineId(id),
  name,
  createdAtMs: 1,
  updatedAtMs: 1,
  blocks,
  triggers: [],
});

class MockHost implements PipelinesHost {
  readonly messages: PipelinesHostToWebview[] = [];
  private messageListener: ((m: PipelinesWebviewToHost) => void) | null = null;
  private disposeListener: (() => void) | null = null;

  postMessage(msg: PipelinesHostToWebview): void {
    this.messages.push(msg);
  }
  onMessage(listener: (m: PipelinesWebviewToHost) => void): { dispose(): void } {
    this.messageListener = listener;
    return { dispose: () => { this.messageListener = null; } };
  }
  onDispose(listener: () => void): { dispose(): void } {
    this.disposeListener = listener;
    return { dispose: () => { this.disposeListener = null; } };
  }

  send(msg: PipelinesWebviewToHost): void {
    if (!this.messageListener) throw new Error("No message listener attached");
    this.messageListener(msg);
  }

  fireDispose(): void {
    if (this.disposeListener) this.disposeListener();
  }

  messagesOfType<T extends PipelinesHostToWebview["type"]>(
    type: T,
  ): readonly Extract<PipelinesHostToWebview, { type: T }>[] {
    return this.messages.filter(
      (m): m is Extract<PipelinesHostToWebview, { type: T }> => m.type === type,
    );
  }
}

let tmp: string;
let host: MockHost;
let pipelineStore: PipelineStore;
let runStore: RunStore;
let clockMs: number;
let runIdCounter: number;
let nextName: string | null;
let confirmDelete: boolean;

const tick = () => { clockMs += 1; return clockMs; };
const newRunId = (): RunId => newRunIdFromClock(clockMs + (++runIdCounter));

const makeActions = (): PipelinesActions => ({
  askPipelineName: () => Promise.resolve(nextName),
  confirmDeletePipeline: () => Promise.resolve(confirmDelete),
  confirmDeleteRun: () => Promise.resolve(true),
  openSessionInTerminal: () => {},
});

const makeController = (runner = new StubAutomationRunner({ workerDurationMs: 1, judgeDurationMs: 1 })) =>
  new PipelinesController({
    host,
    pipelineStore,
    runStore,
    runner,
    deterministic: new StubDeterministicRunner(),
    actions: makeActions(),
    clock: tick,
    newRunId,
  });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-ctrl-"));
  host = new MockHost();
  pipelineStore = new PipelineStore(path.join(tmp, "automations"));
  runStore = new RunStore(path.join(tmp, "runs"));
  clockMs = 1000;
  runIdCounter = 0;
  nextName = "Default name";
  confirmDelete = true;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const waitForRunCompletion = async (
  pred: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for run condition");
};

const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("PipelinesController — basic messaging", () => {
  it("broadcasts the pipelines list when the webview signals ready", () => {
    makeController();
    pipelineStore.save(pipeline("p1", "Alpha", [block("b1", "Step", "Do")]));

    host.send({ type: "ready" });

    const list = host.messagesOfType("pipelinesList");
    expect(list).toHaveLength(1);
    expect(list[0]!.payload.pipelines.map((p) => p.name)).toEqual(["Alpha"]);
  });

  it("create silently aborts when the user cancels the host name prompt", async () => {
    nextName = null;
    makeController();
    host.send({ type: "createPipeline" });
    await flushMicrotasks();
    expect(pipelineStore.list()).toHaveLength(0);
    expect(host.messagesOfType("pipelineDetail")).toHaveLength(0);
  });

  it("create with an empty trimmed name surfaces a warning notice and does not persist", async () => {
    nextName = "   ";
    makeController();
    host.send({ type: "createPipeline" });
    await flushMicrotasks();
    const notices = host.messagesOfType("notice");
    expect(notices.some((n) => n.level === "warning")).toBe(true);
    expect(pipelineStore.list()).toHaveLength(0);
  });

  it("create with a valid name persists a new pipeline and broadcasts both list and detail", async () => {
    nextName = "My pipeline";
    makeController();
    host.send({ type: "createPipeline" });
    await flushMicrotasks();

    expect(pipelineStore.list()).toHaveLength(1);
    expect(host.messagesOfType("pipelinesList")).toHaveLength(1);
    expect(host.messagesOfType("pipelineDetail")).toHaveLength(1);
  });

  it("save with validation errors returns a validationFailed message and does NOT persist", () => {
    makeController();
    const p = pipeline("p1", "", [block("b1", "Step", "Do")]);
    host.send({ type: "savePipeline", pipeline: p });

    const failures = host.messagesOfType("validationFailed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.errors.some((e) => e.code === "empty-name")).toBe(true);
    expect(pipelineStore.list()).toHaveLength(0);
  });

  it("save with a valid pipeline bumps updatedAtMs to the controller clock and persists", () => {
    makeController();
    const original = pipeline("p1", "Original", [block("b1", "Step", "Do")]);
    pipelineStore.save(original);
    clockMs = 9000;

    host.send({ type: "savePipeline", pipeline: { ...original, name: "Renamed" } });

    const stored = pipelineStore.get(original.id);
    expect(stored?.name).toBe("Renamed");
    expect(stored?.updatedAtMs).toBeGreaterThan(8999);
  });

  it("delete asks the host to confirm, then removes the pipeline when accepted", async () => {
    confirmDelete = true;
    makeController();
    pipelineStore.save(pipeline("p1", "Alpha", [block("b1", "Step", "Do")]));
    host.send({ type: "deletePipeline", pipelineId: toPipelineId("p1") });
    await flushMicrotasks();

    expect(pipelineStore.list()).toHaveLength(0);
    expect(host.messagesOfType("pipelinesList")).toHaveLength(1);
  });

  it("delete keeps the pipeline when the host confirmation is cancelled", async () => {
    confirmDelete = false;
    makeController();
    pipelineStore.save(pipeline("p1", "Alpha", [block("b1", "Step", "Do")]));
    host.send({ type: "deletePipeline", pipelineId: toPipelineId("p1") });
    await flushMicrotasks();

    expect(pipelineStore.list()).toHaveLength(1);
  });
});

describe("PipelinesController — run lifecycle (stub runner)", () => {
  it("runs a 3-step pipeline to completion when the orchestrator always succeeds", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "done" }),
    });
    makeController(runner);

    const p = pipeline("p1", "Three step", [
      block("a", "Plan", "Plan"),
      block("b", "Implement", "Implement"),
      block("c", "Verify", "Verify"),
    ]);
    pipelineStore.save(p);

    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(final.blocks.map((b) => b.status)).toEqual(["done", "done", "done"]);
  });

  it("refuses a second run while one is already active", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 50,
      judgeDurationMs: 1,
    });
    makeController(runner);

    const p = pipeline("p1", "Slow", [block("b1", "Slow step", "Wait")]);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });
    await new Promise((r) => setTimeout(r, 5));

    host.send({ type: "runPipeline", pipelineId: p.id });
    const notices = host.messagesOfType("notice");
    expect(notices.some((n) => n.level === "warning" && /already running/i.test(n.message))).toBe(true);

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });
  });

  it("keeps watching a stuck block and completes once a later judgement returns success — no Resume button needed", async () => {
    let judgeCalls = 0;
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => {
        judgeCalls += 1;
        if (judgeCalls === 1) return { kind: "needs-input", reason: "what next?" };
        return { kind: "success", summary: "user clarified in the terminal" };
      },
    });
    makeController(runner);

    const p = pipeline("p1", "Patient", [block("a", "Step", "Do")]);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(final.blocks[0]!.status).toBe("done");
    expect(final.blocks[0]!.sessions[0]!.summary).toBe("user clarified in the terminal");
    expect(judgeCalls).toBe(2);

    const intermediateStuck = host.messagesOfType("runUpdate").some(
      (m) => m.run.status === "paused-needs-input",
    );
    expect(intermediateStuck).toBe(true);
  });

  it("refuses to run a pipeline whose definition is invalid", () => {
    makeController();
    const p = pipeline("p1", "Empty", []);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    const failures = host.messagesOfType("validationFailed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.errors.some((e) => e.code === "no-blocks")).toBe(true);
  });

  it("persists the final RunState to disk so it appears in the run history", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "done" }),
    });
    makeController(runner);

    const p = pipeline("p1", "One", [block("b1", "Only", "Do")]);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    const summaries = runStore.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.status).toBe("completed");
  });
});

describe("PipelinesController — loop iteration (the backend integration test)", () => {
  it("runs Worker A → Worker B → Loop(target=A) for exactly maxIterations rounds then completes", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "iteration complete" }),
    });
    makeController(runner);

    const workerA = block("a", "Worker A", "Plan");
    const workerB = block("b", "Worker B", "Implement");
    const loop = {
      id: toBlockId("L"),
      kind: "loop" as const,
      name: "Refine until done",
      loopBackToBlockId: toBlockId("a"),
      goal: "Stop after refinement converges",
      maxIterations: 3,
      evaluatorModel: "claude-sonnet-4-6" as const,
    };
    const p: Pipeline = {
      id: toPipelineId("p1"),
      name: "With loop",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [workerA, workerB, loop],
    };
    pipelineStore.save(p);

    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;

    expect(final.blocks).toHaveLength(3);
    expect(final.blocks[0]!.sessions).toHaveLength(3);
    expect(final.blocks[1]!.sessions).toHaveLength(3);
    expect(final.blocks[2]!.sessions).toHaveLength(3);

    expect(final.blocks[0]!.sessions.map((s) => s.iteration)).toEqual([0, 1, 2]);
    expect(final.blocks[2]!.sessions.map((s) => s.iteration)).toEqual([0, 1, 2]);

    for (const blockRun of final.blocks) {
      for (const session of blockRun.sessions) {
        expect(session.summary).toBe("iteration complete");
        expect(session.endedAtMs).not.toBeNull();
      }
    }

    expect(final.blocks.map((b) => b.status)).toEqual(["done", "done", "done"]);
    expect(final.status).toBe("completed");
  });

  it("LOOP_DONE stops the loop early — does NOT iterate to maxIterations (regression: convergence-not-respected bug)", async () => {
    let loopJudgeCalls = 0;
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: (opts) => {
        if (opts.taskGoal.includes("Loop evaluator")) {
          loopJudgeCalls += 1;
          if (loopJudgeCalls === 1) return { kind: "success", summary: "iterate" };
          return { kind: "loop-done", summary: "converged" };
        }
        return { kind: "success", summary: "ok" };
      },
    });
    makeController(runner);

    const p: Pipeline = {
      id: toPipelineId("p-loopdone"),
      name: "loop-stops-early",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        block("a", "A", "do A"),
        {
          id: toBlockId("L"),
          kind: "loop",
          name: "Loop",
          loopBackToBlockId: toBlockId("a"),
          goal: "stop on converge",
          maxIterations: 10,
          evaluatorModel: "default",
        },
      ],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(final.status).toBe("completed");
    expect(final.blocks[0]!.sessions.length, "Block A should have run exactly 2 times (SUCCESS then LOOP_DONE)").toBe(2);
    expect(final.blocks[1]!.sessions.length, "Loop should have run exactly 2 times — LOOP_DONE on iter 2 must STOP further iteration").toBe(2);
    expect(loopJudgeCalls).toBe(2);
  });

  it("a Loop block that reports needs-input keeps watching its terminal — the next judgement decides whether to iterate", async () => {
    let callCount = 0;
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => {
        callCount += 1;
        if (callCount === 3) return { kind: "needs-input", reason: "needs guidance" };
        if (callCount === 4) return { kind: "loop-done", summary: "user said stop" };
        return { kind: "success", summary: "ok" };
      },
    });
    makeController(runner);

    const p: Pipeline = {
      id: toPipelineId("p1"),
      name: "Stuck loop",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        block("a", "A", "do A"),
        block("b", "B", "do B"),
        {
          id: toBlockId("L"),
          kind: "loop",
          name: "Loop",
          loopBackToBlockId: toBlockId("a"),
          goal: "stop when done",
          maxIterations: 5,
          evaluatorModel: "default",
        },
      ],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(final.blocks[2]!.status).toBe("done");
    expect(final.blocks[2]!.sessions[0]!.summary).toBe("user said stop");
    const everPaused = host.messagesOfType("runUpdate").some(
      (m) => m.run.status === "paused-needs-input",
    );
    expect(everPaused).toBe(true);
  });
});

describe("PipelinesController — parallel blocks", () => {
  it("runs every parallel worker as its own session, merges, and completes", async () => {
    const judgeTargets: string[] = [];
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: (opts) => {
        judgeTargets.push(opts.taskGoal.slice(0, 40));
        return { kind: "success", summary: `summary for: ${opts.taskGoal.slice(0, 30)}` };
      },
    });
    makeController(runner);

    const parallel = {
      id: toBlockId("P"),
      kind: "parallel" as const,
      name: "Two-worker fanout",
      workers: [
        { id: toBlockId("p-w1"), kind: "worker" as const, name: "Researcher", prompt: "Research X", model: "default" as const, effort: "medium" as const },
        { id: toBlockId("p-w2"), kind: "worker" as const, name: "Critic", prompt: "Critique X", model: "default" as const, effort: "medium" as const },
      ],
      mergerGoal: "Combine both",
      mergerModel: "claude-sonnet-4-6" as const,
    };
    const p: Pipeline = {
      id: toPipelineId("p1"),
      name: "Has parallel",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [parallel],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    const blockRun = final.blocks[0]!;
    expect(blockRun.parallel).not.toBeNull();
    expect(blockRun.parallel!.workerRuns).toHaveLength(2);
    expect(blockRun.parallel!.workerRuns.map((w) => w.status)).toEqual(["done", "done"]);
    expect(blockRun.parallel!.workerRuns[0]!.sessions[0]!.sessionId).not.toBe(
      blockRun.parallel!.workerRuns[1]!.sessions[0]!.sessionId,
    );
    expect(blockRun.parallel!.mergerStatus).toBe("done");
    expect(blockRun.parallel!.mergerSessions).toHaveLength(1);
    expect(blockRun.status).toBe("done");
    expect(judgeTargets.length).toBe(3);
  });

  it("when one parallel worker is stuck, the bubble status flips to stuck and the worker keeps watching for the next turn — eventually completing the block", async () => {
    let critiqueCallCount = 0;
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: (opts) => {
        if (opts.taskGoal.startsWith("Critique")) {
          critiqueCallCount += 1;
          if (critiqueCallCount === 1) return { kind: "needs-input", reason: "what angle?" };
          return { kind: "success", summary: "angle decided" };
        }
        return { kind: "success", summary: "ok" };
      },
    });
    makeController(runner);

    const parallel = {
      id: toBlockId("P"),
      kind: "parallel" as const,
      name: "fanout",
      workers: [
        { id: toBlockId("p-w1"), kind: "worker" as const, name: "Researcher", prompt: "Research X", model: "default" as const, effort: "medium" as const },
        { id: toBlockId("p-w2"), kind: "worker" as const, name: "Critic", prompt: "Critique X", model: "default" as const, effort: "medium" as const },
      ],
      mergerGoal: "Combine",
      mergerModel: "default" as const,
    };
    const p: Pipeline = {
      id: toPipelineId("p1"),
      name: "stuck-one",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [parallel],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    }, 5000);

    const seenStuckCritic = host.messagesOfType("runUpdate").some((m) => {
      const pblock = m.run.blocks[0]?.parallel;
      return !!pblock && pblock.workerRuns.some((w) => w.workerBlockId === toBlockId("p-w2") && w.status === "stuck");
    });
    expect(seenStuckCritic).toBe(true);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(final.blocks[0]!.parallel!.workerRuns.map((w) => w.status)).toEqual(["done", "done"]);
    expect(final.status).toBe("completed");
  });

  it("one parallel worker failing cancels its siblings and fails the block fast", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 200,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "ok" }),
      crashOnPrompt: (prompt) => prompt === "BadTask",
    });
    makeController(runner);

    const parallel = {
      id: toBlockId("P"),
      kind: "parallel" as const,
      name: "one-fails",
      workers: [
        { id: toBlockId("p-good"), kind: "worker" as const, name: "Good", prompt: "GoodTask", model: "default" as const, effort: "medium" as const },
        { id: toBlockId("p-bad"), kind: "worker" as const, name: "Bad", prompt: "BadTask", model: "default" as const, effort: "medium" as const },
      ],
      mergerGoal: "Combine",
      mergerModel: "default" as const,
    };
    const p: Pipeline = {
      id: toPipelineId("p1"),
      name: "fail-one",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [parallel],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "failed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(final.status).toBe("failed");
    expect(final.blocks[0]!.status).toBe("failed");
    expect(final.blocks[0]!.parallel!.mergerStatus).not.toBe("done");
  });
});

describe("PipelinesController — runs list contents broadcast (UX regression coverage)", () => {
  it("deleting a run removes it from the next pipelinesList broadcast so the UI sees it gone", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "done" }),
    });
    makeController(runner);

    const p = pipeline("p1", "Demo", [block("b1", "Only", "Do")]);
    pipelineStore.save(p);

    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });
    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitForRunCompletion(() => {
      const completedRuns = host.messagesOfType("runUpdate").filter((m) => m.run.status === "completed");
      return completedRuns.length >= 2;
    });

    const before = host.messagesOfType("pipelinesList").at(-1)!;
    expect(before.payload.runs.length).toBeGreaterThanOrEqual(2);
    const target = before.payload.runs[0]!.runId;

    host.send({ type: "deleteRun", runId: target });
    await flushMicrotasks();
    await flushMicrotasks();

    const after = host.messagesOfType("pipelinesList").at(-1)!;
    expect(after.payload.runs.find((r) => r.runId === target)).toBeUndefined();
    expect(after.payload.runs.length).toBe(before.payload.runs.length - 1);
  });

  it("after deletion the broadcast arrives BEFORE any further user action — the host doesn't wait for a refresh", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "done" }),
    });
    makeController(runner);
    const p = pipeline("p1", "Demo", [block("b1", "Only", "Do")]);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    const broadcastsBefore = host.messagesOfType("pipelinesList").length;
    const target = runStore.list()[0]!.runId;
    host.send({ type: "deleteRun", runId: target });
    await flushMicrotasks();
    await flushMicrotasks();

    const broadcastsAfter = host.messagesOfType("pipelinesList").length;
    expect(broadcastsAfter, "deleteRun must trigger at least one fresh pipelinesList broadcast").toBeGreaterThan(broadcastsBefore);
  });
});

describe("PipelinesController — terminal lifecycle", () => {
  it("disposes a worker's session as soon as its block succeeds — runtime footprint stays flat across long pipelines", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "ok" }),
    });
    makeController(runner);

    const blocks = Array.from({ length: 6 }, (_, i) => block(`b${i}`, `Block ${i}`, `Do ${i}`));
    const p = pipeline("p1", "Long chain", blocks);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    const peaks: number[] = [];
    const poller = setInterval(() => peaks.push(runner.activeSessionCount()), 2);

    try {
      await waitForRunCompletion(() => {
        const runs = host.messagesOfType("runUpdate");
        return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
      });
    } finally {
      clearInterval(poller);
    }

    expect(runner.activeSessionCount()).toBe(0);
    expect(Math.max(...peaks, 0)).toBeLessThanOrEqual(2);
  });

  it("a successful parallel block frees all worker and merger sessions before the next block starts", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "ok" }),
    });
    makeController(runner);

    const parallel = {
      id: toBlockId("P"),
      kind: "parallel" as const,
      name: "Fanout",
      workers: [
        { id: toBlockId("pw1"), kind: "worker" as const, name: "W1", prompt: "P1", model: "default" as const, effort: "medium" as const },
        { id: toBlockId("pw2"), kind: "worker" as const, name: "W2", prompt: "P2", model: "default" as const, effort: "medium" as const },
        { id: toBlockId("pw3"), kind: "worker" as const, name: "W3", prompt: "P3", model: "default" as const, effort: "medium" as const },
      ],
      mergerGoal: "merge",
      mergerModel: "default" as const,
    };
    const p: Pipeline = {
      id: toPipelineId("p1"),
      name: "Has parallel",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [parallel, block("after", "After", "Do after")],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    expect(runner.activeSessionCount()).toBe(0);
  });

  it("loop iterations dispose their per-iteration sessions — no accumulation across iterations", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "iter ok" }),
    });
    makeController(runner);

    const loop: LoopBlock = {
      id: toBlockId("L"),
      kind: "loop",
      name: "Loop",
      loopBackToBlockId: toBlockId("a"),
      goal: "converge",
      maxIterations: 4,
      evaluatorModel: "default",
    };
    const p: Pipeline = {
      id: toPipelineId("p1"),
      name: "Iterates",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [block("a", "A", "do A"), block("b", "B", "do B"), loop],
    };
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });

    const peaks: number[] = [];
    const poller = setInterval(() => peaks.push(runner.activeSessionCount()), 2);

    try {
      await waitForRunCompletion(() => {
        const runs = host.messagesOfType("runUpdate");
        return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
      }, 5000);
    } finally {
      clearInterval(poller);
    }

    expect(runner.activeSessionCount()).toBe(0);
    expect(Math.max(...peaks, 0)).toBeLessThanOrEqual(2);
  });
});

describe("PipelinesController — delete run", () => {
  it("deleteRun removes the run from disk and rebroadcasts the list", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "done" }),
    });
    makeController(runner);

    const p = pipeline("p1", "One", [block("b1", "Only", "Do")]);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    expect(runStore.list()).toHaveLength(1);
    const runId = runStore.list()[0]!.runId;

    const beforeDeleteCount = host.messagesOfType("pipelinesList").length;
    host.send({ type: "deleteRun", runId });
    await flushMicrotasks();

    expect(runStore.list()).toHaveLength(0);
    expect(host.messagesOfType("pipelinesList").length).toBeGreaterThan(beforeDeleteCount);
  });

  it("deleteRun refuses to delete a run that is currently active and emits a warning", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 200,
      judgeDurationMs: 1,
    });
    makeController(runner);

    const p = pipeline("p1", "Slow", [block("b1", "Slow", "Wait")]);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });
    await new Promise((r) => setTimeout(r, 5));

    const runId = runStore.list()[0]!.runId;
    host.send({ type: "deleteRun", runId });
    await flushMicrotasks();

    expect(runStore.list()).toHaveLength(1);
    expect(host.messagesOfType("notice").some((n) => n.level === "warning" && /currently active/i.test(n.message))).toBe(true);

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });
  });

  it("deleteRun honours the user's cancellation — does NOT delete when confirm returns false", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "success", summary: "done" }),
    });
    let confirmAnswer = false;
    const ctrl = new PipelinesController({
      host,
      pipelineStore,
      runStore,
      runner,
      deterministic: new StubDeterministicRunner(),
      actions: {
        askPipelineName: () => Promise.resolve("ok"),
        confirmDeletePipeline: () => Promise.resolve(true),
        confirmDeleteRun: () => Promise.resolve(confirmAnswer),
  openSessionInTerminal: () => {},
      },
      clock: tick,
      newRunId,
    });

    const p = pipeline("p1", "One", [block("b1", "Only", "Do")]);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    const runId = runStore.list()[0]!.runId;
    confirmAnswer = false;
    host.send({ type: "deleteRun", runId });
    await flushMicrotasks();
    expect(runStore.list(), "user cancelled — run should still exist").toHaveLength(1);

    confirmAnswer = true;
    host.send({ type: "deleteRun", runId });
    await flushMicrotasks();
    expect(runStore.list(), "user confirmed — run should be gone").toHaveLength(0);

    ctrl.dispose();
  });
});

describe("PipelinesController — dispose", () => {
  it("dispose during a run kills the active runner and marks the run interrupted on disk", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 200,
      judgeDurationMs: 1,
    });
    const ctrl = makeController(runner);

    const p = pipeline("p1", "Slow", [block("b1", "Slow step", "Wait")]);
    pipelineStore.save(p);
    host.send({ type: "runPipeline", pipelineId: p.id });
    await new Promise((r) => setTimeout(r, 5));

    expect(runner.activeSessionCount()).toBeGreaterThan(0);

    ctrl.dispose();

    expect(runner.activeSessionCount()).toBe(0);

    const summaries = runStore.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.status).toBe("interrupted");
  });
});

describe("PipelinesController — workflow assistant enforcement", () => {
  class FakeAssistant {
    readonly asks: string[] = [];
    replayTurns: { role: "user" | "assistant"; text: string; events: readonly { kind: string; text?: string }[] }[] = [];
    constructor(private readonly scripted: { text: string; pipeline: Pipeline | null; hadJson: boolean }[]) {}
    sessionInfo(): { sessionId: string; cwd: string } | null { return { sessionId: "s1", cwd: "/tmp/x" }; }
    adopt(): void {}
    cancel(): void {}
    reset(): void {}
    isBusy(): boolean { return false; }
    dispose(): void {}
    historyTurns(): unknown { return this.replayTurns; }
    ask(_conversationId: string, _ctx: unknown, message: string): Promise<{ events: readonly never[]; text: string; proposal: { pipeline: Pipeline | null; hadJson: boolean; errors: readonly string[] } }> {
      this.asks.push(message);
      const step = this.scripted[Math.min(this.asks.length - 1, this.scripted.length - 1)]!;
      return Promise.resolve({ events: [], text: step.text, proposal: { pipeline: step.pipeline, hadJson: step.hadJson, errors: [] } });
    }
  }

  const proposed = pipeline("p1", "Enrich", [block("b1", "Clean", "Validate emails")]);

  const makeWithAssistant = (fake: FakeAssistant) =>
    new PipelinesController({
      host,
      pipelineStore,
      runStore,
      runner: new StubAutomationRunner({ workerDurationMs: 1, judgeDurationMs: 1 }),
      deterministic: new StubDeterministicRunner(),
      actions: makeActions(),
      clock: tick,
      newRunId,
      assistant: fake as unknown as PipelineAssistant,
      assistantSessions: new AssistantSessionStore(path.join(tmp, "asst-sessions.json")),
      workspaceCwd: () => null,
    });

  it("auto-corrects a YAML / GitHub Actions answer into a Claude Trace JSON proposal", async () => {
    const fake = new FakeAssistant([
      { text: "Here is the file to save:\n```yaml\nname: enrich\non:\n  workflow_dispatch:\n```", pipeline: null, hadJson: false },
      { text: "```json\n{...}\n```", pipeline: proposed, hadJson: true },
    ]);
    makeWithAssistant(fake);

    host.send({ type: "pipelineAssistantAsk", pipeline: proposed, conversationId: "c1", message: "build it", model: "default", effort: "default" });
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.asks).toHaveLength(2);
    expect(fake.asks[1]).toContain("single fenced");
    const replies = host.messagesOfType("pipelineAssistantReply");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.proposedPipeline).not.toBeNull();
    expect(replies[0]!.proposedPipeline!.name).toBe("Enrich");
  });

  it("retries the real message when the resume produced a non-answer ('No response requested.')", async () => {
    const fake = new FakeAssistant([
      { text: "No response requested.", pipeline: null, hadJson: false },
      { text: "Sure — which trigger do you want?", pipeline: null, hadJson: false },
    ]);
    makeWithAssistant(fake);

    host.send({ type: "pipelineAssistantAsk", pipeline: proposed, conversationId: "c1", message: "build me a workflow", model: "default", effort: "default" });
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.asks, "the real message is re-issued after the degenerate continuation reply").toHaveLength(2);
    expect(fake.asks[1]).toContain("build me a workflow");
    const replies = host.messagesOfType("pipelineAssistantReply");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("Sure — which trigger do you want?");
  });

  it("does not auto-correct a normal interview question with no code block", async () => {
    const fake = new FakeAssistant([
      { text: "Which trigger do you want: manual, schedule, or webhook?", pipeline: null, hadJson: false },
    ]);
    makeWithAssistant(fake);

    host.send({ type: "pipelineAssistantAsk", pipeline: proposed, conversationId: "c1", message: "help me", model: "default", effort: "default" });
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.asks).toHaveLength(1);
    const replies = host.messagesOfType("pipelineAssistantReply");
    expect(replies[0]!.proposedPipeline).toBeNull();
  });

  it("restores the Apply card on reload by re-extracting the proposal from a saved assistant turn (#5A)", async () => {
    const fake = new FakeAssistant([]);
    const json = JSON.stringify({
      name: "Proposed",
      blocks: [{ id: "w1", kind: "worker", name: "Step", prompt: "Do it", model: "claude-sonnet-4-6", effort: "high" }],
      triggers: [],
    });
    fake.replayTurns = [
      { role: "user", text: "build me a workflow", events: [] },
      { role: "assistant", text: "", events: [{ kind: "text", text: "Here you go.\n```json\n" + json + "\n```" }] },
    ];
    pipelineStore.save(proposed);
    makeWithAssistant(fake);

    host.send({ type: "pipelineAssistantLoadHistory", pipelineId: proposed.id, conversationId: "c1" });
    await new Promise((r) => setTimeout(r, 0));

    const histories = host.messagesOfType("pipelineAssistantHistory");
    expect(histories).toHaveLength(1);
    const turns = histories[0]!.turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.proposedPipeline).toBeUndefined();
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.proposedPipeline).not.toBeNull();
    expect(turns[1]!.proposedPipeline!.name).toBe("Proposed");
    expect(turns[1]!.proposalErrors).toEqual([]);
  });

  it("persists the conversation session on first progress so a reload mid-turn can still recover it", async () => {
    const sessions = new AssistantSessionStore(path.join(tmp, "asst-sessions-progress.json"));
    class ProgressThenFailAssistant {
      sessionInfo(): { sessionId: string; cwd: string } { return { sessionId: "sess-x", cwd: "/tmp/x" }; }
      adopt(): void {}
      cancel(): void {}
      reset(): void {}
      isBusy(): boolean { return false; }
      dispose(): void {}
      historyTurns(): unknown { return []; }
      ask(
        _conversationId: string,
        _ctx: unknown,
        _message: string,
        options: { onProgress?: (events: readonly { kind: string }[]) => void },
      ): Promise<never> {
        options.onProgress?.([{ kind: "text" }]);
        return Promise.reject(new Error("Cancelled."));
      }
    }
    const ctrl = new PipelinesController({
      host,
      pipelineStore,
      runStore,
      runner: new StubAutomationRunner({ workerDurationMs: 1, judgeDurationMs: 1 }),
      deterministic: new StubDeterministicRunner(),
      actions: makeActions(),
      clock: tick,
      newRunId,
      assistant: new ProgressThenFailAssistant() as unknown as PipelineAssistant,
      assistantSessions: sessions,
      workspaceCwd: () => null,
    });
    pipelineStore.save(proposed);

    host.send({ type: "pipelineAssistantAsk", pipeline: proposed, conversationId: "c-reload", message: "build it", model: "default", effort: "default" });
    await new Promise((r) => setTimeout(r, 10));

    expect(sessions.get(proposed.id, "c-reload"), "session must be saved on first progress, before any reply").toBeTruthy();
    ctrl.dispose();
  });
});

describe("PipelinesController — worker pool (bounded concurrency)", () => {
  it("drains the list with at most K concurrent sessions and collects outputs in list order", async () => {
    const runner = new StubAutomationRunner({ workerDurationMs: 25, judgeDurationMs: 1 });
    const deterministic = new StubDeterministicRunner();
    deterministic.scriptHandler = () => ({ stdout: "alpha\nbravo\ncharlie\ndelta\necho", stderr: "", exitCode: 0 });
    const ctrl = new PipelinesController({
      host,
      pipelineStore,
      runStore,
      runner,
      deterministic,
      actions: makeActions(),
      clock: tick,
      newRunId,
    });

    const p: Pipeline = {
      id: toPipelineId("p-pool"),
      name: "Pool run",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        { id: toBlockId("seed"), kind: "script", name: "Seed", interpreter: "bash", code: "echo list", outputVar: "leads" },
        {
          id: toBlockId("pool"),
          kind: "pool",
          name: "Drain",
          listVar: "leads",
          itemVar: "item",
          concurrency: 2,
          prompt: "Process ${vars.item}",
          model: "default",
          effort: "medium",
          outputVar: "results",
        },
      ],
    };
    pipelineStore.save(p);

    const peaks: number[] = [];
    const poller = setInterval(() => peaks.push(runner.activeSessionCount()), 2);
    host.send({ type: "runPipeline", pipelineId: p.id });
    try {
      await waitForRunCompletion(() => {
        const runs = host.messagesOfType("runUpdate");
        return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
      }, 5000);
    } finally {
      clearInterval(poller);
    }

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    const poolRun = final.blocks.find((b) => b.blockId === toBlockId("pool"))!;
    expect(poolRun.status).toBe("done");
    expect(poolRun.sessions, "one session per list item").toHaveLength(5);
    expect(poolRun.sessions.every((s) => s.endedAtMs !== null), "every item session finished").toBe(true);
    expect(Math.max(...peaks, 0), "never more than the concurrency cap running at once").toBeLessThanOrEqual(2);

    const lines = (final.variables["results"] ?? "").split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("alpha");
    expect(lines[1]).toContain("bravo");
    expect(lines[4]).toContain("echo");

    ctrl.dispose();
  });

  it("orchestrator verdicts: a failed item flags the block as failed AFTER draining all items, and one orchestrator session is resumed across every verdict", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 5,
      judgeDurationMs: 1,
      decide: (opts) =>
        opts.taskGoal.includes("bravo")
          ? { kind: "failed", reason: "bravo worker produced garbage" }
          : { kind: "success", summary: "looks right" },
    });
    const deterministic = new StubDeterministicRunner();
    deterministic.scriptHandler = () => ({ stdout: "alpha\nbravo\ncharlie", stderr: "", exitCode: 0 });
    const ctrl = new PipelinesController({
      host,
      pipelineStore,
      runStore,
      runner,
      deterministic,
      actions: makeActions(),
      clock: tick,
      newRunId,
    });

    const p: Pipeline = {
      id: toPipelineId("p-pool-verdict"),
      name: "Pool verdicts",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        { id: toBlockId("seed"), kind: "script", name: "Seed", interpreter: "bash", code: "echo list", outputVar: "leads" },
        {
          id: toBlockId("pool"),
          kind: "pool",
          name: "Drain",
          listVar: "leads",
          itemVar: "item",
          concurrency: 2,
          prompt: "Process ${vars.item}",
          model: "default",
          effort: "medium",
          outputVar: "results",
        },
      ],
    };
    pipelineStore.save(p);

    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "failed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    const poolRun = final.blocks.find((b) => b.blockId === toBlockId("pool"))!;
    expect(poolRun.status).toBe("failed");
    expect(poolRun.failureReason).toContain("1/3 pool workers failed");
    expect(poolRun.failureReason).toContain("bravo worker produced garbage");
    expect(poolRun.sessions, "every item still ran — failure is flagged after the drain").toHaveLength(3);
    expect(poolRun.sessions.every((s) => s.endedAtMs !== null)).toBe(true);

    const verdicts = poolRun.sessions.map((s) => s.verdict?.kind);
    expect(verdicts.filter((v) => v === "failed")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "success")).toHaveLength(2);

    expect(runner.judgeCalls, "one orchestrator verdict per item").toHaveLength(3);
    expect(poolRun.orchestratorSessionId, "the latest judge session is recorded on the block for the UI").toMatch(
      /^stub-orchestrator-\d+$/,
    );

    ctrl.dispose();
  });

  it("fails the pool block instead of silently completing when a file list source is missing", async () => {
    const runner = new StubAutomationRunner({ workerDurationMs: 5, judgeDurationMs: 1 });
    const ctrl = new PipelinesController({
      host,
      pipelineStore,
      runStore,
      runner,
      deterministic: new StubDeterministicRunner(),
      actions: makeActions(),
      clock: tick,
      newRunId,
    });

    const p: Pipeline = {
      id: toPipelineId("p-pool-missing"),
      name: "Pool missing list",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        {
          id: toBlockId("pool"),
          kind: "pool",
          name: "Drain",
          listVar: "missing.jsonl",
          itemVar: "item",
          concurrency: 2,
          prompt: "Process ${vars.item}",
          model: "default",
          effort: "medium",
          outputVar: "results",
        },
      ],
    };
    pipelineStore.save(p);

    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "failed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    const poolRun = final.blocks[0]!;
    expect(poolRun.status).toBe("failed");
    expect(poolRun.failureReason).toContain("No such file: missing.jsonl");
    expect(poolRun.sessions).toHaveLength(0);
    ctrl.dispose();
  });

  it("marks the pool block failed and closes sibling sessions when one pooled session crashes", async () => {
    const runner = new StubAutomationRunner({
      workerDurationMs: 50,
      judgeDurationMs: 1,
      crashOnPrompt: (prompt) => prompt.includes("bad"),
    });
    const deterministic = new StubDeterministicRunner();
    deterministic.scriptHandler = () => ({ stdout: "good\nbad\nnext", stderr: "", exitCode: 0 });
    const ctrl = new PipelinesController({
      host,
      pipelineStore,
      runStore,
      runner,
      deterministic,
      actions: makeActions(),
      clock: tick,
      newRunId,
    });

    const p: Pipeline = {
      id: toPipelineId("p-pool-crash"),
      name: "Pool crash",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        { id: toBlockId("seed"), kind: "script", name: "Seed", interpreter: "bash", code: "echo list", outputVar: "items" },
        {
          id: toBlockId("pool"),
          kind: "pool",
          name: "Drain",
          listVar: "items",
          itemVar: "item",
          concurrency: 2,
          prompt: "Process ${vars.item}",
          model: "default",
          effort: "medium",
          outputVar: "results",
        },
      ],
    };
    pipelineStore.save(p);

    host.send({ type: "runPipeline", pipelineId: p.id });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "failed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    const poolRun = final.blocks.find((b) => b.blockId === toBlockId("pool"))!;
    expect(poolRun.status).toBe("failed");
    expect(poolRun.failureReason).toContain("Terminal was closed before Claude finished responding.");
    expect(poolRun.sessions.length).toBeGreaterThanOrEqual(2);
    expect(poolRun.sessions.every((session) => session.endedAtMs !== null)).toBe(true);
    ctrl.dispose();
  });
});

describe("PipelinesController — orphaned run reconciliation + resume", () => {
  it("marks a persisted 'running' run as interrupted on startup, then resumeRun finishes it from the next pending block", async () => {
    const p = pipeline("p-orphan", "Orphan", [block("a", "A", "do a"), block("b", "B", "do b")]);
    pipelineStore.save(p);

    let seed = initialRunState(p, newRunId(), tick());
    seed = applyBlockSpawned(seed, toBlockId("a"), "sess-a", "do a", tick());
    seed = applyBlockStopped(seed, toBlockId("a"), tick());
    seed = applyDecision(seed, toBlockId("a"), { kind: "success", summary: "A done" }, tick());
    expect(seed.status).toBe("running");
    runStore.save(seed);
    const runId = seed.runId;

    makeController();
    expect(runStore.get(runId)!.status, "orphaned running run is reconciled to interrupted").toBe("interrupted");

    host.send({ type: "resumeRun", runId });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(final.blocks.find((b) => b.blockId === toBlockId("a"))!.status).toBe("done");
    expect(final.blocks.find((b) => b.blockId === toBlockId("b"))!.status).toBe("done");
  });

  it("resumeRun on a FAILED run reruns the ENTIRE workflow from scratch — every step, fresh sessions, cleared variables", async () => {
    const p = pipeline("p-rerun", "Rerun", [block("a", "A", "do a"), block("b", "B", "do b")]);
    pipelineStore.save(p);

    let seed = initialRunState(p, newRunId(), tick());
    seed = applyBlockSpawned(seed, toBlockId("a"), "sess-old-a", "do a", tick());
    seed = applyBlockStopped(seed, toBlockId("a"), tick());
    seed = applyDecision(seed, toBlockId("a"), { kind: "success", summary: "A done" }, tick());
    seed = applyBlockCrashed(seed, toBlockId("b"), "judge could not boot", tick());
    expect(seed.status).toBe("failed");
    runStore.save({ ...seed, name: "Maquettes du soir" });
    const runId = seed.runId;

    makeController();
    host.send({ type: "resumeRun", runId });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(final.runId).toBe(runId);
    expect(final.name, "the run keeps its name across the rerun").toBe("Maquettes du soir");
    const aRun = final.blocks.find((b) => b.blockId === toBlockId("a"))!;
    expect(aRun.status).toBe("done");
    expect(aRun.sessions, "step A re-executed from scratch, not reused").toHaveLength(1);
    expect(aRun.sessions[0]!.sessionId).not.toBe("sess-old-a");
    const bRun = final.blocks.find((b) => b.blockId === toBlockId("b"))!;
    expect(bRun.status).toBe("done");
    expect(bRun.failureReason).toBeNull();
  });

  it("rerun of a failed run KEEPS the submitted input rows — the user never re-fills the table", async () => {
    const p: Pipeline = {
      id: toPipelineId("p-rerun-input"),
      name: "Rerun input",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        {
          id: toBlockId("in"),
          kind: "input",
          name: "Leads",
          message: "Fill the leads",
          columns: [{ key: "site", label: "Site", type: "url", options: [], required: true, help: null }],
          outputVar: "rows",
        },
        block("work", "Work", "process ${vars.rows}"),
      ],
    };
    pipelineStore.save(p);

    let seed = initialRunState(p, newRunId(), tick());
    seed = applyInputPaused(seed, toBlockId("in"), "Fill the leads", tick());
    seed = applyInputSubmitted(seed, toBlockId("in"), [{ site: "https://osez-massage.fr" }], tick());
    seed = applyBlockCrashed(seed, toBlockId("work"), "judge could not boot", tick());
    expect(seed.status).toBe("failed");
    runStore.save(seed);
    const runId = seed.runId;

    makeController();
    host.send({ type: "resumeRun", runId });
    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    });

    const updates = host.messagesOfType("runUpdate").map((m) => m.run);
    expect(
      updates.every((r) => r.status !== "paused-needs-input"),
      "the rerun must never pause to re-ask for the input rows",
    ).toBe(true);
    const final = updates.at(-1)!;
    const inputRun = final.blocks.find((b) => b.blockId === toBlockId("in"))!;
    expect(inputRun.status).toBe("done");
    expect(inputRun.output).toContain("osez-massage.fr");
    expect(final.variables["rows"], "the rows variable feeds downstream blocks again").toContain("osez-massage.fr");
    expect(final.blocks.find((b) => b.blockId === toBlockId("work"))!.status).toBe("done");
  });

  it("loading a stale 'running' run (engine not driving it) returns it as interrupted, never stuck running", () => {
    const p = pipeline("p-stale", "Stale", [block("a", "A", "do a"), block("b", "B", "do b")]);
    pipelineStore.save(p);
    let seed = initialRunState(p, newRunId(), tick());
    seed = applyBlockSpawned(seed, toBlockId("a"), "sess-a", "do a", tick());
    seed = applyBlockStopped(seed, toBlockId("a"), tick());
    seed = applyDecision(seed, toBlockId("a"), { kind: "success", summary: "A" }, tick());
    runStore.save(seed);

    makeController();
    host.send({ type: "loadRun", runId: seed.runId });

    const update = host.messagesOfType("runUpdate").at(-1)!.run;
    expect(update.runId).toBe(seed.runId);
    expect(update.status, "a run with no live engine is never reported as still running").toBe("interrupted");
  });
});

describe("PipelinesController — input table (pause for user rows, then drain)", () => {
  it("pauses for the user to fill the table, then feeds the rows into a downstream pool in order", async () => {
    const runner = new StubAutomationRunner({ workerDurationMs: 5, judgeDurationMs: 1 });
    const ctrl = new PipelinesController({
      host,
      pipelineStore,
      runStore,
      runner,
      deterministic: new StubDeterministicRunner(),
      actions: makeActions(),
      clock: tick,
      newRunId,
    });

    const p: Pipeline = {
      id: toPipelineId("p-input"),
      name: "Input run",
      createdAtMs: 1,
      updatedAtMs: 1,
      triggers: [],
      blocks: [
        {
          id: toBlockId("in1"),
          kind: "input",
          name: "Collect leads",
          message: "Fill one row per lead.",
          columns: [
            { key: "site", label: "Site", type: "url", options: [], required: true, help: null },
            { key: "category", label: "Category", type: "enum", options: ["Massage", "Hair salon"], required: true, help: null },
          ],
          outputVar: "rows",
        },
        {
          id: toBlockId("pool"),
          kind: "pool",
          name: "Drain",
          listVar: "rows",
          itemVar: "row",
          concurrency: 2,
          prompt: "Build a mockup for ${row}",
          model: "default",
          effort: "medium",
          outputVar: "results",
        },
      ],
    };
    pipelineStore.save(p);

    host.send({ type: "runPipeline", pipelineId: p.id });

    await waitForRunCompletion(() =>
      host.messagesOfType("runUpdate").some((m) => m.run.status === "paused-needs-input"),
    );
    const paused = host.messagesOfType("runUpdate").map((m) => m.run).find((r) => r.status === "paused-needs-input")!;
    expect(paused.blocks.find((b) => b.blockId === toBlockId("in1"))!.status).toBe("stuck");
    expect(paused.blocks.find((b) => b.blockId === toBlockId("pool"))!.status).toBe("pending");

    await flushMicrotasks();

    host.send({
      type: "submitInput",
      runId: paused.runId,
      blockId: toBlockId("in1"),
      rows: [
        { site: "https://a.test", category: "Massage" },
        { site: "https://b.test", category: "Hair salon" },
        { site: "https://c.test", category: "Massage" },
      ],
    });

    await waitForRunCompletion(() => {
      const runs = host.messagesOfType("runUpdate");
      return runs.length > 0 && runs[runs.length - 1]!.run.status === "completed";
    }, 5000);

    const final = host.messagesOfType("runUpdate").at(-1)!.run;
    const rowsVar = (final.variables["rows"] ?? "").split("\n");
    expect(rowsVar).toHaveLength(3);
    expect(JSON.parse(rowsVar[0]!)).toEqual({ site: "https://a.test", category: "Massage" });
    const poolRun = final.blocks.find((b) => b.blockId === toBlockId("pool"))!;
    expect(poolRun.status).toBe("done");
    expect(poolRun.sessions, "one session per submitted row").toHaveLength(3);
    expect((final.variables["results"] ?? "").split("\n")).toHaveLength(3);
    expect(
      poolRun.sessions[0]!.promptSent,
      "the bare \\${row} item reference is substituted with the row JSON, not passed literally",
    ).toContain("https://a.test");
    expect(poolRun.sessions[0]!.promptSent).not.toContain("${row}");

    ctrl.dispose();
  });
});
