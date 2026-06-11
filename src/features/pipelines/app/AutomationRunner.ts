import type { ModelChoice } from "../../../shared/models";
import type {
  BlockId,
  OrchestratorDecision,
  RunId,
  EffortLevel,
} from "../domain/types";

export interface SpawnOptions {
  readonly runId: RunId;
  readonly blockId: BlockId;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: EffortLevel;
  readonly resumeSessionId: string | null;
  readonly signal: AbortSignal;
}

export type TurnEndKind = "stopped" | "notified" | "process-exited" | "terminal-closed" | "aborted";

export interface SpawnHandle {
  readonly sessionId: string;
  readonly jsonlPath: string;
  waitForTurnEnd(sinceMs: number, signal: AbortSignal): Promise<TurnEndKind>;
  reveal(): void;
  dispose(): void;
  readLastAssistantText(): string;
}

export interface JudgeOptions {
  readonly runId: RunId;
  readonly blockId: BlockId;
  readonly cwd: string;
  readonly taskGoal: string;
  readonly workerJsonlPath: string;
  readonly resumeSessionId: string | null;
  readonly signal: AbortSignal;
}

export interface JudgeOutcome {
  readonly decision: OrchestratorDecision;
  readonly orchestratorSessionId: string | null;
}

export interface AutomationRunner {
  spawn(options: SpawnOptions): Promise<SpawnHandle>;
  judge(options: JudgeOptions): Promise<JudgeOutcome>;
  killRun(runId: RunId): void;
  dispose(): void;
}
