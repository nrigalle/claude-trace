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

const sched = (everyMs: number, over: { enabled?: boolean } = {}): Trigger => ({
  kind: "schedule",
  enabled: over.enabled ?? true,
  recurrence: { type: "interval", everyMs },
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
  nowMs = 0;
  private counter = 0;

  readonly deps: TriggerSchedulerDeps = {
    listPipelines: () => this.pipelines,
    runPipeline: (id) => this.runs.push(id),
    setTimer: (fn, ms) => {
      const handle = { __brand: "TimerHandle", id: this.counter++ } as unknown as TimerHandle;
      this.timers.push({ handle, fn, ms, cleared: false });
      return handle;
    },
    clearTimer: (handle) => {
      const t = this.timers.find((x) => x.handle === handle);
      if (t) t.cleared = true;
    },
    now: () => this.nowMs,
  };

  fireAll(): void {
    for (const t of [...this.timers]) {
      if (t.cleared) continue;
      t.cleared = true;
      this.nowMs += t.ms;
      t.fn();
    }
  }

  wakeAt(nowMs: number): void {
    this.nowMs = nowMs;
    for (const t of [...this.timers]) {
      if (t.cleared) continue;
      t.cleared = true;
      t.fn();
    }
  }

  activeTimers(): FakeTimer[] {
    return this.timers.filter((t) => !t.cleared);
  }
}

describe("TriggerScheduler", () => {
  it("creates one timer per enabled foreground schedule trigger and fires runPipeline", () => {
    const h = new Harness();
    h.pipelines = [pipeline("p1", [sched(5000)])];
    const scheduler = new TriggerScheduler(h.deps);
    scheduler.reconcile();

    expect(h.activeTimers()).toHaveLength(1);
    expect(h.activeTimers()[0]!.ms).toBe(5000);
    h.fireAll();
    expect(h.runs).toEqual([toPipelineId("p1")]);
  });

  it("re-arms after firing (recurring)", () => {
    const h = new Harness();
    h.pipelines = [pipeline("p1", [sched(5000)])];
    new TriggerScheduler(h.deps).reconcile();
    h.fireAll();
    h.fireAll();
    expect(h.runs).toEqual([toPipelineId("p1"), toPipelineId("p1")]);
    expect(h.activeTimers()).toHaveLength(1);
  });

  it("ignores disabled schedule triggers and webhook triggers", () => {
    const h = new Harness();
    h.pipelines = [
      pipeline("p1", [sched(1000, { enabled: false })]),
      pipeline("p2", [{ kind: "webhook", token: "abc", enabled: true }]),
    ];
    new TriggerScheduler(h.deps).reconcile();
    expect(h.activeTimers()).toHaveLength(0);
  });

  it("caps the underlying timer delay (avoids the >24.8 day setTimeout overflow)", () => {
    const h = new Harness();
    const fortyDaysMs = 40 * 86_400_000;
    h.pipelines = [pipeline("p1", [sched(fortyDaysMs)])];
    new TriggerScheduler(h.deps).reconcile();
    expect(h.activeTimers()[0]!.ms).toBeLessThanOrEqual(30_000);
    h.fireAll();
    expect(h.runs).toEqual([]);
  });

  it("fires once on catch-up after a long sleep, not once per missed interval", () => {
    const h = new Harness();
    h.pipelines = [pipeline("p1", [sched(60_000)])];
    new TriggerScheduler(h.deps).reconcile();
    h.wakeAt(10 * 60_000);
    expect(h.runs).toEqual([toPipelineId("p1")]);
  });

  it("is idempotent: reconciling twice does not double-create timers", () => {
    const h = new Harness();
    h.pipelines = [pipeline("p1", [sched(1000)])];
    const scheduler = new TriggerScheduler(h.deps);
    scheduler.reconcile();
    scheduler.reconcile();
    expect(h.activeTimers()).toHaveLength(1);
  });

  it("clears timers for triggers that disappear on reconcile", () => {
    const h = new Harness();
    h.pipelines = [pipeline("p1", [sched(1000)])];
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
      pipeline("p1", [sched(1000)]),
      pipeline("p2", [sched(2000)]),
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
