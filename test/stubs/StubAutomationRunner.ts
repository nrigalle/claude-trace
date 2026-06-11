import type {
  AutomationRunner,
  JudgeOptions,
  JudgeOutcome,
  SpawnHandle,
  SpawnOptions,
  TurnEndKind,
} from "../../src/features/pipelines/app/AutomationRunner";
import type { OrchestratorDecision, RunId } from "../../src/features/pipelines/domain/types";

interface ActiveBlock {
  readonly runId: RunId;
  readonly killed: { value: boolean };
}

export interface StubRunnerOptions {
  readonly workerDurationMs?: number;
  readonly judgeDurationMs?: number;
  readonly decide?: (opts: JudgeOptions) => OrchestratorDecision;
  readonly crashOnPrompt?: (prompt: string) => boolean;
}

const DEFAULT_WORKER_MS = 800;
const DEFAULT_JUDGE_MS = 300;

interface ResolvedOptions {
  readonly workerDurationMs: number;
  readonly judgeDurationMs: number;
  readonly decide?: (opts: JudgeOptions) => OrchestratorDecision;
  readonly crashOnPrompt?: (prompt: string) => boolean;
}

export class StubAutomationRunner implements AutomationRunner {
  readonly judgeCalls: JudgeOptions[] = [];
  private readonly active = new Map<string, ActiveBlock>();
  private readonly options: ResolvedOptions;
  private sessionCounter = 0;
  private judgeCounter = 0;
  private disposed = false;

  constructor(options: StubRunnerOptions = {}) {
    this.options = {
      workerDurationMs: options.workerDurationMs ?? DEFAULT_WORKER_MS,
      judgeDurationMs: options.judgeDurationMs ?? DEFAULT_JUDGE_MS,
      decide: options.decide,
      crashOnPrompt: options.crashOnPrompt,
    };
  }

  spawn(options: SpawnOptions): Promise<SpawnHandle> {
    this.sessionCounter += 1;
    const sessionId = options.resumeSessionId ?? `stub-session-${this.sessionCounter}`;
    const key = this.key(options.runId, sessionId);
    const killed = { value: false };
    this.active.set(key, { runId: options.runId, killed });

    const workerMs = this.options.workerDurationMs;
    const crashesImmediately = this.options.crashOnPrompt?.(options.prompt) ?? false;
    const handle: SpawnHandle = {
      sessionId,
      jsonlPath: `${options.cwd}/${sessionId}.jsonl`,
      waitForTurnEnd: (_sinceMs, signal) =>
        crashesImmediately
          ? this.waitTurnEnd(key, { value: true }, 1, signal)
          : this.waitTurnEnd(key, killed, workerMs, signal),
      reveal: () => {},
      dispose: () => { killed.value = true; this.active.delete(key); },
      readLastAssistantText: () => `[stub assistant output for prompt: ${options.prompt.slice(0, 60)}]`,
    };
    return Promise.resolve(handle);
  }

  judge(options: JudgeOptions): Promise<JudgeOutcome> {
    this.judgeCalls.push(options);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.judgeCounter += 1;
        const orchestratorSessionId = options.resumeSessionId ?? `stub-orchestrator-${this.judgeCounter}`;
        const finish = (decision: OrchestratorDecision): void =>
          resolve({ decision, orchestratorSessionId });
        if (this.options.decide) {
          finish(this.options.decide(options));
          return;
        }
        const firstLine = options.taskGoal
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0 && !line.startsWith("["))
          ?.slice(0, 140) ?? "no prompt";
        finish({
          kind: "success",
          summary: `[stub runner] Worker completed without actually invoking Claude. Configured task: "${firstLine}". When the real PTY+MCP runner ships, this summary will be produced by the orchestrator's judgment of the worker's session.`,
        });
      }, this.options.judgeDurationMs);
      options.signal.addEventListener("abort", () => { clearTimeout(timer); }, { once: true });
    });
  }

  activeSessionCount(): number {
    return this.active.size;
  }

  killRun(runId: RunId): void {
    for (const [key, entry] of this.active) {
      if (entry.runId !== runId) continue;
      entry.killed.value = true;
      this.active.delete(key);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.active.values()) entry.killed.value = true;
    this.active.clear();
  }

  private waitTurnEnd(
    key: string,
    killed: { value: boolean },
    workerMs: number,
    signal: AbortSignal,
  ): Promise<TurnEndKind> {
    return new Promise<TurnEndKind>((resolve) => {
      const finish = (kind: TurnEndKind) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.active.delete(key);
        resolve(kind);
      };
      const onAbort = () => finish("aborted");
      if (signal.aborted) { finish("aborted"); return; }
      signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => finish(killed.value ? "terminal-closed" : "stopped"), workerMs);
    });
  }

  private key(runId: RunId, sessionId: string): string {
    return `${runId}::${sessionId}`;
  }
}
