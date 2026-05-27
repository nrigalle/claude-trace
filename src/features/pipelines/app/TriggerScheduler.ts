import { fromPipelineId, type Pipeline, type PipelineId } from "../domain/types";

export type TimerHandle = { readonly __brand: "TimerHandle" };

export interface TriggerSchedulerDeps {
  listPipelines(): readonly Pipeline[];
  runPipeline(id: PipelineId): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

const scheduleKey = (id: PipelineId, index: number): string => `${fromPipelineId(id)}::${index}`;

export class TriggerScheduler {
  private readonly timers = new Map<string, TimerHandle>();

  constructor(private readonly deps: TriggerSchedulerDeps) {}

  reconcile(): void {
    const wanted = new Set<string>();
    for (const pipeline of this.deps.listPipelines()) {
      pipeline.triggers.forEach((trigger, index) => {
        if (trigger.kind !== "schedule" || !trigger.enabled) return;
        const key = scheduleKey(pipeline.id, index);
        wanted.add(key);
        if (this.timers.has(key)) return;
        const handle = this.deps.setInterval(() => this.deps.runPipeline(pipeline.id), trigger.intervalMs);
        this.timers.set(key, handle);
      });
    }
    for (const [key, handle] of [...this.timers]) {
      if (wanted.has(key)) continue;
      this.deps.clearInterval(handle);
      this.timers.delete(key);
    }
  }

  dispose(): void {
    for (const handle of this.timers.values()) this.deps.clearInterval(handle);
    this.timers.clear();
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
