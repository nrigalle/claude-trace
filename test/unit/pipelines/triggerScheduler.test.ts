import { describe, expect, it } from "vitest";
import {
  TriggerScheduler,
  webhookPipelineForToken,
  type TimerHandle,
  type TriggerSchedulerDeps,
} from "../../../src/features/pipelines/app/TriggerScheduler";
import {
  toPipelineId,
  type Pipeline,
  type PipelineId,
  type Trigger,
} from "../../../src/features/pipelines/domain/types";

const pipeline = (id: string, triggers: readonly Trigger[]): Pipeline => ({
  id: toPipelineId(id),
  name: id,
  createdAtMs: 0,
  updatedAtMs: 0,
  blocks: [],
  triggers,
});

interface FakeTimer {
  readonly handle: TimerHandle;
  readonly fn: () => void;
  readonly ms: number;
  cleared: boolean;
}

class Harness {
  pipelines: readonly Pipeline[] = [];
  readonly runs: PipelineId[] = [];
  readonly timers: FakeTimer[] = [];
  private counter = 0;

  readonly deps: TriggerSchedulerDeps = {
    listPipelines: () => this.pipelines,
    runPipeline: (id) => this.runs.push(id),
    setInterval: (fn, ms) => {
      const handle = { __brand: "TimerHandle", id: this.counter++ } as unknown as TimerHandle;
      this.timers.push({ handle, fn, ms, cleared: false });
      return handle;
    },
    clearInterval: (handle) => {
      const t = this.timers.find((x) => x.handle === handle);
      if (t) t.cleared = true;
    },
  };

  fireAll(): void {
    for (const t of this.timers) if (!t.cleared) t.fn();
  }

  activeTimers(): FakeTimer[] {
    return this.timers.filter((t) => !t.cleared);
  }
}

describe("TriggerScheduler", () => {
  it("creates one timer per enabled schedule trigger and fires runPipeline", () => {
    const h = new Harness();
    h.pipelines = [pipeline("p1", [{ kind: "schedule", intervalMs: 5000, enabled: true }])];
    const scheduler = new TriggerScheduler(h.deps);
    scheduler.reconcile();

    expect(h.activeTimers()).toHaveLength(1);
    expect(h.activeTimers()[0]!.ms).toBe(5000);
    h.fireAll();
    expect(h.runs).toEqual([toPipelineId("p1")]);
  });

  it("ignores disabled schedule triggers and webhook triggers", () => {
    const h = new Harness();
    h.pipelines = [
      pipeline("p1", [{ kind: "schedule", intervalMs: 1000, enabled: false }]),
      pipeline("p2", [{ kind: "webhook", token: "abc", enabled: true }]),
    ];
    new TriggerScheduler(h.deps).reconcile();
    expect(h.activeTimers()).toHaveLength(0);
  });

  it("is idempotent: reconciling twice does not double-create timers", () => {
    const h = new Harness();
    h.pipelines = [pipeline("p1", [{ kind: "schedule", intervalMs: 1000, enabled: true }])];
    const scheduler = new TriggerScheduler(h.deps);
    scheduler.reconcile();
    scheduler.reconcile();
    expect(h.activeTimers()).toHaveLength(1);
  });

  it("clears timers for triggers that disappear on reconcile", () => {
    const h = new Harness();
    h.pipelines = [pipeline("p1", [{ kind: "schedule", intervalMs: 1000, enabled: true }])];
    const scheduler = new TriggerScheduler(h.deps);
    scheduler.reconcile();
    expect(h.activeTimers()).toHaveLength(1);

    h.pipelines = [pipeline("p1", [])];
    scheduler.reconcile();
    expect(h.activeTimers()).toHaveLength(0);
  });

  it("dispose clears every timer", () => {
    const h = new Harness();
    h.pipelines = [
      pipeline("p1", [{ kind: "schedule", intervalMs: 1000, enabled: true }]),
      pipeline("p2", [{ kind: "schedule", intervalMs: 2000, enabled: true }]),
    ];
    const scheduler = new TriggerScheduler(h.deps);
    scheduler.reconcile();
    expect(h.activeTimers()).toHaveLength(2);
    scheduler.dispose();
    expect(h.activeTimers()).toHaveLength(0);
  });
});

describe("webhookPipelineForToken", () => {
  const pipelines = [
    pipeline("p1", [{ kind: "webhook", token: "secret-1", enabled: true }]),
    pipeline("p2", [{ kind: "webhook", token: "secret-2", enabled: false }]),
  ];

  it("matches an enabled webhook token to its pipeline", () => {
    expect(webhookPipelineForToken(pipelines, "secret-1")).toBe(toPipelineId("p1"));
  });

  it("does not match a disabled webhook", () => {
    expect(webhookPipelineForToken(pipelines, "secret-2")).toBeNull();
  });

  it("returns null for an unknown token", () => {
    expect(webhookPipelineForToken(pipelines, "nope")).toBeNull();
  });
});
