import * as path from "path";
import { TRACE_DATA_DIR } from "../../../shared/config";
import { ConversationStore, type StoredConversation } from "../../../shared/infra/assistant/conversationStore";
import { fromPipelineId, type PipelineId } from "../domain/types";

export type AssistantConversation = StoredConversation;

export class AssistantSessionStore {
  private readonly store: ConversationStore;

  constructor(file: string = path.join(TRACE_DATA_DIR, "pipeline-assistant", "sessions.json")) {
    this.store = new ConversationStore(file);
  }

  list(pipelineId: PipelineId): readonly AssistantConversation[] {
    return this.store.list(fromPipelineId(pipelineId));
  }

  get(pipelineId: PipelineId, conversationId: string): AssistantConversation | null {
    return this.store.get(fromPipelineId(pipelineId), conversationId);
  }

  upsert(pipelineId: PipelineId, conversation: AssistantConversation): void {
    this.store.upsert(fromPipelineId(pipelineId), conversation);
  }

  rename(pipelineId: PipelineId, conversationId: string, title: string): void {
    this.store.rename(fromPipelineId(pipelineId), conversationId, title);
  }

  delete(pipelineId: PipelineId, conversationId: string): void {
    this.store.delete(fromPipelineId(pipelineId), conversationId);
  }

  dropPipeline(pipelineId: PipelineId): void {
    this.store.dropKey(fromPipelineId(pipelineId));
  }
}
