import type {
  BlockId,
  Pipeline,
  PipelineId,
  RunId,
  RunState,
  RunStatus,
} from "./domain/types";
import type { ValidationError } from "./domain/validate";

export interface RunSummary {
  readonly runId: RunId;
  readonly pipelineId: PipelineId;
  readonly pipelineName: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly status: RunStatus;
  readonly blockCount: number;
}

export interface PipelinesListPayload {
  readonly pipelines: readonly Pipeline[];
  readonly runs: readonly RunSummary[];
}

export type SessionTarget =
  | { readonly kind: "self" }
  | { readonly kind: "merger" }
  | { readonly kind: "parallel-worker"; readonly workerBlockId: BlockId };

export type PipelinesHostToWebview =
  | { readonly type: "pipelinesList"; readonly payload: PipelinesListPayload }
  | { readonly type: "pipelineDetail"; readonly pipeline: Pipeline }
  | { readonly type: "runUpdate"; readonly run: RunState }
  | { readonly type: "validationFailed"; readonly errors: readonly ValidationError[] }
  | { readonly type: "notice"; readonly level: "info" | "warning" | "error"; readonly message: string };

export type PipelinesWebviewToHost =
  | { readonly type: "ready" }
  | { readonly type: "createPipeline" }
  | { readonly type: "loadPipeline"; readonly pipelineId: PipelineId }
  | { readonly type: "savePipeline"; readonly pipeline: Pipeline }
  | { readonly type: "deletePipeline"; readonly pipelineId: PipelineId }
  | { readonly type: "runPipeline"; readonly pipelineId: PipelineId }
  | { readonly type: "killRun"; readonly runId: RunId }
  | { readonly type: "deleteRun"; readonly runId: RunId }
  | {
      readonly type: "revealSession";
      readonly runId: RunId;
      readonly blockId: BlockId;
      readonly target: SessionTarget;
      readonly sessionId: string | null;
    }
  | { readonly type: "loadRun"; readonly runId: RunId }
  | { readonly type: "resumeRun"; readonly runId: RunId };

export { assertNever as assertNeverPipelines } from "../../shared/assertNever";
