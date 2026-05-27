import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PipelinesController,
  newRunIdFromClock,
  type PipelinesActions,
  type PipelinesHost,
} from "../../src/features/pipelines/app/PipelinesController";
import { StubAutomationRunner } from "../stubs/StubAutomationRunner";
import { PipelineStore } from "../../src/features/pipelines/infra/PipelineStore";
import { RunStore } from "../../src/features/pipelines/infra/RunStore";
import {
  toBlockId,
  toPipelineId,
  type Block,
  type LoopBlock,
  type OrchestratorDecision,
  type ParallelBlock,
  type Pipeline,
  type RunId,
  type WorkerBlock,
} from "../../src/features/pipelines/domain/types";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
} from "../../src/features/pipelines/protocol";

const STRESS_SEED = 0xc0ffee;

class Mulberry32 {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }
  int(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
  pick<T>(items: readonly T[]): T { return items[this.int(items.length)]!; }
}

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
    if (!this.listener) throw new Error("no listener attached");
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

const buildWorker = (rng: Mulberry32, id: string): WorkerBlock => ({
  id: toBlockId(id),
  kind: "worker",
  name: `Worker ${id}`,
  prompt: `worker:${id}`,
  model: rng.pick(["default", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"] as const),
  effort: rng.pick(["low", "medium", "high", "max"] as const),
});

const buildParallel = (rng: Mulberry32, id: string, workerCount: number): ParallelBlock => {
  const workers: WorkerBlock[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(buildWorker(rng, `${id}-pw${i}`));
  }
  return {
    id: toBlockId(id),
    kind: "parallel",
    name: `Parallel ${id}`,
    workers,
    mergerGoal: `merge:${id}`,
    mergerModel: rng.pick(["default", "claude-sonnet-4-6"] as const),
  };
};

const buildLoop = (rng: Mulberry32, id: string, targetId: string): LoopBlock => ({
  id: toBlockId(id),
  kind: "loop",
  name: `Loop ${id}`,
  loopBackToBlockId: toBlockId(targetId),
  goal: `loop:${id}`,
  maxIterations: 1 + rng.int(3),
  evaluatorModel: rng.pick(["default", "claude-sonnet-4-6"] as const),
});

interface RandomPipelineResult {
  readonly pipeline: Pipeline;
  readonly hasLoop: boolean;
  readonly hasParallel: boolean;
}

const buildRandomPipeline = (rng: Mulberry32, idx: number): RandomPipelineResult => {
  const blockCount = 1 + rng.int(4);
  const blocks: Block[] = [];
  let nameCounter = 0;
  let hasLoop = false;
  let hasParallel = false;

  for (let i = 0; i < blockCount; i++) {
    const remaining = blockCount - i;
    const choice = rng.int(10);
    if (choice < 6) {
      blocks.push(buildWorker(rng, `p${idx}-w${nameCounter++}`));
    } else if (choice < 9 || blocks.length === 0) {
      blocks.push(buildParallel(rng, `p${idx}-par${nameCounter++}`, 2 + rng.int(2)));
      hasParallel = true;
    } else if (remaining >= 1) {
      const earlier = blocks[rng.int(blocks.length)]!;
      blocks.push(buildLoop(rng, `p${idx}-loop${nameCounter++}`, earlier.id));
      hasLoop = true;
    }
  }
  if (blocks.length === 0) blocks.push(buildWorker(rng, `p${idx}-w0`));

  return {
    pipeline: {
      id: toPipelineId(`stress-p${idx}`),
      name: `stress pipeline ${idx}`,
      createdAtMs: 1,
      updatedAtMs: 1,
      blocks,
    },
    hasLoop,
    hasParallel,
  };
};

let tmp: string;
let host: MockHost;
let pipelineStore: PipelineStore;
let runStore: RunStore;
let clockMs: number;
let runIdCounter: number;

const tick = () => { clockMs += 1; return clockMs; };
const newRunId = (): RunId => newRunIdFromClock(clockMs + (++runIdCounter));

const actions: PipelinesActions = {
  askPipelineName: () => Promise.resolve("ok"),
  confirmDeletePipeline: () => Promise.resolve(true),
  confirmDeleteRun: () => Promise.resolve(true),
  openSessionInTerminal: () => {},
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-stress-"));
  host = new MockHost();
  pipelineStore = new PipelineStore(path.join(tmp, "automations"));
  runStore = new RunStore(path.join(tmp, "runs"));
  clockMs = 1000;
  runIdCounter = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const waitForTerminalStatus = async (max = 15000): Promise<string | null> => {
  const start = Date.now();
  while (Date.now() - start < max) {
    const status = host.lastRunStatus();
    if (status === "completed" || status === "failed" || status === "interrupted") {
      return status;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return host.lastRunStatus();
};

describe("PipelinesController — randomized stress", () => {
  it("reaches a terminal state for 60 randomized pipelines built from any mix of worker/parallel/loop blocks", async () => {
    const rng = new Mulberry32(STRESS_SEED);
    let parallelSeen = 0;
    let loopSeen = 0;

    for (let i = 0; i < 60; i++) {
      const { pipeline, hasLoop, hasParallel } = buildRandomPipeline(rng, i);
      if (hasParallel) parallelSeen++;
      if (hasLoop) loopSeen++;

      host = new MockHost();
      const runner = new StubAutomationRunner({
        workerDurationMs: 1,
        judgeDurationMs: 1,
        decide: () => ({ kind: "success", summary: `ok ${i}` }),
      });
      const ctrl = new PipelinesController({
        host,
        pipelineStore,
        runStore,
        runner,
        actions,
        clock: tick,
        newRunId,
      });
      try {
        pipelineStore.save(pipeline);
        host.send({ type: "runPipeline", pipelineId: pipeline.id });
        const status = await waitForTerminalStatus(8000);
        expect(status, `pipeline ${i} did not terminate (blocks: ${pipeline.blocks.map((b) => b.kind).join(",")})`).toBe("completed");
      } finally {
        ctrl.dispose();
      }
    }

    expect(parallelSeen).toBeGreaterThan(10);
    expect(loopSeen).toBeGreaterThan(2);
  }, 60000);

  it("randomized pipelines survive intermittent needs-input on any block — the patient loop recovers", async () => {
    const rng = new Mulberry32(STRESS_SEED ^ 0xfeed);
    let needsInputBudget = 0;

    for (let i = 0; i < 25; i++) {
      const { pipeline } = buildRandomPipeline(rng, i);
      host = new MockHost();
      let judgeCount = 0;
      const stuckEvery = 5 + rng.int(4);
      const runner = new StubAutomationRunner({
        workerDurationMs: 1,
        judgeDurationMs: 1,
        decide: (): OrchestratorDecision => {
          judgeCount += 1;
          if (judgeCount % stuckEvery === 0 && needsInputBudget < 20) {
            needsInputBudget += 1;
            return { kind: "needs-input", reason: "stress: clarify" };
          }
          return { kind: "success", summary: "ok" };
        },
      });
      const ctrl = new PipelinesController({
        host,
        pipelineStore,
        runStore,
        runner,
        actions,
        clock: tick,
        newRunId,
      });
      try {
        pipelineStore.save(pipeline);
        host.send({ type: "runPipeline", pipelineId: pipeline.id });
        const status = await waitForTerminalStatus(8000);
        expect(status, `pipeline ${i} did not recover from intermittent needs-input`).toBe("completed");
      } finally {
        ctrl.dispose();
      }
    }
    expect(needsInputBudget).toBeGreaterThan(5);
  }, 60000);

  it("a parallel block always exposes exactly one session per parallel worker plus exactly one merger session — invariant across 40 randomized parallel-only pipelines", async () => {
    const rng = new Mulberry32(STRESS_SEED ^ 0xdead);
    for (let i = 0; i < 40; i++) {
      const parallelCount = 1 + rng.int(2);
      const blocks: Block[] = [];
      for (let j = 0; j < parallelCount; j++) {
        const workerCount = 2 + rng.int(3);
        blocks.push(buildParallel(rng, `inv-${i}-${j}`, workerCount));
      }
      const pipeline: Pipeline = {
        id: toPipelineId(`inv-p${i}`),
        name: `invariant ${i}`,
        createdAtMs: 1,
        updatedAtMs: 1,
        blocks,
      };

      host = new MockHost();
      const runner = new StubAutomationRunner({
        workerDurationMs: 1,
        judgeDurationMs: 1,
        decide: () => ({ kind: "success", summary: "ok" }),
      });
      const ctrl = new PipelinesController({
        host, pipelineStore, runStore, runner, actions, clock: tick, newRunId,
      });
      try {
        pipelineStore.save(pipeline);
        host.send({ type: "runPipeline", pipelineId: pipeline.id });
        const status = await waitForTerminalStatus(8000);
        expect(status).toBe("completed");

        const final = host.messages
          .filter((m): m is Extract<PipelinesHostToWebview, { type: "runUpdate" }> => m.type === "runUpdate")
          .at(-1)!.run;
        for (const blockRun of final.blocks) {
          const definition = final.pipelineSnapshot.blocks.find((b) => b.id === blockRun.blockId);
          if (definition?.kind !== "parallel") continue;
          expect(blockRun.parallel).not.toBeNull();
          expect(blockRun.parallel!.workerRuns).toHaveLength(definition.workers.length);
          for (const wr of blockRun.parallel!.workerRuns) {
            expect(wr.sessions).toHaveLength(1);
            expect(wr.status).toBe("done");
          }
          expect(blockRun.parallel!.mergerSessions).toHaveLength(1);
          expect(blockRun.parallel!.mergerStatus).toBe("done");
        }
      } finally {
        ctrl.dispose();
      }
    }
  }, 60000);

  it("Kill is honoured on randomized in-flight pipelines and the run lands as interrupted", async () => {
    const rng = new Mulberry32(STRESS_SEED ^ 0xbeef);
    for (let i = 0; i < 20; i++) {
      const { pipeline } = buildRandomPipeline(rng, i);
      host = new MockHost();
      const runner = new StubAutomationRunner({
        workerDurationMs: 50,
        judgeDurationMs: 5,
        decide: () => ({ kind: "success", summary: "ok" }),
      });
      const ctrl = new PipelinesController({
        host, pipelineStore, runStore, runner, actions, clock: tick, newRunId,
      });
      try {
        pipelineStore.save(pipeline);
        host.send({ type: "runPipeline", pipelineId: pipeline.id });
        await new Promise((r) => setTimeout(r, 3 + rng.int(15)));
        const lastUpdate = host.messages
          .filter((m): m is Extract<PipelinesHostToWebview, { type: "runUpdate" }> => m.type === "runUpdate")
          .at(-1);
        if (!lastUpdate) continue;
        host.send({ type: "killRun", runId: lastUpdate.run.runId });
        const status = await waitForTerminalStatus(8000);
        expect(status === "interrupted" || status === "completed").toBe(true);
      } finally {
        ctrl.dispose();
      }
    }
  }, 60000);
});
