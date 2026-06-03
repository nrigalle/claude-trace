import type {
  BlockId,
  Pipeline,
  PipelineId,
  RunId,
  RunState,
  RunStatus,
} from "./domain/types";
import type { ValidationError } from "./domain/validate";
import type { TimelineEvent, ReplayTurn } from "../../shared/assistant/timeline";
import type { EffortChoice, ModelChoice } from "../../shared/models";

export type { TimelineEvent, ReplayTurn };

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

export interface AssistantConversationMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface WorkflowReplayTurn extends ReplayTurn {
  readonly proposedPipeline?: Pipeline | null;
  readonly proposalErrors?: readonly string[];
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
  | { readonly type: "notice"; readonly level: "info" | "warning" | "error"; readonly message: string }
  | {
      readonly type: "pipelineAssistantReply";
      readonly pipelineId: PipelineId;
      readonly conversationId: string;
      readonly events: readonly TimelineEvent[];
      readonly text: string;
      readonly proposedPipeline: Pipeline | null;
      readonly proposalErrors: readonly string[];
    }
  | { readonly type: "pipelineAssistantProgress"; readonly pipelineId: PipelineId; readonly conversationId: string; readonly events: readonly TimelineEvent[] }
  | { readonly type: "pipelineAssistantHistory"; readonly pipelineId: PipelineId; readonly conversationId: string; readonly turns: readonly WorkflowReplayTurn[] }
  | { readonly type: "pipelineAssistantError"; readonly pipelineId: PipelineId; readonly conversationId: string; readonly message: string }
  | { readonly type: "pipelineAssistantBusy"; readonly pipelineId: PipelineId; readonly conversationId: string; readonly busy: boolean }
  | { readonly type: "pipelineAssistantConversations"; readonly pipelineId: PipelineId; readonly conversations: readonly AssistantConversationMeta[] };

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
  | { readonly type: "resumeRun"; readonly runId: RunId }
  | {
      readonly type: "pipelineAssistantAsk";
      readonly pipeline: Pipeline;
      readonly conversationId: string;
      readonly message: string;
      readonly model: ModelChoice;
      readonly effort: EffortChoice;
    }
  | { readonly type: "pipelineAssistantListConversations"; readonly pipelineId: PipelineId }
  | { readonly type: "pipelineAssistantLoadHistory"; readonly pipelineId: PipelineId; readonly conversationId: string }
  | { readonly type: "pipelineAssistantCancel"; readonly pipelineId: PipelineId; readonly conversationId: string }
  | { readonly type: "pipelineAssistantRenameConversation"; readonly pipelineId: PipelineId; readonly conversationId: string; readonly title: string }
  | { readonly type: "pipelineAssistantDeleteConversation"; readonly pipelineId: PipelineId; readonly conversationId: string };

export { assertNever as assertNeverPipelines } from "../../shared/assertNever";
