import { fromPipelineId, type Pipeline, type PipelineId, type ScheduleRecurrence } from "../domain/types";
import { nextScheduleDelayMs } from "../domain/schedule";

export type TimerHandle = { readonly __brand: "TimerHandle" };

export interface TriggerSchedulerDeps {
  listPipelines(): readonly Pipeline[];
  runPipeline(id: PipelineId): void;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  now(): number;
}

const TICK_CAP_MS = 30_000;

interface ScheduledTimer {
  handle: TimerHandle;
  readonly signature: string;
  readonly epoch: number;
}

const scheduleKey = (id: PipelineId, index: number): string => `${fromPipelineId(id)}::${index}`;

export class TriggerScheduler {
  private readonly timers = new Map<string, ScheduledTimer>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly deps: TriggerSchedulerDeps) {}

  reconcile(): void {
    const wanted = new Set<string>();
    for (const pipeline of this.deps.listPipelines()) {
      pipeline.triggers.forEach((trigger, index) => {
        if (trigger.kind !== "schedule" || !trigger.enabled) return;
        const key = scheduleKey(pipeline.id, index);
        wanted.add(key);
        const signature = JSON.stringify(trigger.recurrence);
        const existing = this.timers.get(key);
        if (existing && existing.signature === signature) return;
        if (existing) this.deps.clearTimer(existing.handle);
        const epoch = (this.epochs.get(key) ?? 0) + 1;
        this.epochs.set(key, epoch);
        const nextFireMs = this.deps.now() + nextScheduleDelayMs(trigger.recurrence, this.deps.now());
        this.arm(key, pipeline.id, trigger.recurrence, signature, epoch, nextFireMs);
      });
    }
    for (const [key, timer] of [...this.timers]) {
      if (wanted.has(key)) continue;
      this.deps.clearTimer(timer.handle);
      this.timers.delete(key);
      this.epochs.delete(key);
    }
  }

  private arm(
    key: string,
    id: PipelineId,
    recurrence: ScheduleRecurrence,
    signature: string,
    epoch: number,
    nextFireMs: number,
  ): void {
    const tick = (): void => {
      if (this.epochs.get(key) !== epoch) return;
      let nextFire = nextFireMs;
      const now = this.deps.now();
      if (now >= nextFire) {
        this.deps.runPipeline(id);
        nextFire = now + nextScheduleDelayMs(recurrence, now);
      }
      this.arm(key, id, recurrence, signature, epoch, nextFire);
    };
    const delay = Math.min(TICK_CAP_MS, Math.max(1, nextFireMs - this.deps.now()));
    const handle = this.deps.setTimer(tick, delay);
    this.timers.set(key, { handle, signature, epoch });
  }

  dispose(): void {
    for (const timer of this.timers.values()) this.deps.clearTimer(timer.handle);
    this.timers.clear();
    this.epochs.clear();
  }
}

export const webhookPipelineForToken = (
  pipelines: readonly Pipeline[],
  token: string,
): PipelineId | null => {
  for (const pipeline of pipelines) {
    for (const trigger of pipeline.triggers) {
      if (trigger.kind === "webhook" && trigger.enabled && trigger.token === token) {
        return pipeline.id;
      }
    }
  }
  return null;
};
