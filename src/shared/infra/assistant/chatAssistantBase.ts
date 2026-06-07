import { ClaudeChatEngine, type ClaudeChatConfig, type ReplayTurn } from "./claudeChatEngine";
import type { EffortChoice, ModelChoice } from "../../models";

export class ChatAssistantBase {
  protected readonly engine: ClaudeChatEngine;

  constructor(config: ClaudeChatConfig) {
    this.engine = new ClaudeChatEngine(config);
  }

  dispose(): void {
    this.engine.dispose();
  }

  reset(conversationId: string): void {
    this.engine.reset(conversationId);
  }

  cancel(conversationId: string): void {
    this.engine.cancel(conversationId);
  }

  isBusy(conversationId: string): boolean {
    return this.engine.isBusy(conversationId);
  }

  adopt(conversationId: string, sessionId: string, sessionCwd: string): void {
    this.engine.adopt(conversationId, sessionId, sessionCwd);
  }

  historyTurns(conversationId: string): readonly ReplayTurn[] {
    return this.engine.historyTurns(conversationId);
  }

  sessionInfo(conversationId: string): { readonly sessionId: string; readonly cwd: string } | null {
    const state = this.engine.sessionMap().get(conversationId);
    return state ? { sessionId: state.sessionId, cwd: state.sessionCwd } : null;
  }

  buildArgsForTesting(conversationId: string, message: string, model?: ModelChoice, effort?: EffortChoice): string[] | null {
    return this.engine.buildArgsForTesting(conversationId, message, model, effort);
  }
}
